import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { InputError } from './store.mjs';
import { normalizeAisa } from './aisa-normalize.mjs';

const PROJECT_DIR = fileURLToPath(new URL('../', import.meta.url));
const TOOL = 'get_twitter_tweet_advanced_search';
const CALL_ID = 'x_ai_latest';
const SOURCE = 'aisa-x';
const TTL = 15 * 60 * 1000;
const MAX_BYTES = 20 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const execute = promisify(execFile);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nonnegativeMicros = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const beijingDate = value => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));

export const DEFAULT_X_SETTINGS = Object.freeze({
  handles: Object.freeze(['OpenAI', 'AnthropicAI', 'GoogleDeepMind', 'github', 'Saccc_c']),
  keywords: Object.freeze([]), enabled: false, maxEstimatedUsd: 0.05, maxDailyCalls: 4, acceptUncappedEstimate: false,
});

export function validateXSettings(partial = {}, previous = DEFAULT_X_SETTINGS) {
  if (!record(partial) || !record(previous)) throw new InputError('X 监控设置必须是对象');
  if (Object.keys(partial).some(key => !Object.hasOwn(DEFAULT_X_SETTINGS, key))) throw new InputError('不支持的 X 监控设置字段');
  const value = { ...DEFAULT_X_SETTINGS, ...previous, ...partial };
  if (!Array.isArray(value.handles) || value.handles.length < 1 || value.handles.length > 20) throw new InputError('请提供 1–20 个 X 账号');
  const handles = [];
  for (const input of value.handles) {
    const handle = typeof input === 'string' ? input.trim().replace(/^@/, '') : '';
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new InputError('X 账号只能包含 1–15 个英文字母、数字或下划线');
    if (!handles.some(existing => existing.toLowerCase() === handle.toLowerCase())) handles.push(handle);
  }
  if (!Array.isArray(value.keywords) || value.keywords.length > 10) throw new InputError('最多填写 10 个 X 搜索关键词');
  const keywords = [];
  for (const input of value.keywords) {
    if (typeof input !== 'string' || /[\x00-\x1f\x7f"\\:(){}\[\]]/.test(input)) throw new InputError('关键词不能包含引号、反斜杠、控制字符或查询操作符');
    const keyword = input.trim().replace(/\s+/g, ' ');
    if (!keyword || keyword.length > 60) throw new InputError('每个 X 搜索关键词需要 1–60 个字符');
    if (!keywords.includes(keyword)) keywords.push(keyword);
  }
  if (typeof value.enabled !== 'boolean' || typeof value.acceptUncappedEstimate !== 'boolean') throw new InputError('X 监控开关和费用确认必须是布尔值');
  if (typeof value.maxEstimatedUsd !== 'number' || !Number.isFinite(value.maxEstimatedUsd) || value.maxEstimatedUsd <= 0 || value.maxEstimatedUsd > 5) throw new InputError('单次估价阈值必须大于 0 且不超过 5 美元；它不是实际扣费上限');
  if (!Number.isInteger(value.maxDailyCalls) || value.maxDailyCalls < 1 || value.maxDailyCalls > 24) throw new InputError('每日调用次数需为 1–24 次');
  if (value.enabled && !value.acceptUncappedEstimate) throw new InputError('启用 X 自动采集前，需要明确接受可能超过估价且没有保证上限的费用');
  return { handles, keywords, enabled: value.enabled, maxEstimatedUsd: value.maxEstimatedUsd, maxDailyCalls: value.maxDailyCalls, acceptUncappedEstimate: value.acceptUncappedEstimate };
}

function fixedRequest(settings, now) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = offset => new Date(today + offset * 86400000).toISOString().slice(0, 10);
  const accounts = `(${settings.handles.map(handle => `from:${handle}`).join(' OR ')})`;
  // Every keyword is one quoted literal, never an untrusted query fragment.
  const keywords = settings.keywords.length ? ` (${settings.keywords.map(word => `"${word}"`).join(' OR ')})` : '';
  return { calls: [{ call_id: CALL_ID, tool: TOOL, arguments: { query: `${accounts}${keywords} since:${day(-1)} until:${day(1)} -filter:replies`, queryType: 'Latest' } }] };
}

async function directory(path, create = true) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new InputError('X 数据目录不能是符号链接或普通文件', 409);
  return realpath(path);
}

