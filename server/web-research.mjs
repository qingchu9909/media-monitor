import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { InputError, canonicalUrl, plainText } from './store.mjs';
import { fetchPublicText, validatePublicUrl } from './public-fetch.mjs';

export const MAX_RESEARCH_BYTES = 1024 * 1024;
const required = ['sourceName', 'url', 'title', 'summary', 'publishedAt', 'retrievedAt', 'titleZh', 'summaryZh', 'evidenceType', 'evidenceText', 'evidenceQuote'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clean = (text, limit) => plainText(plainText(text, limit), limit);
function text(value, key, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !clean(value, max))) throw new InputError(`网页研究字段 ${key} 为空、过长或格式无效`);
  return clean(value, max);
}
function timestamp(value, key, now, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new InputError(`${key} 必须是带时区的真实时间；不知道时 publishedAt 填 null`);
  const calendar = value.slice(0, 10);
  if (new Date(calendar + 'T00:00:00Z').toISOString().slice(0, 10) !== calendar || Date.parse(value) > now.getTime() + 120000) throw new InputError(`${key} 日期无效或在未来`);
  return new Date(value).toISOString();
}

export function validateResearchPayload(payload, now = new Date()) {
  if (!Number.isFinite(now.getTime()) || !object(payload) || Object.keys(payload).length !== 2 || payload.schemaVersion !== 1 || !Array.isArray(payload.items) || !payload.items.length || payload.items.length > 30) throw new InputError('网页研究需要 schemaVersion:1 和 1–30 条 items');
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_RESEARCH_BYTES) throw new InputError('网页研究输入超过 1 MB');
  const urls = new Set();
  return payload.items.map(row => {
    if (!object(row) || required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => ![...required, 'dateEvidence'].includes(key))) throw new InputError('网页研究字段不完整或含不支持字段');
    try { validatePublicUrl(row.url); } catch (error) { throw new InputError(error.message); }
    const url = canonicalUrl(row.url);
    if (!url || row.url.length > 4000 || urls.has(url)) throw new InputError('网页研究链接无效、过长或重复');
    urls.add(url);
    if (!['original-page', 'search-snippet'].includes(row.evidenceType)) throw new InputError('evidenceType 只能是 original-page 或 search-snippet');
    const item = { sourceName: text(row.sourceName, 'sourceName', 80), url, originalUrl: row.url, title: text(row.title, 'title', 500), summary: text(row.summary, 'summary', 3000, true),
      publishedAt: timestamp(row.publishedAt, 'publishedAt', now, true), retrievedAt: timestamp(row.retrievedAt, 'retrievedAt', now), titleZh: text(row.titleZh, 'titleZh', 500), summaryZh: text(row.summaryZh, 'summaryZh', 2000),
      evidenceType: row.evidenceType, evidenceText: text(row.evidenceText, 'evidenceText', 16000), evidenceQuote: text(row.evidenceQuote, 'evidenceQuote', 500), dateEvidence: row.dateEvidence === undefined ? null : text(row.dateEvidence, 'dateEvidence', 500) };
    if (!/\p{Script=Han}/u.test(item.titleZh + item.summaryZh) || item.evidenceQuote.length < 8 || !item.evidenceText.includes(item.evidenceQuote)) throw new InputError('需要中文整理及至少 8 字符、命中所提供证据的原样引文');
    return item;
  });
}

// Read only: importing research must not recover, cancel or change another job.
export function assertNoActiveResearchJob(dataDir) {
  const filename = join(dataDir, 'operations.sqlite');
  let info; try { info = lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw new InputError('任务数据库必须为普通文件', 409);
  const db = new DatabaseSync(filename, { readOnly: true });
  try { if (db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','running') LIMIT 1").get()) throw new InputError('已有更新或分析任务，完成后再导入网页研究', 409); }
  finally { db.close(); }
}

function pageText(html) {
  if (typeof html !== 'string') throw new InputError('网页正文格式无效');
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  return clean(article || main || html, 16000);
}

function playerJson(html) {
  const assignment = /\bytInitialPlayerResponse\s*=\s*/g.exec(html);
  if (!assignment) return null;
  const start = assignment.index + assignment[0].length;
  if (html[start] !== '{') return null;
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, index + 1)); } catch { return null; }
    }
  }
  return null;
}

