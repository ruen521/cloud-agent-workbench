import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, Check, ChevronDown, FileText, Paperclip, Terminal } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { active, errorLabel, fileUrl, json, runUrl, statusLabels } from './api.js';

export function Markdown({ children }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    img: () => null,
    a: ({ href, children: text }) => <a href={href} target="_blank" rel="noreferrer noopener">{text}</a>,
  }}>{children}</ReactMarkdown></div>;
}

export function Artifact({ sessionId, file, onPreview }) {
  return <div className="artifact">
    <FileText aria-hidden="true" />
    <span title={file.path}>{file.name ?? file.path.split('/').at(-1)}</span>
    <div className="artifact-actions">
      <button type="button" onClick={() => onPreview(file)}>预览</button>
      <a href={fileUrl(sessionId, file.path)} download={file.name ?? ''}><ArrowDownToLine aria-hidden="true" />下载</a>
    </div>
  </div>;
}

const types = ['status', 'step', 'tool', 'text', 'error', 'artifacts'];

function useRunLog(id, live, enabled, onRunStatus, onFileChange) {
  const [events, setEvents] = useState([]);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let stream;
    setProblem('');
    if (live) {
      // EventSource 自动带上最后一个事件 ID。终态主动关闭连接，避免浏览器重复重连。
      stream = new EventSource(runUrl(id) + '/events');
      stream.onopen = () => setProblem('');
      for (const type of types) {
        stream.addEventListener(type, message => {
          if (!(message instanceof MessageEvent)) return;
          const event = JSON.parse(message.data);
          setEvents(list => list.some(item => item.id === event.id) ? list : [...list, event]);
          if (type === 'tool' && ['write', 'edit', 'bash'].includes(event.payload.tool)) onFileChange();
          if (type === 'status') {
            if (!active(event.payload.status)) stream.close();
            onRunStatus(id, event.payload);
          }
        });
      }
      stream.onerror = event => {
        if (!(event instanceof MessageEvent)) setProblem('连接中断，正在重连');
      };
    } else {
      (async () => {
        const history = [];
        let after = 0;
        do {
          const page = await json(runUrl(id) + '/events?format=json&limit=100&after=' + after,
            { signal: controller.signal });
          history.push(...page.items);
          after = page.nextCursor;
        } while (after !== null);
        if (!controller.signal.aborted) setEvents(history);
      })().catch(error => { if (!controller.signal.aborted) setProblem(error.message); });
    }
    return () => { controller.abort(); stream?.close(); };
  }, [id, live, enabled, onRunStatus, onFileChange]);
  return { events, problem };
}

const toolLabels = {
  read: '读取', edit: '更新', write: '写入', bash: '运行命令', grep: '搜索内容', glob: '查找文件',
  apply_patch: '更新文件', list: '列出文件',
};

function ToolLine({ payload }) {
  const { path, testsPassed, tool, status, exitCode } = payload;
  const failed = status === 'failed';
  const label = testsPassed !== undefined ? testsPassed + ' 项测试通过' : toolLabels[tool] ?? '执行工具';
  return <li>
    {failed ? <AlertTriangle className="warning-icon" /> : <Check className="check-icon" />}
    <span>{label}{path ? ' ' + path.split('/').at(-1) : ''}</span>
    {failed && <span className="warning-text">{exitCode !== undefined ? '退出码 ' + exitCode : '失败'}</span>}
  </li>;
}

export function Turn({ message, answer, latest, sessionId, files, onPreview, onRunStatus, onFileChange, onContinue }) {
  const live = active(message.run_status);
  const [expanded, setExpanded] = useState(latest || live);
  const { events, problem } = useRunLog(message.run_id, live, live || expanded, onRunStatus, onFileChange);
  const terminal = events.findLast(event => event.type === 'status')?.payload;
  const status = terminal?.status ?? message.run_status;
  const error = terminal?.code ?? message.run_error_code;
  const recentText = events.filter(event => event.type === 'text').map(event => event.payload.text).join('\n\n');
  const text = answer?.content ?? recentText;
  const tools = events.filter(event => event.type === 'tool');
  const listed = events.findLast(event => event.type === 'artifacts')?.payload ?? message.artifacts;
  const fileByPath = new Map(files.map(file => [file.path, file]));
  const knownWrites = new Set(tools.filter(event => ['write', 'edit'].includes(event.payload.tool) &&
    event.payload.status === 'completed').map(event => event.payload.path));
  // 执行中只展示工具确认过、且文件接口已经看得到的产物。
  const interim = files.filter(file => !file.path.startsWith('inputs/') && knownWrites.has(file.path));
  const artifacts = (listed?.items ?? interim).filter(file => fileByPath.has(file.path) || !latest);
  const showError = ['failed', 'interrupted', 'timed_out'].includes(status);

  return <section className="turn" aria-label="任务记录">
    <div className="user-message">
      {message.content}
      {!!message.attachments?.length && <div className="message-attachments">
        {message.attachments.map(file => <button type="button" key={file.path}
          onClick={() => onPreview(fileByPath.get(file.path) ?? file)}><Paperclip aria-hidden="true" />{file.name}</button>)}
      </div>}
    </div>
    <div className="assistant-turn">
      {text && <Markdown>{text}</Markdown>}
      <div className="activities">
        <button type="button" className="activity-toggle" aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}>
          <Terminal aria-hidden="true" />执行进展<ChevronDown className={expanded ? '' : 'collapsed'} aria-hidden="true" />
        </button>
        {expanded && <ul className="activity-list" aria-live={live ? 'polite' : 'off'}>
          {tools.map(event => <ToolLine key={event.id} payload={event.payload} />)}
          {active(status) && <li><span className={'indicator ' + status} /><span>{statusLabels[status]}</span></li>}
          {showError && <li><AlertTriangle className="warning-icon" /><span>{errorLabel(error)}</span></li>}
          {status === 'cancelled' && <li><span>已取消</span></li>}
          {status === 'succeeded' && tools.length === 0 && <li><Check className="check-icon" /><span>已完成</span></li>}
          {problem && <li role="status"><span>{problem}</span></li>}
        </ul>}
      </div>
      {showError && latest && <div className="run-warning" role="status">
        <span>{artifacts.length ? '生成的文件已保留。' : errorLabel(error)}</span>
        <button type="button" onClick={onContinue}>继续任务</button>
      </div>}
      <div className="artifacts">
        {artifacts.map(file => <Artifact key={file.path} sessionId={sessionId}
          file={fileByPath.get(file.path) ?? file} onPreview={onPreview} />)}
      </div>
    </div>
  </section>;
}
