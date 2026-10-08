import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOperations } from '../server/operation-store.mjs';
import { validateAnalysis, selectCandidates } from '../server/analysis.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-operations-'));
  const ops = openOperations(dir);
  t.after(() => { ops.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, ops };
}

test('job creation is exclusive and interrupted jobs survive reopening', t => {
  const { dir, ops } = fixture(t);
  const job = ops.createJob('analysis');
  assert.throws(() => ops.createJob('refresh'), /正在|任务/);
  ops.updateJob(job.id, { status: 'running', stage: 'analyzing', ownerPid: -1 });
  ops.close();
  const reopened = openOperations(dir);
  try {
    assert.equal(reopened.getJob(job.id).status, 'interrupted');
    assert.equal(reopened.activeJob(), null);
    assert.equal(reopened.createJob('refresh').status, 'queued');
  } finally { reopened.close(); }
});

test('notifications deduplicate by event and retain read state', t => {
  const { ops } = fixture(t);
  ops.addNotification({ key: 'new:one', title: '一条新线索', message: '来自已保存原文' });
  ops.addNotification({ key: 'new:one', title: '重复线索', message: '不重复推送' });
  const list = ops.notifications();
  assert.equal(list.length, 1);
  assert.equal(ops.markRead([list[0].id]), 1);
  assert.equal(ops.notifications()[0].read, true);
});

test('opening another connection preserves a live task and its exclusive lock', t => {
  const { dir, ops } = fixture(t);
  const job = ops.createJob('analysis');
  const second = openOperations(dir);
  try {
    assert.equal(second.activeJob().id, job.id);
    assert.equal(ops.getJob(job.id).status, 'queued');
    assert.throws(() => second.createJob('refresh'), /正在|任务/);
  } finally { second.close(); }
});

test('automated paid collection requires explicit acceptance and bounded attempts', t => {
  const { ops } = fixture(t);
  assert.equal(ops.settings().x.enabled, false);
  assert.throws(() => ops.saveSettings({ x: { enabled: true } }), /接受|估|授权/);
  assert.throws(() => ops.saveSettings({ x: { maxDailyCalls: 9999 } }));
  assert.throws(() => ops.saveSettings({ token: 'secret' }));
  assert.equal(ops.saveSettings({ x: { handles: ['OpenAI'], enabled: true, acceptUncappedEstimate: true, maxDailyCalls: 1 } }).x.enabled, true);
});

test('candidates exclude unknown, future, old, paper and unrelated content', () => {
  const now = new Date('2026-09-13T04:00:00Z');
  const item = { url: 'https://example.org/valid', sourceId: 'openai', sourceIds: ['openai'], topicIds: ['ai'], publishedAt: '2026-09-13T02:00:00Z', title: 'OpenAI introduces a new API model', summary: 'The new model adds streaming responses and configurable reasoning controls for developers using the public API.' };
  const items = [item, { ...item, url: 'https://example.org/future', publishedAt: '2099-01-01' }, { ...item, url: 'https://example.org/old', publishedAt: '2026-09-01' }, { ...item, url: 'https://example.org/unknown', publishedAt: null }, { ...item, url: 'https://example.org/paper', sourceIds: ['arxiv'] }, { ...item, url: 'https://example.org/unrelated', topicIds: [] }];
  assert.deepEqual(selectCandidates(items, now).map(x => x.url), [item.url]);
});

test('analysis rejects invented sources and unsupported quotes, and uses stored source dates', () => {
  const evidence = [{ url: 'https://example.org/a', title: 'Release', sourceName: 'Official', publishedAt: '2026-09-13T01:00:00Z', evidenceText: 'The official release adds offline export and fixes the startup crash.', pageEvidenceText: 'The official release adds offline export and fixes the startup crash.', verification: 'original-page' }];
  const output = { summary: '有一项更新', highlights: [{ url: evidence[0].url, titleZh: '新增离线导出', summaryZh: '本次增加离线导出并修复启动崩溃。', whyItMatters: '可以测试导出流程。', supportingQuote: 'adds offline export and fixes the startup crash' }], ideas: [{ title: '测试导出', angle: '实际测试功能', hook: '离线时能不能导出？', sourceUrls: [evidence[0].url] }] };
  const validated = validateAnalysis(output, evidence);
  assert.equal(validated.highlights[0].publishedAt, evidence[0].publishedAt);
  assert.equal(validated.highlights[0].verification, 'original-page');
  assert.throws(() => validateAnalysis({ ...output, highlights: [{ ...output.highlights[0], url: 'https://evil.example/new' }] }, evidence), /来源/);
  assert.throws(() => validateAnalysis({ ...output, highlights: [{ ...output.highlights[0], supportingQuote: 'unfounded performance benchmark' }] }, evidence), /引文|证据/);
  assert.throws(() => validateAnalysis({ ...output, ideas: [{ ...output.ideas[0], sourceUrls: ['https://evil.example/new'] }] }, evidence), /来源/);
});