export function extractResearchPageEvidence(html, url) {
  if (typeof html !== 'string') throw new InputError('网页正文格式无效');
  const address = validatePublicUrl(url);
  const videoId = address.pathname === '/watch' ? address.searchParams.get('v') : address.pathname.match(/^\/(?:shorts|embed)\/([\w-]{11})(?:\/|$)/)?.[1];
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(address.hostname) || !/^[\w-]{11}$/.test(videoId ?? '')) return { text: pageText(html), contentKind: 'web-page' };
  const metadata = new Map();
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = Object.fromEntries([...tag[0].matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map(match => [match[1].toLowerCase(), match[3]]));
    if (attributes.content) metadata.set((attributes.name || attributes.property || '').toLowerCase(), attributes.content);
  }
  // Parse only the literal public JSON object; never evaluate surrounding script.
  const details = playerJson(html)?.videoDetails;
  const matching = details?.videoId === videoId ? details : null;
  const title = matching?.title || metadata.get('og:title') || html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const description = matching?.shortDescription || metadata.get('description') || metadata.get('og:description') || '';
  const text = [title, description].filter(value => typeof value === 'string').map(value => clean(value, 16000)).filter(Boolean).join('\n');
  return { text, contentKind: 'video-description' };
}

/** Imports research already gathered by the calling user task/automation.
 * No search, model, paid API, credential lookup or automatic retry occurs here. */
export async function importWebResearch({ store, payload, signal, fetchText = fetchPublicText, now = new Date() }) {
  const items = validateResearchPayload(payload, now);
  signal?.throwIfAborted(); assertNoActiveResearchJob(store.dataDir);
  if (store.isCollecting()) throw new InputError('采集正在运行，完成后再导入网页研究', 409);
  const sources = new Map(items.map(item => [item.url, store.ensureResearchSource({ name: item.sourceName, url: item.originalUrl })]));
  const sourceIds = [...new Set([...sources.values()].map(source => source.id))];
  let runId;
  const startedAt = new Date().toISOString();
  try {
    runId = store.beginRun(sourceIds, { kind: 'web-research' });
    assertNoActiveResearchJob(store.dataDir);
    const records = [];
    for (let offset = 0; offset < items.length; offset += 3) {
      const batch = await Promise.all(items.slice(offset, offset + 3).map(async item => {
        signal?.throwIfAborted();
        const research = { ...item, method: 'codex-web-research', verification: 'research-lead', checkedAt: null, finalUrl: null, pageEvidenceText: null, verificationError: item.evidenceType === 'search-snippet' ? '仅保存所提供的搜索线索，尚未核验原文页面' : null };
        if (item.evidenceType === 'original-page') {
          try {
            const response = await fetchText(item.originalUrl, { signal, timeoutMs: 12000, maxBytes: 2 * 1024 * 1024 });
            research.checkedAt = new Date().toISOString();
            research.finalUrl = response.url ?? item.originalUrl;
            validatePublicUrl(research.finalUrl);
            const extracted = extractResearchPageEvidence(response.text, research.finalUrl);
            research.pageEvidenceText = extracted.text;
            research.contentKind = extracted.contentKind;
            if (!research.pageEvidenceText.includes(item.evidenceQuote)) throw new Error('引文未在本次读取的网页正文中找到');
            research.verification = 'original-page'; research.verificationError = null;
          } catch (error) {
            signal?.throwIfAborted();
            research.verificationError = '原文读取或引文核对未完成：' + clean(error.message, 200);
          }
        }
        return { sourceId: sources.get(item.url).id, url: item.url, title: item.title, summary: item.summary, publishedAt: item.publishedAt, research };
      }));
      records.push(...batch);
    }
    signal?.throwIfAborted(); assertNoActiveResearchJob(store.dataDir);
    const { bySource, ...counts } = store.upsertResearchItems(records);
    for (const sourceId of sourceIds) {
      const own = bySource[sourceId];
      store.recordSourceResult(runId, sourceId, { status: 'ok', startedAt, itemCount: own.total, inserted: own.inserted, updated: own.updated });
    }
    const run = store.finishRun(runId);
    const verified = records.filter(row => row.research.verification === 'original-page').length;
    return { kind: 'web-research', runId: run.id, status: run.status, ...counts, verified, leads: records.length - verified,
      results: records.map(row => ({ url: row.url, verification: row.research.verification, error: row.research.verificationError })),
      note: '已保存本次提供的网页研究；原文引文命中与待核验线索分别标注，未调用 AIsa 或模型。' };
  } catch (error) {
    if (runId) {
      const message = error.name === 'AbortError' ? '网页研究导入已取消' : clean(error.message, 300);
      for (const sourceId of sourceIds) store.recordSourceResult(runId, sourceId, { status: 'error', startedAt, error: message });
      store.finishRun(runId, message);
    }
    throw error;
  }
}
