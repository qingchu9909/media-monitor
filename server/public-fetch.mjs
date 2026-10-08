import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TIMEOUT_MS = 20000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const addressHost = hostname => hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6) return false;
  // Accept global unicast only. This excludes local/link-local, mapped IPv4,
  // NAT64, multicast and unspecified addresses before any connection is made.
  const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  const [firstText, secondText = '0'] = normalized.split(':');
  const first = parseInt(firstText || '0', 16); const second = parseInt(secondText || '0', 16);
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && (second < 0x200 || second === 0xdb8)) return false;
  if (first === 0x2002 || (first === 0x3fff && second < 0x1000)) return false;
  return true;
}

export function validatePublicUrl(input) {
  if (typeof input !== 'string' || !input || input.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(input)) throw new Error('来源地址须为不含空白的公开 HTTPS URL（最多 2048 字符）');
  let url; try { url = new URL(input); } catch { throw new Error('来源地址无效'); }
  if (url.protocol !== 'https:' || !/^https:\/\//i.test(input) || url.username || url.password || (url.port && url.port !== '443') || url.hash) throw new Error('来源和重定向只允许无账户、无片段的标准 HTTPS 地址');
  const host = addressHost(url.hostname);
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host) || host === 'home.arpa' || host.endsWith('.home.arpa')) throw new Error('来源必须使用公开地址，不能访问本机或内网');
  if (isIP(host)) { if (!isPublicAddress(host)) throw new Error('来源必须使用公网 IP 地址'); }
  else if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host) || host.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) throw new Error('来源必须使用有效的公开域名');
  return url;
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

const isProxyFakeAddress = address => /^198\.(18|19)\.\d{1,3}\.\d{1,3}$/.test(address) || /^::ffff:0:c6(12|13):[0-9a-f]{1,4}$/i.test(address);