async function paths(dataDir, create = true) {
  try {
    const root = await directory(resolve(dataDir), create);
    const quotes = await directory(join(root, 'x-quotes'), create);
    const attempts = await directory(join(root, 'x-attempts'), create);
    if (quotes !== join(root, 'x-quotes') || attempts !== join(root, 'x-attempts')) throw new InputError('X 数据目录不在预期位置', 409);
    return { root, quotes, attempts };
  } catch (error) {
    if (error instanceof InputError) throw error;
    if (!create && error.code === 'ENOENT') return null;
    throw new InputError('无法安全访问 X 数据目录', 409);
  }
}

async function readPrivate(file) {
  let handle;
  try {
    await directory(dirname(file), false);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new InputError('X 记录必须是普通文件，不能读取符号链接', 409);
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_BYTES) throw new InputError('X 记录文件无效或超过大小限制', 409);
    const raw = await handle.readFile('utf8');
    const parsed = JSON.parse(raw);
    if (!record(parsed)) throw new InputError('X 记录格式无效', 409);
    return parsed;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('X 记录不存在、损坏或无法安全读取', 409);
  } finally { await handle?.close(); }
}

async function writeExclusive(file, value, raw = false) {
  let handle;
  try {
    await directory(dirname(file), false);
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(raw ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle?.close(); }
}

async function updatePrivate(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await directory(dirname(file), false);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new InputError('X 执行记录无法安全更新', 409);
    await writeExclusive(temp, value);
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
}

async function command({ projectDir, runner = execute }, args, signal, onResponse) {
  try {
    let result, executionError;
    try {
      result = await runner(join(projectDir, 'node_modules', '.bin', 'aisa'), args, {
        cwd: projectDir, env: process.env, signal, timeout: args[0] === 'call' ? 120000 : 30000,
        maxBuffer: MAX_BYTES, encoding: 'utf8',
      });
    } catch (error) { executionError = error; result = error; }
    const raw = typeof result === 'string' ? result : result?.stdout;
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BYTES) throw new Error('CLI response absent or too large');
    // Preserve provider stdout privately even for nonzero exits, malformed JSON,
    // partial batches, or failed results. Stderr is never persisted or relayed.
    if (onResponse) await onResponse(raw);
    if (executionError || (result?.exitCode !== undefined && result.exitCode !== 0) || (result?.code !== undefined && result.code !== 0) || result?.signal) throw new Error('CLI returned a failed exit status');
    const body = JSON.parse(raw);
    if (!record(body)) throw new Error('CLI response must be an object');
    return { body, raw };
  } catch {
    // Never relay stderr, process arguments, account details, or a provider's error text.
    throw new InputError(args[0] === 'call' ? 'X 调用未能确认成功；结果和扣费可能未知。本次已记录且不会自动重试。' : 'AIsa 工具发现、参数核验或报价未完成；本次没有执行付费采集。', 502);
  }
}

function singleSuccess(body) {
  if (body.success === false || body.successful === false || body.error || body.total_count !== 1 || body.success_count !== 1 || body.error_count !== 0 || !Array.isArray(body.results) || body.results.length !== 1) throw new InputError('AIsa 返回了失败、不完整或多项结果，不能用于本次单页采集', 502);
  const result = body.results[0];
  if (!record(result) || result.call_id !== CALL_ID || result.tool !== TOOL || result.successful !== true || result.error || !record(result.data)) throw new InputError('AIsa 结果未匹配本次已报价的唯一请求', 502);
  return result;
}

