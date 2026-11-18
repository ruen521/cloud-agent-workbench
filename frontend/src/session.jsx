import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Folder, Menu, Paperclip, Square, X } from 'lucide-react';
import { active, json, post, readSaved, runUrl, save, sessionUrl, statusLabels } from './api.js';
import { FileDrawer } from './files.jsx';
import { Markdown, Turn } from './transcript.jsx';

const emptyDraft = { text: '', attachments: [] };
const unique = items => [...new Map(items.map(item => [item.path, item])).values()];

function Composer({ draft, setDraft, pending, uploading, busy, cancelling, onSend, onCancel, onFiles, inputRef, picker }) {
  const [dragging, setDragging] = useState(false);
  const hoverCount = useRef(0);
  const containsFiles = event => Array.from(event.dataTransfer.types).includes('Files');
  return <form className={'composer' + (dragging ? ' drag-over' : '')} onSubmit={onSend}
    onDragEnter={event => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      hoverCount.current++;
      setDragging(true);
    }} onDragOver={event => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }} onDragLeave={event => {
      if (!containsFiles(event)) return;
      hoverCount.current = Math.max(0, hoverCount.current - 1);
      if (hoverCount.current === 0) setDragging(false);
    }} onDrop={event => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      hoverCount.current = 0;
      setDragging(false);
      onFiles(Array.from(event.dataTransfer.files));
    }}>
    {dragging && <div className="drop-target"><Paperclip />松开以上传文件</div>}
    {draft.attachments.length > 0 && <div className="draft-attachments">
      {draft.attachments.map(file => <span className="draft-file" key={file.path}>
        <Paperclip aria-hidden="true" /><span>{file.name}</span>
        <button type="button" className="icon-button" aria-label={'移除 ' + file.name}
          onClick={() => setDraft(value => ({ ...value, attachments: value.attachments.filter(item => item.path !== file.path) }))}>
          <X aria-hidden="true" />
        </button>
      </span>)}
    </div>}
    <textarea ref={inputRef} rows={2} maxLength={16000} aria-label="输入消息"
      placeholder={busy ? '输入反馈…' : '继续提问…'} value={draft.text}
      onChange={event => setDraft(value => ({ ...value, text: event.target.value }))}
      onKeyDown={event => {
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.currentTarget.form.requestSubmit();
      }} />
    <div className="composer-controls">
      <button type="button" className="icon-button" aria-label="添加附件" onClick={() => picker.current.click()} disabled={uploading}>
        <Paperclip aria-hidden="true" />
      </button>
      {uploading && <span role="status">正在上传…</span>}
      <div className="composer-actions">
        {busy && draft.text.trim() && <span className="draft-status">完成后可发送</span>}
        {busy ? <button type="button" className="primary-button" onClick={onCancel} disabled={cancelling}>
          <Square aria-hidden="true" />{cancelling ? '正在停止…' : '停止'}
        </button> : <button type="submit" className="primary-button send-button" aria-label="发送"
          disabled={pending || uploading || !draft.text.trim()}><ArrowUp aria-hidden="true" /></button>}
      </div>
    </div>
    <input ref={picker} type="file" multiple hidden onChange={event => {
      onFiles(Array.from(event.target.files));
      event.target.value = '';
    }} />
  </form>;
}

