export const active = status => status === 'queued' || status === 'running';

export const statusLabels = {
  queued: '排队中', running: '运行中', succeeded: '已完成', failed: '执行失败',
  cancelled: '已取消', timed_out: '执行超时', interrupted: '已中断',
};

const errors = {
  MODEL_AUTH_FAILED: '模型凭据无效或已过期',
  MODEL_ACCESS_DENIED: '模型服务拒绝访问',
  MODEL_NOT_FOUND: '模型不可用',
  MODEL_RATE_LIMITED: '模型服务限流',
  MODEL_CONTEXT_LIMIT: '会话内容超出模型请求上限',
  MODEL_OUTPUT_LIMIT: '模型输出达到长度上限',
  MODEL_BUDGET_EXHAUSTED: '模型调用额度已用完',
  MODEL_STREAM_INCOMPLETE: '模型回复中途断开',
  MODEL_STREAM_INVALID: '模型回复格式异常',
  MODEL_UPSTREAM_FAILED: '模型服务暂不可用',
  AGENT_NO_VALID_OUTPUT: '助手未返回完整结果',
  AGENT_OUTPUT_INVALID: '助手输出格式异常',
  AGENT_SESSION_UNAVAILABLE: '原助手会话无法打开',
  ARTIFACT_SCAN_FAILED: '成果文件扫描失败',
  SERVICE_RESTARTED: '服务重启，正在执行的任务已中断',
  SERVICE_STOPPED: '服务关闭，任务已中断',
  RUN_TIMEOUT: '任务超过运行时限',
};

export const errorLabel = code => errors[code] ?? '助手执行遇到问题';

export async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message ?? '请求失败，请重试');
  }
  return response;
}

export async function json(path, options) {
  return (await request(path, options)).json();
}

export const post = (path, body) => json(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const sessionUrl = id => '/api/sessions/' + encodeURIComponent(id);
export const runUrl = id => '/api/runs/' + encodeURIComponent(id);
export const fileUrl = (id, path) => sessionUrl(id) + '/files/download?path=' + encodeURIComponent(path);

export function readSaved(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

export function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 会话仍由服务端持久化 */ }
}
