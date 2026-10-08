import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink, stat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PROJECT_DIR = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const TOOL = 'get_twitter_tweet_advanced_search';
const READ_COMMANDS = new Set(['balance', 'search', 'schema', 'quote']);
const QUOTE_NOTE = '这是本次固定请求的脱敏原始报价。动态估价或部分报价不代表完整费用或花费上限；报价不是执行授权，本次未执行数据采集。';

function options(input = {}) {
  const projectDir = input.projectDir ?? PROJECT_DIR;
  return { projectDir, dataDir: input.dataDir ?? join(projectDir, 'data'), homeDir: input.homeDir ?? homedir(), env: input.env ?? process.env, runner: input.runner ?? execute };
}

async function command(config, args) {
  if (!READ_COMMANDS.has(args[0])) throw new Error('Unsupported read-only command');
  return config.runner(join(config.projectDir, 'node_modules', '.bin', 'aisa'), args, { cwd: config.projectDir, env: config.env, timeout: 25000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
}

function failure(error, action = 'verify') {
  const detail = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`.toLowerCase();
  if (/not authenticated|not logged in|login required|authentication required|missing api.?key|no api.?key|api.?key.{0,40}required/.test(detail)) return { code: 'not_authenticated', message: 'AIsa 尚未通过官方 CLI 登录验证，请完成已打开的登录流程后再试。' };
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid.{0,30}(token|credential|api.?key)|expired.{0,30}(token|credential)|authorization failed/.test(detail)) return { code: 'authorization_failed', message: 'AIsa 拒绝了本次授权，请检查官方账户授权状态后重试。' };
  return { code: 'verification_failed', message: action === 'quote' ? '本次报价未能完成，可能是网络、工具定义或报价服务异常。请稍后重试，当前没有执行采集。' : '本次连接验证未能完成，可能是网络或服务异常。请稍后重试，当前无法确认连接状态。' };
}

async function credentialMetadata({ homeDir, env }) {
  if (env.AISA_API_KEY) return { credentialSource: 'environment', credentialFingerprint: createHash('sha256').update(env.AISA_API_KEY).digest('hex') };
  for (const name of ['tokens', 'key']) {
    const info = await stat(join(homeDir, '.aisa', name === 'tokens' ? 'tokens.json' : 'key')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isFile()) return { credentialSource: name, credentialMtimeMs: info.mtimeMs };
  }
  return null;
}

async function savePrivate(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function verifyAisaConnection(input = {}) {
  const config = options(input);
  const evidence = join(config.dataDir, 'aisa-auth.json');
  try {
    // Never return or save the balance payload. OAuth may refresh its token during this call.
    await command(config, ['balance', '--json']);
    const credential = await credentialMetadata(config);
    if (!credential) throw new Error('Post-verification credential metadata unavailable');
    const verifiedAt = new Date().toISOString();
    await mkdir(config.dataDir, { recursive: true });
    await savePrivate(evidence, { command: 'aisa balance', exitCode: 0, verifiedAt, ...credential });
    return { connected: true, verifiedAt, message: 'AIsa 余额接口验证成功。此操作没有执行付费数据采集。' };
  } catch (error) {
    await unlink(evidence).catch(() => {});
    return { connected: false, ...failure(error) };
  }
}

function parseResponse(result) {
  const value = JSON.parse(String(result.stdout ?? ''));
  if (!value || typeof value !== 'object') throw new Error('Expected an application JSON object');
  return value;
}

function findTool(value, predicate = () => true, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 30) return null;
  if (!Array.isArray(value) && value.tool === TOOL && predicate(value)) return value;
  for (const child of Object.values(value)) {
    const found = findTool(child, predicate, depth + 1);
    if (found) return found;
  }
  return null;
}

function acceptsFixedArguments(schema) {
  const properties = schema?.properties;
  return schema?.type === 'object' && properties?.query?.type === 'string' && properties?.queryType?.type === 'string'
    && (!properties.queryType.enum || properties.queryType.enum.includes('Latest'))
    && (!properties.queryType.const || properties.queryType.const === 'Latest')
    && (schema.required ?? []).every(key => ['query', 'queryType'].includes(key));
}

function fixedRequest(now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = offset => new Date(today + offset * 86400000).toISOString().slice(0, 10);
  return { calls: [{ call_id: 'x_ai_latest', tool: TOOL, arguments: { query: `(from:OpenAI OR from:AnthropicAI OR from:GoogleDeepMind OR from:github OR from:Saccc_c) since:${day(-1)} until:${day(1)} -filter:replies`, queryType: 'Latest' } }] };
}

function redact(value, config, depth = 0) {
  if (depth > 30) return '[层级过深，已省略]';
  if (Array.isArray(value)) return value.map(item => redact(item, config, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/api.?key|token|secret|password|authorization|cookie|credential|headers|email|phone|account|session.?id|user.?id|__proto__|constructor/i.test(key)) continue;
      result[key] = redact(item, config, depth + 1);
    }
    return result;
  }
  if (typeof value === 'string') {
    let cleaned = value;
    if (config.env.AISA_API_KEY) cleaned = cleaned.replaceAll(config.env.AISA_API_KEY, '[已隐藏]');
    return cleaned.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]').replace(/([?&](?:api_key|key|token|code|secret)=)[^&\s]+/gi, '$1[已隐藏]');
  }
  return value;
}

export async function quoteAisaMonitoring(input = {}) {
  const config = options(input);
  try {
    const discovery = parseResponse(await command(config, ['search', TOOL, '--limit', '5', '--json']));
    let tool = findTool(discovery);
    if (!tool) throw new Error('Requested published tool was not discovered');
    if (tool.has_full_schema !== true || !tool.arguments_schema) {
      const result = parseResponse(await command(config, ['schema', TOOL, '--json']));
      tool = findTool(result, value => Boolean(value.arguments_schema));
    }
    if (!acceptsFixedArguments(tool?.arguments_schema)) throw new Error('Published arguments cannot accept the fixed request');
    const request = fixedRequest();
    const quote = redact(parseResponse(await command(config, ['quote', '--input', JSON.stringify(request), '--json'])), config);
    const result = { quotedAt: new Date().toISOString(), request, quote, note: QUOTE_NOTE };
    const directory = join(config.dataDir, 'aisa');
    await mkdir(directory, { recursive: true });
    await savePrivate(join(directory, 'x-request.json'), request);
    await savePrivate(join(directory, 'x-quote.json'), result);
    return result;
  } catch (error) {
    return failure(error, 'quote');
  }
}
