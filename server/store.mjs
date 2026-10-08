import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validatePublicUrl } from './public-fetch.mjs';

const DEFAULT_TOPICS = [
  { id: 'ai', name: 'AI 产品发布', keywords: ['OpenAI', 'GPT', 'Claude', 'model', 'release', '模型发布'] },
  { id: 'tools', name: 'Agent / 开源工具', keywords: ['agent', 'GitHub', 'developer', 'coding', '开源', '代码'] },
  { id: 'video', name: 'AI 视频创作', keywords: ['video', '视频', 'Sora', 'Veo', 'Kling', 'diffusion', '生成影像'] },
];
const DEFAULT_SOURCES = [
  { id: 'openai', name: 'OpenAI News', kind: 'rss', platform: 'OpenAI', url: 'https://openai.com/news/rss.xml', enabled: true },
  { id: 'huggingface', name: 'Hugging Face', kind: 'rss', platform: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', enabled: true },
  { id: 'github', name: 'GitHub Blog', kind: 'rss', platform: 'GitHub', url: 'https://github.blog/feed/', enabled: true },
  { id: 'arxiv', name: 'arXiv · cs.AI', kind: 'rss', platform: 'arXiv', url: 'https://rss.arxiv.org/rss/cs.AI', enabled: true },
  { id: 'aisa-x', name: 'X · AIsa', kind: 'aisa', platform: 'X', url: 'https://aisa.one', enabled: false },
  { id: 'aisa-youtube', name: 'YouTube · AIsa', kind: 'aisa', platform: 'YouTube', url: 'https://aisa.one', enabled: false },
  { id: 'aisa-reddit', name: 'Reddit · AIsa', kind: 'aisa', platform: 'Reddit', url: 'https://aisa.one', enabled: false },
  { id: 'aisa-web', name: '全网搜索 · AIsa', kind: 'aisa', platform: '全网', url: 'https://aisa.one', enabled: false },
];

export class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

export function plainText(value, limit = 3000) {
  const raw = typeof value === 'object' && value !== null ? (value['#text'] ?? '') : value;
  return String(raw ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '').replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => { const cp = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[e.toLowerCase()])
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// Counts are observations from the provider, never an inferred popularity score.
export function sanitizeSocialMetadata(value = {}) {
  const label = (text, limit) => typeof text === 'string' ? plainText(plainText(text, limit), limit) || null : null;
  const count = value => {
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value.trim());
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  return {
    author: { name: label(value?.author?.name, 200), handle: label(value?.author?.handle, 100) },
    metrics: { views: count(value?.metrics?.views), likes: count(value?.metrics?.likes), reposts: count(value?.metrics?.reposts), replies: count(value?.metrics?.replies) },
  };
}

function readSocialMetadata(data) {
  try { return sanitizeSocialMetadata(JSON.parse(data)); } catch { return sanitizeSocialMetadata(); }
}

const researchContentHash = item => createHash('sha256').update(JSON.stringify({ url: item.url, title: item.title, summary: item.summary })).digest('hex');

export function canonicalUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    const host = url.hostname.toLowerCase();
    if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|ref_url|mkt_tok)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString();
  } catch { return null; }
}

function validateTopic(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('主题参数必须是对象');
  if (Object.keys(input).some(k => !['name', 'keywords', 'enabled'].includes(k))) throw new InputError('不支持的主题字段');
  const result = {};
  if (!partial || 'name' in input) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) throw new InputError('主题名称需为 1–60 个字符');
    result.name = plainText(input.name, 60);
    if (!result.name) throw new InputError('主题名称不能为空');
  }
  if (!partial || 'keywords' in input) {
    if (!Array.isArray(input.keywords) || input.keywords.length > 30 || input.keywords.some(k => typeof k !== 'string' || !k.trim() || k.length > 80)) throw new InputError('关键词需为最多 30 个非空短文本');
    result.keywords = [...new Set(input.keywords.map(k => plainText(k, 80)).filter(Boolean))];
    if (!result.keywords.length) throw new InputError('请至少填写一个关键词');
  }
  if ('enabled' in input) { if (typeof input.enabled !== 'boolean') throw new InputError('enabled 必须为布尔值'); result.enabled = input.enabled; }
  return result;
}

