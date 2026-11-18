import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from './config.js';

const now = () => new Date().toISOString();

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, cli_session_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','timed_out','interrupted')),
        queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error_code TEXT, exit_code INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_session ON runs(session_id)
        WHERE status IN ('queued','running');
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_job ON runs(status) WHERE status = 'running';
      CREATE INDEX IF NOT EXISTS run_history ON runs(session_id, queued_at DESC);
      CREATE INDEX IF NOT EXISTS run_queue ON runs(status, queued_at);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        run_id TEXT NOT NULL REFERENCES runs(id), role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, role)
      );
      CREATE INDEX IF NOT EXISTS message_history ON messages(session_id, id DESC);
      CREATE TABLE IF NOT EXISTS message_attachments (
        message_id INTEGER NOT NULL REFERENCES messages(id),
        position INTEGER NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL,
        PRIMARY KEY(message_id, position)
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
        type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_stream ON run_events(run_id, id);
      CREATE INDEX IF NOT EXISTS event_type_by_run ON run_events(run_id, type);
      CREATE TABLE IF NOT EXISTS model_calls (
        id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), requested_at TEXT NOT NULL,
        prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS model_calls_by_date ON model_calls(requested_at);
      CREATE INDEX IF NOT EXISTS model_calls_by_run ON model_calls(run_id);
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        path TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(session_id, path)
      );
    `);
    this.statements = new Map();
  }

  sql(query) {
    if (!this.statements.has(query)) this.statements.set(query, this.db.prepare(query));
    return this.statements.get(query);
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createSession(id, title) {
    const time = now();
    this.sql('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, title, time, time);
    return this.session(id);
  }

  session(id) {
    const session = this.sql('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
    return session;
  }

  sessions(before, limit) {
    return this.sql(`SELECT rowid AS cursor, id, title, created_at, updated_at,
      (SELECT status FROM runs WHERE session_id = sessions.id ORDER BY queued_at DESC, rowid DESC LIMIT 1) AS status
      FROM sessions WHERE rowid < ? ORDER BY rowid DESC LIMIT ?`).all(before, limit);
  }

  messages(sessionId, before, limit) {
    return this.sql(`SELECT m.*, r.status AS run_status, r.error_code AS run_error_code,
      CASE WHEN m.role = 'user' THEN (
        SELECT payload FROM run_events WHERE run_id = m.run_id AND type = 'artifacts' LIMIT 1
      ) END AS artifacts,
      CASE WHEN m.role = 'assistant' AND r.status = 'succeeded' THEN (
        WITH final_step AS (
          SELECT id FROM run_events WHERE run_id = m.run_id AND type = 'step'
            AND json_extract(payload, '$.reason') = 'stop' ORDER BY id DESC LIMIT 1
        ), start_step AS (
          SELECT id FROM run_events WHERE run_id = m.run_id AND type = 'step'
            AND json_extract(payload, '$.status') = 'started' AND id < (SELECT id FROM final_step)
            ORDER BY id DESC LIMIT 1
        )
        SELECT group_concat(text, char(10) || char(10)) FROM (
          SELECT json_extract(payload, '$.text') AS text FROM run_events
          WHERE run_id = m.run_id AND type = 'text'
            AND id > coalesce((SELECT id FROM start_step), 0) AND id < (SELECT id FROM final_step)
          ORDER BY id
        )
      ) END AS final_content, (
        SELECT json_group_array(json_object('path', path, 'name', name))
        FROM (SELECT path, name FROM message_attachments WHERE message_id = m.id ORDER BY position)
      ) AS attachments
      FROM messages m JOIN runs r ON m.run_id = r.id
      WHERE m.session_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
      // 旧会话的答复曾把过程说明一起保存，从同一批持久化事件恢复最终答复。
      .all(sessionId, before, limit).map(({ final_content, ...message }) => ({
        ...message,
        content: final_content ?? message.content,
        attachments: JSON.parse(message.attachments),
        artifacts: message.artifacts ? JSON.parse(message.artifacts) : null,
      }));
  }

  latestRun(sessionId) {
    return this.sql('SELECT * FROM runs WHERE session_id = ? ORDER BY queued_at DESC, rowid DESC LIMIT 1')
      .get(sessionId) ?? null;
  }

  run(id) {
    const run = this.sql('SELECT * FROM runs WHERE id = ?').get(id);
    if (!run) throw new HttpError(404, 'RUN_NOT_FOUND', '任务不存在');
    return run;
  }

  append(runId, type, payload, time = now()) {
    this.sql('INSERT INTO run_events (run_id, type, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(runId, type, JSON.stringify(payload), time);
  }

  events(runId, after, limit) {
    return this.sql('SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?')
      .all(runId, after, limit).map(event => ({ ...event, payload: JSON.parse(event.payload) }));
  }

  enqueue(sessionId, content, paths = []) {
    // 消息、任务和首个事件一起提交，页面不会看到没有任务的用户消息。
    return this.transaction(() => {
      this.session(sessionId);
      const active = this.sql(`SELECT id FROM runs WHERE session_id = ? AND status IN ('queued','running')`)
        .get(sessionId);
      if (active) throw new HttpError(409, 'SESSION_BUSY', '此会话已有排队或运行中的任务');
      if (this.sql("SELECT count(*) AS count FROM runs WHERE status = 'queued'").get().count >= 32) {
        throw new HttpError(429, 'QUEUE_FULL', '任务队列已满');
      }
      const id = randomUUID();
      const time = now();
      this.sql("INSERT INTO runs (id, session_id, status, queued_at) VALUES (?, ?, 'queued', ?)")
        .run(id, sessionId, time);
      const message = this.sql("INSERT INTO messages (session_id, run_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)")
        .run(sessionId, id, content, time);
      // 附件必须属于当前会话。消息、附件引用和任务在同一个事务里保存。
      for (const [position, path] of paths.entries()) {
        const file = this.sql('SELECT path, name FROM uploads WHERE session_id = ? AND path = ?').get(sessionId, path);
        if (!file) throw new HttpError(400, 'ATTACHMENT_NOT_FOUND', '附件不存在于当前会话');
        this.sql('INSERT INTO message_attachments VALUES (?, ?, ?, ?)')
          .run(message.lastInsertRowid, position, file.path, file.name);
      }
      this.sql('UPDATE sessions SET updated_at = ? WHERE id = ?').run(time, sessionId);
      this.append(id, 'status', { status: 'queued' }, time);
      return this.run(id);
    });
  }

  claim() {
    return this.transaction(() => {
      if (this.sql("SELECT id FROM runs WHERE status = 'running'").get()) return null;
      const task = this.sql(`
        SELECT r.id, r.session_id, s.cli_session_id, m.content
        FROM runs r JOIN sessions s ON s.id = r.session_id
        JOIN messages m ON m.run_id = r.id AND m.role = 'user'
        WHERE r.status = 'queued' ORDER BY r.queued_at, r.rowid LIMIT 1
      `).get();
      if (!task) return null;
      const time = now();
      this.sql("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?").run(time, task.id);
      this.append(task.id, 'status', { status: 'running' }, time);
      task.attachments = this.sql(`SELECT a.path FROM message_attachments a JOIN messages m ON m.id = a.message_id
        WHERE m.run_id = ? AND m.role = 'user' ORDER BY a.position`).all(task.id).map(file => file.path);
      return task;
    });
  }

  recordCliSession(sessionId, cliSessionId) {
    const result = this.sql(`UPDATE sessions SET cli_session_id = ? WHERE id = ?
      AND (cli_session_id IS NULL OR cli_session_id = ?)`).run(cliSessionId, sessionId, cliSessionId);
    if (result.changes !== 1) throw new Error('CLI_SESSION_MISMATCH');
  }

  finish(id, status, { code = null, exitCode = null, text = null, expected = 'running', artifacts } = {}) {
    // 最终消息、用量和状态事件一起写入，SSE 重连能完整重放终态。
    return this.transaction(() => {
      const time = now();
      const result = this.sql(`UPDATE runs SET status = ?, finished_at = ?, error_code = ?, exit_code = ?
        WHERE id = ? AND status = ?`).run(status, time, code, exitCode, id, expected);
      const run = this.run(id);
      if (result.changes !== 1) return run;
      if (text) {
        this.sql("INSERT INTO messages (session_id, run_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)")
          .run(run.session_id, id, text, time);
      }
      this.sql('UPDATE sessions SET updated_at = ? WHERE id = ?').run(time, run.session_id);
      if (artifacts) this.append(id, 'artifacts', artifacts, time);
      this.append(id, 'status', { status, code, usage: this.usage(id) }, time);
      return run;
    });
  }

  recover() {
    const orphan = this.sql("SELECT id FROM runs WHERE status = 'running'").get();
    if (orphan) this.finish(orphan.id, 'interrupted', { code: 'SERVICE_RESTARTED' });
  }

  reserveCall(runId, perRun, perDay) {
    // 上游请求之前持久化预约，失败或重启时也按已尝试调用计数。
    return this.transaction(() => {
      const time = now();
      const midnight = `${time.slice(0, 10)}T00:00:00.000Z`;
      const run = this.sql('SELECT count(*) AS count FROM model_calls WHERE run_id = ?').get(runId);
      const day = this.sql('SELECT count(*) AS count FROM model_calls WHERE requested_at >= ?').get(midnight);
      if (run.count >= perRun || day.count >= perDay) return null;
      return this.sql('INSERT INTO model_calls (run_id, requested_at) VALUES (?, ?)').run(runId, time).lastInsertRowid;
    });
  }

  recordUsage(callId, usage) {
    this.sql(`UPDATE model_calls SET prompt_tokens = ?, completion_tokens = ?, total_tokens = ? WHERE id = ?`)
      .run(usage.promptTokens, usage.completionTokens, usage.totalTokens, callId);
  }

  usage(runId) {
    return this.sql(`SELECT count(*) AS calls, count(total_tokens) AS callsWithUsage,
      sum(prompt_tokens) AS promptTokens, sum(completion_tokens) AS completionTokens, sum(total_tokens) AS totalTokens
      FROM model_calls WHERE run_id = ?`).get(runId);
  }

  recordUpload(id, sessionId, path, name, size) {
    this.sql('INSERT INTO uploads VALUES (?, ?, ?, ?, ?, ?)').run(id, sessionId, path, name, size, now());
  }
}
