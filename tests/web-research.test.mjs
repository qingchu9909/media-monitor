import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { openOperations } from '../server/operation-store.mjs';

const module = await import('../server/web-research.mjs').catch(() => ({}));
const now = new Date('2026-09-13T04:10:00Z');
const quote = 'The new video editor supports reusable characters';
const body = `${quote} and exports an editable scene. The official tutorial describes the workflow and its limits.`;
const row = (changes = {}) => ({ sourceName: 'Creator official', url: 'https://creator.example/video', title: 'New video editor workflow', summary: body,
  publishedAt: '2026-09-12T09:00:00Z', retrievedAt: '2026-09-13T04:00:00Z', titleZh: '视频编辑器支持复用角色', summaryZh: '官方说明支持复用角色并导出可编辑场景。',
  evidenceType: 'original-page', evidenceText: body, evidenceQuote: quote, ...changes });
const payload = (...items) => ({ schemaVersion: 1, items });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-web-research-'));
  const store = openStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const run = (input, options = {}) => {
    assert.equal(typeof module.importWebResearch, 'function');
    return module.importWebResearch({ store, payload: input, now, fetchText: async () => ({ text: `<article>${body}</article>`, url: 'https://creator.example/video', contentType: 'text/html' }), ...options });
  };
  return { dir, store, run };
}

test('research import verifies a fetched quotation and persists original text separately from Chinese notes', async t => {
  const { dir, store, run } = await fixture(t);
  const result = await run(payload(row()));
  assert.equal(result.inserted, 1); assert.equal(result.verified, 1); assert.equal(result.leads, 0);
  const item = store.listItems()[0];
  assert.equal(item.title, row().title); assert.equal(item.summary, body);
  assert.equal(item.research.titleZh, row().titleZh); assert.equal(item.research.verification, 'original-page');
  assert.equal(item.research.pageEvidenceText, body); assert.equal(item.research.evidenceQuote, quote);
  assert.equal(item.sourceKind, 'web-research');
  assert.equal(store.getSource(item.sourceId).enabled, false);
  assert.equal(store.listRuns()[0].kind, 'web-research');
  store.close(); const reopened = openStore(dir); t.after(() => reopened.close());
  assert.deepEqual(reopened.listItems()[0].research, item.research);
});

test('search snippets and unreadable pages remain research leads; submitted quotation never proves a fetched page', async t => {
  const { store, run } = await fixture(t);
  let calls = 0;
  const result = await run(payload(row({ evidenceType: 'search-snippet' }), row({ url: 'https://creator.example/second' }), row({ url: 'https://creator.example/third' })), {
    fetchText: async url => { calls++; if (url.endsWith('/second')) throw new Error('HTTP 403'); return { text: '<article>Other unrelated information that never contains the supplied quotation.</article>', url }; },
  });
  assert.equal(calls, 2); assert.equal(result.verified, 0); assert.equal(result.leads, 3);
  assert.ok(store.listItems().every(item => item.research.verification === 'research-lead'));
  assert.ok(store.listItems().every(item => item.research.verification !== 'feed-excerpt'));
});

test('duplicate RSS URL attaches research without replacing source text, date, primary identity or favorite', async t => {
  const { store, run } = await fixture(t);
  store.upsertItems('openai', [{ url: row().url, title: 'RSS original title', summary: 'Original RSS summary', publishedAt: '2026-09-11T01:00:00Z' }]);
  const before = store.listItems()[0]; store.setStarred(before.id, true);
  const result = await run(payload(row({ publishedAt: null })));
  assert.equal(result.inserted, 0); assert.equal(result.updated, 1);
  const after = store.listItems()[0];
  for (const key of ['id', 'title', 'summary', 'publishedAt', 'sourceId']) assert.equal(after[key], before[key], key);
  assert.equal(after.starred, true); assert.equal(after.sourceIds.length, 2);
  assert.equal(after.research.titleZh, row().titleZh);
});

test('unknown publication time stays null and date-only evidence is preserved without inventing a clock time', async t => {
  const { store, run } = await fixture(t);
  await run(payload(row({ publishedAt: null, dateEvidence: 'Published September 12, 2026' })));
  const item = store.listItems()[0];
  assert.equal(item.publishedAt, null); assert.equal(item.research.dateEvidence, 'Published September 12, 2026');
});

test('a later unreadable attempt preserves earlier fetched evidence and records the failed attempt separately', async t => {
  const { store, run } = await fixture(t);
  await run(payload(row()));
  const before = store.listItems()[0].research;
  const result = await run(payload(row({ summaryZh: '这次页面没有读取成功。' })), { fetchText: async () => { throw new Error('HTTP 404'); } });
  const after = store.listItems()[0].research;
  assert.equal(result.leads, 1); assert.equal(after.verification, 'original-page');
  assert.equal(after.checkedAt, before.checkedAt); assert.equal(after.summaryZh, before.summaryZh);
  assert.equal(after.lastAttempt.verification, 'research-lead'); assert.match(after.lastAttempt.verificationError, /404/);
});

