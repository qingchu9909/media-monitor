import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { startServer } from '../server/main.mjs';

const TOOL = 'get_twitter_tweet_advanced_search';
const schema = { type: 'object', properties: { query: { type: 'string' }, queryType: { type: 'string', enum: ['Latest', 'Top'] } }, required: ['query', 'queryType'] };
const discovered = full => ({ tools: [{ tool: TOOL, has_full_schema: full, ...(full ? { arguments_schema: schema } : {}) }] });
const cliError = (message, code = 1) => Object.assign(new Error('CLI failed'), { code, stderr: message });

async function fixture(t, runner) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-aisa-'));
  const store = openStore(dir);
  const server = await startServer({ store, port: 0, projectDir: dir, homeDir: dir, aisaOptions: { runner, env: {} } });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); await rm(dir, { recursive: true, force: true }); });
  const post = (path, body = {}, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { dir, post };
}

test('successful balance verification reads post-refresh credential metadata and saves no account payload', async t => {
  let tokenPath;
  const calls = [];
  const { dir, post } = await fixture(t, async (file, args, options) => {
    calls.push({ file, args, options });
    await writeFile(tokenPath, 'refreshed-secret-token-with-new-size');
    return { stdout: JSON.stringify({ balance: 100, email: 'private@example.org', token: 'SECRET-ACCOUNT-DATA' }), stderr: '' };
  });
  await mkdir(join(dir, '.aisa'));
  tokenPath = join(dir, '.aisa', 'tokens.json');
  await writeFile(tokenPath, 'old-secret');
  const response = await post('/api/aisa/verify');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.connected, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['balance', '--json']);
  assert.equal(calls[0].options.timeout, 25000);
  assert.equal(calls[0].options.maxBuffer, 1024 * 1024);
  const evidenceText = await readFile(join(dir, 'aisa-auth.json'), 'utf8');
  const evidence = JSON.parse(evidenceText);
  assert.equal(evidence.credentialMtimeMs, (await stat(tokenPath)).mtimeMs);
  assert.equal(evidence.command, 'aisa balance');
  assert.equal(evidence.exitCode, 0);
  assert.ok(!JSON.stringify(result).includes('private@example.org'));
  assert.ok(!evidenceText.includes('SECRET'));
  assert.ok(!evidenceText.includes('balance":'));
});

test('authentication, authorization and network failures stay distinct and invalidate old evidence', async t => {
  let failure = cliError('Not authenticated. Please run aisa login. SECRET');
  const { dir, post } = await fixture(t, async () => { throw failure; });
  for (const [error, code] of [[failure, 'not_authenticated'], [cliError('HTTP 403 forbidden SECRET'), 'authorization_failed'], [cliError('connect ETIMEDOUT SECRET', 'ETIMEDOUT'), 'verification_failed']]) {
    failure = error;
    await writeFile(join(dir, 'aisa-auth.json'), '{"exitCode":0}');
    const result = await (await post('/api/aisa/verify')).json();
    assert.equal(result.connected, false);
    assert.equal(result.code, code);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    if (code === 'verification_failed') assert.ok(!result.message.includes('未登录'));
    await assert.rejects(readFile(join(dir, 'aisa-auth.json')), { code: 'ENOENT' });
  }
});

