import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InputError } from './store.mjs';
import { DEFAULT_X_SETTINGS, validateXSettings } from './x-monitor.mjs';
import { DEFAULT_EDITORIAL, validateEditorial } from './editorial.mjs';
const OWNER_TOKEN = randomUUID();
function ownerAlive(job) {
  if (!Number.isSafeInteger(job.ownerPid) || job.ownerPid < 1) return false;
  if (job.ownerPid === process.pid) return job.ownerToken === OWNER_TOKEN;
  try { process.kill(job.ownerPid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function openOperations(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const filename = join(dataDir, 'operations.sqlite');
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  db.exec([
    'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;',
    'CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,status TEXT NOT NULL,createdAt TEXT NOT NULL,data TEXT NOT NULL);',
    "CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs((1)) WHERE status IN ('queued','running');",
    'CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);',
    'CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,eventKey TEXT UNIQUE NOT NULL,createdAt TEXT NOT NULL,read INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);',
    'CREATE TABLE IF NOT EXISTS processed_urls(url TEXT PRIMARY KEY);',
  ].join('\n'));
  const decode = row => row ? JSON.parse(row.data) : null;
  const getJob = id => decode(db.prepare('SELECT data FROM jobs WHERE id=?').get(id));
  const updateJob = (id, changes) => {
    const job = getJob(id);
    if (!job) throw new InputError('任务不存在', 404);
    const result = { ...job, ...changes };
    db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run(result.status, JSON.stringify(result), id);
    return result;
  };
  // Opened once per service process; a restart never retries an old paid task.
  for (const row of db.prepare("SELECT data FROM jobs WHERE status IN ('queued','running')").all()) {
    const job = decode(row);
    if (ownerAlive(job)) continue;
    updateJob(job.id, { status: 'interrupted', stage: 'interrupted', finishedAt: new Date().toISOString(), message: '服务已重启，上次任务中断。付费请求不会自动重试。' });
  }
  const settings = () => { const saved=decode(db.prepare('SELECT data FROM settings WHERE id=1').get()) || {}; return { x: saved.x ?? structuredClone(DEFAULT_X_SETTINGS), editorial: saved.editorial ?? structuredClone(DEFAULT_EDITORIAL) }; };
  let closed = false;
  return {
    close() { if (!closed) { db.close(); closed = true; } },
    settings, getJob, updateJob,
    saveSettings(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key => !['x','editorial'].includes(key))) throw new InputError('只支持监控和推荐偏好配置');
      const old=settings();
      const next = { x: 'x' in input ? validateXSettings(input.x, old.x) : old.x, editorial: 'editorial' in input ? validateEditorial(input.editorial, old.editorial) : old.editorial };
      db.prepare('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(next));
      return next;
    },
    activeJob() { return decode(db.prepare("SELECT data FROM jobs WHERE status IN ('queued','running') LIMIT 1").get()); },
    jobs() { return db.prepare('SELECT data FROM jobs ORDER BY createdAt DESC,rowid DESC LIMIT 100').all().map(decode); },
    createJob(kind, input = {}) {
      if (!['refresh', 'analysis', 'x', 'translation', 'draft'].includes(kind)) throw new InputError('不支持的任务类型');
      const job = { id: randomUUID(), kind, status: 'queued', stage: 'queued', createdAt: new Date().toISOString(), message: '任务等待开始', input, ownerPid: process.pid, ownerToken: OWNER_TOKEN };
      try { db.prepare('INSERT INTO jobs(id,status,createdAt,data) VALUES(?,?,?,?)').run(job.id, job.status, job.createdAt, JSON.stringify(job)); }
      catch (error) { if (String(error.message).includes('UNIQUE')) throw new InputError('已有任务正在运行，请等待完成或取消', 409); throw error; }
      return job;
    },
    addNotification({ key, jobId = null, level = 'info', title, message }) {
      const record = { id: randomUUID(), jobId, level, title, message, createdAt: new Date().toISOString() };
      return db.prepare('INSERT OR IGNORE INTO notifications(id,eventKey,createdAt,data) VALUES(?,?,?,?)').run(record.id, key, record.createdAt, JSON.stringify(record)).changes;
    },
    notifications() { return db.prepare('SELECT data,read FROM notifications ORDER BY createdAt DESC,rowid DESC LIMIT 100').all().map(row => ({ ...decode(row), read: !!row.read })); },
    markRead(ids) {
      if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string')) throw new InputError('通知 ID 格式无效');
      let updated = 0;
      for (const id of ids) updated += db.prepare('UPDATE notifications SET read=1 WHERE id=? AND read=0').run(id).changes;
      return updated;
    },
    newUrls(urls) { return urls.filter(url => !db.prepare('SELECT 1 FROM processed_urls WHERE url=?').get(url)); },
    rememberUrls(urls) {
      const statement = db.prepare('INSERT OR IGNORE INTO processed_urls(url) VALUES(?)');
      for (const url of urls) statement.run(url);
    },
    hasJobs() { return Boolean(db.prepare('SELECT 1 FROM jobs LIMIT 1').get()); },
  };
}
