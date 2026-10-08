import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { openStore, InputError } from './store.mjs';
import { collect } from './collector.mjs';
import { renderReport } from './report.mjs';
import { getBrief, readBriefCatalog } from './briefs.mjs';
import { verifyAisaConnection, quoteAisaMonitoring } from './aisa-connection.mjs';
import { sourceRoutes } from './source-routes.mjs';
import { createJobManager } from './job-manager.mjs';
import { openTranslationStore } from './translations.mjs';

export const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function aisaStatus({ projectDir = PROJECT_DIR, homeDir = homedir(), dataDir = join(projectDir, 'data'), env = process.env } = {}) {
  const aisaInstalled = existsSync(join(projectDir, 'node_modules', '.bin', 'aisa'));
  const keyPath = join(homeDir, '.aisa', 'key');
  const hasKey = existsSync(keyPath);
  const tokensPath = join(homeDir, '.aisa', 'tokens.json');
  const hasTokens = existsSync(tokensPath);
  const credentialSource = env.AISA_API_KEY ? 'environment' : hasTokens ? 'tokens' : hasKey ? 'key' : null;
  let aisaConnected = false;
  try {
    const authPath = join(dataDir, 'aisa-auth.json');
    if (statSync(authPath).size <= 4096) {
      const auth = JSON.parse(readFileSync(authPath, 'utf8'));
      const verified = Date.parse(auth.verifiedAt);
      const age = Date.now() - verified;
      const credentialUnchanged = credentialSource === 'environment' ? auth.credentialFingerprint === createHash('sha256').update(env.AISA_API_KEY).digest('hex') : credentialSource ? auth.credentialMtimeMs === statSync(credentialSource === 'tokens' ? tokensPath : keyPath).mtimeMs : false;
      aisaConnected = aisaInstalled && auth.command === 'aisa balance' && auth.exitCode === 0 && Number.isFinite(verified) && age >= -300000 && age < 86400000 && credentialSource === auth.credentialSource && credentialUnchanged;
    }
  } catch { /* Missing or invalid verification is not a connection. No credential contents are read. */ }
  const aisaMessage = aisaConnected ? '官方余额命令最近验证成功；平台采集仍需按授权执行。' : !aisaInstalled ? '官方 CLI 尚未安装；免费 RSS 可正常使用。' : credentialSource ? '检测到凭据配置，尚无有效的余额验证记录；不能确认已连接。' : '官方 CLI 已安装，尚未完成登录与余额验证。';
  return { aisaInstalled, aisaConnected, aisaMessage };
}

function sendJSON(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }

async function jsonBody(req) {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new InputError('写操作需要 application/json', 415);
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new InputError('不支持压缩请求体', 415);
  if (Number(req.headers['content-length'] ?? 0) > 65536) { req.resume(); throw new InputError('JSON 请求体超过 64 KB', 413); }
  const buffers = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) { req.resume(); throw new InputError('JSON 请求体超过 64 KB', 413); } buffers.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(buffers).toString('utf8') || '{}'); } catch { throw new InputError('JSON 格式无效'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('请求体必须是 JSON 对象');
  return value;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export function createServer({ store: suppliedStore, dataDir = join(PROJECT_DIR, 'data'), distDir = join(PROJECT_DIR, 'dist'), projectDir = PROJECT_DIR, homeDir = homedir(), collectorOptions = {}, aisaOptions = {}, operationsOptions = {} } = {}) {
  const store = suppliedStore ?? openStore(dataDir);
  const manager = createJobManager({ store, projectDir, collectorOptions, ...operationsOptions });
  let task = null;
  let aisaBusy = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const address = server.address();
      const host = `127.0.0.1:${address.port}`; const origin = `http://${host}`;
      if (req.headers.host !== host) throw new InputError('仅允许本机服务 Host', 403);
      if (req.headers.origin && req.headers.origin !== origin) throw new InputError('不允许跨源访问', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new InputError('不允许跨站访问', 403);
      let path; try { path = decodeURIComponent((req.url ?? '/').split('?')[0]); } catch { throw new InputError('请求路径编码无效'); }
      if (!path.startsWith('/') || path.includes('\0') || path.includes('\\') || path.split('/').some(segment => segment === '..' || segment === '.')) throw new InputError('禁止路径穿越', 403);
      const method = req.method;
      if (path === '/api/health' && method === 'GET') return sendJSON(res, 200, { ok: true, app: 'qingchu-media-monitor' });
      if (path === '/api/operations' && method === 'GET') return sendJSON(res, 200, await manager.snapshot());
      if (path === '/api/settings' && method === 'PATCH') return sendJSON(res, 200, manager.saveSettings(await jsonBody(req)));
      if (path === '/api/jobs' && method === 'POST') return sendJSON(res, 202, manager.start(await jsonBody(req)));
      const cancelJob = path.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (cancelJob && method === 'POST') {
        if (Object.keys(await jsonBody(req)).length) throw new InputError('取消任务只接受空 JSON 对象');
        return sendJSON(res, 200, manager.cancel(cancelJob[1]));
      }
      if (path === '/api/x/quote' && method === 'POST') {
        if (Object.keys(await jsonBody(req)).length) throw new InputError('报价使用已保存的监控配置，只接受空 JSON 对象');
        if (aisaBusy) throw new InputError('AIsa 验证正在进行，请稍后再试', 409);
        return sendJSON(res, 200, await manager.quote());
      }
      if (path === '/api/notifications/read' && method === 'POST') {
        const body = await jsonBody(req);
        if (Object.keys(body).some(key => key !== 'ids')) throw new InputError('不支持的通知字段');
        return sendJSON(res, 200, manager.markRead(body.ids));
      }
      if (path.startsWith('/api/sources') && method !== 'GET' && manager.activeJob()) throw new InputError('更新任务正在运行，请完成后再修改来源', 409);
      if (await sourceRoutes({ path, method, req, res, store, jsonBody, sendJSON })) return;
      if (['/api/aisa/verify', '/api/aisa/quote'].includes(path) && method === 'POST') {
        const body = await jsonBody(req);
        if (Object.keys(body).length) throw new InputError('此操作只接受空 JSON 对象，不接收密钥或自定义调用');
        if (aisaBusy || manager.activeJob()) throw new InputError('AIsa 验证、报价或更新任务正在进行，请稍后再试', 409);
        aisaBusy = true;
        try {
          const config = { ...aisaOptions, projectDir, homeDir, dataDir: store.dataDir };
          if (path === '/api/aisa/verify') return sendJSON(res, 200, await verifyAisaConnection(config));
          const result = await quoteAisaMonitoring(config);
          return sendJSON(res, result.quotedAt ? 200 : 502, result.quotedAt ? result : { ...result, error: result.message });
        } finally { aisaBusy = false; }
      }
      if (path === '/api/state' && method === 'GET') {
        const runs = store.listRuns();
        const briefCatalog = await readBriefCatalog(store.dataDir);
        const items = store.listItems({ includeStarred: true });
        const translations = openTranslationStore(store.dataDir);
        let translationByUrl;
        try { translationByUrl=translations.getMap(items); } finally { translations.close(); }
        let uiBuild = null;
        try { uiBuild = readFileSync(join(distDir,'index.html'),'utf8').match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1] || null; } catch { /* Development server may have no build. */ }
        return sendJSON(res, 200, { uiBuild, topics: store.listTopics(), sources: store.listSources(), items, translationByUrl, runs, analysisByUrl: briefCatalog.analysisByUrl, latestBrief: briefCatalog.latest,
          status: { running: !!task || store.isCollecting() || Boolean(manager.activeJob()), ...aisaStatus({ projectDir, homeDir, dataDir: store.dataDir }), lastCollectedAt: runs.find(r => r.finishedAt)?.finishedAt ?? null, totalItems: store.itemCount(), returnedItemsLimit: 2000 } });
      }
      if (path === '/api/briefs' && method === 'GET') {
        const { briefs, latest } = await readBriefCatalog(store.dataDir);
        return sendJSON(res, 200, { briefs, latest });
      }
      const briefPath = path.match(/^\/api\/briefs\/([^/]+)$/);
      if (briefPath && method === 'GET') {
        const brief = await getBrief(store.dataDir, briefPath[1]);
        if (!brief) throw new InputError('当日尚无已保存的中文简报', 404);
        return sendJSON(res, 200, brief);
      }
      if (path === '/api/report' && method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="media-monitor-report.md"' }); return res.end(renderReport(store)); }
      if (path === '/api/collect' && method === 'POST') {
        const body = await jsonBody(req);
        if (Object.keys(body).some(k => k !== 'sourceIds')) throw new InputError('不支持的采集字段');
        if (task || store.isCollecting() || manager.activeJob()) throw new InputError('采集或更新任务正在进行，请稍后再试', 409);
        if ('sourceIds' in body && (!Array.isArray(body.sourceIds) || !body.sourceIds.length || body.sourceIds.some(id => !store.listSources().some(s => s.id === id && s.enabled && s.kind === 'rss')))) throw new InputError('sourceIds 只能包含已启用的免费 RSS 来源');
        task = collect(store, { ...collectorOptions, sourceIds: body.sourceIds }).catch(() => {}).finally(() => { task = null; });
        return sendJSON(res, 202, { started: true });
      }
      if (path === '/api/topics' && method === 'POST') return sendJSON(res, 201, store.createTopic(await jsonBody(req)));
      const topic = path.match(/^\/api\/topics\/([^/]+)$/);
      if (topic && method === 'PATCH') return sendJSON(res, 200, store.updateTopic(topic[1], await jsonBody(req)));
      const item = path.match(/^\/api\/items\/([^/]+)$/);
      if (item && method === 'PATCH') { const body = await jsonBody(req); if (Object.keys(body).length !== 1 || !('starred' in body)) throw new InputError('文章只支持修改 starred'); return sendJSON(res, 200, store.setStarred(item[1], body.starred)); }
      if (path.startsWith('/api/')) throw new InputError('接口不存在或方法不支持', 404);
      if (method !== 'GET' && method !== 'HEAD') throw new InputError('请求方法不支持', 405);
      const distRoot = await realpath(distDir).catch(() => null);
      if (!distRoot) return sendJSON(res, 503, { error: '前端尚未构建，请先运行 npm run build' });
      const target = resolve(distRoot, `.${path === '/' ? '/index.html' : path}`);
      if (!target.startsWith(`${distRoot}${sep}`)) throw new InputError('禁止访问该路径', 403);
      let realTarget = await realpath(target).catch(() => null);
      if (!realTarget && !extname(path)) realTarget = await realpath(join(distRoot, 'index.html')).catch(() => null);
      if (!realTarget || !realTarget.startsWith(`${distRoot}${sep}`)) throw new InputError('文件不存在', 404);
      if (!(await stat(realTarget)).isFile()) throw new InputError('文件不存在', 404);
      const content = await readFile(realTarget);
      res.writeHead(200, { 'Content-Type': MIME[extname(realTarget)] ?? 'application/octet-stream', 'Content-Length': content.length });
      res.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent) sendJSON(res, error.status ?? 500, { error: error instanceof InputError ? error.message : '服务处理失败，请查看本地运行状态后重试' });
      else res.end();
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.jobManager = manager;
  server.on('close', () => {
    manager.close().finally(() => {
      if (!suppliedStore) { if (task) task.finally(() => store.close()); else store.close(); }
    });
  });
  return server;
}

export async function startServer(options = {}) {
  const server = createServer(options);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4318, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer();
  console.log('自媒体监控已启动：http://127.0.0.1:4318');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