test('quote discovers the exact read tool, sends one fixed request and persists only redacted quote without executing it', async t => {
  const calls = [];
  const { dir, post } = await fixture(t, async (file, args, options) => {
    calls.push({ args, options });
    if (args[0] === 'search') return { stdout: JSON.stringify(discovered(true)) };
    assert.equal(args[0], 'quote', 'discovery must never execute a tool');
    return { stdout: JSON.stringify({ estimated_total: 0.023, currency: 'USD', api_key: 'DROP-ME', nested: { accessToken: 'DROP-ME', message: 'Estimate only' } }) };
  });
  const response = await post('/api/aisa/quote');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(calls.map(x => x.args[0]), ['search', 'quote']);
  assert.ok(calls.every(x => x.options.timeout === 25000 && x.options.maxBuffer === 1024 * 1024));
  assert.deepEqual(calls[0].args, ['search', TOOL, '--limit', '5', '--json']);
  const sent = JSON.parse(calls[1].args[calls[1].args.indexOf('--input') + 1]);
  assert.deepEqual(sent, result.request);
  assert.equal(sent.calls.length, 1);
  assert.equal(sent.calls[0].call_id, 'x_ai_latest');
  assert.equal(sent.calls[0].tool, TOOL);
  assert.equal(sent.calls[0].arguments.queryType, 'Latest');
  assert.match(sent.calls[0].arguments.query, /^\(from:OpenAI OR from:AnthropicAI OR from:GoogleDeepMind OR from:github OR from:Saccc_c\) since:\d{4}-\d{2}-\d{2} until:\d{4}-\d{2}-\d{2} -filter:replies$/);
  assert.equal(result.quote.estimated_total, 0.023);
  assert.ok(!JSON.stringify(result).includes('DROP-ME'));
  assert.match(result.note, /上限/);
  assert.match(result.note, /未执行/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'aisa', 'x-request.json'), 'utf8')), sent);
  assert.ok(!(await readFile(join(dir, 'aisa', 'x-quote.json'), 'utf8')).includes('DROP-ME'));
});

test('incomplete discovery resolves schema before quote and never guesses an unsupported required parameter', async t => {
  let unsupported = false;
  const calls = [];
  const { post } = await fixture(t, async (file, args) => {
    calls.push(args[0]);
    if (args[0] === 'search') return { stdout: JSON.stringify(discovered(false)) };
    if (args[0] === 'schema') return { stdout: JSON.stringify({ schemas: [{ tool: TOOL, arguments_schema: { ...schema, required: unsupported ? ['query', 'queryType', 'accountSecret'] : schema.required } }] }) };
    assert.equal(args[0], 'quote');
    return { stdout: JSON.stringify({ amount: 0.02 }) };
  });
  assert.equal((await post('/api/aisa/quote')).status, 200);
  assert.deepEqual(calls, ['search', 'schema', 'quote']);
  calls.length = 0; unsupported = true;
  const failed = await post('/api/aisa/quote');
  assert.equal(failed.status, 502);
  assert.deepEqual(calls, ['search', 'schema']);
  assert.ok(!(await failed.text()).includes('accountSecret'));
});

test('failed discovery or failed quote never creates request evidence or falls through to execution', async t => {
  let found = false;
  const calls = [];
  const { post, dir } = await fixture(t, async (file, args) => {
    calls.push(args[0]);
    if (args[0] === 'search') return { stdout: JSON.stringify(found ? discovered(true) : { tools: [{ tool: 'other_tool' }] }) };
    throw cliError('Not authenticated SECRET');
  });
  let response = await post('/api/aisa/quote');
  assert.equal(response.status, 502);
  assert.deepEqual(calls, ['search']);
  found = true; calls.length = 0;
  response = await post('/api/aisa/quote');
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'not_authenticated');
  assert.deepEqual(calls, ['search', 'quote']);
  await assert.rejects(readFile(join(dir, 'aisa', 'x-request.json')), { code: 'ENOENT' });
});

test('verify and quote share a lock and reject nonempty bodies or hostile origins before invoking CLI', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const { dir, post } = await fixture(t, async (file, args) => { calls.push(args[0]); await pending; throw cliError('Not authenticated'); });
  assert.equal((await post('/api/aisa/verify', { token: 'do-not-accept' })).status, 400);
  assert.equal((await post('/api/aisa/quote', { calls: [] })).status, 400);
  assert.equal((await post('/api/aisa/verify', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(calls.length, 0);
  const first = post('/api/aisa/verify');
  for (let n = 0; n < 50 && calls.length === 0; n++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal((await post('/api/aisa/quote')).status, 409);
  finish();
  assert.equal((await first).status, 200);
  assert.deepEqual(calls, ['balance']);
  await assert.rejects(readFile(join(dir, 'aisa-auth.json')), { code: 'ENOENT' });
});
