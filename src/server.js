import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import express from 'express';
import { HttpError, loadConfig } from './config.js';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { sessionPaths } from './workspace.js';
import { startGateway } from './gateway.js';
import { createWorkspace, downloadFile, listFiles, uploadFile } from './files.js';

const active = status => status === 'queued' || status === 'running';
const invalid = message => new HttpError(400, 'INVALID_INPUT', message);

function cursor(value, name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw invalid(`${name} 必须为整数`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw invalid(`${name} 超出范围`);
  return number;
}

function input(value, maxBytes, name) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maxBytes || value.includes('\0')) {
    throw invalid(`${name} 不能为空或超过大小限制`);
  }
  return value.trim();
}

function page(rows, limit, id) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items.at(-1)[id] : null };
}

function streamEvents(req, res, store) {
  const run = store.run(req.params.id);
  let last = cursor(req.get('Last-Event-ID') ?? req.query.after, '事件游标', 0);
  let timer;
  let blocked = false;
  let lastWrite = Date.now();
  const write = data => {
    lastWrite = Date.now();
    if (!res.write(data)) {
      blocked = true;
      res.once('drain', () => { blocked = false; pump(); });
    }
  };
  const pump = () => {
    if (res.destroyed || res.writableEnded || blocked) return;
    try {
      // 每次回放有限事件，慢浏览器触发背压时暂停读取。
      const events = store.events(run.id, last, 50);
      for (const event of events) {
        write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        last = event.id;
        if (blocked) return;
      }
      if (events.length < 50 && !active(store.run(run.id).status)) res.end();
      else if (Date.now() - lastWrite > 15000) write(': heartbeat\n\n');
    } catch (error) {
      console.error('事件流异常', res.locals.requestId, error.code ?? error.name);
      res.destroy();
    }
  };
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.once('close', () => clearInterval(timer));
  timer = setInterval(pump, 200);
  pump();
}

