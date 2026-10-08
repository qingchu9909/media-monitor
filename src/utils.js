export function formatDate(value, withTime = true) {
  if (!value) return '未提供时间';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(date).replaceAll('/', '-');
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    signal: options.signal || AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try { message = (await response.json()).error || message; } catch { /* Non-JSON server errors retain HTTP status. */ }
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}
