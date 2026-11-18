import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseAgentOutput } from '../src/agent-output.js';
import { createWorkspace, downloadFile, listFiles } from '../src/files.js';
import { startGateway } from '../src/gateway.js';
import { Runner } from '../src/runner.js';
import { sessionPaths } from '../src/workspace.js';
import { Store } from '../src/store.js';

test('JSONL 处理分块中文，忽略隐私字段并识别无效输出', () => {
  const events = [];
  const sessions = [];
  const parser = parseAgentOutput({
    onEvent: (type, payload) => events.push({ type, payload }),
    onSession: id => sessions.push(id),
    redact: text => text.replaceAll('fixture-key', '[已隐藏]'),
  });
  const line = (type, part) => JSON.stringify({ type, part, sessionID: 'ses_fixture' });
  const raw = Buffer.from([
    line('step_start'), line('tool_use', { tool: 'read', state: { status: 'completed', output: '私人材料' } }),
    line('text', { text: '执行成功 fixture-key' }), line('step_finish', { reason: 'stop' }),
  ].join('\n'));
  for (const byte of raw) parser.write(Buffer.from([byte]));
  parser.finish();
  assert.deepEqual(sessions, ['ses_fixture']);
  assert.equal(parser.output.text, '执行成功 [已隐藏]');
  assert.equal(parser.output.completed, true);
  assert.deepEqual(events.find(event => event.type === 'tool').payload, { tool: 'read', status: 'completed' });
  assert.throws(() => parser.write(Buffer.from('unexpected output\n')), /AGENT_OUTPUT_INVALID/);
});

test('同会话只接纳一个任务，重启恢复排队，不自动重放运行中任务', () => {
  const store = new Store(':memory:');
  try {
    store.createSession('s1', 'A');
    store.createSession('s2', 'B');
    const first = store.enqueue('s1', 'hello');
    const second = store.enqueue('s2', 'world');
    assert.throws(() => store.enqueue('s1', 'duplicate'), { code: 'SESSION_BUSY' });
    assert.equal(store.claim().id, first.id);
    assert.equal(store.claim(), null);
    store.recover();
    assert.equal(store.run(first.id).status, 'interrupted');
    assert.equal(store.claim().id, second.id);
    store.finish(second.id, 'succeeded', { text: 'done' });
    const events = store.events(second.id, 0, 50);
    assert.deepEqual(events.map(event => event.payload.status), ['queued', 'running', 'succeeded']);
    assert.equal(store.events(second.id, events[1].id, 50).length, 1);
    assert.equal(store.messages('s2', Number.MAX_SAFE_INTEGER, 10)[0].content, 'done');
  } finally {
    store.db.close();
  }
});

