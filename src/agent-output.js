import { readLines } from './lines.js';

export function parseAgentOutput({ onEvent, onSession, redact }) {
  const output = { text: '', code: null, completed: false, sessionId: null };
  let eventCount = 0;

  // 只发布稳定的业务字段。工具参数、完整输出和模型思考内容不进入浏览器事件。
  const reader = readLines(line => {
    if (!line) return;
    if (++eventCount > 1000) throw new Error('AGENT_EVENT_LIMIT');
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('AGENT_OUTPUT_INVALID'); }
    if (!event || typeof event.type !== 'string') throw new Error('AGENT_OUTPUT_INVALID');
    if (event.sessionID !== undefined) {
      if (typeof event.sessionID !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(event.sessionID)) {
        throw new Error('AGENT_OUTPUT_INVALID');
      }
      if (output.sessionId && output.sessionId !== event.sessionID) throw new Error('CLI_SESSION_MISMATCH');
      if (!output.sessionId) {
        onSession(event.sessionID);
        output.sessionId = event.sessionID;
      }
    }

    const part = event.part;
    switch (event.type) {
      case 'step_start':
        output.completed = false;
        onEvent('step', { status: 'started' });
        break;
      case 'step_finish': {
        const reason = typeof part?.reason === 'string' ? redact(part.reason).slice(0, 60) : null;
        output.completed = reason === 'stop';
        if (reason === 'length') output.code = 'MODEL_OUTPUT_LIMIT';
        onEvent('step', { status: 'finished', reason });
        break;
      }
      case 'tool_use': {
        const tool = typeof part?.tool === 'string' ? redact(part.tool).slice(0, 80) : 'unknown';
        const status = part?.state?.status === 'error' ? 'failed' : 'completed';
        onEvent('tool', { tool, status });
        break;
      }
      case 'text': {
        if (typeof part?.text !== 'string') throw new Error('AGENT_OUTPUT_INVALID');
        const text = redact(part.text);
        if (output.text.length + text.length > 65536) throw new Error('AGENT_OUTPUT_LIMIT');
        output.text += (output.text ? '\n\n' : '') + text;
        onEvent('text', { text });
        break;
      }
      case 'error':
        output.code ??= 'AGENT_EXECUTION_FAILED';
        onEvent('error', { code: output.code });
        break;
    }
  }, 1024 * 1024);

  return { output, ...reader };
}
