import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`缺少配置 ${name}`);
  return value;
}

function integer(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const base = new URL(required(env, 'AGENT_API_BASE_URL'));
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(loopback && base.protocol === 'http:')) ||
      base.username || base.password || base.search || base.hash) {
    throw new Error('AGENT_API_BASE_URL 须为 HTTPS 基地址，允许本地 HTTP 联调');
  }
  return {
    upstream: new URL(`${base.href.replace(/\/+$/, '')}/chat/completions`),
    key: required(env, 'AGENT_API_KEY'),
    model: required(env, 'AGENT_MODEL'),
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    host: env.HOST ?? '127.0.0.1',
    port: integer(env, 'PORT', 3000, 1, 65535),
    executable: env.AGENT_EXECUTABLE || fileURLToPath(new URL('../node_modules/.bin/opencode', import.meta.url)),
    maxCallsPerRun: integer(env, 'AGENT_MAX_CALLS_PER_RUN', 12, 1, 60),
    maxCallsPerDay: integer(env, 'AGENT_MAX_CALLS_PER_DAY', 120, 1, 10000),
    maxPromptBytes: integer(env, 'AGENT_MAX_PROMPT_BYTES', 524288, 16384, 2097152),
    maxOutputTokens: integer(env, 'AGENT_MAX_OUTPUT_TOKENS', 4096, 256, 32768),
    minRequestIntervalMs: integer(env, 'AGENT_MIN_REQUEST_INTERVAL_MS', 1500, 0, 60000),
    timeoutMs: integer(env, 'AGENT_RUN_TIMEOUT_MS', 300000, 1000, 900000),
  };
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