export function SessionView({ id, refreshSessions, openNavigation }) {
  const target = sessionUrl(id);
  const draftKey = 'workbench.draft.' + id;
  const [draft, updateDraft] = useState(() => readSaved(draftKey, emptyDraft));
  const [detail, setDetail] = useState(null);
  const [files, setFiles] = useState([]);
  const [fileNext, setFileNext] = useState(null);
  const [filesLoading, setFilesLoading] = useState(true);
  const [fileError, setFileError] = useState('');
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [selection, setSelection] = useState(null);
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const draftRef = useRef(draft);
  const uploadingRef = useRef(false);
  const sendingRef = useRef(false);
  const picker = useRef(null);
  const composer = useRef(null);
  const fileControl = useRef(null);
  const alive = useRef(true);
  const scroll = useRef(null);
  const thread = useRef(null);
  const followScroll = useRef(true);
  const fileTimer = useRef();
  const scrollPrepend = useRef(null);

  const setDraft = useCallback(action => {
    draftRef.current = typeof action === 'function' ? action(draftRef.current) : action;
    // 草稿按会话立即保存，切换工作时不会混用输入或附件。
    save(draftKey, draftRef.current);
    if (alive.current) updateDraft(draftRef.current);
  }, [draftKey]);

  const loadFiles = useCallback(async (cursor = null, signal) => {
    try {
      const page = await json(target + '/files' + (cursor === null ? '' : '?cursor=' + cursor), { signal });
      if (signal?.aborted || !alive.current) return;
      setFiles(old => cursor === null ? page.items : unique([...old, ...page.items]));
      setFileNext(page.nextCursor);
      setFileError('');
    } catch (failure) {
      if (!signal?.aborted && alive.current) setFileError(failure.message);
    } finally {
      if (!signal?.aborted && alive.current) setFilesLoading(false);
    }
  }, [target]);

  const loadDetail = useCallback(async signal => {
    try {
      const result = await json(target, { signal });
      if (signal?.aborted || !alive.current) return;
      setDetail(old => {
        if (!old || old.messages.length <= 50) return result;
        const first = result.messages[0]?.id ?? Infinity;
        return { ...result, nextCursor: old.nextCursor,
          messages: [...old.messages.filter(message => message.id < first), ...result.messages] };
      });
    } catch (failure) {
      if (!signal?.aborted && alive.current) setError(failure.message);
    }
  }, [target]);

  useEffect(() => {
    const controller = new AbortController();
    alive.current = true;
    loadDetail(controller.signal);
    loadFiles(null, controller.signal);
    return () => { alive.current = false; controller.abort(); clearTimeout(fileTimer.current); };
  }, [loadDetail, loadFiles]);

  const onRunStatus = useCallback((runId, state) => {
    setDetail(old => {
      if (!old || old.latestRun?.id !== runId) return old;
      const run = { ...old.latestRun, status: state.status, error_code: state.code ?? null };
      return { ...old, latestRun: run, activeRun: active(state.status) ? run : null,
        messages: old.messages.map(message => message.run_id === runId ?
          { ...message, run_status: state.status, run_error_code: state.code ?? null } : message) };
    });
    if (!active(state.status)) {
      setCancelling(false);
      loadDetail();
      loadFiles();
    }
    refreshSessions();
  }, [loadDetail, loadFiles, refreshSessions]);

  const onFileChange = useCallback(() => {
    clearTimeout(fileTimer.current);
    fileTimer.current = setTimeout(() => loadFiles(), 300);
  }, [loadFiles]);

  useLayoutEffect(() => {
    if (!scroll.current || !thread.current) return;
    const observer = new ResizeObserver(() => {
      if (followScroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(thread.current);
    return () => observer.disconnect();
  }, [Boolean(detail)]);

  useLayoutEffect(() => {
    if (scrollPrepend.current === null || !scroll.current) return;
    scroll.current.scrollTop += scroll.current.scrollHeight - scrollPrepend.current;
    scrollPrepend.current = null;
  }, [detail]);

  const closeDrawer = useCallback(() => {
    setDrawer(false);
    fileControl.current?.focus();
  }, []);

  useEffect(() => {
    if (!drawer) return;
    const onKey = event => { if (event.key === 'Escape') closeDrawer(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer, closeDrawer]);

  async function uploadFiles(items) {
    if (!items.length || uploadingRef.current || sendingRef.current) return;
    if (items.length + draftRef.current.attachments.length > 10) {
      setError('每条消息最多添加 10 个附件');
      return;
    }
    uploadingRef.current = true;
    setUploading(true);
    setError('');
    try {
      for (const item of items) {
        if (item.size > 20 * 1024 * 1024) throw new Error(item.name + ' 超过 20 MiB');
        const body = new FormData();
        body.append('file', item);
        const saved = await json(target + '/files', { method: 'POST', body });
        setDraft(value => ({ ...value, attachments: [...value.attachments, saved] }));
      }
    } catch (failure) {
      if (alive.current) setError(failure.message);
    } finally {
      uploadingRef.current = false;
      if (alive.current) { setUploading(false); loadFiles(); }
    }
  }

  async function send(event) {
    event.preventDefault();
    const current = draftRef.current;
    if (!current.text.trim() || detail?.activeRun || sendingRef.current || uploadingRef.current) return;
    sendingRef.current = true;
    setPending(true);
    setError('');
    try {
      await post(target + '/messages', { content: current.text, attachments: current.attachments.map(file => file.path) });
      setDraft(value => value === current ? emptyDraft : { ...value, attachments: [] });
      followScroll.current = true;
      await loadDetail();
      refreshSessions();
    } catch (failure) {
      if (alive.current) setError(failure.message);
    } finally {
      sendingRef.current = false;
      if (alive.current) setPending(false);
    }
  }

  async function cancel() {
    setCancelling(true);
    setError('');
    try {
      const result = await post(runUrl(detail.activeRun.id) + '/cancel', {});
      if (!active(result.run.status)) onRunStatus(result.run.id, result.run);
    } catch (failure) {
      if (alive.current) { setError(failure.message); setCancelling(false); }
    }
  }

  async function moreMessages() {
    try {
      const result = await json(target + '?before=' + detail.nextCursor);
      if (!alive.current) return;
      followScroll.current = false;
      scrollPrepend.current = scroll.current.scrollHeight;
      setDetail(old => ({ ...old, nextCursor: result.nextCursor, messages: [...result.messages, ...old.messages] }));
    } catch (failure) {
      setError(failure.message);
    }
  }

  function preview(file) { setSelection(file); setDrawer(true); }

  function continueTask() {
    setDraft(value => ({ ...value, text: value.text || '请从已有成果继续上次任务，先检查当前进展。' }));
    composer.current?.focus();
  }

  const status = detail?.latestRun?.status;
  const selected = files.find(file => file.path === selection?.path) ?? selection;
  const answers = new Map(detail?.messages.filter(message => message.role === 'assistant').map(message => [message.run_id, message]));
  const standaloneAnswer = detail?.messages[0]?.role === 'assistant' ? detail.messages[0] : null;

  return <div className={'session-space' + (drawer ? ' drawer-open' : '')}>
    <main className="conversation">
      <header className="conversation-header">
        <button className="icon-button mobile-menu" aria-label="打开会话列表" type="button" onClick={openNavigation}><Menu /></button>
        <h1>{detail?.session.title ?? 'Agent 工作台'}</h1>
        <div className="heading-controls">
          {status && <span className={'run-state ' + status}><span />{statusLabels[status]}</span>}
          <button ref={fileControl} type="button" className="file-toggle" aria-expanded={drawer}
            aria-controls="files-panel" onClick={() => drawer ? closeDrawer() : setDrawer(true)} disabled={!detail}><Folder />文件</button>
        </div>
      </header>
      {detail ? <>
        <div className="transcript" ref={scroll} onScroll={event => {
          const area = event.currentTarget;
          followScroll.current = area.scrollHeight - area.scrollTop - area.clientHeight < 70;
        }}>
          <div className="thread measure" ref={thread}>
            {detail.nextCursor !== null && <button type="button" className="text-button history-button" onClick={moreMessages}>加载更早消息</button>}
            {standaloneAnswer && <Markdown>{standaloneAnswer.content}</Markdown>}
            {detail.messages.filter(message => message.role === 'user').map(message => <Turn
              key={message.run_id} message={message} answer={answers.get(message.run_id)}
              latest={message.run_id === detail.latestRun?.id} sessionId={id} files={files}
              onPreview={preview} onRunStatus={onRunStatus} onFileChange={onFileChange} onContinue={continueTask} />)}
          </div>
        </div>
        <div className="composer-wrap">
          <div className="measure">
            {error && <div className="inline-error" role="alert">{error}<button type="button" className="icon-button"
              aria-label="关闭提示" onClick={() => setError('')}><X /></button></div>}
            <Composer draft={draft} setDraft={setDraft} pending={pending} uploading={uploading}
              busy={Boolean(detail.activeRun)} cancelling={cancelling} onSend={send} onCancel={cancel}
              onFiles={uploadFiles} inputRef={composer} picker={picker} />
          </div>
        </div>
      </> : <div className="empty-workspace" role={error ? 'alert' : 'status'}>
        {error || '正在打开会话…'}
        {error && <button type="button" className="text-button" onClick={() => { setError(''); loadDetail(); }}>重新加载</button>}
      </div>}
    </main>
    {drawer && <FileDrawer sessionId={id} files={files} selection={selected} onSelect={setSelection}
      onClose={closeDrawer} onUpload={() => picker.current?.click()} error={fileError} loading={filesLoading}
      next={fileNext} onMore={() => loadFiles(fileNext)} />}
  </div>;
}
