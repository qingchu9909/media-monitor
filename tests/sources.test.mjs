import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { collect } from '../server/collector.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-sources-'));
  const store = openStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store };
}

const input = { name: 'Release notes', url: 'https://new-feed.example/releases.atom?b=2&a=1&utm_source=feed', kind: 'rss' };
const status = expected => error => error.status === expected;

test('custom RSS sources persist original URL parameters and rename rematches existing articles', async t => {
  const { dir, store } = await fixture(t);
  assert.equal(typeof store.createSource, 'function');
  const source = store.createSource(input);
  assert.equal(source.url, input.url);
  assert.equal(source.enabled, true);
  assert.equal(source.archived, false);
  store.upsertItems(source.id, [{ title: 'A new release', url: 'https://new-feed.example/v1' }]);
  const topic = store.createTopic({ name: 'Tracked vendor', keywords: ['NewVendor'] });
  assert.equal(store.listItems()[0].topicIds.includes(topic.id), false);
  store.updateSource(source.id, { name: 'NewVendor releases', platform: 'NewVendor', enabled: false });
  assert.equal(store.listItems()[0].topicIds.includes(topic.id), true);
  store.close();
  const reopened = openStore(dir); t.after(() => reopened.close());
  assert.equal(reopened.getSource(source.id).name, 'NewVendor releases');
  assert.equal(reopened.getSource(source.id).enabled, false);
  assert.equal(reopened.getSource(source.id).url, input.url);
});

test('archiving built-in sources preserves articles and remains archived after reopening', async t => {
  const { dir, store } = await fixture(t);
  assert.equal(typeof store.archiveSource, 'function');
  store.upsertItems('openai', [{ title: 'Saved article', url: 'https://example.org/saved' }]);
  store.setStarred(store.listItems()[0].id, true);
  store.archiveSource('openai');
  assert.equal(store.getSource('openai').archived, true);
  assert.equal(store.getSource('openai').enabled, false);
  store.close();
  const reopened = openStore(dir); t.after(() => reopened.close());
  assert.equal(reopened.getSource('openai').archived, true);
  assert.equal(reopened.listItems()[0].starred, true);
  assert.equal(reopened.listSources().filter(s => s.id === 'openai').length, 1);
  reopened.restoreSource('openai');
  assert.equal(reopened.getSource('openai').archived, false);
  assert.equal(reopened.getSource('openai').enabled, false);
});

test('source URLs deduplicate without reordering meaningful query parameters', async t => {
  const { store } = await fixture(t);
  assert.equal(typeof store.createSource, 'function');
  const source = store.createSource(input);
  assert.throws(() => store.createSource({ ...input, url: input.url.replace('new-feed.example', 'NEW-FEED.EXAMPLE:443') }), status(409));
  store.archiveSource(source.id);
  assert.throws(() => store.createSource(input), status(409));
  const other = store.createSource({ ...input, url: 'https://new-feed.example/releases.atom?a=1&b=2&utm_source=feed' });
  assert.notEqual(other.id, source.id);
  assert.throws(() => store.updateSource(other.id, { url: input.url }), status(409));
});

test('source writes reject unsafe addresses, immutable types and malformed fields', async t => {
  const { store } = await fixture(t);
  assert.equal(typeof store.createSource, 'function');
  for (const url of ['http://example.org/feed', 'https://localhost/feed', 'https://127.0.0.1/feed', 'https://[::1]/feed', 'https://[fd00::1]/feed', 'https://user:password@example.org/feed', 'https://example.org:444/feed', ' https://example.org/feed', 'https://example.org/feed#fragment']) {
    assert.throws(() => store.createSource({ ...input, url }), status(400), url);
  }
  assert.throws(() => store.createSource({ ...input, kind: 'aisa' }), status(400));
  assert.throws(() => store.createSource({ ...input, enabled: 'yes' }), status(400));
  assert.throws(() => store.updateSource('aisa-x', { name: 'Changed' }), status(400));
  assert.throws(() => store.archiveSource('missing-source'), status(404));
  const source = store.createSource(input);
  assert.throws(() => store.updateSource(source.id, { kind: 'web' }), status(400));
  store.archiveSource(source.id);
  assert.throws(() => store.updateSource(source.id, { enabled: true }), status(409));
});

test('active collection rejects source creation, editing, archiving and restoring', async t => {
  const { store } = await fixture(t);
  assert.equal(typeof store.createSource, 'function');
  store.beginRun(['openai']);
  for (const action of [() => store.createSource(input), () => store.updateSource('openai', { enabled: false }), () => store.archiveSource('openai'), () => store.restoreSource('openai')]) assert.throws(action, status(409));
});

test('collection accepts a newly configured public domain and skips archived sources', async t => {
  const { store } = await fixture(t);
  assert.equal(typeof store.createSource, 'function');
  const source = store.createSource(input);
  const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>New release</title><link href="https://new-feed.example/v1"/><published>2026-09-13T00:00:00Z</published></entry></feed>';
  const run = await collect(store, { sourceIds: [source.id], fetchImpl: async () => new Response(xml) });
  assert.equal(run.status, 'success');
  assert.equal(run.inserted, 1);
  store.archiveSource(source.id);
  await assert.rejects(collect(store, { sourceIds: [source.id], fetchImpl: async () => { throw new Error('archived source must not be requested'); } }), status(400));
});

test('changing a feed URL resets its old success claim while preserving saved articles', async t => {
  const { store } = await fixture(t);
  const source = store.createSource(input);
  store.upsertItems(source.id, [{ title: 'Historical article', url: 'https://new-feed.example/old' }]);
  store.updateSourceResult(source.id, { status: 'ok', itemCount: 1 });
  const changed = store.updateSource(source.id, { url: 'https://new-feed.example/new.xml' });
  assert.equal(changed.status, 'idle'); assert.equal(changed.lastRun, null); assert.equal(changed.itemCount, 0);
  assert.equal(store.listItems()[0].title, 'Historical article');
});
