import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import * as storeModule from '../server/store.mjs';
import * as collectorModule from '../server/collector.mjs';
import * as reportModule from '../server/report.mjs';
import * as serverModule from '../server/main.mjs';

const modules = [storeModule, collectorModule, reportModule, serverModule];

async function fixture(t) {
  assert.equal(typeof modules[0]?.openStore, 'function', 'SQLite storage must exist');
  const dir = await mkdtemp(join(tmpdir(), 'media-monitor-'));
  const store = modules[0].openStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, dir };
}

const rss = (url, title = 'OpenAI agent research') => `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title><item><title>${title}</title><link>${url.replaceAll('&', '&amp;')}</link><description><![CDATA[<p>A paper on AI agents</p><script>alert('bad')</script>]]></description><pubDate>Fri, 11 Sep 2026 01:00:00 GMT</pubDate></item></channel></rss>`;

test('canonical URLs merge across sources, retain topic matches and persist bookmarks', async t => {
  const { store, dir } = await fixture(t);
  const topic = store.createTopic({ name: '智能体观察', keywords: ['agent'] });
  const sources = store.listSources().filter(x => x.kind === 'rss');
  store.upsertItems(sources[0].id, [{ title: 'OpenAI agent research', url: 'https://example.org/story?utm_source=x&b=2&a=1#read', summary: 'AI research', publishedAt: '2026-09-11T01:00:00Z' }]);
  store.upsertItems(sources[1].id, [{ title: 'OpenAI agent research', url: 'https://example.org/story?a=1&b=2', summary: 'AI research' }]);
  let items = store.listItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://example.org/story?a=1&b=2');
  assert.ok(items[0].topicIds.includes(topic.id));
  assert.ok(items[0].topicIds.length >= 2);
  assert.equal(items[0].sourceIds.length, 2);
  store.setStarred(items[0].id, true);
  store.close();
  const reopened = modules[0].openStore(dir);
  t.after(() => reopened.close());
  assert.equal(reopened.listItems()[0].starred, true);
  reopened.updateTopic(topic.id, { keywords: ['不匹配的关键词'] });
  assert.equal(reopened.listItems()[0].topicIds.includes(topic.id), false);
});

test('RSS collection isolates source failures, caps concurrency and reports truthful duplicate counts', async t => {
  const { store } = await fixture(t);
  assert.equal(typeof modules[1]?.collect, 'function');
  let active = 0;
  let peak = 0;
  const fetchImpl = async url => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--;
    if (String(url).includes('github.blog')) return new Response('unavailable', { status: 503 });
    return new Response(rss(`https://example.org/${new URL(url).hostname}`), { status: 200 });
  };
  const run = await modules[1].collect(store, { fetchImpl });
  assert.equal(peak, 3);
  assert.equal(run.status, 'partial');
  assert.equal(run.inserted, 3);
  assert.equal(store.listItems().length, 3);
  assert.equal(store.listSources().find(x => x.url.includes('github.blog')).status, 'error');
  assert.equal(store.listRuns().length, 1);
  assert.ok(!store.listItems()[0].summary.includes('alert'));
  const second = await modules[1].collect(store, { fetchImpl });
  assert.equal(second.inserted, 0);
  assert.equal(store.listItems().length, 3);
  const report = modules[2].renderReport(store, { now: new Date('2026-09-11T02:00:00Z') });
  assert.match(report, /规则/);
  assert.match(report, /不是 AI 分析|非 AI 分析/);
  assert.match(report, /GitHub/);
  assert.match(report, /失败|失效/);
  assert.match(report, /https:\/\/example.org/);
  assert.match(report, /发布时间/);
});

