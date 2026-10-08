import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { canonicalUrl, plainText, InputError } from './store.mjs';
import { fetchPublicText } from './public-fetch.mjs';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, processEntities: true, trimValues: true });
const array = x => x == null ? [] : Array.isArray(x) ? x : [x];

export async function fetchFeed(input, options = {}) {
  return (await fetchPublicText(input, options)).text;
}

export function parseFeed(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('不支持的 XML / RSS 文档');
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(markup)) throw new Error('不支持的 XML / RSS 文档');
  const valid = XMLValidator.validate(xml); if (valid !== true) throw new Error('RSS XML 格式无效');
  const doc = parser.parse(xml);
  let entries;
  if (doc.rss?.channel) entries = array(doc.rss.channel.item);
  else if (doc.feed) entries = array(doc.feed.entry);
  else if (doc.RDF) entries = array(doc.RDF.item);
  else throw new Error('响应不是 RSS 或 Atom feed');
  const candidates = entries.slice(0, 1000);
  const items = candidates.flatMap(entry => {
    const links = array(entry.link);
    const atomLink = links.find(l => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate') && l['@_href']);
    const rawUrl = atomLink?.['@_href'] ?? links.find(l => typeof l === 'string') ?? (typeof entry.guid === 'string' ? entry.guid : entry.guid?.['#text']);
    const url = canonicalUrl(rawUrl); const title = plainText(entry.title, 500);
    if (!url || !title) return [];
    return [{ title, url, summary: plainText(entry.description ?? entry.summary ?? entry.encoded ?? entry.content, 3000), publishedAt: entry.pubDate ?? entry.published ?? entry.updated ?? entry.date ?? null }];
  });
  if (candidates.length && !items.length) throw new Error(`RSS / Atom 的 ${candidates.length} 条记录均无有效标题或公开 HTTPS 链接，未入库`);
  return items;
}

export async function collect(store, { sourceIds, ...options } = {}) {
  if (sourceIds !== undefined && (!Array.isArray(sourceIds) || sourceIds.some(id => typeof id !== 'string'))) throw new InputError('sourceIds 必须是来源 ID 数组');
  const all = store.listSources();
  if (sourceIds?.some(id => !all.some(s => s.id === id && s.kind === 'rss' && s.enabled && !s.archived))) throw new InputError('只能采集已启用且未归档的免费 RSS 来源');
  const sources = all.filter(s => s.enabled && !s.archived && s.kind === 'rss' && (!sourceIds || sourceIds.includes(s.id)));
  if (!sources.length) throw new InputError('没有可采集的免费来源');
  const runId = store.beginRun(sources.map(s => s.id));
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const source = sources[next++]; const startedAt = new Date().toISOString();
      try {
        const xml = await fetchFeed(source.url, options); const entries = parseFeed(xml); const counts = store.upsertItems(source.id, entries);
        store.recordSourceResult(runId, source.id, { status: 'ok', startedAt, itemCount: entries.length, ...counts });
      } catch (error) {
        const message = error.name === 'TimeoutError' || error.name === 'AbortError' ? '网络请求超时' : error.message === 'fetch failed' ? '网络连接失败' : plainText(error.message, 200);
        store.recordSourceResult(runId, source.id, { status: 'error', startedAt, error: message });
      }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(3, sources.length) }, worker)); return store.finishRun(runId); }
  catch { return store.finishRun(runId, '采集任务中断，已完成的结果仍保留'); }
}
