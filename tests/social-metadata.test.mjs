import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../server/store.mjs';
import { normalizeAisa } from '../server/aisa-normalize.mjs';
import * as importer from '../scripts/aisa-import.mjs';

const emptyMetrics = { views: null, likes: null, reposts: null, replies: null };
const tweet = extra => ({ id: '123', url: 'https://x.com/creator/status/123', text: 'An agent release', createdAt: '2026-09-11T10:00:00Z', ...extra });
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'media-social-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('X metadata maps documented counts and removes HTML without inventing a score or capture time', () => {
  const [item] = normalizeAisa('x', { tweets: [tweet({ author: { name: '<b>Alice</b><script>bad()</script>', userName: '<i>creator</i>' }, viewCount: 1200, likeCount: 0, retweetCount: 12, replyCount: '7' })] });
  assert.deepEqual(item.author, { name: 'Alice', handle: 'creator' });
  assert.deepEqual(item.metrics, { views: 1200, likes: 0, reposts: 12, replies: 7 });
  assert.equal(item.publishedAt, '2026-09-11T10:00:00.000Z');
  assert.equal(item.capturedAt ?? null, null);
  assert.equal(item.score, undefined);
});

test('missing, invalid and negative X metrics remain unknown while real zero survives', () => {
  for (const value of [undefined, null, '', ' ', -1, '-1', '1.5', 1.5, false, [], {}, NaN, Infinity, '1K', Number.MAX_SAFE_INTEGER + 1]) {
    const [item] = normalizeAisa('x', { tweets: [tweet({ viewCount: value, likeCount: value, retweetCount: value, replyCount: value })] });
    assert.deepEqual(item.metrics, emptyMetrics, `invalid metric: ${String(value)}`);
    assert.deepEqual(item.author, { name: null, handle: null });
  }
  const [zero] = normalizeAisa('x', { tweets: [tweet({ viewCount: 0, likeCount: '0', retweetCount: 0, replyCount: 0 })] });
  assert.deepEqual(zero.metrics, { views: 0, likes: 0, reposts: 0, replies: 0 });
});

test('opening a legacy database preserves saved content and migrates social metadata idempotently', async t => {
  const dir = await directory(t);
  const legacy = new DatabaseSync(join(dir, 'monitor.sqlite'));
  legacy.exec(`
    CREATE TABLE topics(id TEXT PRIMARY KEY,name TEXT NOT NULL,keywords TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,createdAt TEXT NOT NULL);
    CREATE TABLE sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,platform TEXT NOT NULL,url TEXT NOT NULL,enabled INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'idle',lastRun TEXT,error TEXT,itemCount INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE items(id TEXT PRIMARY KEY,url TEXT UNIQUE NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,publishedAt TEXT,sourceId TEXT NOT NULL REFERENCES sources(id),starred INTEGER NOT NULL DEFAULT 0,firstSeenAt TEXT NOT NULL,lastSeenAt TEXT NOT NULL);
    CREATE TABLE item_sources(itemId TEXT NOT NULL REFERENCES items(id),sourceId TEXT NOT NULL REFERENCES sources(id),PRIMARY KEY(itemId,sourceId));
    CREATE TABLE item_topics(itemId TEXT NOT NULL REFERENCES items(id),topicId TEXT NOT NULL REFERENCES topics(id),PRIMARY KEY(itemId,topicId));
    INSERT INTO topics VALUES('saved-topic','Saved topic','["agent"]',1,'2026-09-10T00:00:00Z');
    INSERT INTO sources VALUES('legacy-feed','Legacy feed','rss','Original','https://example.org/feed',1,'ok',NULL,NULL,1);
    INSERT INTO items VALUES('saved-item','https://x.com/creator/status/123','An agent release','Saved text','2026-09-11T10:00:00Z','legacy-feed',1,'2026-09-11T11:00:00Z','2026-09-11T11:00:00Z');
    INSERT INTO item_sources VALUES('saved-item','legacy-feed');
    INSERT INTO item_topics VALUES('saved-item','saved-topic');
  `);
  legacy.close();
  let store = openStore(dir);
  try {
    const before = store.listItems()[0];
    assert.equal(before.id, 'saved-item');
    assert.equal(before.summary, 'Saved text');
    assert.equal(before.starred, true);
    assert.deepEqual(before.topicIds, ['saved-topic']);
    assert.deepEqual(before.author, { name: null, handle: null });
    assert.deepEqual(before.metrics, emptyMetrics);
    store.upsertItems('aisa-x', normalizeAisa('x', { tweets: [tweet({ author: { name: 'Alice', userName: 'creator' }, viewCount: 100, likeCount: 2, retweetCount: 1, replyCount: 0 })] }));
    store.upsertItems('aisa-x', normalizeAisa('x', { tweets: [tweet({ author: { name: 'Alice', userName: 'creator' }, viewCount: 150, likeCount: 0, replyCount: 1 })] }));
    store.close();
    store = openStore(dir);
    const item = store.listItems()[0];
    assert.equal(item.id, 'saved-item');
    assert.equal(item.sourceId, 'legacy-feed');
    assert.deepEqual(new Set(item.sourceIds), new Set(['legacy-feed', 'aisa-x']));
    assert.equal(item.starred, true);
    assert.ok(item.topicIds.includes('saved-topic'));
    assert.deepEqual(item.author, { name: 'Alice', handle: 'creator' });
    assert.deepEqual(item.metrics, { views: 150, likes: 0, reposts: null, replies: 1 });
    assert.equal(item.publishedAt, '2026-09-11T10:00:00Z');
    assert.equal(item.firstSeenAt, '2026-09-11T11:00:00Z');
  } finally { store.close(); }
});

