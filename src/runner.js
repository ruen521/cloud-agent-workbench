import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { parseAgentOutput } from './agent-output.js';
import { listFiles } from './files.js';
import { sessionPaths } from './workspace.js';

function terminate(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function prepare(config, task, lease) {
  const paths = sessionPaths(config.dataDir, task.session_id);
  await Promise.all([
    mkdir(join(paths.workspace, 'inputs'), { recursive: true }),
    mkdir(join(paths.workspace, 'outputs'), { recursive: true }),
    mkdir(paths.cliData, { recursive: true }),
  ]);
  const model = `workbench/${config.model}`;
  const agentConfig = {
    model, small_model: model, share: 'disabled', autoupdate: false,
    enabled_providers: ['workbench'],
    // 精简系统指令和工具定义，减少每一步重复发送的输入。保留开发和文件处理所需的工具。
    agent: {
      // 工作台自己管理标题，关闭 CLI 内置的逐消息标题生成。
      title: { disable: true },
      workbench: {
        mode: 'primary',
        steps: config.maxCallsPerRun,
        prompt: 'Work in the current session directory. User materials are in inputs/. Put requested deliverables in outputs/ unless asked otherwise. Use tools only when needed, verify changes, and report outcomes and limitations concisely in the user’s language.',
        permission: { question: 'deny', task: 'deny', webfetch: 'deny', websearch: 'deny',
          todowrite: 'deny', todoread: 'deny', skill: 'deny', codesearch: 'deny' },
      },
    },
    permission: { external_directory: 'deny' },
    provider: { workbench: {
      npm: '@ai-sdk/openai-compatible', name: 'Workbench',
      options: { baseURL: lease.url, apiKey: 'local-gateway' },
      models: { [config.model]: { name: config.model, tool_call: true } },
    } },
  };
  const environment = {
    PATH: [fileURLToPath(new URL('../node_modules/.bin', import.meta.url)), process.env.PATH].join(delimiter),
    HOME: paths.cliData,
    XDG_DATA_HOME: paths.cliData,
    XDG_CONFIG_HOME: paths.cliData,
    XDG_STATE_HOME: paths.cliData,
    XDG_CACHE_HOME: join(config.dataDir, 'cli-cache'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(agentConfig),
    OPENCODE_DISABLE_AUTOCOMPACT: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_SHARE: 'true',
    NO_COLOR: '1',
    LANG: 'C.UTF-8',
  };
  const args = ['run', '--format', 'json', '--agent', 'workbench', '--model', model];
  if (task.cli_session_id) args.push('--session', task.cli_session_id);
  else args.push('--title', 'Workbench session');
  const attachments = task.attachments.length ? `

Uploaded attachment paths: ${JSON.stringify(task.attachments)}` : '';
  args.push('--', task.content + attachments);
  return { args, environment, paths };
}

export class Runner {
  constructor(config, store, gateway) {
    this.config = config;
    this.store = store;
    this.gateway = gateway;
    this.current = null;
    this.stopping = false;
  }

  wake() {
    if (this.current || this.stopping) return;
    const task = this.store.claim();
    if (!task) return;
    const run = { id: task.id, requested: null };
    this.current = run;
    run.done = this.execute(task, run).catch(() => {
      this.store.finish(task.id, 'failed', { code: 'RUN_INTERNAL_ERROR' });
    }).catch(error => {
      console.error('无法保存任务终态', error.code ?? error.name);
      process.exitCode = 1;
      this.stopping = true;
      process.kill(process.pid, 'SIGTERM');
    }).finally(() => {
      this.current = null;
      this.wake();
    });
  }

  stop(run, status) {
    if (run.requested) return;
    run.requested = status;
    run.lease?.close();
    if (run.child) {
      // 结束整个进程组，确保 Agent 启动的脚本同样收到取消信号。
      terminate(run.child, 'SIGTERM');
      run.killTimer = setTimeout(() => terminate(run.child, 'SIGKILL'), 1500);
      run.killTimer.unref();
    }
  }

  cancel(id) {
    const run = this.store.run(id);
    if (run.status === 'queued') return this.store.finish(id, 'cancelled', { expected: 'queued' });
    if (this.current?.id === id) this.stop(this.current, 'cancelled');
    return this.store.run(id);
  }

  async shutdown() {
    this.stopping = true;
    if (!this.current) return;
    this.stop(this.current, 'interrupted');
    await this.current.done;
  }

  async execute(task, run) {
    const lease = this.gateway.open(task.id);
    run.lease = lease;
    let exitCode = null;
    let failure = null;
    const secrets = [this.config.key, lease.url, new URL(lease.url).pathname.slice(1)];
    const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[已隐藏]'), value);
    const parser = parseAgentOutput({
      workspace: sessionPaths(this.config.dataDir, task.session_id).workspace,
      onEvent: (type, payload) => this.store.append(task.id, type, payload),
      onSession: id => this.store.recordCliSession(task.session_id, id),
      redact,
    });
    const timeout = setTimeout(() => this.stop(run, 'timed_out'), this.config.timeoutMs);
    timeout.unref();
    let before;
    let artifacts;
    try {
      const { args, environment, paths } = await prepare(this.config, task, lease);
      if (!run.requested) before = await listFiles(this.config.dataDir, task.session_id, 0, 200);
      if (!run.requested) {
        // 明确列出子进程环境，只传本次任务的代理地址，模型 API 密钥留在服务端。
        const child = spawn(this.config.executable, args, {
          cwd: paths.workspace, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        run.child = child;
        const parse = action => {
          if (failure || run.requested) return;
          try { action(); } catch (error) {
            failure = ['AGENT_EVENT_LIMIT', 'AGENT_OUTPUT_INVALID', 'AGENT_OUTPUT_LIMIT',
              'STREAM_LINE_TOO_LARGE', 'CLI_SESSION_MISMATCH'].includes(error.message)
              ? error.message : 'AGENT_EVENT_PERSIST_FAILED';
            this.stop(run, 'failed');
          }
        };
        child.stdout.on('data', chunk => parse(() => parser.write(chunk)));
        child.stdout.once('end', () => parse(() => parser.finish()));
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
        exitCode = await new Promise(resolve => {
          child.once('error', () => { failure ??= 'AGENT_START_FAILED'; });
          child.once('close', resolve);
        });
        terminate(child, 'SIGKILL');
        if (exitCode !== 0 && task.cli_session_id && /session not found/i.test(stderr)) {
          failure ??= 'AGENT_SESSION_UNAVAILABLE';
        }
      }
    } finally {
      clearTimeout(timeout);
      clearTimeout(run.killTimer);
      lease.close();
    }

    if (before) {
      try {
        // 以磁盘快照确认每轮变更，也能捕获通过 Shell 生成的成果。
        const after = await listFiles(this.config.dataDir, task.session_id, 0, 200);
        const previous = new Map(before.items.map(file => [file.path, file]));
        const changes = after.items.filter(file => !file.path.startsWith('inputs/') &&
          (previous.get(file.path)?.modifiedAt !== file.modifiedAt ||
           previous.get(file.path)?.size !== file.size));
        artifacts = {
          items: changes.slice(0, 12),
          limited: changes.length > 12 || before.limited || after.limited ||
            before.nextCursor !== null || after.nextCursor !== null,
        };
      } catch {
        failure ??= 'ARTIFACT_SCAN_FAILED';
      }
    }
    const state = parser.output;
    const code = failure ?? lease.error ?? state.code ??
      (exitCode !== 0 ? 'AGENT_EXIT_NONZERO' : null) ??
      (!state.completed || !state.sessionId || !state.text.trim() ? 'AGENT_NO_VALID_OUTPUT' : null);
    const status = run.requested ?? (code ? 'failed' : 'succeeded');
    const statusCode = { timed_out: 'RUN_TIMEOUT', interrupted: 'SERVICE_STOPPED', cancelled: null };
    this.store.finish(task.id, status, {
      code: Object.hasOwn(statusCode, status) ? statusCode[status] : code,
      exitCode,
      text: state.text.trim() || null,
      artifacts,
    });
  }
}