function priceInfo(quote) {
  const data = singleSuccess(quote).data;
  if (data.currency !== 'USD' || !nonnegativeMicros(data.estimated_cost_micros_usd) || typeof data.may_exceed_estimate !== 'boolean') throw new InputError('本次报价缺少有效美元估价或费用不确定性说明', 502);
  if (data.max_cost_micros_usd != null && (!nonnegativeMicros(data.max_cost_micros_usd) || data.max_cost_micros_usd < data.estimated_cost_micros_usd)) throw new InputError('报价中的最高费用字段无效', 502);
  return { estimatedUsd: data.estimated_cost_micros_usd / 1000000, mayExceedEstimate: data.may_exceed_estimate, maxCostUsd: data.max_cost_micros_usd == null ? null : data.max_cost_micros_usd / 1000000 };
}

function redact(value, depth = 0) {
  if (depth > 30) return '[已省略]';
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  if (record(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !/api.?key|token|secret|password|authorization|cookie|credential|headers|email|phone|account|session.?id|user.?id|__proto__|constructor/i.test(key)).map(([key, item]) => [key, redact(item, depth + 1)]));
  if (typeof value !== 'string') return value;
  const cleaned = process.env.AISA_API_KEY ? value.replaceAll(process.env.AISA_API_KEY, '[已隐藏]') : value;
  return cleaned.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [已隐藏]').replace(/\bsk-aisa-[\w-]+/g, '[已隐藏]').replace(/([?&](?:api_key|key|token|code|secret)=)[^&\s]+/gi, '$1[已隐藏]');
}

export async function quoteX({ projectDir = PROJECT_DIR, dataDir = join(projectDir, 'data'), settings = {}, runner, now } = {}) {
  const selected = validateXSettings(settings);
  const at = new Date(typeof now === 'function' ? now() : now ?? Date.now());
  if (!Number.isFinite(at.valueOf())) throw new InputError('报价时间无效');
  const dirs = await paths(dataDir);
  const config = { projectDir, runner };
  const discovery = (await command(config, ['search', TOOL, '--limit', '5', '--json'])).body;
  if (discovery.error || discovery.success === false || !Array.isArray(discovery.tools) || !discovery.tools.some(tool => tool?.tool === TOOL)) throw new InputError('没有发现可验证的 X 高级搜索工具', 502);
  const definition = (await command(config, ['schema', TOOL, '--json'])).body;
  const tool = definition.tools?.[TOOL];
  const schema = tool?.arguments_schema;
  if (definition.total_count !== 1 || definition.success_count !== 1 || definition.error_count !== 0 || tool?.successful !== true || tool.read_only !== true || (tool.side_effects?.length ?? 0) > 0 || schema?.type !== 'object' || schema.properties?.query?.type !== 'string' || schema.properties?.queryType?.type !== 'string' || (schema.properties.queryType.enum && !schema.properties.queryType.enum.includes('Latest')) || (schema.properties.queryType.const && schema.properties.queryType.const !== 'Latest') || !Array.isArray(schema.required) || !schema.required.every(key => ['query', 'queryType'].includes(key))) throw new InputError('X 工具参数或只读性质未通过核验', 502);
  const request = fixedRequest(selected, at);
  const rawQuote = (await command(config, ['quote', '--input', JSON.stringify(request), '--json'])).body;
  const info = priceInfo(rawQuote);
  if (info.estimatedUsd > selected.maxEstimatedUsd) throw new InputError('本次 X 估价超过设置的单次估价阈值，没有执行采集');
  const summary = {
    id: randomUUID(), quotedAt: at.toISOString(), expiresAt: new Date(at.valueOf() + TTL).toISOString(),
    ...info, callCount: 1, handles: selected.handles, keywords: selected.keywords, query: request.calls[0].arguments.query,
    quote: redact(rawQuote),
    note: info.maxCostUsd === null ? '这是估价，未提供保证最高费用；实际扣费可能超过估价。报价尚未执行采集，有效期为 15 分钟。' : '报价尚未执行采集；仅适用于本次固定单页请求，有效期为 15 分钟。',
  };
  try {
    await writeExclusive(join(dirs.quotes, `${summary.id}.json`), { ...summary, request, requestHash: hash(request), settings: selected });
  } catch { throw new InputError('报价已取得，但未能安全保存，因此不能执行', 502); }
  return summary;
}