async function main() {
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true });
  const store = new Store(join(config.dataDir, 'workbench.sqlite'));
  store.recover();
  const gateway = await startGateway(config, store);
  const runner = new Runner(config, store, gateway);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const id = randomUUID();
    res.locals.requestId = id;
    res.set({ 'X-Request-ID': id, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    const host = req.get('Host') ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i.test(host)) {
      return next(new HttpError(403, 'HOST_DENIED', '请从本机地址访问工作台'));
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        (req.get('Sec-Fetch-Site') === 'cross-site' || (req.get('Origin') && req.get('Origin') !== `http://${host}`))) {
      return next(new HttpError(403, 'ORIGIN_DENIED', '浏览器写入请求必须来自工作台本身'));
    }
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    store.sql('SELECT 1 FROM sessions LIMIT 1').get();
    res.json({ status: 'ok' });
  });
  app.get('/api/sessions', (req, res) => {
    const before = cursor(req.query.before, '分页游标', Number.MAX_SAFE_INTEGER, 1);
    const limit = cursor(req.query.limit, '分页大小', 50, 1, 50);
    res.json(page(store.sessions(before, limit + 1), limit, 'cursor'));
  });
  app.post('/api/sessions', async (req, res) => {
    const title = input(req.body?.title ?? '新会话', 200, '会话名称');
    const id = randomUUID();
    try {
      await createWorkspace(config.dataDir, id);
      res.status(201).json(store.createSession(id, title));
    } catch (error) {
      await rm(sessionPaths(config.dataDir, id).root, { recursive: true, force: true });
      throw error;
    }
  });
  app.get('/api/sessions/:id', (req, res) => {
    const session = store.session(req.params.id);
    const before = cursor(req.query.before, '分页游标', Number.MAX_SAFE_INTEGER, 1);
    const limit = cursor(req.query.limit, '分页大小', 50, 1, 50);
    const history = page(store.messages(session.id, before, limit + 1), limit, 'id');
    const latestRun = store.latestRun(session.id);
    res.json({ session, messages: history.items.reverse(), nextCursor: history.nextCursor,
      latestRun, activeRun: latestRun && active(latestRun.status) ? latestRun : null });
  });
  app.post('/api/sessions/:id/messages', (req, res) => {
    const content = input(req.body?.content, 16384, '消息');
    const attachments = req.body?.attachments ?? [];
    if (!Array.isArray(attachments) || attachments.length > 10 ||
        attachments.some(path => typeof path !== 'string' || path.length > 512) ||
        new Set(attachments).size !== attachments.length) throw invalid('附件列表无效');
    const run = store.enqueue(req.params.id, content, attachments);
    res.status(202).json({ run, eventsUrl: `/api/runs/${run.id}/events` });
    runner.wake();
  });
  app.get('/api/runs/:id', (req, res) => {
    const run = store.run(req.params.id);
    res.json({ run, usage: store.usage(run.id) });
  });
  app.get('/api/runs/:id/events', (req, res) => {
    if (req.query.format !== 'json') return streamEvents(req, res, store);
    const run = store.run(req.params.id);
    const after = cursor(req.query.after, '事件游标', 0);
    const limit = cursor(req.query.limit, '分页大小', 50, 1, 100);
    res.json(page(store.events(run.id, after, limit + 1), limit, 'id'));
  });
  app.post('/api/runs/:id/cancel', (req, res) => {
    const run = runner.cancel(req.params.id);
    res.status(run.status === 'running' ? 202 : 200).json({ run });
  });

  app.get('/api/sessions/:id/files', async (req, res) => {
    const session = store.session(req.params.id);
    const from = cursor(req.query.cursor, '文件游标', 0, 0, 10000);
    const limit = cursor(req.query.limit, '分页大小', 50, 1, 50);
    res.json(await listFiles(config.dataDir, session.id, from, limit));
  });
  app.post('/api/sessions/:id/files', async (req, res) => {
    const session = store.session(req.params.id);
    res.status(201).json(await uploadFile(req, config, store, session.id));
  });
  app.get('/api/sessions/:id/files/download', async (req, res) => {
    const session = store.session(req.params.id);
    const file = await downloadFile(config.dataDir, session.id, req.query.path);
    res.attachment(file.name);
    res.type('application/octet-stream');
    res.set('Content-Length', String(file.size));
    if (req.method === 'HEAD' || file.size === 0) {
      await file.fd.close();
      res.end();
      return;
    }
    await pipeline(file.fd.createReadStream({ end: file.size - 1 }), res);
  });

  app.use(express.static(fileURLToPath(new URL('../dist/', import.meta.url)), { redirect: false }));
  app.use((_req, _res, next) => next(new HttpError(404, 'ROUTE_NOT_FOUND', '接口不存在')));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    let known = error instanceof HttpError ? error : null;
    if (!known && error.type === 'entity.parse.failed') known = invalid('JSON 格式无效');
    if (!known && error.type === 'entity.too.large') known = new HttpError(413, 'BODY_TOO_LARGE', '请求体过大');
    if (!known) console.error('请求失败', res.locals.requestId, error.code ?? error.name);
    res.status(known?.status ?? 500).json({ code: known?.code ?? 'INTERNAL_ERROR',
      message: known?.message ?? '服务处理失败', requestId: res.locals.requestId });
  });

  const server = app.listen(config.port, config.host);
  await once(server, 'listening');
  console.log(`Workbench API listening on ${config.host}:${config.port}`);
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    const timed = setTimeout(() => server.closeAllConnections(), 3000);
    timed.unref();
    const closed = once(server, 'close');
    server.close();
    try {
      await runner.shutdown();
      await closed;
    } finally {
      clearTimeout(timed);
      gateway.close();
      store.db.close();
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => shutdown().catch(error => {
      console.error('关闭服务失败', error.code ?? error.name);
      process.exitCode = 1;
    }));
  }
  runner.wake();
}

main().catch(error => {
  // 配置错误由本进程报告，避免输出可能含凭据的 URL 和异常对象。
  console.error('服务启动失败', /^(缺少配置|AGENT_|PORT)/.test(error.message) ? error.message : (error.code ?? error.name));
  process.exit(1);
});
