import test from 'node:test';
import assert from 'node:assert/strict';
import { filterFeed, rankXItems, xPostIdentity, xPostOrigin } from '../src/feed-filters.mjs';

const now = Date.parse('2026-09-13T08:00:00Z');
const url = 'https://x.com/OpenAI/status/2097394956457623964';
function researched(id = 'public-x', extra = {}) {
  return {
    id, url, sourceId: 'research-x', sourceKind: 'web-research', platform: 'Web',
    title: 'A public video update', summary: 'A new public video workflow is available.',
    publishedAt: '2026-09-13T01:00:00Z', firstSeenAt: '2026-09-13T07:00:00Z',
    metrics: { views: null, likes: null, reposts: null, replies: null },
    research: { url, isStale: false, evidenceType: 'original-page', verification: 'original-page', evidenceQuote: 'public video workflow', pageEvidenceText: 'A new public video workflow is available.', titleZh: '公开的视频更新', summaryZh: '原帖介绍新的视频工作流程。' },
    ...extra,
  };
}

test('verified public X posts join historical AIsa data without turning unknown metrics into heat', () => {
  const older = researched('public-older', { publishedAt: '2026-09-12T10:00:00Z', firstSeenAt: '2026-09-13T07:59:00Z' });
  const newer = researched('public-newer');
  const aisa = { ...researched('aisa-history'), sourceId: 'aisa-x', sourceKind: 'aisa', metrics: { views: 0, likes: 0 }, research: undefined };
  const input = [older, newer, aisa];
  assert.deepEqual(rankXItems(input, { now }).map(item => item.id), ['aisa-history', 'public-newer', 'public-older']);
  assert.equal(xPostOrigin(newer), 'public-web');
  assert.equal(xPostOrigin(aisa), 'aisa');
  assert.equal(newer.metrics.views, null);
  assert.equal(newer.metrics.likes, null);
  assert.deepEqual(input.map(item => item.id), ['public-older', 'public-newer', 'aisa-history']);
});

test('search snippets, stale research, unrelated pages and unmatched evidence cannot become X posts', () => {
  const base = researched();
  const cases = [
    { research: undefined },
    { research: { ...base.research, isStale: true } },
    { research: { ...base.research, isStale: undefined } },
    { research: { ...base.research, verification: 'research-lead' } },
    { research: { ...base.research, evidenceType: 'search-snippet' } },
    { research: { ...base.research, pageEvidenceText: 'A different page has no matching quote.' } },
    { research: { ...base.research, url: 'https://x.com/OpenAI/status/123' } },
    { url: 'https://x.com/OpenAI' },
    { url: 'https://x.com/search?q=OpenAI' },
    { url: 'https://example.org/posts/2097394956457623964', platform: 'X' },
    { url: 'https://x.com.evil.example/OpenAI/status/2097394956457623964' },
  ].map((extra, index) => researched(`excluded-${index}`, extra));
  assert.deepEqual(rankXItems(cases, { now, range: 'all' }), []);
});

test('research uses original publication time rather than the time it was found or checked', () => {
  const old = researched('old', { publishedAt: '2026-09-01T01:00:00Z' });
  const unknown = researched('unknown', { publishedAt: null });
  const future = researched('future', { publishedAt: '2026-09-14T01:00:00Z' });
  assert.deepEqual(rankXItems([old, unknown, future], { now }), []);
  assert.deepEqual(rankXItems([unknown, old], { now, range: 'all' }).map(item => item.id), ['old', 'unknown']);
});

test('a handle is extracted only from a direct official X status URL', () => {
  assert.deepEqual(xPostIdentity(url), { handle: 'OpenAI', statusId: '2097394956457623964' });
  assert.deepEqual(xPostIdentity('https://mobile.twitter.com/Some_Account/status/123/photo/1?s=20'), { handle: 'Some_Account', statusId: '123' });
  for (const invalid of ['http://x.com/OpenAI/status/123', 'https://x.com@evil.example/OpenAI/status/123', 'https://user@x.com/OpenAI/status/123', 'https://x.com/OpenAI/status/not-a-post', 'https://x.com/OpenAI/status/123/analytics', 'https://x.com/OpenAI/status/0', 'javascript:alert(1)']) assert.equal(xPostIdentity(invalid), null);
});

test('adding X research eligibility preserves Chinese research and translation search', () => {
  const publicItem = researched();
  const translated = { ...researched('translated'), research: undefined, translation: { titleZh: '字幕功能', summaryZh: '支持本地导出' } };
  assert.deepEqual(filterFeed([publicItem, translated], { now, query: '视频工作流程' }).map(item => item.id), ['public-x']);
  assert.deepEqual(filterFeed([publicItem, translated], { now, query: '本地导出' }).map(item => item.id), ['translated']);
});
