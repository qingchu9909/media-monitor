import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalUrl, InputError, plainText } from './store.mjs';

const MAX_FILE_BYTES = 1024 * 1024;
const text = (value, limit = 3000) => typeof value === 'string' ? plainText(value, limit) : '';
const texts = value => Array.isArray(value) ? value.slice(0, 100).map(x => text(x)).filter(Boolean) : [];
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function isBriefDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

// Only regular files under the two fixed directories are read; links cannot redirect reads.
async function regularFile(dataDir, folder, filename) {
  try {
    const directory = join(dataDir, folder);
    const dirStat = await lstat(directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
    const path = join(directory, filename);
    const fileStat = await lstat(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return null;
    if (fileStat.size > MAX_FILE_BYTES) throw new InputError('简报文件超过 1 MB，请缩小后重试', 422);
    return await readFile(path, 'utf8');
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}

const markdownText = value => String(value ?? '').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&');
const markdownUrl = value => value.replace(/[()<>\\\s]/g, c => encodeURIComponent(c));
const VERIFICATION = { 'video-description': '仅依据公开视频描述', 'original-page': '原文页面证据', 'feed-excerpt': 'RSS 摘要证据', 'provider-post': '接口返回原帖', legacy: '历史资料，未记录完整核验方式' };

export function renderBriefMarkdown(brief) {
  const lines = [`# ${markdownText(brief.title)}`, '', `日期：${brief.date}`, `生成时间：${brief.generatedAt}`, `整理方式：${markdownText(brief.generationMethod)}`, '', markdownText(brief.summary), '', '## 值得关注', ''];
  if (brief.highlights.some(item => isBriefDate(item.firstRecommendedDate))) lines.push('“本日新增”指首次进入已保存的日简报，不代表原文今天发布。', '');
  for (const item of brief.highlights) {
    lines.push(`### [${markdownText(item.titleZh)}](${markdownUrl(item.url)})`, '', markdownText(item.summaryZh), '', `值得关注：${markdownText(item.whyItMatters)}`, '', `来源：${markdownText(item.sourceName)} ｜ 原文发布时间：${item.publishedAt || '未提供'}`, '');
    if (isBriefDate(item.firstRecommendedDate) && item.firstRecommendedDate <= brief.date) lines.push(`推荐状态：${item.firstRecommendedDate === brief.date ? '本日新增' : '继续跟进'} ｜ 首次入选日报：${item.firstRecommendedDate}`, '');
    lines.push(`证据类型：${VERIFICATION[item.verification] || VERIFICATION.legacy}`, '');
    if (item.supportingQuote) lines.push(`支持引文：${markdownText(item.supportingQuote)}`, '');
  }
  if (brief.ideas.length) lines.push('## 可以做的选题', '');
  for (const idea of brief.ideas) {
    lines.push(`### ${markdownText(idea.title)}`, '', markdownText(idea.angle), '');
    if (idea.hook) lines.push(`开头：${markdownText(idea.hook)}`, '');
    for (const url of idea.sourceUrls) lines.push(`- [原始来源](${markdownUrl(url)})`);
    lines.push('');
  }
  for (const [title, entries] of [['来源覆盖', brief.coverage], ['需要留意', brief.caveats]]) {
    if (entries.length) lines.push(`## ${title}`, '', ...entries.map(value => `- ${markdownText(value)}`), '');
  }
  return lines.join('\n');
}

function metadata(brief, format) {
  return { date: brief.date, title: brief.title, generatedAt: brief.generatedAt, status: brief.status, summary: brief.summary, format, highlightCount: brief.highlights.length, ideaCount: brief.ideas.length, generationMethod: brief.generationMethod };
}

function structuredBrief(value, date) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.date !== date || value.status !== 'reviewed' || !text(value.title) || !timestamp(value.generatedAt) || !Array.isArray(value.highlights) || !Array.isArray(value.ideas) || !Array.isArray(value.coverage) || !Array.isArray(value.caveats)) {
    throw new InputError('结构化简报格式无效，需要日期、生成时间及 reviewed 状态等完整字段', 422);
  }
  const highlights = value.highlights.slice(0, 100).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const url = canonicalUrl(item.url);
    if (!url || !text(item.titleZh)) return [];
    return [{ ...(text(item.id, 100) ? { id: text(item.id, 100) } : {}), url, titleZh: text(item.titleZh, 500), summaryZh: text(item.summaryZh), whyItMatters: text(item.whyItMatters), sourceName: text(item.sourceName, 200), publishedAt: timestamp(item.publishedAt),
      ...(isBriefDate(item.firstRecommendedDate) && item.firstRecommendedDate <= date ? { firstRecommendedDate: item.firstRecommendedDate } : {}),
      verification: Object.hasOwn(VERIFICATION, item.verification) ? item.verification : 'legacy', supportingQuote: text(item.supportingQuote, 500) }];
  });
  const ideas = value.ideas.slice(0, 100).flatMap(idea => {
    if (!idea || typeof idea !== 'object' || !text(idea.title)) return [];
    const sourceUrls = [...new Set((Array.isArray(idea.sourceUrls) ? idea.sourceUrls : []).map(canonicalUrl).filter(Boolean))];
    if (!sourceUrls.length) return [];
    return [{ title: text(idea.title, 500), angle: text(idea.angle), ...(text(idea.hook) ? { hook: text(idea.hook) } : {}), sourceUrls }];
  });
  const result = { date, title: text(value.title, 500), generatedAt: timestamp(value.generatedAt), status: 'reviewed', summary: text(value.summary), generationMethod: text(value.generationMethod, 200) || '未注明生成方式', highlights, ideas, coverage: texts(value.coverage), caveats: texts(value.caveats) };
  const omitted = value.highlights.length - highlights.length + value.ideas.length - ideas.length;
  if (omitted) result.caveats.push(`${omitted} 项内容因缺少有效标题、来源链接或超出展示范围，未纳入本简报。`);
  return { ...result, metadata: metadata(result, 'structured'), markdown: renderBriefMarkdown(result) };
}