test('feed validation rejects private redirects, unsafe item links and malformed documents', async t => {
  await fixture(t);
  const { fetchFeed, parseFeed } = modules[1] ?? {};
  assert.equal(typeof fetchFeed, 'function');
  await assert.rejects(fetchFeed('https://openai.com/news/rss.xml', {
    fetchImpl: async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1:9000/private' } }),
  }), /HTTPS|允许|来源|redirect/i);
  await assert.rejects(fetchFeed('https://127.0.0.1/rss', { fetchImpl: async () => { throw new Error('must not fetch'); } }), /允许|来源|地址/);
  const result = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Good</title><link rel="alternate" href="https://example.org/good"/><summary>&lt;b&gt;safe&lt;/b&gt;</summary><updated>2026-09-11T00:00:00Z</updated></entry><entry><title>Bad</title><link href="javascript:alert(1)"/></entry></feed>`);
  assert.equal(result.length, 1);
  assert.equal(result[0].summary, 'safe');
  assert.throws(() => parseFeed('<html>not a feed</html>'), /RSS|Atom|feed/i);
  assert.throws(() => parseFeed('<rss><channel>'), /XML|RSS|feed/i);
  assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY x "untrusted">]><rss><channel><title>&x;</title></channel></rss>'), /XML|RSS|feed/i);
  const cdata = parseFeed('<rss><channel><item><title>GitHub article</title><link>https://github.blog/example/</link><description><![CDATA[<!DOCTYPE html><html><body><p>Readable article</p></body></html>]]></description></item></channel></rss>');
  assert.equal(cdata[0].summary, 'Readable article');
});

function request(port, path, { method = 'GET', headers = {}, body, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      let text = ''; res.on('data', x => { text += x; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject); if (chunked) { req.write(body); req.end(); } else req.end(body);
  });
}

test('HTTP boundaries reject hostile origins, oversized JSON, malformed input and traversal', async t => {
  const { store, dir } = await fixture(t);
  assert.equal(typeof modules[3]?.startServer, 'function');
  const distDir = join(dir, 'dist'); await mkdir(distDir); await writeFile(join(distDir, 'index.html'), '<main>Monitor</main>');
  await writeFile(join(dir, 'secret.txt'), 'PRIVATE');
  const server = await modules[3].startServer({ store, port: 0, distDir, projectDir: dir, homeDir: dir });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  assert.equal(server.address().address, '127.0.0.1');
  assert.equal((await request(port, '/api/health')).status, 200);
  assert.equal(JSON.parse((await request(port, '/api/health')).text).app, 'qingchu-media-monitor');
  assert.equal((await request(port, '/api/state', { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal((await request(port, '/api/topics', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ name: 'bad', keywords: ['bad'] }) })).status, 403);
  assert.equal((await request(port, '/api/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await request(port, '/api/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(70000), keywords: [] }) })).status, 413);
  assert.equal((await request(port, '/api/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(70000), keywords: [] }), chunked: true })).status, 413);
  assert.equal((await request(port, '/api/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '', keywords: [] }) })).status, 400);
  const good = await request(port, '/api/topics', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ name: '我的监控', keywords: ['机器人'] }) });
  assert.equal(good.status, 201);
  const topic = JSON.parse(good.text);
  assert.equal((await request(port, `/api/topics/${topic.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) })).status, 200);
  const state = JSON.parse((await request(port, '/api/state')).text);
  assert.equal(state.topics.find(x => x.id === topic.id).enabled, false);
  assert.equal(state.status.aisaConnected, false);
  const traversal = await request(port, '/%2e%2e/secret.txt');
  assert.ok([400, 403, 404].includes(traversal.status));
  assert.ok(!traversal.text.includes('PRIVATE'));
  assert.match((await request(port, '/')).text, /Monitor/);
  assert.equal((await request(port, '/api/report')).headers['content-type'], 'text/markdown; charset=utf-8');
});