test('storage sanitizes untrusted metadata and a later RSS update does not erase X counts', async t => {
  const store = openStore(await directory(t));
  try {
    store.upsertItems('aisa-x', [{ title: 'agent', url: 'https://x.com/creator/status/123', author: { name: '<script>bad()</script><b>Alice</b>', handle: '<i>creator</i>' }, metrics: { views: 500, likes: -5, reposts: false, replies: 0 }, extra: 'not metadata' }]);
    store.upsertItems('openai', [{ title: 'agent', url: 'https://x.com/creator/status/123', summary: 'New excerpt' }]);
    const item = store.listItems()[0];
    assert.deepEqual(item.author, { name: 'Alice', handle: 'creator' });
    assert.deepEqual(item.metrics, { views: 500, likes: null, reposts: null, replies: 0 });
    const starred = store.setStarred(item.id, true);
    assert.deepEqual(starred.metrics, item.metrics);
    assert.deepEqual(starred.author, item.author);
  } finally { store.close(); }
});

test('offline AIsa imports persist identified runs and update the latest snapshot without losing bookmarks', async t => {
  assert.equal(typeof importer.importAisaFile, 'function');
  const dir = await directory(t);
  const file = join(dir, 'response.json');
  await writeFile(file, JSON.stringify({ tweets: [tweet({ viewCount: 100, likeCount: 5 })] }));
  const first = importer.importAisaFile('x', file, { dataDir: dir });
  assert.equal(first.inserted, 1);
  let store = openStore(dir);
  try { store.setStarred(store.listItems()[0].id, true); } finally { store.close(); }
  await writeFile(file, JSON.stringify({ tweets: [tweet({ viewCount: 140, likeCount: 0 })] }));
  const second = importer.importAisaFile('x', file, { dataDir: dir });
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 1);
  assert.match(second.note, /provided|supplied|导入/);
  store = openStore(dir);
  try {
    const runs = store.listRuns();
    assert.equal(runs.length, 2);
    for (const run of runs) {
      assert.equal(run.kind, 'aisa-import');
      assert.equal(run.status, 'success');
      assert.ok(run.finishedAt);
      assert.deepEqual(run.sourceIds, ['aisa-x']);
      assert.equal(run.results[0].status, 'ok');
      assert.equal(run.results[0].itemCount, 1);
    }
    assert.equal(store.listItems()[0].starred, true);
    assert.deepEqual(store.listItems()[0].metrics, { views: 140, likes: 0, reposts: null, replies: null });
  } finally { store.close(); }
});

test('failed or malformed offline imports persist failed evidence and do not become empty success', async t => {
  assert.equal(typeof importer.importAisaFile, 'function');
  const dir = await directory(t);
  const file = join(dir, 'response.json');
  for (const raw of ['{"success":false,"error":"rejected"}', '{not-json']) {
    await writeFile(file, raw);
    assert.throws(() => importer.importAisaFile('x', file, { dataDir: dir }));
  }
  const store = openStore(dir);
  try {
    assert.equal(store.itemCount(), 0);
    assert.equal(store.isCollecting(), false);
    const runs = store.listRuns();
    assert.equal(runs.length, 2);
    for (const run of runs) {
      assert.equal(run.kind, 'aisa-import');
      assert.equal(run.status, 'failed');
      assert.equal(run.results[0].status, 'error');
      assert.equal(run.inserted, 0);
      assert.ok(run.error);
    }
    assert.equal(store.getSource('aisa-x').status, 'error');
  } finally { store.close(); }
});
