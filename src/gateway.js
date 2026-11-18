import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { readLines } from './lines.js';

const upstreamErrors = {
  401: 'MODEL_AUTH_FAILED', 403: 'MODEL_ACCESS_DENIED', 404: 'MODEL_NOT_FOUND',
  429: 'MODEL_RATE_LIMITED',
};

function sendError(res, status, code) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { type: code, code, message: code } }));
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function forwardStream(config, store, response, res, id, signal) {
  let usage;
  let finished = false;
  const tap = readLines(line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      finished = true;
      return;
    }
    const frame = JSON.parse(data);
    if (!frame || typeof frame !== 'object' || frame.error) throw new Error('MODEL_STREAM_INVALID');
    if (Array.isArray(frame.choices) && frame.choices.some(choice => choice?.finish_reason)) finished = true;
    const value = frame.usage;
    const valid = n => Number.isSafeInteger(n) && n >= 0;
    if (value && valid(value.prompt_tokens) && valid(value.completion_tokens) && valid(value.total_tokens)) {
      usage = { promptTokens: value.prompt_tokens, completionTokens: value.completion_tokens,
        totalTokens: value.total_tokens };
    }
  }, config.maxPromptBytes);
  let received = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > 4 * 1024 * 1024) return callback(new Error('MODEL_STREAM_TOO_LARGE'));
      try { tap.write(chunk); } catch (error) { return callback(error); }
      callback(null, chunk);
    },
    flush(callback) {
      try {
        tap.finish();
        if (usage) store.recordUsage(id, usage);
        if (!finished) throw new Error('MODEL_STREAM_INCOMPLETE');
        callback();
      } catch (error) { callback(error); }
    },
  });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  return pipeline(Readable.fromWeb(response.body), stream, res, { signal });
}

export async function startGateway(config, store) {
  let active;
  let nextRequestAt = 0;
  const server = createServer(async (req, res) => {
    const run = active;
    if (!run || req.method !== 'POST' || req.url !== `/${run.token}/chat/completions`) {
      sendError(res, 404, 'ROUTE_NOT_FOUND');
      return;
    }
    if (run.error || run.controller.signal.aborted) {
      sendError(res, 400, run.error ?? 'RUN_CLOSED');
      return;
    }
    const fail = (status, code) => {
      run.error ??= code;
      if (!res.headersSent && !res.destroyed) sendError(res, status, code);
      else if (!res.destroyed) res.destroy();
    };
    const request = new AbortController();
    const signal = AbortSignal.any([run.controller.signal, request.signal]);
    res.once('close', () => { if (!res.writableFinished) request.abort(); });
    try {
      const body = await readBody(req, config.maxPromptBytes);
      if (run.error || signal.aborted) {
        if (!res.destroyed && !res.headersSent) sendError(res, 400, run.error ?? 'RUN_CLOSED');
        return;
      }
      if (!body) return fail(400, 'MODEL_CONTEXT_LIMIT');
      let input;
      try { input = JSON.parse(body); } catch { return fail(400, 'MODEL_REQUEST_INVALID'); }
      if (input?.model !== config.model || input.stream !== true || !Array.isArray(input.messages)) {
        return fail(400, 'MODEL_REQUEST_INVALID');
      }

      // 多个工具步骤可能连续触发模型请求。按全局间隔出站，避免瞬时请求扎堆。
      const slot = Math.max(Date.now(), nextRequestAt);
      nextRequestAt = slot + config.minRequestIntervalMs;
      if (slot > Date.now()) await wait(slot - Date.now(), undefined, { signal });
      if (run.error) return fail(400, run.error);

      // 每个实际发送的请求都先占用配额。上游报错后拒绝 CLI 重试，避免重复扣费。
      const id = store.reserveCall(run.id, config.maxCallsPerRun, config.maxCallsPerDay);
      if (id === null) return fail(400, 'MODEL_BUDGET_EXHAUSTED');
      const requested = input.max_completion_tokens ?? input.max_tokens;
      input.max_tokens = Number.isSafeInteger(requested) && requested > 0
        ? Math.min(requested, config.maxOutputTokens) : config.maxOutputTokens;
      delete input.max_completion_tokens;
      input.n = 1;
      input.stream_options = { include_usage: true };

      const response = await fetch(config.upstream, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        redirect: 'error',
        signal,
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel();
        return fail(400, upstreamErrors[response.status] ?? 'MODEL_UPSTREAM_FAILED');
      }
      await forwardStream(config, store, response, res, id, signal);
    } catch (error) {
      if (run.controller.signal.aborted) return;
      if (error instanceof SyntaxError || error.message === 'STREAM_LINE_TOO_LARGE') {
        fail(400, 'MODEL_STREAM_INVALID');
      } else if (['MODEL_STREAM_TOO_LARGE', 'MODEL_STREAM_INCOMPLETE', 'MODEL_STREAM_INVALID'].includes(error.message)) {
        fail(400, error.message);
      } else if (!request.signal.aborted) {
        fail(400, 'MODEL_UPSTREAM_FAILED');
      }
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = `http://127.0.0.1:${server.address().port}`;
  return {
    open(runId) {
      const run = { id: runId, token: randomBytes(24).toString('hex'), controller: new AbortController(), error: null };
      active = run;
      return {
        url: `${address}/${run.token}`,
        get error() { return run.error; },
        close() {
          if (active === run) active = null;
          run.controller.abort();
        },
      };
    },
    close() { server.close(); },
  };
}