test('collect endpoint runs in background and rejects overlapping work', async t => {
  const { store, dir } = await fixture(t);
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const server = await modules[3].startServer({ store, port: 0, projectDir: dir, homeDir: dir, collectorOptions: { fetchImpl: async () => { await pending; return new Response(rss('https://example.org/one')); } } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const first = await request(port, '/api/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(first.status, 202);
  assert.equal((await request(port, '/api/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 409);
  assert.equal(JSON.parse((await request(port, '/api/state')).text).status.running, true);
  finish();
  for (let n = 0; n < 100 && store.isCollecting(); n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(store.isCollecting(), false);
  assert.equal(store.listItems().length, 1);
});

test('an installed AIsa CLI and a key file do not claim authenticated access', async t => {
  const { dir } = await fixture(t);
  assert.equal(typeof modules[3]?.aisaStatus, 'function');
  await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.bin', 'aisa'), 'placeholder');
  await mkdir(join(dir, '.aisa')); await writeFile(join(dir, '.aisa', 'key'), 'secret-do-not-output');
  const status = modules[3].aisaStatus({ projectDir: dir, homeDir: dir, dataDir: dir });
  assert.equal(status.aisaInstalled, true);
  assert.equal(status.aisaConnected, false);
  assert.ok(!JSON.stringify(status).includes('secret-do-not-output'));
});

test('AIsa authentication evidence is invalidated when the actual credential file changes', async t => {
  const { dir } = await fixture(t);
  await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.bin', 'aisa'), 'placeholder');
  await mkdir(join(dir, '.aisa'));
  const tokenPath = join(dir, '.aisa', 'tokens.json');
  await writeFile(tokenPath, 'private-token-not-to-be-read');
  const credentialMtimeMs = (await stat(tokenPath)).mtimeMs;
  await writeFile(join(dir, 'aisa-auth.json'), JSON.stringify({ command: 'aisa balance', exitCode: 0, verifiedAt: new Date().toISOString(), credentialSource: 'tokens', credentialMtimeMs }));
  const opts = { projectDir: dir, homeDir: dir, dataDir: dir, env: {} };
  assert.equal(modules[3].aisaStatus(opts).aisaConnected, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(tokenPath, 'new-private-token');
  assert.equal(modules[3].aisaStatus(opts).aisaConnected, false);
});

test('collection lock blocks competing stores and recovers an interrupted stale run', async t => {
  const { store, dir } = await fixture(t);
  const other = modules[0].openStore(dir); t.after(() => other.close());
  const id = store.beginRun(['openai']);
  assert.throws(() => other.beginRun(['openai']), /正在进行/);
  const db = new DatabaseSync(join(dir, 'monitor.sqlite'));
  db.prepare('UPDATE runs SET startedAt=? WHERE id=?').run(new Date(Date.now() - 700000).toISOString(), id); db.close();
  assert.equal(other.isCollecting(), false);
  assert.equal(store.listRuns()[0].status, 'failed');
  assert.ok(other.beginRun(['openai']));
});

test('known future publication dates stay distinct from unknown dates and are excluded from today', async t => {
  const { store } = await fixture(t);
  store.upsertItems('openai', [{ title: 'Future scheduled story', url: 'https://example.org/future', publishedAt: '2099-01-01T00:00:00Z' }, { title: 'Undated story', url: 'https://example.org/undated' }]);
  assert.equal(store.listItems().find(i => i.title === 'Future scheduled story').publishedAt, '2099-01-01T00:00:00.000Z');
  const report = modules[2].renderReport(store);
  assert.ok(!report.includes('Future scheduled story'));
  assert.match(report, /Undated story/);
  assert.match(report, /发布时间：未知/);
});

test('bookmarked articles remain available after they fall out of the newest-item window', async t => {
  const { store } = await fixture(t);
  store.upsertItems('openai', [
    { title: 'Older bookmark', url: 'https://example.org/older', publishedAt: '2026-09-01T00:00:00Z' },
    { title: 'Newest', url: 'https://example.org/newest', publishedAt: '2026-09-12T00:00:00Z' },
    { title: 'Older ordinary', url: 'https://example.org/ordinary', publishedAt: '2026-08-01T00:00:00Z' },
  ]);
  const older = store.listItems().find(i => i.title === 'Older bookmark');
  store.setStarred(older.id, true);
  assert.deepEqual(store.listItems({ limit: 1, includeStarred: true }).map(i => i.title), ['Newest', 'Older bookmark']);
});

test('a nonempty feed with no usable entries records a failure instead of an empty success', async t => {
  const { store } = await fixture(t);
  store.upsertItems('openai', [{ title: 'Previously collected article', url: 'https://example.org/retained' }]);
  const xml = '<rss><channel><title>Fixture</title><item><title>Relative link</title><link>/post/a</link></item><item><title>Missing link</title></item></channel></rss>';
  const run = await modules[1].collect(store, { sourceIds: ['openai'], fetchImpl: async () => new Response(xml) });
  assert.equal(run.status, 'failed');
  assert.equal(run.results[0].status, 'error');
  assert.match(run.results[0].error, /2.*无.*有效|2.*不可用/);
  assert.equal(store.getSource('openai').status, 'error');
  assert.equal(store.itemCount(), 1, 'failed collection must preserve previously saved content');
  const sourceLine = modules[2].renderReport(store).split('\n').find(line => line.startsWith('| OpenAI News |'));
  assert.match(sourceLine, /失败/);
});

test('a genuinely empty feed remains a successful zero-result collection', async t => {
  const { store } = await fixture(t);
  const xml = '<rss><channel><title>Empty fixture</title></channel></rss>';
  const run = await modules[1].collect(store, { sourceIds: ['openai'], fetchImpl: async () => new Response(xml) });
  assert.equal(run.status, 'success');
  assert.equal(run.results[0].itemCount, 0);
  assert.equal(store.getSource('openai').error, null);
});

test('an unusable entry does not discard the usable articles from the same feed', async t => {
  const { store } = await fixture(t);
  const xml = '<rss><channel><title>Mixed fixture</title><item><title>Useful article</title><link>https://example.org/usable</link></item><item><title>Missing link</title></item></channel></rss>';
  const run = await modules[1].collect(store, { sourceIds: ['openai'], fetchImpl: async () => new Response(xml) });
  assert.equal(run.status, 'success');
  assert.equal(run.inserted, 1);
  assert.equal(store.listItems()[0].url, 'https://example.org/usable');
});

test('the original source can correct a publication date without empty or invalid updates erasing it', async t => {
  const { store } = await fixture(t);
  const item = { title: 'Corrected publication', url: 'https://example.org/date-correction' };
  store.upsertItems('openai', [{ ...item, publishedAt: '2099-01-01T00:00:00Z' }]);
  store.upsertItems('openai', [{ ...item, publishedAt: '2026-09-13T02:00:00Z' }]);
  assert.equal(store.listItems()[0].publishedAt, '2026-09-13T02:00:00.000Z');
  assert.match(modules[2].renderReport(store, { now: new Date('2026-09-13T03:00:00Z') }), /Corrected publication/);
  for (const publishedAt of [null, undefined, '', 'not-a-date']) {
    store.upsertItems('openai', [{ ...item, publishedAt }]);
    assert.equal(store.listItems()[0].publishedAt, '2026-09-13T02:00:00.000Z');
  }
});

test('another source may fill an unknown publication date but cannot replace a known date', async t => {
  const { store } = await fixture(t);
  const item = { title: 'Cross-source publication', url: 'https://example.org/shared-date' };
  store.upsertItems('openai', [item]);
  store.upsertItems('huggingface', [{ ...item, publishedAt: '2026-09-12T01:00:00Z' }]);
  assert.equal(store.listItems()[0].publishedAt, '2026-09-12T01:00:00.000Z');
  store.upsertItems('huggingface', [{ ...item, publishedAt: '2026-09-13T02:00:00Z' }]);
  assert.equal(store.listItems()[0].publishedAt, '2026-09-12T01:00:00.000Z');
  assert.equal(store.listItems()[0].sourceId, 'openai');
});

test('the report identifies paused RSS sources before their previous collection result', async t => {
  const { store, dir } = await fixture(t);
  store.updateSourceResult('openai', { status: 'ok', lastRun: '2026-09-13T01:00:00Z', itemCount: 12 });
  const db = new DatabaseSync(join(dir, 'monitor.sqlite'));
  db.prepare('UPDATE sources SET enabled=0 WHERE id=?').run('openai');
  db.close();
  const report = modules[2].renderReport(store, { now: new Date('2026-09-13T03:00:00Z') });
  const sourceLine = report.split('\n').find(line => line.startsWith('| OpenAI News |'));
  assert.match(sourceLine, /已暂停|未启用/);
  assert.match(sourceLine, /12/);
  assert.match(sourceLine, /2026/);
});
