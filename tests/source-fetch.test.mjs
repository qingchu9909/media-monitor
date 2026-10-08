import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const api = await import('../server/public-fetch.mjs').catch(() => ({}));
const publicDNS = async () => [{ address: '93.184.215.14', family: 4 }];
function responseTransport(body = 'public text', { status = 200, headers = {}, inspect } = {}) {
  return (url, options, callback) => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      inspect?.(url, options);
      const response = Readable.from([Buffer.from(body)]);
      response.statusCode = status; response.headers = { 'content-type': 'text/plain', ...headers };
      callback(response);
    });
    request.destroy = error => request.emit('error', error);
    return request;
  };
}

test('public fetch rejects private, local and reserved IP forms before any connection', async () => {
  assert.equal(typeof api.fetchPublicText, 'function');
  for (const url of ['https://localhost/x', 'https://127.1/x', 'https://2130706433/x', 'https://0x7f000001/x', 'https://10.0.0.1/x', 'https://169.254.169.254/x', 'https://100.64.0.1/x', 'https://192.168.0.1/x', 'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://[fe80::1]/x', 'https://[fd00::1]/x']) {
    await assert.rejects(api.fetchPublicText(url, { lookupImpl: publicDNS, requestImpl: () => { throw new Error('MUST NOT CONNECT'); } }), /公开|公网|地址|localhost|HTTPS/);
  }
});

test('DNS must resolve exclusively to public addresses before making a request', async () => {
  assert.equal(typeof api.fetchPublicText, 'function');
  for (const addresses of [[{ address: '10.1.2.3', family: 4 }], [{ address: '93.184.215.14', family: 4 }, { address: '127.0.0.1', family: 4 }], [{ address: 'fd00::1', family: 6 }]]) {
    await assert.rejects(api.fetchPublicText('https://news.example/feed', { lookupImpl: async () => addresses, requestImpl: () => { throw new Error('MUST NOT CONNECT'); } }), /公网|公开|地址/);
  }
});

test('HTTPS lookup pins the validated address instead of resolving DNS again at connection time', async () => {
  assert.equal(typeof api.fetchPublicText, 'function');
  let calls = 0; let pinned;
  const result = await api.fetchPublicText('https://news.example/feed?b=2&a=1', {
    lookupImpl: async () => { calls++; return [{ address: calls === 1 ? '93.184.215.14' : '127.0.0.1', family: 4 }]; },
    requestImpl: responseTransport('verified content', { inspect: (url, options) => {
      options.lookup('news.example', {}, (error, address, family) => { assert.equal(error, null); pinned = { address, family }; });
      assert.equal(options.servername, 'news.example');
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.agent, false);
    } }),
  });
  assert.equal(calls, 1);
  assert.deepEqual(pinned, { address: '93.184.215.14', family: 4 });
  assert.equal(result.text, 'verified content');
  assert.equal(result.url, 'https://news.example/feed?b=2&a=1');
  assert.equal(result.contentType, 'text/plain');
});

test('every redirect validates its destination and refuses a DNS-private target', async () => {
  assert.equal(typeof api.fetchPublicText, 'function');
  let requests = 0;
  await assert.rejects(api.fetchPublicText('https://news.example/feed', {
    lookupImpl: async host => [{ address: host === 'news.example' ? '93.184.215.14' : '10.0.0.1', family: 4 }],
    requestImpl: (...args) => { requests++; return responseTransport('', { status: 302, headers: { location: 'https://internal.example/private' } })(...args); },
  }), /公网|公开|地址/);
  assert.equal(requests, 1);
});

test('responses exceeding the byte limit fail instead of returning truncated content', async () => {
  assert.equal(typeof api.fetchPublicText, 'function');
  await assert.rejects(api.fetchPublicText('https://news.example/feed', { lookupImpl: publicDNS, maxBytes: 4, requestImpl: responseTransport('too many bytes') }), /超过|限制/);
  await assert.rejects(api.fetchPublicText('https://news.example/feed', { lookupImpl: publicDNS, maxBytes: 4, requestImpl: responseTransport('', { headers: { 'content-length': '20' } }) }), /超过|限制/);
});

test('the deadline includes DNS resolution, not only response transfer', async () => {
  assert.equal(typeof api.fetchPublicText, 'function');
  await assert.rejects(api.fetchPublicText('https://news.example/feed', { timeoutMs: 15, lookupImpl: () => new Promise(() => {}), requestImpl: () => { throw new Error('MUST NOT CONNECT'); } }), /超时/);
});

test('proxy Fake-IP DNS is replaced with independently resolved public DNS and never connected directly', async () => {
  const connections = [];
  const result = await api.fetchPublicText('https://news.example/feed', {
    lookupImpl: async () => [{ address: '198.18.0.91', family: 4 }, { address: '::ffff:0:c612:5b', family: 6 }],
    requestImpl: (url, options, callback) => {
      options.lookup(url.hostname, {}, (error, address) => { assert.equal(error, null); connections.push({ host: url.hostname, address }); });
      const body = url.hostname === 'dns.google'
        ? JSON.stringify({ Status: 0, Answer: [{ name: 'news.example.', type: 1, data: '93.184.215.14' }] })
        : 'resolved safely';
      return responseTransport(body)(url, options, callback);
    },
  });
  assert.equal(result.text, 'resolved safely');
  assert.deepEqual(connections, [{ host: 'dns.google', address: '8.8.8.8' }, { host: 'news.example', address: '93.184.215.14' }]);
});

test('proxy DNS fallback rejects a private answer without contacting the target', async () => {
  let requests = 0;
  await assert.rejects(api.fetchPublicText('https://news.example/feed', {
    lookupImpl: async () => [{ address: '198.18.0.91', family: 4 }],
    requestImpl: (url, options, callback) => {
      requests++; assert.equal(url.hostname, 'dns.google');
      return responseTransport(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }] }))(url, options, callback);
    },
  }), /公网|拒绝/);
  assert.equal(requests, 1);
});

test('redirect loops stop after four hops and a caller cannot raise the 5 MB ceiling', async () => {
  let requests = 0;
  await assert.rejects(api.fetchPublicText('https://news.example/feed', {
    lookupImpl: publicDNS,
    requestImpl: (...args) => { requests++; return responseTransport('', { status: 302, headers: { location: '/again' } })(...args); },
  }), /重定向次数/);
  assert.equal(requests, 5);
  await assert.rejects(api.fetchPublicText('https://news.example/feed', { lookupImpl: publicDNS, maxBytes: 999999999, requestImpl: responseTransport('', { headers: { 'content-length': String(5 * 1024 * 1024 + 1) } }) }), /超过|限制/);
});

test('a stalled response stream is stopped by the total request deadline', async () => {
  await assert.rejects(api.fetchPublicText('https://news.example/feed', {
    lookupImpl: publicDNS, timeoutMs: 15,
    requestImpl: (url, options, callback) => {
      const request = new EventEmitter();
      request.end = () => { const body = new Readable({ read() {} }); body.statusCode = 200; body.headers = {}; callback(body); };
      return request;
    },
  }), /超时/);
});
