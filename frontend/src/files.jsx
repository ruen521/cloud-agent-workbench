import React, { useEffect, useState } from 'react';
import { ArrowDownToLine, FileText, Folder, Paperclip, X } from 'lucide-react';
import { fileUrl, request } from './api.js';
import { Markdown } from './transcript.jsx';

const previewTypes = /\.(?:md|txt|csv|tsv|json|yaml|yml|toml|ini|log|py|js|ts|jsx|tsx|css|html|xml|sh|java|sql|r|go|rs|c|cpp|h)$/i;
const maxPreview = 256 * 1024;

function Preview({ sessionId, file }) {
  const [result, setResult] = useState({ text: null, error: '' });
  useEffect(() => {
    const controller = new AbortController();
    const url = fileUrl(sessionId, file.path);
    (async () => {
      if (!previewTypes.test(file.path)) throw new Error('此文件可下载查看');
      const head = await request(url, { method: 'HEAD', signal: controller.signal });
      if (Number(head.headers.get('Content-Length')) > maxPreview) throw new Error('文件较大，请下载查看');
      const response = await request(url, { signal: controller.signal });
      if (Number(response.headers.get('Content-Length')) > maxPreview) {
        await response.body?.cancel();
        throw new Error('文件较大，请下载查看');
      }
      const text = await response.text();
      if (!controller.signal.aborted) setResult({ text, error: '' });
    })().catch(error => {
      if (!controller.signal.aborted) setResult({ text: null, error: error.message });
    });
    return () => controller.abort();
  }, [sessionId, file.path, file.modifiedAt]);

  if (result.error) return <p className="panel-state" role="status">{result.error}</p>;
  if (result.text === null) return <p className="panel-state" role="status">正在读取文件…</p>;
  if (!result.text) return <p className="panel-state">空文件</p>;
  return /\.md$/i.test(file.path) ? <Markdown>{result.text}</Markdown> : <pre>{result.text}</pre>;
}

export function FileDrawer({ sessionId, files, selection, onSelect, onClose, onUpload, error, loading, next, onMore }) {
  const materials = files.filter(file => file.path.startsWith('inputs/'));
  const results = files.filter(file => !file.path.startsWith('inputs/'));
  const sections = [['成果', results], ['材料', materials]];
  return <aside className="file-drawer" aria-label="文件面板" id="files-panel">
    <div className="drawer-heading">
      <h2>文件</h2>
      <div className="drawer-actions">
        <button type="button" className="icon-button" aria-label="上传文件" onClick={onUpload}><Paperclip /></button>
        <button type="button" className="icon-button" aria-label="关闭文件面板" onClick={onClose}><X /></button>
      </div>
    </div>
    <div className="drawer-body">
      {loading && <p className="panel-state" role="status">正在读取文件…</p>}
      {error && <p className="panel-state warning-text" role="alert">{error}</p>}
      {!loading && !error && files.length === 0 && <p className="panel-state"><Folder />暂无文件</p>}
      {sections.map(([title, items]) => items.length > 0 && <section className="file-group" key={title}>
        <h3>{title}</h3>
        {items.map(file => <button type="button" className="file-row" key={file.path}
          aria-pressed={file.path === selection?.path} title={file.path} onClick={() => onSelect(file)}>
          <FileText aria-hidden="true" /><span>{file.name ?? file.path.split('/').at(-1)}</span>
        </button>)}
      </section>)}
      {next !== null && <button type="button" className="text-button" onClick={onMore}>更多文件</button>}
      {selection && <section className="file-preview">
        <div className="preview-heading">
          <h3 title={selection.path}>{selection.name ?? selection.path.split('/').at(-1)}</h3>
          <a href={fileUrl(sessionId, selection.path)} download={selection.name ?? ''}>
            <ArrowDownToLine aria-hidden="true" />下载
          </a>
        </div>
        <Preview key={selection.path + (selection.modifiedAt ?? '')} sessionId={sessionId} file={selection} />
      </section>}
    </div>
  </aside>;
}