function matches(text, keyword) {
  const lower = keyword.toLowerCase();
  if (/^[a-z0-9]{1,3}$/.test(lower)) return new RegExp(`(^|[^a-z0-9])${lower}([^a-z0-9]|$)`, 'i').test(text);
  return text.includes(lower);
}

function validateSource(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('来源参数必须是对象');
  const allowed = partial ? ['name', 'url', 'platform', 'enabled'] : ['name', 'url', 'platform', 'kind', 'enabled'];
  if (!Object.keys(input).length || Object.keys(input).some(key => !allowed.includes(key))) throw new InputError('不支持的来源字段');
  if (!partial && input.kind !== 'rss') throw new InputError('只能添加免费 RSS / Atom 来源');
  const result = {};
  for (const field of ['name', 'platform']) {
    if (field in input || (!partial && field === 'name')) {
      if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 80) throw new InputError('来源名称和平台需为 1–80 个字符');
      result[field] = plainText(input[field], 80);
      if (!result[field]) throw new InputError('来源名称和平台不能为空');
    }
  }
  if (!partial || 'url' in input) {
    try { validatePublicUrl(input.url); } catch (error) { throw new InputError(error.message); }
    // Keep the supplied query string intact; feed parameters can be signed or ordered.
    result.url = input.url;
  }
  if ('enabled' in input) { if (typeof input.enabled !== 'boolean') throw new InputError('enabled 必须为布尔值'); result.enabled = input.enabled; }
  return result;
}