test('a later RSS observation becomes primary and invalidates research Chinese when original text changes', async t => {
  const { store, run } = await fixture(t);
  await run(payload(row()));
  const before = store.listItems()[0];
  assert.equal(before.research.isStale, false);
  assert.match(before.research.sourceContentHash, /^[a-f0-9]{64}$/);
  store.upsertItems('openai', [{ url: row().url, title: 'Corrected official RSS title', summary: 'Corrected official source summary', publishedAt: '2026-09-11T10:00:00Z' }]);
  const after = store.listItems()[0];
  assert.equal(after.sourceId, 'openai'); assert.equal(after.sourceKind, 'rss');
  assert.equal(after.publishedAt, '2026-09-11T10:00:00.000Z');
  assert.equal(after.research.titleZh, before.research.titleZh); assert.equal(after.research.isStale, true);
  assert.deepEqual(new Set(after.sourceIds), new Set([before.sourceId, 'openai']));
});

test('RSS promotion with missing publication time preserves the known date and matching research content remains current', async t => {
  const { store, run } = await fixture(t);
  await run(payload(row()));
  store.upsertItems('openai', [{ url: row().url, title: row().title, summary: row().summary, publishedAt: null }]);
  const item = store.listItems()[0];
  assert.equal(item.sourceId, 'openai'); assert.equal(item.publishedAt, '2026-09-12T09:00:00.000Z');
  assert.equal(item.research.isStale, false);
});

test('invalid fields, dates, private URLs and duplicate inputs fail before network or database changes', async t => {
  const { store, run } = await fixture(t);
  let calls = 0;
  const bad = [row({ key: 'never accepted' }), row({ sourceName: '' }), row({ titleZh: '' }), row({ publishedAt: '2026-09-12' }), row({ publishedAt: '2026-02-30T00:00:00Z' }), row({ publishedAt: '2026-09-14T00:00:00Z' }), row({ retrievedAt: '2026-09-14T00:00:00Z' }), row({ url: 'https://127.0.0.1/private' }), row({ evidenceQuote: 'not in submitted evidence' })];
  const before = store.listSources().length;
  for (const entry of bad) await assert.rejects(run(payload(entry), { fetchText: async () => { calls++; } }), error => error.status === 400);
  await assert.rejects(run(payload(row(), row())), error => error.status === 400);
  assert.equal(calls, 0); assert.equal(store.itemCount(), 0); assert.equal(store.listSources().length, before); assert.equal(store.listRuns().length, 0);
});

test('active model jobs or collections reject import before fetching or creating research sources', async t => {
  const { dir, store, run } = await fixture(t);
  const ops = openOperations(dir); t.after(() => ops.close());
  const job = ops.createJob('analysis');
  const before = store.listSources().length;
  await assert.rejects(run(payload(row())), error => error.status === 409);
  assert.equal(store.listSources().length, before);
  ops.updateJob(job.id, { status: 'completed' });
  const runId = store.beginRun(['openai']);
  await assert.rejects(run(payload(row())), error => error.status === 409);
  store.finishRun(runId, 'fixture complete');
});

test('cancelled page verification writes no articles and closes the research run as failed', async t => {
  const { store, run } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(run(payload(row()), { signal: controller.signal, fetchText: async () => { controller.abort(); throw new DOMException('Cancelled', 'AbortError'); } }), error => error.name === 'AbortError');
  assert.equal(store.itemCount(), 0); assert.equal(store.isCollecting(), false); assert.equal(store.listRuns()[0].status, 'failed');
});

test('the CLI wrapper imports supplied JSON without a model or paid provider dependency', async t => {
  const { dir } = await fixture(t);
  const cli = await import('../scripts/import-research.mjs');
  const file = join(dir, 'provided-research.json');
  await writeFile(file, JSON.stringify(payload(row({ evidenceType: 'search-snippet' }))));
  const result = await cli.importResearchFile(file, { dataDir: dir, now });
  assert.equal(result.inserted, 1); assert.equal(result.leads, 1); assert.equal(result.kind, 'web-research');
});

test('YouTube public player JSON provides video-description evidence without executing scripts', async t => {
  const { store, run } = await fixture(t);
  const url = 'https://www.youtube.com/shorts/abc12345678';
  const player = { videoDetails: { videoId: 'abc12345678', title: 'Official video workflow', shortDescription: body } };
  const html = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};globalThis.__researchScriptExecuted = true;</script></html>`;
  await run(payload(row({ url })), { fetchText: async () => ({ text: html, url }) });
  const item = store.listItems()[0];
  assert.equal(item.research.verification, 'original-page');
  assert.equal(item.research.contentKind, 'video-description');
  assert.ok(item.research.pageEvidenceText.includes(body));
  assert.equal(globalThis.__researchScriptExecuted, undefined);
});

test('YouTube static descriptions are decoded safely and ordinary sites cannot use the video adapter', async t => {
  const { store, run } = await fixture(t);
  const url = 'https://www.youtube.com/watch?v=abc12345678';
  const html = `<html><meta content="Official video workflow" property="og:title"><meta name='description' content='${body}'><script>globalThis.__researchScriptExecuted = true;</script></html>`;
  await run(payload(row({ url })), { fetchText: async () => ({ text: html, url }) });
  assert.equal(store.listItems()[0].research.contentKind, 'video-description');
  assert.equal(store.listItems()[0].research.verification, 'original-page');
  const fakeUrl = 'https://www.youtube.com.creator.example/watch?v=abc12345678';
  await run(payload(row({ url: fakeUrl })), { fetchText: async () => ({ text: html, url: fakeUrl }) });
  const fake = store.listItems().find(item => item.url === fakeUrl);
  assert.equal(fake.research.verification, 'research-lead');
  assert.notEqual(fake.research.contentKind, 'video-description');
  assert.equal(globalThis.__researchScriptExecuted, undefined);
});
