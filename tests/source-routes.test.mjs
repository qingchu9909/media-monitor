import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';

const routeModule = await import('../server/source-routes.mjs').catch(() => ({}));
async function fixture(t, fetchOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-source-routes-'));
  const store = openStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  async function call(path, method = 'GET', body = {}) {
    assert.equal(typeof routeModule.sourceRoutes, 'function');
    let result;
    const handled = await routeModule.sourceRoutes({ path, method, req: {}, res: {}, store, jsonBody: async () => body, sendJSON: (res, status, data) => { result = { status, data }; }, fetchOptions });
    return { handled, ...result };
  }
  return { store, call };
}

test('source routes persist edits and retain the same source identity through archive and restore', async t => {
  const { store, call } = await fixture(t);
  const created = await call('/api/sources', 'POST', { kind: 'rss', name: 'Creator feed', url: 'https://creator.example/feed.xml' });
  assert.equal(created.handled, true); assert.equal(created.status, 201);
  const id = created.data.id;
  const edited = await call(`/api/sources/${id}`, 'PATCH', { name: 'Edited feed', enabled: false });
  assert.equal(edited.data.name, 'Edited feed'); assert.equal(edited.data.enabled, false);
  assert.equal((await call(`/api/sources/${id}/archive`, 'POST')).data.archived, true);
  assert.equal((await call(`/api/sources/${id}/restore`, 'POST')).data.archived, false);
  assert.equal(store.getSource(id).name, 'Edited feed');
  assert.equal((await call('/api/not-a-source-route')).handled, false);
});

test('catalog provides verified official feed URLs and YouTube instructions without inserting sources', async t => {
  const { store, call } = await fixture(t);
  const before = store.listSources().length;
  const result = await call('/api/source-catalog');
  assert.equal(result.status, 200);
  assert.ok(result.data.entries.some(entry => entry.url === 'https://github.com/anthropics/claude-code/releases.atom'));
  assert.ok(result.data.entries.every(entry => entry.id && entry.name && entry.url && entry.platform && entry.description));
  assert.match(result.data.youtube.urlTemplate, /channel_id=/);
  assert.equal(store.listSources().length, before);
});

test('feed validation returns real parsed preview without writing sources, items or collection runs', async t => {
  const xml = '<rss><channel><title>Preview</title><item><title>Preview entry</title><link>https://creator.example/entry</link></item></channel></rss>';
  const { store, call } = await fixture(t, { fetchImpl: async () => new Response(xml, { headers: { 'Content-Type': 'application/rss+xml' } }) });
  const before = store.listSources().length;
  const result = await call('/api/sources/validate', 'POST', { url: 'https://creator.example/feed.xml' });
  assert.equal(result.status, 200); assert.equal(result.data.itemCount, 1);
  assert.equal(result.data.samples[0].title, 'Preview entry');
  assert.equal(store.itemCount(), 0); assert.equal(store.listRuns().length, 0); assert.equal(store.listSources().length, before);
  await assert.rejects(call('/api/sources/validate', 'POST', { url: 'https://creator.example/feed.xml', key: 'never-accepted' }), error => error.status === 400);
});

test('a second feed validation cannot overlap the first request', async t => {
  let release; let started;
  const waiting = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { started = resolve; });
  const { call } = await fixture(t, { fetchImpl: async () => { started(); await waiting; return new Response('<rss><channel><title>Empty</title></channel></rss>'); } });
  const first = call('/api/sources/validate', 'POST', { url: 'https://creator.example/feed.xml' });
  await reached;
  try { await assert.rejects(call('/api/sources/validate', 'POST', { url: 'https://creator.example/other.xml' }), error => error.status === 409); }
  finally { release(); await first; }
});