async function resolveProxyDns(host, signal, requestImpl) {
  // Local proxy DNS can synthesize benchmarking-range addresses. Never connect
  // to those addresses: ask Google Public DNS over hostname-verified TLS pinned
  // to its published public IP, then apply the same public-address policy.
  const dnsUrl = new URL(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`);
  const response = await requestPinned(dnsUrl, { address: '8.8.8.8', family: 4 }, signal, requestImpl);
  if (response.status !== 200) { await dispose(response.body); throw new Error('公开 DNS 验证失败，未访问代理合成地址'); }
  let value;
  try { value = JSON.parse(await readBounded(response, 65536, signal)); }
  catch (error) { if (signal.aborted) throw signal.reason; throw new Error('公开 DNS 返回无效，未访问代理合成地址'); }
  const answers = value.Status === 0 && Array.isArray(value.Answer) ? value.Answer.filter(answer => answer.type === 1) : [];
  if (!answers.length || answers.some(answer => isIP(answer.data) !== 4 || !isPublicAddress(answer.data))) throw new Error('公开 DNS 未确认公网地址，已拒绝访问');
  return answers.map(answer => ({ address: answer.data, family: 4 }));
}

async function resolvePublic(url, lookupImpl, signal, requestImpl) {
  const host = addressHost(url.hostname);
  if (isIP(host)) return { address: host, family: isIP(host) };
  let addresses;
  try { addresses = await abortable(lookupImpl(host, { all: true, verbatim: true }), signal); }
  catch (error) { if (signal.aborted) throw signal.reason; throw new Error('来源域名无法解析，请检查订阅地址或网络'); }
  if (Array.isArray(addresses) && addresses.length && addresses.every(entry => isProxyFakeAddress(entry.address))) addresses = await resolveProxyDns(host, signal, requestImpl);
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(entry => !isPublicAddress(entry.address) || isIP(entry.address) !== entry.family)) throw new Error('来源域名解析到非公网地址，已拒绝访问');
  return addresses.find(entry => entry.family === 4) ?? addresses[0];
}

function requestPinned(url, pin, signal, requestImpl) {
  return new Promise((resolve, reject) => {
    const hostname = addressHost(url.hostname);
    const request = requestImpl(url, {
      method: 'GET', agent: false, signal, family: pin.family,
      servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true,
      headers: { Accept: 'application/rss+xml, application/atom+xml, text/html, application/xml, text/plain;q=0.9', 'Accept-Encoding': 'identity', 'User-Agent': 'LocalMediaMonitor/1.0 (+local personal public reader)' },
      // No second DNS lookup: both single and all-address modes return only the
      // public address validated for this exact redirect hop. TLS still checks the hostname.
      lookup: (name, options, callback) => {
        if (addressHost(name) !== hostname) return callback(new Error('连接域名与已验证来源不一致'));
        if (options?.all) callback(null, [{ address: pin.address, family: pin.family }]);
        else callback(null, pin.address, pin.family);
      },
    }, response => resolve({ status: response.statusCode, headers: response.headers, body: response }));
    request.once('error', reject);
    request.end();
  });
}

function header(response, name) {
  const value = typeof response.headers?.get === 'function' ? response.headers.get(name) : response.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

async function dispose(body) {
  if (typeof body?.destroy === 'function') body.destroy();
  else if (typeof body?.cancel === 'function') await body.cancel().catch(() => {});
}

async function readBounded(response, maxBytes, signal) {
  if (Number(header(response, 'content-length') || 0) > maxBytes) { await dispose(response.body); throw new Error('来源响应超过大小限制（最多 5 MB）'); }
  const encoding = String(header(response, 'content-encoding') || 'identity').toLowerCase();
  if (encoding !== 'identity') { await dispose(response.body); throw new Error('来源未返回请求的未压缩文本，请使用标准 RSS / Atom 地址'); }
  if (!response.body) throw new Error('来源响应为空');
  const chunks = []; let size = 0;
  const abort = () => { void dispose(response.body); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of response.body) {
      if (signal.aborted) throw signal.reason;
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > maxBytes) throw new Error('来源响应超过大小限制（最多 5 MB）');
      chunks.push(bytes);
    }
    if (signal.aborted) throw signal.reason;
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal.removeEventListener('abort', abort); await dispose(response.body); }
}

export async function fetchPublicText(input, { lookupImpl = dnsLookup, requestImpl = httpsRequest, fetchImpl, timeoutMs = MAX_TIMEOUT_MS, maxBytes = MAX_BYTES, signal: callerSignal } = {}) {
  let url = validatePublicUrl(input);
  const controller = new AbortController();
  const duration = Math.max(1, Math.min(MAX_TIMEOUT_MS, Number(timeoutMs) || MAX_TIMEOUT_MS));
  const limit = Math.max(1, Math.min(MAX_BYTES, Number(maxBytes) || MAX_BYTES));
  const timer = setTimeout(() => { const error = new Error('网络请求超时'); error.name = 'TimeoutError'; controller.abort(error); }, duration);
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  try {
    for (let redirects = 0; redirects <= 4; redirects++) {
      // fetchImpl is the existing trusted, offline fixture adapter. It is never
      // accepted from HTTP input. Production always resolves and pins DNS below.
      const response = fetchImpl
        ? await abortable(fetchImpl(url.toString(), { redirect: 'manual', signal, headers: { Accept: 'application/rss+xml, application/atom+xml, text/html, application/xml, text/plain', 'Accept-Encoding': 'identity' } }), signal)
        : await requestPinned(url, await resolvePublic(url, lookupImpl, signal, requestImpl), signal, requestImpl);
      if (REDIRECTS.has(response.status)) {
        const location = header(response, 'location'); await dispose(response.body);
        if (!location) throw new Error('来源返回无效重定向');
        url = validatePublicUrl(new URL(location, url).toString());
        continue;
      }
      if (response.status < 200 || response.status >= 300) { await dispose(response.body); throw new Error(`HTTP ${response.status}`); }
      const text = await readBounded(response, limit, signal);
      return { text, url: url.toString(), contentType: String(header(response, 'content-type') || '').slice(0, 300) };
    }
    throw new Error('来源重定向次数超过限制');
  } catch (error) { if (signal.aborted) throw signal.reason; throw error; }
  finally { clearTimeout(timer); }
}