test('模型代理限额在出站前生效，SSE 用量写入 SQLite', async () => {
  let forwarded = 0;
  let maxTokens;
  let usageRequested;
  const upstream = createServer(async (req, res) => {
    forwarded++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    maxTokens = input.max_tokens;
    usageRequested = input.stream_options.include_usage;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const store = new Store(':memory:');
  const gateway = await startGateway({
    upstream: new URL(`http://127.0.0.1:${upstream.address().port}`), model: 'test', key: 'fixture-key',
    maxCallsPerRun: 1, maxCallsPerDay: 2, maxPromptBytes: 16384, maxOutputTokens: 256,
    minRequestIntervalMs: 0,
  }, store);
  try {
    store.createSession('s1', 'A');
    const run = store.enqueue('s1', 'hello');
    const lease = gateway.open(run.id);
    const call = () => fetch(`${lease.url}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'test', stream: true, messages: [], max_tokens: 900 }),
    });
    const result = await call();
    assert.equal(result.status, 200);
    assert.match(await result.text(), /DONE/);
    assert.equal(maxTokens, 256);
    assert.equal(usageRequested, true);
    const rejected = await call();
    assert.equal((await rejected.json()).error.code, 'MODEL_BUDGET_EXHAUSTED');
    assert.equal(lease.error, 'MODEL_BUDGET_EXHAUSTED');
    assert.equal(forwarded, 1);
    assert.deepEqual({ ...store.usage(run.id) }, {
      calls: 1, callsWithUsage: 1, promptTokens: 4, completionTokens: 3, totalTokens: 7,
    });
    assert.equal(store.reserveCall(run.id, 2, 2) !== null, true);
    assert.equal(store.reserveCall(run.id, 3, 2), null);
    lease.close();
  } finally {
    gateway.close();
    upstream.close();
    store.db.close();
  }
});

test('文件列表与下载拒绝路径穿越和中间目录符号链接', async () => {
  const data = await mkdtemp(join(tmpdir(), 'workbench-test-'));
  try {
    await createWorkspace(data, 's1');
    const { workspace } = sessionPaths(data, 's1');
    await writeFile(join(data, 'private.txt'), 'private');
    await writeFile(join(workspace, 'outputs', 'report.md'), 'ok');
    await symlink(data, join(workspace, 'escape'));
    await symlink(join(data, 'private.txt'), join(workspace, 'outputs', 'link'));
    assert.deepEqual((await listFiles(data, 's1', 0, 50)).items.map(file => file.path), ['outputs/report.md']);
    await assert.rejects(downloadFile(data, 's1', 'escape/private.txt'), { code: 'FILE_NOT_FOUND' });
    await assert.rejects(downloadFile(data, 's1', 'outputs/link'), { code: 'FILE_NOT_FOUND' });
    await assert.rejects(downloadFile(data, 's1', '../private.txt'), { code: 'FILE_NOT_FOUND' });
    const report = await downloadFile(data, 's1', 'outputs/report.md');
    try { assert.equal(await report.fd.readFile('utf8'), 'ok'); } finally { await report.fd.close(); }
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('CLI 空输出判失败，运行中任务可取消', async () => {
  const data = await mkdtemp(join(tmpdir(), 'workbench-runner-'));
  const store = new Store(':memory:');
  const executable = join(data, 'fixture');
  const gateway = { open: () => ({ url: 'http://127.0.0.1:1/local-lease', close() {} }) };
  const runner = new Runner({ dataDir: data, executable, key: 'fixture-key', model: 'test',
    timeoutMs: 5000, maxCallsPerRun: 2 }, store, gateway);
  try {
    await writeFile(executable, '#!/bin/sh\nfor arg do last="$arg"; done\nif [ "$last" = wait ]; then sleep 5; fi\n', { mode: 0o700 });
    store.createSession('s1', 'A');
    const empty = store.enqueue('s1', 'empty');
    runner.wake();
    await runner.current.done;
    assert.equal(store.run(empty.id).status, 'failed');
    assert.equal(store.run(empty.id).error_code, 'AGENT_NO_VALID_OUTPUT');

    const pending = store.enqueue('s1', 'wait');
    runner.wake();
    const current = runner.current;
    for (let attempts = 0; !current.child?.pid && attempts < 50; attempts++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(current.child?.pid);
    runner.cancel(pending.id);
    await current.done;
    assert.equal(store.run(pending.id).status, 'cancelled');
  } finally {
    await runner.shutdown();
    store.db.close();
    await rm(data, { recursive: true, force: true });
  }
});

test('上游限流和不完整的流显式失败，限流后重试不会出站', async () => {
  let calls = 0;
  const upstream = createServer((_req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(429).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const store = new Store(':memory:');
  const gateway = await startGateway({
    upstream: new URL(`http://127.0.0.1:${upstream.address().port}`), model: 'test', key: 'fixture-key',
    maxCallsPerRun: 3, maxCallsPerDay: 5, maxPromptBytes: 16384, maxOutputTokens: 256,
    minRequestIntervalMs: 0,
  }, store);
  const send = lease => fetch(`${lease.url}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
  });
  try {
    store.createSession('s1', 'A');
    const run = store.enqueue('s1', 'hello');
    const rateLimited = gateway.open(run.id);
    assert.equal((await (await send(rateLimited)).json()).error.code, 'MODEL_RATE_LIMITED');
    assert.equal((await (await send(rateLimited)).json()).error.code, 'MODEL_RATE_LIMITED');
    assert.equal(calls, 1);
    rateLimited.close();

    const truncated = gateway.open(run.id);
    await assert.rejects(async () => (await send(truncated)).text());
    assert.equal(truncated.error, 'MODEL_STREAM_INCOMPLETE');
    assert.equal(calls, 2);
    truncated.close();
  } finally {
    gateway.close();
    upstream.close();
    store.db.close();
  }
});

test('上传附件随消息持久化，跨会话引用在事务中拒绝', () => {
  const store = new Store(':memory:');
  try {
    store.createSession('s1', 'A');
    store.createSession('s2', 'B');
    const path = 'inputs/fixture-会议纪要.txt';
    store.recordUpload('upload1', 's1', path, '会议纪要.txt', 10);
    assert.throws(() => store.enqueue('s2', '跨会话', [path]), { code: 'ATTACHMENT_NOT_FOUND' });
    assert.equal(store.messages('s2', Number.MAX_SAFE_INTEGER, 20).length, 0);
    assert.equal(store.latestRun('s2'), null);
    const run = store.enqueue('s1', '读附件', [path]);
    assert.deepEqual(store.claim().attachments, [path]);
    store.finish(run.id, 'succeeded', { text: '完成', artifacts: { items: [{ path: 'outputs/report.md' }], limited: false } });
    const message = store.messages('s1', Number.MAX_SAFE_INTEGER, 20).find(row => row.role === 'user');
    assert.deepEqual(message.attachments, [{ path, name: '会议纪要.txt' }]);
    assert.equal(message.artifacts.items[0].path, 'outputs/report.md');
  } finally {
    store.db.close();
  }
});

test('工具事件只展示工作目录相对路径及受控测试结果', () => {
  const observed = [];
  const parser = parseAgentOutput({ workspace: '/workspace', redact: text => text,
    onSession() {}, onEvent(_type, payload) { observed.push(payload); } });
  for (const [tool, state] of [
    ['write', { status: 'completed', input: { filePath: '/workspace/outputs/tool.py', content: 'secret' } }],
    ['read', { status: 'completed', input: { filePath: '/workspace/../other.txt' } }],
    ['bash', { status: 'completed', metadata: { exit: 1, output: 'raw run output' } }],
    ['bash', { status: 'completed', metadata: { exit: 0, output: 'Ran 3 tests in 0.001s\n\nOK\n' } }],
  ]) {
    parser.write(Buffer.from(JSON.stringify({ type: 'tool_use', part: { tool, state } }) + '\n'));
  }
  assert.deepEqual(observed, [
    { tool: 'write', status: 'completed', path: 'outputs/tool.py' },
    { tool: 'read', status: 'completed' },
    { tool: 'bash', status: 'failed', exitCode: 1 },
    { tool: 'bash', status: 'completed', exitCode: 0, testsPassed: 3 },
  ]);
});

test('历史消息和浏览器均只把最后成功步骤的文字作为答复', async () => {
  const { summarizeTurn } = await import('../frontend/src/turn-events.js');
  const store = new Store(':memory:');
  try {
    store.createSession('s1', '任务');
    const run = store.enqueue('s1', '生成报告');
    store.claim();
    const parser = parseAgentOutput({ redact: value => value, onSession() {},
      onEvent(type, payload) { store.append(run.id, type, payload); } });
    for (const [type, part] of [
      ['step_start'], ['text', { text: '我先检查材料。' }], ['tool_use', { tool: 'read' }],
      ['step_finish', { reason: 'tool-calls' }], ['step_start'],
      ['text', { text: '报告已生成。' }], ['text', { text: '已核对负责人。' }],
      ['step_finish', { reason: 'stop' }],
    ]) {
      parser.write(Buffer.from(JSON.stringify({ type, part, sessionID: 'ses_fixture' }) + '\n'));
    }
    assert.equal(parser.output.finalText, '报告已生成。\n\n已核对负责人。');
    const events = store.events(run.id, 0, 50);
    assert.equal(summarizeTurn(events, 'running').finalText, '');
    assert.equal(summarizeTurn(events, 'failed').finalText, '');
    const view = summarizeTurn(events, 'succeeded');
    assert.equal(view.finalText, parser.output.finalText);
    assert.deepEqual(view.progress.map(event => event.type), ['text', 'tool']);
    // 模拟上一版已保存的答复，验证折叠进展时历史仍可显示干净的结论。
    store.finish(run.id, 'succeeded', { text: parser.output.text });
    const reply = store.messages('s1', Number.MAX_SAFE_INTEGER, 20).find(row => row.role === 'assistant');
    assert.equal(reply.content, view.finalText);
  } finally {
    store.db.close();
  }
});