async function loadBrief(dataDir, date) {
  if (!isBriefDate(date)) throw new InputError('简报日期必须是有效的 YYYY-MM-DD', 400);
  const json = await regularFile(dataDir, 'briefs', `${date}.json`);
  if (json !== null) {
    let value;
    try { value = JSON.parse(json); } catch { throw new InputError('结构化简报 JSON 无法解析', 422); }
    return structuredBrief(value, date);
  }
  const markdown = await regularFile(dataDir, 'reports', `${date}-brief.md`);
  if (markdown === null || !markdown.trim()) return null;
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1];
  const result = { date, title: text(heading, 500) || `${date} 中文简报`, generatedAt: null, status: 'markdown-only', summary: '', generationMethod: '旧版 Markdown 文稿，未提供结构化生成记录', highlights: [], ideas: [], coverage: [], caveats: ['仅展示已保存文稿，不能据此确认每一项内容的核验状态。'] };
  return { ...result, metadata: metadata(result, 'markdown'), markdown };
}

async function briefDates(dataDir, includeReports = true) {
  const dates = new Set();
  const folders = [['briefs', /^(\d{4}-\d{2}-\d{2})\.json$/], ...(includeReports ? [['reports', /^(\d{4}-\d{2}-\d{2})-brief\.md$/]] : [])];
  for (const [folder, pattern] of folders) {
    const directory = join(dataDir, folder);
    const dirStat = await lstat(directory).catch(error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; });
    if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const date = entry.isFile() && entry.name.match(pattern)?.[1];
      if (isBriefDate(date)) dates.add(date);
    }
  }
  return [...dates].sort();
}

function decorateWithHistory(brief, firstByUrl) {
  return { ...brief, highlights: brief.highlights.map(item => {
    const url = canonicalUrl(item.url);
    if (!url) return { ...item };
    const persisted = isBriefDate(item.firstRecommendedDate) && item.firstRecommendedDate <= brief.date ? item.firstRecommendedDate : brief.date;
    const earlier = firstByUrl.get(url);
    const firstRecommendedDate = earlier && earlier < persisted ? earlier : persisted;
    return { ...item, firstRecommendedDate, newToBrief: firstRecommendedDate === brief.date };
  }) };
}

function rememberRecommendations(brief, firstByUrl) {
  for (const item of brief.highlights) {
    const url = canonicalUrl(item.url);
    if (!url) continue;
    const first = isBriefDate(item.firstRecommendedDate) && item.firstRecommendedDate <= brief.date ? item.firstRecommendedDate : brief.date;
    if (!firstByUrl.has(url) || first < firstByUrl.get(url)) firstByUrl.set(url, first);
  }
}

// Root daily JSON files are the history; same-day backups and future briefs are excluded.
// The returned copy can be persisted by the caller without rewriting existing files on reads.
export async function decorateBriefHistory(dataDir, brief) {
  if (!isBriefDate(brief?.date) || !Array.isArray(brief.highlights)) throw new InputError('简报需要有效日期与 highlights 列表', 422);
  const firstByUrl = new Map();
  for (const date of (await briefDates(dataDir, false)).filter(date => date < brief.date)) {
    try {
      const earlier = await loadBrief(dataDir, date);
      if (earlier) rememberRecommendations(earlier, firstByUrl);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
    }
  }
  return decorateWithHistory(brief, firstByUrl);
}

function presentation(brief) {
  return brief.status === 'reviewed' ? { ...brief, metadata: metadata(brief, 'structured'), markdown: renderBriefMarkdown(brief) } : brief;
}

export async function getBrief(dataDir, date) {
  const brief = await loadBrief(dataDir, date);
  return brief?.status === 'reviewed' ? presentation(await decorateBriefHistory(dataDir, brief)) : brief;
}

export async function readBriefCatalog(dataDir) {
  const documents = [];
  const firstByUrl = new Map();
  for (const date of await briefDates(dataDir)) {
    try {
      const brief = await loadBrief(dataDir, date);
      if (brief) {
        const decorated = presentation(decorateWithHistory(brief, firstByUrl));
        documents.push(decorated);
        rememberRecommendations(decorated, firstByUrl);
      }
    } catch (error) {
      // Bad individual documents do not hide earlier readable briefs; their detail URL returns 422.
      if (!(error instanceof InputError)) throw error;
    }
  }
  documents.reverse();
  const briefs = documents.map(brief => brief.metadata);
  const analysisByUrl = Object.create(null);
  for (const brief of documents) for (const item of brief.highlights) {
    if (!analysisByUrl[item.url]) analysisByUrl[item.url] = { ...item, brief: brief.metadata };
  }
  return { briefs, latest: briefs[0] ?? null, analysisByUrl };
}
