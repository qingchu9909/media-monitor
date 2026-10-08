const DAY = 24 * 60 * 60 * 1000;

export function itemTime(item) {
  const published = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
  if (Number.isFinite(published)) return { value: published, kind: 'published' };
  const discovered = item.firstSeenAt ? Date.parse(item.firstSeenAt) : NaN;
  return { value: Number.isFinite(discovered) ? discovered : null, kind: 'discovered' };
}

export function hasSource(item, source) {
  return item.sourceId === source || (Array.isArray(item.sourceIds) && item.sourceIds.includes(source));
}

export function isPaper(item) {
  return hasSource(item, 'arxiv') || item.platform === 'arxiv';
}

export function attachAnalysis(items, analysisByUrl = {}) {
  return items.map(item => ({ ...item, analysis: analysisByUrl[item.url] || null }));
}

export function filterFeed(items, { range = '24h', source = 'all', includePapers = false, starredOnly = false, topicId, query = '', now = Date.now() } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  const duration = range === '24h' ? DAY : range === '7d' ? DAY * 7 : null;
  return items.filter(item => {
    if (starredOnly && !item.starred) return false;
    if (source !== 'all' && !hasSource(item, source)) return false;
    if (!includePapers && isPaper(item)) return false;
    if (topicId && !item.topicIds?.includes(topicId)) return false;
    const time = itemTime(item);
    if (duration !== null && (time.value === null || time.value > now || time.value < now - duration)) return false;
    if (needle) {
      const text = [item.title, item.summary, item.sourceName, item.analysis?.titleZh, item.analysis?.summaryZh, item.analysis?.whyItMatters, item.research?.titleZh, item.research?.summaryZh, item.translation?.titleZh, item.translation?.summaryZh].filter(Boolean).join(' ').toLocaleLowerCase();
      if (!text.includes(needle)) return false;
    }
    return true;
  });
}

export function completedRunSummary(run) {
  if (!run?.finishedAt) return null;
  const failures = (run.results || []).filter(result => ['error', 'failed'].includes(result.status)).length;
  return { inserted: Number(run.inserted) || 0, failures, failed: run.status === 'failed', finishedAt: run.finishedAt };
}

export function metricValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function xPostIdentity(value) {
  try {
    const url = new URL(value);
    const hosts = ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'];
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d{0,19})(?:\/(?:photo|video)\/[1-4])?\/?$/);
    return match ? { handle: match[1], statusId: match[2] } : null;
  } catch { return null; }
}

export function xPostOrigin(item) {
  // Existing provider records keep their original provenance. A Web platform
  // label or a search result pointing to X is insufficient for this board.
  if (hasSource(item, 'aisa-x')) return 'aisa';
  const post = xPostIdentity(item.url), research = item.research;
  if (!post || !research || research.isStale !== false || research.verification !== 'original-page' || research.evidenceType !== 'original-page') return null;
  const evidencePost = xPostIdentity(research.url);
  if (evidencePost?.statusId !== post.statusId || typeof research.evidenceQuote !== 'string' || research.evidenceQuote.length < 8 || typeof research.pageEvidenceText !== 'string' || !research.pageEvidenceText.includes(research.evidenceQuote)) return null;
  return 'public-web';
}

export function rankXItems(items, { range = '24h', now = Date.now() } = {}) {
  const posts = items.filter(item => xPostOrigin(item));
  const timestamped = range === 'all' ? posts : posts.filter(item => itemTime(item).kind === 'published');
  return filterFeed(timestamped, { range, now, includePapers: true }).sort((a, b) => {
    for (const field of ['views', 'likes']) {
      const left = metricValue(a.metrics?.[field]);
      const right = metricValue(b.metrics?.[field]);
      if (left === null && right !== null) return 1;
      if (right === null && left !== null) return -1;
      if (left !== right) return right - left;
    }
    const published = item => itemTime(item).kind === 'published' ? itemTime(item).value : 0;
    return published(b) - published(a);
  });
}
