import test from 'node:test';
import assert from 'node:assert/strict';
import { attachAnalysis, completedRunSummary, filterFeed, itemTime, metricValue, rankXItems } from '../src/feed-filters.mjs';

const now = Date.parse('2026-09-12T04:00:00Z');
const row = (id, date, extra = {}) => ({ id, title: id, url: `https://example.com/${id}`, publishedAt: date, firstSeenAt: '2026-09-12T01:00:00Z', sourceId: 'openai', ...extra });
test('recent feed excludes future and old articles; unknown dates use explicitly identified discovery time', () => {
  const items = [row('recent', '2026-09-11T04:00:00Z'), row('old', '2026-09-10T00:00:00Z'), row('future', '2026-09-13T00:00:00Z'), row('unknown', null), row('undated', null, { firstSeenAt: null })];
  assert.deepEqual(filterFeed(items, { now }).map(i => i.id), ['recent', 'unknown']);
  assert.equal(itemTime(items[3]).kind, 'discovered');
  assert.equal(itemTime(items[4]).value, null);
  assert.equal(filterFeed(items, { now, range: 'all' }).length, 5);
});
test('7-day, source, paper, and topic filters compose without mutating stored items', () => {
  const items = [row('paper', '2026-09-09T00:00:00Z', { sourceId: 'arxiv', topicIds: ['ai'] }), row('tool', '2026-09-09T00:00:00Z', { topicIds: ['tools'] })];
  assert.deepEqual(filterFeed(items, { now, range: '7d' }).map(i => i.id), ['tool']);
  assert.deepEqual(filterFeed(items, { now, range: '7d', includePapers: true, source: 'arxiv', topicId: 'ai' }).map(i => i.id), ['paper']);
  assert.equal(items.length, 2);
});
test('all-time favorites retain historical papers and future dated saved items', () => {
  const items = [row('old-paper', '2020-01-01', { starred: true, sourceId: 'arxiv' }), row('saved-future', '2026-10-01', { starred: true }), row('unsaved', '2026-09-12')];
  assert.deepEqual(filterFeed(items, { now, range: 'all', includePapers: true, starredOnly: true }).map(i => i.id), ['old-paper', 'saved-future']);
});
test('reviewed Chinese fields are searchable while original source text remains available', () => {
  const original = [row('workflow', '2026-09-12T01:00:00Z')];
  const enriched = attachAnalysis(original, { [original[0].url]: { titleZh: '创作者的工作流', summaryZh: '用真实来源核验', whyItMatters: '减少重复操作' } });
  assert.equal(filterFeed(enriched, { now, query: '重复操作' }).length, 1);
  assert.equal(enriched[0].title, 'workflow');
  assert.equal(original[0].analysis, undefined);
});
test('collection feedback uses the completed run, including real zero-new and source failures', () => {
  assert.deepEqual(completedRunSummary({ finishedAt: '2026-09-12', inserted: 0, status: 'partial', results: [{ status: 'ok' }, { status: 'failed' }] }), { inserted: 0, failures: 1, failed: false, finishedAt: '2026-09-12' });
  assert.equal(completedRunSummary({ status: 'running' }), null);
});
test('X ranking uses only X data, true views then likes; unknown never becomes zero', () => {
  const items = [row('rss', '2026-09-12T01:00:00Z', { metrics: { views: 1000 } }), ...[
    ['unknown', { likes: 90 }], ['zero', { views: 0 }], ['popular', { views: 12, likes: 4 }], ['same-views', { views: 12, likes: 8 }],
  ].map(([id, metrics]) => row(id, '2026-09-12T01:00:00Z', { sourceId: 'aisa-x', metrics }))];
  assert.deepEqual(rankXItems(items, { now }).map(item => item.id), ['same-views', 'popular', 'zero', 'unknown']);
  assert.equal(metricValue(null), null);
  assert.equal(metricValue(-1), null);
  assert.equal(metricValue(0), 0);
});
test('recent X ranking does not treat newly imported undated history as current news', () => {
  const items = [row('undated-x', null, { sourceId: 'aisa-x', metrics: { views: 900 } }), row('dated-x', '2026-09-12T01:00:00Z', { sourceId: 'aisa-x' })];
  assert.deepEqual(rankXItems(items, { now }).map(item => item.id), ['dated-x']);
  assert.equal(rankXItems(items, { now, range: 'all' }).length, 2);
});
test('an article first discovered through web remains visible under every subsequently recorded source', () => {
  const crossSource = row('web-then-x', '2026-09-12T01:00:00Z', { sourceId: 'aisa-web', sourceIds: ['aisa-web', 'aisa-x'], metrics: { views: 120 } });
  const webOnly = row('web-only', '2026-09-12T01:00:00Z', { sourceId: 'aisa-web', sourceIds: ['aisa-web'], metrics: { views: 999 } });
  const xOnly = row('x-only', '2026-09-12T01:00:00Z', { sourceId: 'aisa-x', metrics: { views: 30 } });
  const items = [crossSource, webOnly, xOnly];
  assert.deepEqual(filterFeed(items, { now, source: 'aisa-x' }).map(item => item.id), ['web-then-x', 'x-only']);
  assert.deepEqual(filterFeed(items, { now, source: 'aisa-web' }).map(item => item.id), ['web-then-x', 'web-only']);
  assert.deepEqual(rankXItems(items, { now }).map(item => item.id), ['web-then-x', 'x-only']);
  assert.equal(crossSource.sourceId, 'aisa-web');
  assert.equal(filterFeed(items, { now }).length, 3);
});
