import test from 'node:test';
import assert from 'node:assert/strict';
import { runRefresh, refreshExitCode } from '../scripts/run-refresh.mjs';

const job = (status, extra = {}) => ({ id: 'refresh-1', kind: 'refresh', status, stage: status === 'success' ? 'complete' : 'collecting', message: '测试任务', ...extra });
const snapshot = (current = null, notifications = []) => ({ jobs: current ? [current] : [], activeJob: current && ['queued', 'running'].includes(current.status) ? current : null, notifications });
function fake(steps) {
  const calls = [];
  let tick = 0;
  return {
    calls,
    options: {
      now: () => tick, sleep: async ms => { tick += ms; }, pollMs: 10, timeoutMs: 100,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        const next = steps.shift();
        assert.ok(next, `unexpected request ${url}`);
        assert.equal(url, 'http://127.0.0.1:4318' + next.path);
        assert.equal(options.method || 'GET', next.method || 'GET');
        assert.equal(options.redirect, 'error');
        if (next.error) throw new Error('connection lost');
        return new Response(JSON.stringify(next.body), { status: next.status || 200 });
      },
    },
  };
}

test('refresh posts once, waits for completion, reports only this job new notifications', async () => {
  const old = { id: 'old', jobId: 'refresh-1', title: '以前的通知' };
  const fresh = { id: 'new', jobId: 'refresh-1', title: '有新的机会', message: '新选题', level: 'info' };
  const fixture = fake([
    { path: '/api/operations', body: snapshot(null, [old]) },
    { path: '/api/jobs', method: 'POST', status: 202, body: job('queued') },
    { path: '/api/operations', body: snapshot(job('running'), [old]) },
    { path: '/api/operations', body: snapshot(job('success', { result: { analysis: { date: '2026-09-13', published: true, highlights: [{}, {}] } } }), [fresh, old, { ...fresh, id: 'other', jobId: 'another-job' }]) },
    { path: '/api/briefs', body: { latest: { date: '2026-09-13', highlightCount: 2 } } },
  ]);
  const result = await runRefresh(fixture.options);
  assert.equal(result.status, 'success'); assert.equal(result.briefUpdated, true);
  assert.equal(result.selectedCount, 2); assert.equal(result.newNotificationCount, 1);
  assert.equal(result.shouldNotify, true); assert.equal(refreshExitCode(result), 0);
  const posts = fixture.calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 1); assert.deepEqual(JSON.parse(posts[0].options.body), { kind: 'refresh' });
});

test('409 follows an existing refresh without another POST and keeps unchanged success quiet', async () => {
  const fixture = fake([
    { path: '/api/operations', body: snapshot(job('running')) },
    { path: '/api/jobs', method: 'POST', status: 409, body: { error: '忙' } },
    { path: '/api/operations', body: snapshot(job('running')) },
    { path: '/api/operations', body: snapshot(job('success', { result: { analysis: { date: '2026-09-13', published: false, highlights: [] } } })) },
    { path: '/api/briefs', body: { latest: { date: '2026-09-13', highlightCount: 0 } } },
  ]);
  const result = await runRefresh(fixture.options);
  assert.equal(result.adoptedExistingRefresh, true); assert.equal(result.shouldNotify, false);
  assert.equal(fixture.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('409 never follows paid X or analysis jobs', async () => {
  for (const kind of ['x', 'analysis']) {
    const fixture = fake([
      { path: '/api/operations', body: snapshot(job('running', { kind })) },
      { path: '/api/jobs', method: 'POST', status: 409, body: { error: '忙' } },
      { path: '/api/operations', body: snapshot(job('running', { kind })) },
    ]);
    const result = await runRefresh(fixture.options);
    assert.equal(result.status, 'busy'); assert.equal(result.jobId, null);
    assert.equal(refreshExitCode(result), 1); assert.equal(fixture.calls.length, 3);
  }
});

test('a normal translation queue or unchanged recorded fault stays quiet while new faults notify', async () => {
  for (const entry of [{ warnings: [], notificationCount: 0 }, { warnings: ['同一来源故障'], notificationCount: 0 }, { warnings: ['新的来源故障'], notificationCount: 1 }]) {
    const fixture = fake([
      { path: '/api/operations', body: snapshot() },
      { path: '/api/jobs', method: 'POST', status: 202, body: job('queued') },
      { path: '/api/operations', body: snapshot(job('partial', { stage: 'complete', result: { ...entry, translation: { remaining: 5, failed: 0 }, analysis: { date: '2026-09-13', published: true, highlights: [] } } })) },
      { path: '/api/briefs', body: { latest: { date: '2026-09-13', highlightCount: 0 } } },
    ]);
    const result = await runRefresh(fixture.options);
    assert.equal(result.status, 'partial');
    assert.equal(result.shouldNotify, entry.notificationCount > 0);
  }
});

test('uncertain POST is not retried', async () => {
  const fixture = fake([
    { path: '/api/operations', body: snapshot() },
    { path: '/api/jobs', method: 'POST', error: true },
  ]);
  const result = await runRefresh(fixture.options);
  assert.equal(result.status, 'unconfirmed'); assert.equal(result.taskMayStillBeRunning, true);
  assert.equal(fixture.calls.length, 2); assert.equal(refreshExitCode(result), 1);
});

test('deadline stops polling without retrying or cancelling the active task', async () => {
  const fixture = fake([
    { path: '/api/operations', body: snapshot() },
    { path: '/api/jobs', method: 'POST', status: 202, body: job('queued') },
    { path: '/api/operations', body: snapshot(job('running')) },
    { path: '/api/operations', body: snapshot(job('running')) },
  ]);
  const result = await runRefresh({ ...fixture.options, timeoutMs: 20 });
  assert.equal(result.status, 'timeout'); assert.equal(result.jobId, 'refresh-1');
  assert.equal(result.taskMayStillBeRunning, true); assert.equal(fixture.calls.length, 4);
  assert.equal(refreshExitCode(result), 1);
});

test('partial and failed terminal states remain failures even when an older brief exists', async () => {
  for (const status of ['partial', 'failed', 'cancelled', 'interrupted']) {
    const fixture = fake([
      { path: '/api/operations', body: snapshot() },
      { path: '/api/jobs', method: 'POST', status: 202, body: job('queued') },
      { path: '/api/operations', body: snapshot(job(status)) },
      { path: '/api/briefs', body: { latest: { date: '2026-09-12', highlightCount: 5 } } },
    ]);
    const result = await runRefresh(fixture.options);
    assert.equal(result.status, status); assert.equal(result.briefUpdated, false);
    assert.equal(result.briefDate, '2026-09-12'); assert.equal(result.selectedCount, 5);
    assert.equal(result.shouldNotify, true); assert.equal(refreshExitCode(result), 1);
  }
});
