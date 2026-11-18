import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Check, CircleAlert, Menu, Plus, X } from 'lucide-react';
import { active, json, post, readSaved, save, statusLabels } from './api.js';
import { SessionView } from './session.jsx';
import './style.css';

const selectionKey = 'workbench.last-session';

function currentId() {
  return new URL(location.href).searchParams.get('session') ?? readSaved(selectionKey, null);
}

function Mark() { return <span className="mark" aria-hidden="true"><i /><i /></span>; }

function NewSession({ dialog, create }) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await create(title.trim() || '新会话');
      dialog.current.close();
      setTitle('');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setSaving(false);
    }
  }
  return <dialog ref={dialog} aria-labelledby="new-session-heading">
    <form onSubmit={submit}>
      <div className="dialog-heading">
        <h2 id="new-session-heading">新建会话</h2>
        <button className="icon-button" type="button" aria-label="关闭" onClick={() => dialog.current.close()}><X /></button>
      </div>
      <label htmlFor="session-title">会话名称</label>
      <input id="session-title" autoFocus maxLength={60} value={title} placeholder="新会话"
        onChange={event => setTitle(event.target.value)} />
      {error && <p className="warning-text" role="alert">{error}</p>}
      <button type="submit" className="primary-button" disabled={saving}>{saving ? '正在创建…' : '创建会话'}</button>
    </form>
  </dialog>;
}

function SessionState({ status }) {
  if (active(status)) return <span role="img" aria-label={statusLabels[status]} className={'indicator ' + status} />;
  if (status === 'succeeded') return <Check aria-label="已完成" role="img" className="check-icon" />;
  if (['failed', 'timed_out', 'interrupted'].includes(status)) {
    return <CircleAlert aria-label={statusLabels[status]} role="img" className="warning-icon" />;
  }
  return null;
}

function App() {
  const [selected, setSelected] = useState(currentId);
  const [sessions, setSessions] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const [navigation, setNavigation] = useState(false);
  const dialog = useRef(null);
  const loading = useRef(false);
  const paging = useRef(false);
  const more = useRef(false);
  const current = useRef(selected);

  const select = useCallback((id, method = 'pushState') => {
    current.current = id;
    setSelected(id);
    setNavigation(false);
    save(selectionKey, id);
    const url = new URL(location.href);
    if (id) url.searchParams.set('session', id);
    else url.searchParams.delete('session');
    if (url.href !== location.href) history[method](null, '', url);
  }, []);

  const refreshSessions = useCallback(async (signal, before = null) => {
    const lock = before === null ? loading : paging;
    if (lock.current) return;
    lock.current = true;
    try {
      const page = await json('/api/sessions' + (before === null ? '' : '?before=' + before), { signal });
      if (signal?.aborted) return;
      setSessions(old => {
        const all = before === null ? [...page.items, ...(more.current ? old : [])] : [...old, ...page.items];
        return [...new Map(all.reverse().map(session => [session.id, session])).values()]
          .sort((a, b) => b.cursor - a.cursor);
      });
      if (before !== null || !more.current) setNextCursor(page.nextCursor);
      if (before !== null) more.current = true;
      if (!current.current && page.items[0]) select(page.items[0].id, 'replaceState');
      setNotice('');
    } catch (failure) {
      if (!signal?.aborted) setNotice(failure.message);
    } finally {
      lock.current = false;
      if (!signal?.aborted) setReady(true);
    }
  }, [select]);

  useEffect(() => {
    const controller = new AbortController();
    refreshSessions(controller.signal);
    const timer = setInterval(() => refreshSessions(controller.signal), 2500);
    const onHistory = () => select(new URL(location.href).searchParams.get('session'), 'replaceState');
    window.addEventListener('popstate', onHistory);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('popstate', onHistory);
    };
  }, [refreshSessions, select]);

  async function create(title) {
    const session = await post('/api/sessions', { title });
    select(session.id);
    setSessions(old => [{ ...session, cursor: (old[0]?.cursor ?? 0) + 1 }, ...old.filter(item => item.id !== session.id)]);
    refreshSessions();
  }

  return <div className="workbench">
    {navigation && <button type="button" className="mobile-shade" aria-label="关闭会话列表" onClick={() => setNavigation(false)} />}
    <aside className={'sidebar' + (navigation ? ' navigation-open' : '')} aria-label="会话列表">
      <div className="brand"><Mark /><span>Agent 工作台</span></div>
      <div className="sidebar-content">
        <button type="button" className="new-session" onClick={() => dialog.current.showModal()}><Plus />新建会话</button>
        <nav aria-label="最近会话">
          <h2>最近会话</h2>
          {sessions.map(session => <button key={session.id} type="button" className="session-row"
            aria-current={session.id === selected ? 'page' : undefined} title={session.title}
            onClick={() => select(session.id)}>
            <span>{session.title}</span><SessionState status={session.status} />
          </button>)}
          {nextCursor !== null && <button type="button" className="text-button more-sessions"
            onClick={() => refreshSessions(undefined, nextCursor)}>更多会话</button>}
          {notice && <p className="sidebar-notice" role="alert">{notice}</p>}
        </nav>
      </div>
    </aside>
    {selected ? <SessionView key={selected} id={selected} refreshSessions={refreshSessions}
      openNavigation={() => setNavigation(true)} /> : <main className="initial">
      <header className="conversation-header"><button className="icon-button mobile-menu" type="button"
        aria-label="打开会话列表" onClick={() => setNavigation(true)}><Menu /></button><h1>Agent 工作台</h1></header>
      <div className="empty-workspace">
        {ready ? <><Mark /><h2>开始一项工作</h2><button type="button" className="primary-button"
          onClick={() => dialog.current.showModal()}><Plus />新建会话</button></> : <span role="status">正在读取会话…</span>}
      </div>
    </main>}
    <NewSession dialog={dialog} create={create} />
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