function validateSavedQuote(saved, quoteId) {
  try {
    if (saved.id !== quoteId || !record(saved.request) || hash(saved.request) !== saved.requestHash) throw new Error();
    const at = new Date(saved.quotedAt);
    const expires = new Date(saved.expiresAt);
    if (!Number.isFinite(at.valueOf()) || !Number.isFinite(expires.valueOf()) || expires.valueOf() - at.valueOf() !== TTL || at.valueOf() > Date.now() + 5000 || expires.valueOf() <= Date.now()) throw new Error();
    const selected = validateXSettings(saved.settings);
    if (JSON.stringify(saved.request) !== JSON.stringify(fixedRequest(selected, at))) throw new Error();
    const info = priceInfo(saved.quote);
    if (info.estimatedUsd !== saved.estimatedUsd || info.mayExceedEstimate !== saved.mayExceedEstimate || info.estimatedUsd > selected.maxEstimatedUsd || saved.callCount !== 1) throw new Error();
    return info;
  } catch { throw new InputError('X 报价已过期、内容不一致或请求被修改，请重新报价；本次没有调用', 409); }
}

export async function executeX({ store, projectDir = PROJECT_DIR, dataDir = join(projectDir, 'data'), quoteId, acceptUncappedEstimate = false, runner, signal } = {}) {
  const state = {
    attemptId: null, quoteId: typeof quoteId === 'string' && UUID.test(quoteId) ? quoteId : null, runId: null,
    requestStarted: false, callCount: 0, inserted: null, updated: null, total: null,
    hasNextPage: null, chargedUsd: null, chargeStatus: 'unknown', rawResponseSaved: false,
  };
  let attempt, attemptPath, startedAt;
  const checkCancelled = () => {
    if (signal?.aborted) throw new InputError(state.requestStarted ? 'X 调用发起后已取消，结果或扣费可能未知；不会自动重试。' : 'X 采集已取消，没有开始付费调用', state.requestStarted ? 502 : 409);
  };
  try {
    if (typeof quoteId !== 'string' || !UUID.test(quoteId)) throw new InputError('X 报价编号无效');
    if (typeof acceptUncappedEstimate !== 'boolean') throw new InputError('费用不确定性确认必须是布尔值');
    checkCancelled();
    const dirs = await paths(dataDir);
    const saved = await readPrivate(join(dirs.quotes, `${quoteId}.json`));
    const info = validateSavedQuote(saved, quoteId);
    if ((info.mayExceedEstimate || info.maxCostUsd === null) && !acceptUncappedEstimate) throw new InputError('本次没有保证费用上限；执行前需明确接受可能超过估价的费用');
    checkCancelled();
    state.attemptId = randomUUID();
    startedAt = new Date().toISOString();
    // O_EXCL consumes this quote across concurrent processes. Never remove the
    // marker, even on cancellation, crash, or an ambiguous provider response.
    try { await writeExclusive(join(dirs.quotes, `${quoteId}.consumed`), { quoteId, attemptId: state.attemptId, consumedAt: startedAt }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new InputError('本次 X 报价已使用或正在执行；不会重复扣费，请查看执行记录', 409);
      throw new InputError('无法安全锁定本次 X 报价，没有开始调用', 409);
    }
    attemptPath = join(dirs.attempts, `${state.attemptId}.json`);
    state.runId = store.beginRun([SOURCE], { kind: 'aisa-import' });
    attempt = { id: state.attemptId, quoteId, runId: state.runId, requestHash: saved.requestHash, startedAt, status: 'prepared', requestStarted: false, callCount: 0, estimatedUsd: info.estimatedUsd, chargeStatus: 'unknown', chargedUsd: null };
    await writeExclusive(attemptPath, attempt);
    checkCancelled();
    // Durable accounting precedes execution. A crash after this write leaves one
    // conservatively counted attempt; a known pre-dispatch cancellation resets it.
    await updatePrivate(attemptPath, { ...attempt, status: 'call_started', requestStarted: true, callCount: 1 });
    checkCancelled();
    state.requestStarted = true;
    state.callCount = 1;
    const { body } = await command({ projectDir, runner }, ['call', '--input', JSON.stringify(saved.request), '--json'], signal, async raw => {
      await writeExclusive(join(dirs.attempts, `${state.attemptId}-response.json`), raw, true);
      state.rawResponseSaved = true;
      let response;
      try { response = JSON.parse(raw); } catch { return; }
      const result = Array.isArray(response?.results) && response.results.length === 1 ? response.results[0] : null;
      // Only the official router's matching result field establishes actual cost,
      // including a charged failure. Never infer zero cost from missing evidence.
      if (record(result) && result.call_id === CALL_ID && result.tool === TOOL && nonnegativeMicros(result.customer_cost_micros_usd)) {
        state.chargedUsd = result.customer_cost_micros_usd / 1000000;
        state.chargeStatus = 'reported';
      }
    });
    checkCancelled();
    const result = singleSuccess(body);
    state.hasNextPage = typeof result.data.has_next_page === 'boolean' ? result.data.has_next_page : null;
    const items = normalizeAisa('x', result.data);
    Object.assign(state, store.upsertItems(SOURCE, items));
    store.recordSourceResult(state.runId, SOURCE, { status: 'ok', startedAt, error: null, itemCount: state.total, inserted: state.inserted, updated: state.updated });
    store.finishRun(state.runId);
    await updatePrivate(attemptPath, { ...attempt, ...state, status: 'success', finishedAt: new Date().toISOString() });
    return { ...state };
  } catch (error) {
    const message = state.requestStarted
      ? 'X 本次执行未能完成，结果或扣费可能未知；已保留记录且不会自动重试此报价。'
      : error instanceof InputError ? error.message : 'X 本次执行未能准备完成，没有开始付费调用；请查看执行记录。';
    const status = state.requestStarted ? 502 : error instanceof InputError ? error.status : 502;
    if (attempt) await updatePrivate(attemptPath, { ...attempt, ...state, status: signal?.aborted && !state.requestStarted ? 'cancelled' : 'failed', finishedAt: new Date().toISOString(), error: message }).catch(() => {});
    if (state.runId) {
      try { store.recordSourceResult(state.runId, SOURCE, { status: 'error', startedAt, error: message, itemCount: state.total, inserted: state.inserted, updated: state.updated }); }
      catch { /* The durable attempt remains the authority when the database is unavailable. */ }
      try { store.finishRun(state.runId, message); } catch { /* Never retry the remote call. */ }
    }
    const failure = new InputError(message, status);
    Object.assign(failure, state, { xAttempt: { ...state } });
    throw failure;
  }
}

export async function countXAttempts(dataDir, date = beijingDate(Date.now())) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new InputError('X 调用统计日期无效');
  let attempts;
  try {
    const root = await directory(resolve(dataDir), false);
    attempts = await directory(join(root, 'x-attempts'), false);
    if (attempts !== join(root, 'x-attempts')) throw new InputError('X 调用记录目录不在预期位置', 409);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    if (error instanceof InputError) throw error;
    throw new InputError('无法安全读取 X 调用次数，不能继续付费采集', 409);
  }
  let count = 0;
  for (const entry of await readdir(attempts, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json') || !UUID.test(entry.name.slice(0, -5))) continue;
    const attempt = await readPrivate(join(attempts, entry.name));
    const validCount = (attempt.callCount === 1 && attempt.requestStarted !== false) || (attempt.callCount === 0 && attempt.requestStarted === false);
    if (attempt.id !== entry.name.slice(0, -5) || !validCount || typeof attempt.startedAt !== 'string' || !Number.isFinite(Date.parse(attempt.startedAt))) throw new InputError('存在无法确认的 X 调用记录，请核对后再继续付费采集', 409);
    if (attempt.callCount === 1 && beijingDate(attempt.startedAt) === date) count++;
  }
  return count;
}