export function openStore(dataDir = resolve('data')) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'monitor.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS topics(id TEXT PRIMARY KEY,name TEXT NOT NULL,keywords TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,platform TEXT NOT NULL,url TEXT NOT NULL,enabled INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'idle',lastRun TEXT,error TEXT,itemCount INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,url TEXT UNIQUE NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,publishedAt TEXT,sourceId TEXT NOT NULL REFERENCES sources(id),starred INTEGER NOT NULL DEFAULT 0,firstSeenAt TEXT NOT NULL,lastSeenAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS item_metadata(itemId TEXT PRIMARY KEY REFERENCES items(id),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS item_research(itemId TEXT PRIMARY KEY REFERENCES items(id),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS item_sources(itemId TEXT NOT NULL REFERENCES items(id),sourceId TEXT NOT NULL REFERENCES sources(id),PRIMARY KEY(itemId,sourceId));
    CREATE TABLE IF NOT EXISTS item_topics(itemId TEXT NOT NULL REFERENCES items(id),topicId TEXT NOT NULL REFERENCES topics(id),PRIMARY KEY(itemId,topicId));
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,startedAt TEXT NOT NULL,finishedAt TEXT,status TEXT NOT NULL,sourceIds TEXT NOT NULL,inserted INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL DEFAULT 0,error TEXT);
    CREATE TABLE IF NOT EXISTS run_metadata(runId TEXT PRIMARY KEY REFERENCES runs(id),kind TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(status) WHERE status='running';
    CREATE TABLE IF NOT EXISTS source_runs(runId TEXT NOT NULL REFERENCES runs(id),sourceId TEXT NOT NULL REFERENCES sources(id),status TEXT NOT NULL,startedAt TEXT,finishedAt TEXT,itemCount INTEGER NOT NULL DEFAULT 0,inserted INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(runId,sourceId));
    CREATE INDEX IF NOT EXISTS items_date ON items(publishedAt DESC,firstSeenAt DESC);`);
  const now = () => new Date().toISOString();
  const expireInterruptedRuns = () => db.prepare("UPDATE runs SET status='failed',finishedAt=?,error='上次采集超过 10 分钟未完成，可能已中断' WHERE status='running' AND startedAt < ?").run(now(), new Date(Date.now() - 600000).toISOString());
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  tx(() => {
    if (!db.prepare('PRAGMA table_info(sources)').all().some(column => column.name === 'archived')) db.exec('ALTER TABLE sources ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    for (const t of DEFAULT_TOPICS) db.prepare('INSERT OR IGNORE INTO topics(id,name,keywords,createdAt) VALUES(?,?,?,?)').run(t.id, t.name, JSON.stringify(t.keywords), now());
    for (const s of DEFAULT_SOURCES) db.prepare('INSERT OR IGNORE INTO sources(id,name,kind,platform,url,enabled,status) VALUES(?,?,?,?,?,?,?)').run(s.id,s.name,s.kind,s.platform,s.url,+s.enabled,s.enabled ? 'idle' : 'pending');
  });
  const listTopics = () => db.prepare('SELECT * FROM topics ORDER BY createdAt,id').all().map(t => ({ ...t, keywords: JSON.parse(t.keywords), enabled: !!t.enabled }));
  const listSources = () => db.prepare('SELECT * FROM sources ORDER BY rowid').all().map(s => ({ ...s, enabled: !!s.enabled, archived: !!s.archived }));
  const getSource = id => listSources().find(s => s.id === id);
  const sourceWriteGuard = () => {
    expireInterruptedRuns();
    if (db.prepare("SELECT id FROM runs WHERE status='running'").get()) throw new InputError('采集正在进行，请完成后再修改来源', 409);
  };
  const sourceUrlGuard = (url, id) => {
    const key = new URL(url).href;
    if (listSources().some(source => source.kind === 'rss' && source.id !== id && new URL(source.url).href === key)) throw new InputError('已存在同一订阅地址；若已归档，请恢复已有来源', 409);
  };
  function rematch(itemId) {
    const item = db.prepare('SELECT title,summary FROM items WHERE id=?').get(itemId);
    const sourceText = db.prepare('SELECT s.name FROM item_sources x JOIN sources s ON s.id=x.sourceId WHERE x.itemId=?').all(itemId).map(s => s.name).join(' ');
    const text = `${item.title} ${item.summary} ${sourceText}`.toLowerCase();
    db.prepare('DELETE FROM item_topics WHERE itemId=?').run(itemId);
    for (const t of listTopics()) if (t.enabled && t.keywords.some(k => matches(text, k))) db.prepare('INSERT INTO item_topics(itemId,topicId) VALUES(?,?)').run(itemId,t.id);
  }
  const rematchAll = () => { for (const item of db.prepare('SELECT id FROM items').all()) rematch(item.id); };
  function decorateItems(items) {
    const topicMap = new Map();
    for (const x of db.prepare('SELECT * FROM item_topics').all()) { if (!topicMap.has(x.itemId)) topicMap.set(x.itemId, []); topicMap.get(x.itemId).push(x.topicId); }
    const sourceMap = new Map();
    for (const x of db.prepare('SELECT * FROM item_sources').all()) { if (!sourceMap.has(x.itemId)) sourceMap.set(x.itemId, []); sourceMap.get(x.itemId).push(x.sourceId); }
    const metadataMap = new Map(db.prepare('SELECT itemId,data FROM item_metadata').all().map(x => [x.itemId, readSocialMetadata(x.data)]));
    const researchMap = new Map(db.prepare('SELECT itemId,data FROM item_research').all().flatMap(x => { try { return [[x.itemId, JSON.parse(x.data)]]; } catch { return []; } }));
    return items.map(i => ({ ...i, ...(metadataMap.get(i.id) ?? sanitizeSocialMetadata()), ...(researchMap.has(i.id) ? { research: { ...researchMap.get(i.id), isStale: researchMap.get(i.id)?.sourceContentHash !== researchContentHash(i) } } : {}), starred: !!i.starred, topicIds: topicMap.get(i.id) ?? [], sourceIds: sourceMap.get(i.id) ?? [i.sourceId] }));
  }
  function listItems({ limit = 2000, includeStarred = false } = {}) {
    const count = Math.max(1, Math.min(10000, Number(limit) || 2000));
    const query = includeStarred
      ? 'SELECT i.*,s.name AS sourceName,s.platform,s.kind AS sourceKind FROM items i JOIN sources s ON s.id=i.sourceId WHERE i.starred=1 OR i.id IN (SELECT id FROM items ORDER BY COALESCE(publishedAt,firstSeenAt) DESC LIMIT ?) ORDER BY COALESCE(i.publishedAt,i.firstSeenAt) DESC'
      : 'SELECT i.*,s.name AS sourceName,s.platform,s.kind AS sourceKind FROM items i JOIN sources s ON s.id=i.sourceId ORDER BY COALESCE(i.publishedAt,i.firstSeenAt) DESC LIMIT ?';
    return decorateItems(db.prepare(query).all(count));
  }
  const updateSourceResult = (id, result) => {
    if (!getSource(id)) throw new InputError('来源不存在', 404);
    db.prepare('UPDATE sources SET status=?,lastRun=?,error=?,itemCount=? WHERE id=?').run(result.status, result.lastRun ?? now(), result.error ? plainText(result.error, 300) : null, result.itemCount ?? 0,id);
  };
  let closed = false;
  return {
    dataDir, listTopics, listSources, getSource, listItems, updateSourceResult,
    close() { if (!closed) { db.close(); closed = true; } },
    ensureResearchSource({ name, url }) {
      if (typeof name !== 'string' || !plainText(name, 80) || name.length > 80) throw new InputError('网页研究需要来源名称');
      let address; try { address = validatePublicUrl(url); } catch (error) { throw new InputError(error.message); }
      const id = 'research-' + createHash('sha256').update(address.hostname.toLowerCase()).digest('hex').slice(0, 20);
      return tx(() => {
        sourceWriteGuard();
        const existing = getSource(id);
        if (existing?.archived) throw new InputError('该网页研究来源已归档，请先恢复', 409);
        if (existing && existing.kind !== 'web-research') throw new InputError('网页研究来源标识冲突', 409);
        db.prepare("INSERT OR IGNORE INTO sources(id,name,kind,platform,url,enabled,status,archived) VALUES(?,?,'web-research','Web',?,0,'idle',0)").run(id, plainText(name, 80) + ' · 网页研究', address.origin + '/');
        return getSource(id);
      });
    },
    // Only the validated research importer uses this path. Existing article text,
    // dates and primary attribution are immutable here, including RSS duplicates.
    upsertResearchItems(records) {
      if (!Array.isArray(records) || records.length > 30 || records.some(row => getSource(row.sourceId)?.kind !== 'web-research' || !canonicalUrl(row.url) || !row.title || !row.research)) throw new InputError('网页研究入库参数无效');
      return tx(() => {
        let inserted = 0, updated = 0;
        const bySource = {};
        for (const row of records) {
          const url = canonicalUrl(row.url);
          const existing = db.prepare('SELECT id,url,title,summary FROM items WHERE url=?').get(url);
          const id = existing?.id ?? randomUUID();
          bySource[row.sourceId] ??= { inserted: 0, updated: 0, total: 0 };
          bySource[row.sourceId][existing ? 'updated' : 'inserted']++; bySource[row.sourceId].total++;
          if (existing) { db.prepare('UPDATE items SET lastSeenAt=? WHERE id=?').run(now(), id); updated++; }
          else { db.prepare('INSERT INTO items(id,url,title,summary,publishedAt,sourceId,firstSeenAt,lastSeenAt) VALUES(?,?,?,?,?,?,?,?)').run(id, url, row.title, row.summary, row.publishedAt, row.sourceId, now(), now()); inserted++; }
          let previous; try { previous = JSON.parse(db.prepare('SELECT data FROM item_research WHERE itemId=?').get(id)?.data ?? 'null'); } catch { /* Treat invalid legacy metadata as absent. */ }
          const research = previous?.verification === 'original-page' && row.research.verification !== 'original-page'
            ? { ...previous, lastAttempt: { retrievedAt: row.research.retrievedAt, verification: row.research.verification, verificationError: row.research.verificationError } }
            : { ...row.research, sourceContentHash: researchContentHash(existing ?? { url, title: row.title, summary: row.summary }) };
          db.prepare('INSERT INTO item_research(itemId,data) VALUES(?,?) ON CONFLICT(itemId) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(research));
          db.prepare('INSERT OR IGNORE INTO item_sources(itemId,sourceId) VALUES(?,?)').run(id, row.sourceId); rematch(id);
        }
        return { inserted, updated, total: records.length, bySource };
      });
    },
    createSource(input) {
      const source = validateSource(input);
      return tx(() => {
        sourceWriteGuard(); sourceUrlGuard(source.url);
        const id = randomUUID();
        db.prepare('INSERT INTO sources(id,name,kind,platform,url,enabled,status,archived) VALUES(?,?,?,?,?,?,?,0)').run(id, source.name, 'rss', source.platform ?? new URL(source.url).hostname, source.url, +(source.enabled ?? true), 'idle');
        return getSource(id);
      });
    },
    updateSource(id, input) {
      const updates = validateSource(input, true);
      return tx(() => {
        sourceWriteGuard();
        const existing = getSource(id);
        if (!existing) throw new InputError('来源不存在', 404);
        if (existing.kind !== 'rss') throw new InputError('只有 RSS / Atom 来源可以编辑');
        if (existing.archived && updates.enabled === true) throw new InputError('请先恢复已归档来源，再启用采集', 409);
        const source = { ...existing, ...updates }; sourceUrlGuard(source.url, id);
        db.prepare('UPDATE sources SET name=?,platform=?,url=?,enabled=? WHERE id=?').run(source.name, source.platform, source.url, +source.enabled, id);
        if (source.url !== existing.url) db.prepare("UPDATE sources SET status='idle',lastRun=NULL,error=NULL,itemCount=0 WHERE id=?").run(id);
        if (source.name !== existing.name) rematchAll();
        return getSource(id);
      });
    },
    archiveSource(id) {
      return tx(() => {
        sourceWriteGuard();
        if (!getSource(id)) throw new InputError('来源不存在', 404);
        db.prepare('UPDATE sources SET archived=1,enabled=0 WHERE id=?').run(id);
        return getSource(id);
      });
    },
    restoreSource(id) {
      return tx(() => {
        sourceWriteGuard();
        if (!getSource(id)) throw new InputError('来源不存在', 404);
        // Restoring history does not silently resume network collection.
        db.prepare('UPDATE sources SET archived=0 WHERE id=?').run(id);
        return getSource(id);
      });
    },
    createTopic(input) {
      const t = validateTopic(input); const id = randomUUID();
      tx(() => { db.prepare('INSERT INTO topics(id,name,keywords,enabled,createdAt) VALUES(?,?,?,?,?)').run(id,t.name,JSON.stringify(t.keywords),+(t.enabled ?? true),now()); rematchAll(); });
      return listTopics().find(t => t.id === id);
    },
    updateTopic(id, input) {
      const updates = validateTopic(input, true); const existing = listTopics().find(t => t.id === id);
      if (!existing) throw new InputError('主题不存在', 404);
      const t = { ...existing, ...updates };
      tx(() => { db.prepare('UPDATE topics SET name=?,keywords=?,enabled=? WHERE id=?').run(t.name,JSON.stringify(t.keywords),+t.enabled,id); rematchAll(); });
      return listTopics().find(t => t.id === id);
    },
    upsertItems(sourceId, items) {
      const incomingSource = getSource(sourceId);
      if (!incomingSource) throw new InputError('来源不存在', 404);
      if (!Array.isArray(items)) throw new InputError('文章必须为数组');
      return tx(() => {
        let inserted = 0; let updated = 0; let total = 0;
        for (const raw of items.slice(0, 1000)) {
          const url = canonicalUrl(raw.url); const title = plainText(raw.title, 500); if (!url || !title) continue;
          const summary = plainText(raw.summary, 3000); const parsedDate = raw.publishedAt ? new Date(raw.publishedAt) : null;
          const publishedAt = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null;
          const existing = db.prepare('SELECT i.id,i.sourceId,s.kind AS sourceKind FROM items i JOIN sources s ON s.id=i.sourceId WHERE i.url=?').get(url); const id = existing?.id ?? randomUUID();
          if (existing) {
            // The original source can correct its date; other sources only fill an unknown date.
            // Missing or invalid dates never erase an existing valid publication timestamp.
            // A real RSS observation takes primary attribution from an earlier research lead.
            const promoteRss = incomingSource.kind === 'rss' && existing.sourceKind === 'web-research';
            db.prepare(`UPDATE items SET title=?,summary=CASE WHEN ? <> '' THEN ? ELSE summary END,
              publishedAt=CASE WHEN ? THEN COALESCE(?,publishedAt) ELSE COALESCE(publishedAt,?) END,
              sourceId=CASE WHEN ? THEN ? ELSE sourceId END,
              lastSeenAt=? WHERE id=?`).run(title,summary,summary,+(existing.sourceId === sourceId || promoteRss),publishedAt,publishedAt,+promoteRss,sourceId,now(),id);
            updated++;
          }
          else { db.prepare('INSERT INTO items(id,url,title,summary,publishedAt,sourceId,firstSeenAt,lastSeenAt) VALUES(?,?,?,?,?,?,?,?)').run(id,url,title,summary,publishedAt,sourceId,now(),now()); inserted++; }
          if (Object.hasOwn(raw, 'author') || Object.hasOwn(raw, 'metrics')) {
            const previous = readSocialMetadata(db.prepare('SELECT data FROM item_metadata WHERE itemId=?').get(id)?.data);
            const metadata = sanitizeSocialMetadata({
              author: Object.hasOwn(raw, 'author') ? raw.author : previous.author,
              metrics: Object.hasOwn(raw, 'metrics') ? raw.metrics : previous.metrics,
            });
            db.prepare('INSERT INTO item_metadata(itemId,data) VALUES(?,?) ON CONFLICT(itemId) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(metadata));
          }
          db.prepare('INSERT OR IGNORE INTO item_sources(itemId,sourceId) VALUES(?,?)').run(id,sourceId); rematch(id); total++;
        }
        return { inserted, updated, total };
      });
    },
    setStarred(id, starred) {
      if (typeof starred !== 'boolean') throw new InputError('starred 必须为布尔值');
      if (!db.prepare('UPDATE items SET starred=? WHERE id=?').run(+starred,id).changes) throw new InputError('文章不存在', 404);
      return decorateItems(db.prepare('SELECT i.*,s.name AS sourceName,s.platform,s.kind AS sourceKind FROM items i JOIN sources s ON s.id=i.sourceId WHERE i.id=?').all(id))[0];
    },
    isCollecting() { expireInterruptedRuns(); return !!db.prepare("SELECT id FROM runs WHERE status='running'").get(); },
    beginRun(sourceIds, { kind = 'collection' } = {}) {
      if (!['collection', 'aisa-import', 'web-research'].includes(kind)) throw new InputError('不支持的运行类型');
      return tx(() => {
        expireInterruptedRuns();
        if (db.prepare("SELECT id FROM runs WHERE status='running'").get()) throw new InputError('采集正在进行，请稍后再试', 409);
        const id = randomUUID(); db.prepare('INSERT INTO runs(id,startedAt,status,sourceIds) VALUES(?,?,?,?)').run(id,now(),'running',JSON.stringify(sourceIds));
        db.prepare('INSERT INTO run_metadata(runId,kind) VALUES(?,?)').run(id, kind); return id;
      });
    },
    recordSourceResult(runId, sourceId, result) {
      tx(() => {
        db.prepare('INSERT OR REPLACE INTO source_runs(runId,sourceId,status,startedAt,finishedAt,itemCount,inserted,updated,error) VALUES(?,?,?,?,?,?,?,?,?)').run(runId,sourceId,result.status,result.startedAt ?? now(),now(),result.itemCount ?? 0,result.inserted ?? 0,result.updated ?? 0,result.error ?? null);
        updateSourceResult(sourceId, { ...result, lastRun: now() });
      });
    },
    finishRun(id, error = null) {
      const results = db.prepare('SELECT * FROM source_runs WHERE runId=?').all(id);
      const failures = results.filter(r => r.status === 'error').length;
      const status = error || !results.length || failures === results.length ? 'failed' : failures ? 'partial' : 'success';
      db.prepare('UPDATE runs SET status=?,finishedAt=?,inserted=?,updated=?,error=? WHERE id=?').run(status,now(),results.reduce((a,r)=>a+r.inserted,0),results.reduce((a,r)=>a+r.updated,0),error,id);
      return this.listRuns().find(r => r.id === id);
    },
    listRuns(limit = 30) {
      return db.prepare("SELECT r.*,COALESCE(m.kind,'collection') AS kind FROM runs r LEFT JOIN run_metadata m ON m.runId=r.id ORDER BY r.startedAt DESC LIMIT ?").all(limit).map(r => ({ ...r, sourceIds: JSON.parse(r.sourceIds), results: db.prepare('SELECT r.*,s.name AS sourceName FROM source_runs r JOIN sources s ON s.id=r.sourceId WHERE runId=?').all(r.id) }));
    },
    itemCount() { return db.prepare('SELECT COUNT(*) AS count FROM items').get().count; },
  };
}
