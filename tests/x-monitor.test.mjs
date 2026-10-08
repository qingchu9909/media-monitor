import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { DEFAULT_X_SETTINGS, validateXSettings, quoteX, executeX, countXAttempts } from '../server/x-monitor.mjs';

const TOOL = 'get_twitter_tweet_advanced_search';
const schema = { type: 'object', properties: { query: { type: 'string' }, queryType: { type: 'string', enum: ['Latest', 'Top'] }, cursor: { type: 'string' } }, required: ['query', 'queryType'], additionalProperties: false };
const batch = data => ({ total_count: 1, success_count: 1, error_count: 0, results: [{ call_id: 'x_ai_latest', tool: TOOL, successful: true, data }] });
const price = () => batch({ currency: 'USD', estimate_kind: 'estimate', estimated_cost_micros_usd: 6525, may_exceed_estimate: true });
const tweet = { id: '123', url: 'https://x.com/OpenAI/status/123', text: 'A new model', createdAt: '2026-09-13T02:00:00Z', author: { name: 'OpenAI', userName: 'OpenAI' }, likeCount: 23, viewCount: 456, retweetCount: 3, replyCount: 0 };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-x-paid-'));
  const store = openStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { projectDir: dir, dataDir: dir, store };
}

function cli({ quote = price(), response = batch({ tweets: [tweet], has_next_page: true }), fail, onCall } = {}) {
  const calls = [];
  const runner = async (file, args, options) => {
    calls.push({ file, args, options });
    let value;
    if (args[0] === 'search') value = { tools: [{ tool: TOOL, has_full_schema: true, arguments_schema: schema }] };
    else if (args[0] === 'schema') value = { total_count: 1, success_count: 1, error_count: 0, tools: { [TOOL]: { successful: true, read_only: true, side_effects: [], arguments_schema: schema } } };
    else if (args[0] === 'quote') value = quote;
    else if (args[0] === 'call') { await onCall?.({ file, args, options }); if (fail) throw fail; value = response; }
    else assert.fail('Unexpected CLI command');
    return { stdout: JSON.stringify(value), stderr: '', exitCode: 0 };
  };
  return { runner, calls };
}

test('settings normalize handles and reject injected queries or unaccepted paid automation', () => {
  const value = validateXSettings({ handles: [' @OpenAI ', 'openai', 'github'], keywords: [' AI video ', 'AI video', '中文'], maxDailyCalls: 2 });
  assert.deepEqual(value.handles, ['OpenAI', 'github']);
  assert.deepEqual(value.keywords, ['AI video', '中文']);
  assert.equal(value.enabled, false);
  assert.equal(value.maxDailyCalls, 2);
  assert.deepEqual(DEFAULT_X_SETTINGS.handles, ['OpenAI', 'AnthropicAI', 'GoogleDeepMind', 'github', 'Saccc_c']);
  for (const input of [{ handles: [] }, { handles: ['x) OR from:evil'] }, { handles: ['a'.repeat(16)] }, { keywords: ['AI" OR from:evil'] }, { keywords: ['x\\"'] }, { keywords: ['since:2020'] }, { keywords: ['a'.repeat(61)] }, { keywords: Array(11).fill('AI') }, { enabled: true }, { enabled: 'yes' }, { acceptUncappedEstimate: 'true' }, { maxEstimatedUsd: 0 }, { maxEstimatedUsd: 5.01 }, { maxEstimatedUsd: NaN }, { maxDailyCalls: 0 }, { maxDailyCalls: 25 }, { maxDailyCalls: 1.5 }, { unrelated: true }]) assert.throws(() => validateXSettings(input), error => error.status === 400);
  assert.equal(validateXSettings({ enabled: true, acceptUncappedEstimate: true }).enabled, true);
});

test('quote discovers and verifies schema, saves a private exact request with a 15 minute expiry', async t => {
  const config = await fixture(t);
  const quote = price();
  quote.api_key = 'DO-NOT-SAVE';
  quote.results[0].data.note = 'Bearer DO-NOT-SAVE';
  const fake = cli({ quote });
  const result = await quoteX({ ...config, runner: fake.runner, settings: DEFAULT_X_SETTINGS, now: new Date('2026-09-13T03:26:39Z') });
  assert.deepEqual(fake.calls.map(c => c.args[0]), ['search', 'schema', 'quote']);
  assert.equal(result.query, '(from:OpenAI OR from:AnthropicAI OR from:GoogleDeepMind OR from:github OR from:Saccc_c) since:2026-09-12 until:2026-09-14 -filter:replies');
  assert.equal(result.estimatedUsd, 0.006525);
  assert.equal(result.mayExceedEstimate, true);
  assert.equal(result.callCount, 1);
  assert.equal(Date.parse(result.expiresAt) - Date.parse(result.quotedAt), 900000);
  const file = join(config.dataDir, 'x-quotes', result.id + '.json');
  const contents = await readFile(file, 'utf8');
  const saved = JSON.parse(contents);
  assert.ok(!contents.includes('DO-NOT-SAVE'));
  assert.match(saved.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(saved.request.calls.length, 1);
  assert.equal(saved.request.calls[0].arguments.query, result.query);
  assert.equal(saved.request.calls[0].arguments.queryType, 'Latest');
  assert.ok(!('cursor' in saved.request.calls[0].arguments));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await countXAttempts(config.dataDir), 0);
});

test('keywords remain quoted literals within the selected accounts', async t => {
  const config = await fixture(t);
  const result = await quoteX({ ...config, runner: cli().runner, settings: { handles: ['OpenAI'], keywords: ['AI video', 'OR'] }, now: new Date('2026-09-13T03:26:39Z') });
  assert.equal(result.query, '(from:OpenAI) ("AI video" OR "OR") since:2026-09-12 until:2026-09-14 -filter:replies');
});

test('failed, partial, mismatched, invalid or over-budget quotes never authorize a call', async t => {
  const config = await fixture(t);
  const bad = [
    { ...price(), error_count: 1 },
    { ...price(), total_count: 2 },
    { ...price(), results: [...price().results, ...price().results] },
    { ...price(), results: [{ ...price().results[0], call_id: 'other' }] },
    batch({ currency: 'USD', estimated_cost_micros_usd: '6525', may_exceed_estimate: true }),
    batch({ currency: 'USD', estimated_cost_micros_usd: -1, may_exceed_estimate: true }),
    batch({ currency: 'EUR', estimated_cost_micros_usd: 6525, may_exceed_estimate: true }),
    batch({ currency: 'USD', estimated_cost_micros_usd: 6525 }),
    batch({ currency: 'USD', estimated_cost_micros_usd: 60000, may_exceed_estimate: true }),
  ];
  for (const quote of bad) {
    const fake = cli({ quote });
    await assert.rejects(quoteX({ ...config, runner: fake.runner }), error => [400, 502].includes(error.status));
    assert.ok(fake.calls.every(c => c.args[0] !== 'call'));
  }
  const files = await readdir(join(config.dataDir, 'x-quotes'));
  assert.equal(files.length, 0);
});

test('unaccepted, expired, tampered and traversal quotes fail before any paid attempt', async t => {
  const config = await fixture(t);
  const fake = cli();
  const result = await quoteX({ ...config, runner: fake.runner });
  await assert.rejects(executeX({ ...config, runner: fake.runner, quoteId: result.id }), error => error.status === 400);
  await assert.rejects(executeX({ ...config, runner: fake.runner, quoteId: '../outside', acceptUncappedEstimate: true }), error => error.status === 400);
  const expired = await quoteX({ ...config, runner: fake.runner, now: new Date(Date.now() - 901000) });
  await assert.rejects(executeX({ ...config, runner: fake.runner, quoteId: expired.id, acceptUncappedEstimate: true }), error => error.status === 409);
  const file = join(config.dataDir, 'x-quotes', result.id + '.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.request.calls[0].arguments.cursor = 'next-page';
  await writeFile(file, JSON.stringify(saved));
  await assert.rejects(executeX({ ...config, runner: fake.runner, quoteId: result.id, acceptUncappedEstimate: true }), error => error.status === 409);
  assert.ok(fake.calls.every(c => c.args[0] !== 'call'));
  assert.equal(await countXAttempts(config.dataDir), 0);
});

test('one paid attempt persists before CLI runs and imports exact raw metrics without pagination', async t => {
  const config = await fixture(t);
  const response = batch({ tweets: [tweet], has_next_page: true, next_cursor: 'DO-NOT-FOLLOW' });
  response.results[0].customer_cost_micros_usd = 7100;
  const fake = cli({ response, onCall: async ({ args, options }) => {
    assert.equal(await countXAttempts(config.dataDir), 1);
    assert.equal(config.store.listRuns()[0].status, 'running');
    const attempts = (await readdir(join(config.dataDir, 'x-attempts'))).filter(f => /^[a-f0-9-]{36}\.json$/.test(f));
    assert.equal(JSON.parse(await readFile(join(config.dataDir, 'x-attempts', attempts[0]), 'utf8')).status, 'call_started');
    const input = JSON.parse(args[args.indexOf('--input') + 1]);
    assert.ok(!('cursor' in input.calls[0].arguments));
    assert.equal(options.maxBuffer, 20 * 1024 * 1024);
    assert.ok(options.timeout <= 120000);
  } });
  const quote = await quoteX({ ...config, runner: fake.runner });
  const result = await executeX({ ...config, runner: fake.runner, quoteId: quote.id, acceptUncappedEstimate: true });
  assert.deepEqual({ inserted: result.inserted, updated: result.updated, total: result.total, hasNextPage: result.hasNextPage, chargedUsd: result.chargedUsd, chargeStatus: result.chargeStatus }, { inserted: 1, updated: 0, total: 1, hasNextPage: true, chargedUsd: 0.0071, chargeStatus: 'reported' });
  const item = config.store.listItems({})[0];
  assert.deepEqual(item.metrics, { views: 456, likes: 23, reposts: 3, replies: 0 });
  assert.equal(item.author.handle, 'OpenAI');
  assert.equal(config.store.listRuns()[0].status, 'success');
  const rawFile = join(config.dataDir, 'x-attempts', result.attemptId + '-response.json');
  assert.deepEqual(JSON.parse(await readFile(rawFile, 'utf8')), response);
  assert.equal((await stat(rawFile)).mode & 0o777, 0o600);
  await assert.rejects(executeX({ ...config, runner: fake.runner, quoteId: quote.id, acceptUncappedEstimate: true }), error => error.status === 409);
  assert.equal(fake.calls.filter(c => c.args[0] === 'call').length, 1);
});

test('concurrent execution of the same quote reaches the paid CLI once', async t => {
  const config = await fixture(t);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const fake = cli({ onCall: () => waiting });
  const quote = await quoteX({ ...config, runner: fake.runner });
  const input = { ...config, runner: fake.runner, quoteId: quote.id, acceptUncappedEstimate: true };
  const first = executeX(input);
  while (!fake.calls.some(c => c.args[0] === 'call')) await new Promise(resolve => setTimeout(resolve, 2));
  await assert.rejects(executeX(input), error => error.status === 409);
  release(); await first;
  assert.equal(fake.calls.filter(c => c.args[0] === 'call').length, 1);
});

test('zero results and absent pagination or billed costs remain explicit and unknown', async t => {
  const config = await fixture(t);
  const fake = cli({ response: batch({ tweets: [], estimated_cost_micros_usd: 6525 }) });
  const quote = await quoteX({ ...config, runner: fake.runner });
  const result = await executeX({ ...config, runner: fake.runner, quoteId: quote.id, acceptUncappedEstimate: true });
  assert.equal(result.total, 0);
  assert.equal(result.hasNextPage, null);
  assert.equal(result.chargedUsd, null);
  assert.equal(result.chargeStatus, 'unknown');
  assert.equal(config.store.getSource('aisa-x').status, 'ok');
});

test('provider failure and transport exception are counted and cannot be retried or imported', async t => {
  for (const failure of ['batch', 'transport', 'nonzero']) {
    const config = await fixture(t);
    const fake = cli({ response: { ...batch({ tweets: [tweet] }), error_count: 1, success_count: 0, results: [{ call_id: 'x_ai_latest', tool: TOOL, successful: false, data: { tweets: [tweet] } }] }, fail: failure === 'transport' ? Object.assign(new Error('Bearer SECRET'), { stderr: 'SECRET account@example.org', code: 'ETIMEDOUT' }) : undefined });
    const runner = failure === 'nonzero' ? async (...args) => args[1][0] === 'call' ? { stdout: JSON.stringify(batch({ tweets: [tweet] })), exitCode: 3, stderr: 'SECRET' } : fake.runner(...args) : fake.runner;
    const quote = await quoteX({ ...config, runner });
    await assert.rejects(executeX({ ...config, runner, quoteId: quote.id, acceptUncappedEstimate: true }), error => error.status === 502 && !error.message.includes('SECRET'));
    assert.equal(await countXAttempts(config.dataDir), 1);
    assert.equal(config.store.itemCount(), 0);
    assert.equal(config.store.listRuns()[0].status, 'failed');
    await assert.rejects(executeX({ ...config, runner, quoteId: quote.id, acceptUncappedEstimate: true }), error => error.status === 409);
    const attempts = (await readdir(join(config.dataDir, 'x-attempts'))).filter(f => /^[a-f0-9-]{36}\.json$/.test(f));
    const saved = await readFile(join(config.dataDir, 'x-attempts', attempts[0]), 'utf8');
    assert.equal(JSON.parse(saved).status, 'failed');
    assert.ok(!saved.includes('SECRET'));
    assert.equal(await countXAttempts(config.dataDir, '2000-01-01'), 0);
  }
});

test('already cancelled work never starts a billable call', async t => {
  const config = await fixture(t);
  const fake = cli();
  const quote = await quoteX({ ...config, runner: fake.runner });
  await assert.rejects(executeX({ ...config, runner: fake.runner, quoteId: quote.id, acceptUncappedEstimate: true, signal: AbortSignal.abort() }), error => error.status === 409);
  assert.equal(await countXAttempts(config.dataDir), 0);
  assert.ok(fake.calls.every(c => c.args[0] !== 'call'));
});

test('cancellation after dispatch is persisted as an unknown attempt and never redelivered', async t => {
  const config = await fixture(t);
  const controller = new AbortController();
  const fake = cli({ onCall: ({ options }) => { assert.equal(options.signal, controller.signal); controller.abort(); throw Object.assign(new Error('private aborted output'), { name: 'AbortError' }); } });
  const quote = await quoteX({ ...config, runner: fake.runner });
  await assert.rejects(executeX({ ...config, runner: fake.runner, quoteId: quote.id, acceptUncappedEstimate: true, signal: controller.signal }), error => error.status === 502);
  assert.equal(await countXAttempts(config.dataDir), 1);
  assert.equal(config.store.itemCount(), 0);
  await assert.rejects(executeX({ ...config, runner: fake.runner, quoteId: quote.id, acceptUncappedEstimate: true }), error => error.status === 409);
  assert.equal(fake.calls.filter(c => c.args[0] === 'call').length, 1);
});

test('symlinked quote files and data subdirectories are rejected before reading or invoking CLI', async t => {
  const config = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'monitor-x-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const fake = cli();
  await mkdir(join(config.dataDir, 'x-quotes'));
  const id = '00000000-0000-4000-8000-000000000001';
  await writeFile(join(outside, 'secret.json'), '{}');
  await symlink(join(outside, 'secret.json'), join(config.dataDir, 'x-quotes', id + '.json'));
  await assert.rejects(executeX({ ...config, runner: fake.runner, quoteId: id, acceptUncappedEstimate: true }), error => [400, 409].includes(error.status));
  await rm(join(config.dataDir, 'x-attempts'), { recursive: true });
  await symlink(outside, join(config.dataDir, 'x-attempts'));
  await assert.rejects(quoteX({ ...config, runner: fake.runner }), error => [400, 409].includes(error.status));
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(await readdir(outside), ['secret.json']);
});

test('attempt accounting survives missing quote files and counts interrupted attempts', async t => {
  const config = await fixture(t);
  const fake = cli({ fail: new Error('connection lost') });
  const quote = await quoteX({ ...config, runner: fake.runner });
  await assert.rejects(executeX({ ...config, runner: fake.runner, quoteId: quote.id, acceptUncappedEstimate: true }));
  await rm(join(config.dataDir, 'x-quotes'), { recursive: true });
  assert.equal(await countXAttempts(config.dataDir), 1);
});

test('failed provider responses are privately saved before validation and retain reported charges', async t => {
  const config = await fixture(t);
  const response = { ...batch({ tweets: [tweet] }), success_count: 0, error_count: 1 };
  response.results[0] = { ...response.results[0], successful: false, customer_cost_micros_usd: 4321, error: { message: 'provider failure' } };
  const fake = cli({ response });
  const quote = await quoteX({ ...config, runner: fake.runner });
  let failure;
  try { await executeX({ ...config, runner: fake.runner, quoteId: quote.id, acceptUncappedEstimate: true }); } catch (error) { failure = error; }
  assert.equal(failure?.status, 502);
  assert.equal(failure.xAttempt.requestStarted, true);
  assert.equal(failure.xAttempt.callCount, 1);
  assert.equal(failure.xAttempt.chargedUsd, 0.004321);
  assert.equal(failure.xAttempt.chargeStatus, 'reported');
  assert.equal(failure.xAttempt.rawResponseSaved, true);
  assert.equal(failure.xAttempt.total, null);
  assert.equal(failure.xAttempt.inserted, null);
  assert.equal(failure.xAttempt.updated, null);
  assert.equal(failure.xAttempt.runId, config.store.listRuns()[0].id);
  const path = join(config.dataDir, 'x-attempts', failure.attemptId + '-response.json');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), response);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(config.store.itemCount(), 0);
});

test('nonzero CLI errors retain bounded stdout evidence and expose no stderr credentials', async t => {
  const config = await fixture(t);
  const response = batch({ tweets: [] }); response.results[0].customer_cost_micros_usd = 1234;
  const fake = cli({ fail: Object.assign(new Error('SECRET'), { code: 3, stdout: JSON.stringify(response), stderr: 'Bearer SECRET' }) });
  const quote = await quoteX({ ...config, runner: fake.runner });
  let failure;
  try { await executeX({ ...config, runner: fake.runner, quoteId: quote.id, acceptUncappedEstimate: true }); } catch (error) { failure = error; }
  assert.equal(failure?.xAttempt.rawResponseSaved, true);
  assert.equal(failure.xAttempt.chargedUsd, 0.001234);
  assert.ok(!JSON.stringify(failure).includes('SECRET'));
  assert.ok(!failure.message.includes('SECRET'));
  assert.equal(await countXAttempts(config.dataDir), 1);
});

test('cancellation during quote reading does not consume the quote', async t => {
  const config = await fixture(t);
  const fake = cli();
  const quote = await quoteX({ ...config, runner: fake.runner });
  const controller = new AbortController();
  const pending = executeX({ ...config, runner: fake.runner, quoteId: quote.id, acceptUncappedEstimate: true, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.status === 409 && error.xAttempt?.requestStarted === false);
  const files = await readdir(join(config.dataDir, 'x-quotes'));
  assert.ok(!files.includes(quote.id + '.consumed'));
  assert.equal(await countXAttempts(config.dataDir), 0);
});

test('cancellation before dispatch preserves an uncharged zero-count attempt', async t => {
  const config = await fixture(t);
  const controller = new AbortController();
  const store = { ...config.store, beginRun: (...args) => { const id = config.store.beginRun(...args); controller.abort(); return id; } };
  const fake = cli();
  const quote = await quoteX({ ...config, runner: fake.runner });
  let failure;
  try { await executeX({ ...config, store, runner: fake.runner, quoteId: quote.id, acceptUncappedEstimate: true, signal: controller.signal }); } catch (error) { failure = error; }
  assert.equal(failure?.status, 409);
  assert.equal(failure.xAttempt.requestStarted, false);
  assert.equal(failure.xAttempt.callCount, 0);
  assert.equal(failure.xAttempt.chargedUsd, null);
  assert.equal(failure.xAttempt.total, null);
  assert.ok(fake.calls.every(call => call.args[0] !== 'call'));
  assert.equal(await countXAttempts(config.dataDir), 0);
  const attempt = JSON.parse(await readFile(join(config.dataDir, 'x-attempts', failure.attemptId + '.json'), 'utf8'));
  assert.equal(attempt.requestStarted, false);
  assert.equal(attempt.callCount, 0);
});

test('daily attempts use Beijing dates and legacy attempt records remain counted', async t => {
  const config = await fixture(t);
  await mkdir(join(config.dataDir, 'x-attempts'));
  const records = [
    { id: '00000000-0000-4000-8000-000000000001', startedAt: '2026-09-12T15:59:59Z', callCount: 1 },
    { id: '00000000-0000-4000-8000-000000000002', startedAt: '2026-09-12T16:00:00Z', callCount: 1 },
    { id: '00000000-0000-4000-8000-000000000003', startedAt: '2026-09-13T15:59:59Z', callCount: 1 },
    { id: '00000000-0000-4000-8000-000000000004', startedAt: '2026-09-13T16:00:00Z', callCount: 1 },
    { id: '00000000-0000-4000-8000-000000000005', startedAt: '2026-09-13T02:00:00Z', callCount: 0, requestStarted: false, status: 'cancelled' },
  ];
  for (const attempt of records) await writeFile(join(config.dataDir, 'x-attempts', attempt.id + '.json'), JSON.stringify(attempt));
  assert.equal(await countXAttempts(config.dataDir, '2026-09-12'), 1);
  assert.equal(await countXAttempts(config.dataDir, '2026-09-13'), 2);
  assert.equal(await countXAttempts(config.dataDir, '2026-09-14'), 1);
});

test('a failure after collection preserves known imported counts and billed cost', async t => {
  const config = await fixture(t);
  const response = batch({ tweets: [tweet], has_next_page: false });
  response.results[0].customer_cost_micros_usd = 7000;
  const fake = cli({ response });
  const quote = await quoteX({ ...config, runner: fake.runner });
  const store = { ...config.store, recordSourceResult: () => { throw new Error('database detail must stay private'); } };
  let failure;
  try { await executeX({ ...config, store, runner: fake.runner, quoteId: quote.id, acceptUncappedEstimate: true }); }
  catch (error) { failure = error; }
  assert.equal(failure?.status, 502);
  assert.equal(failure.xAttempt.total, 1);
  assert.equal(failure.xAttempt.inserted, 1);
  assert.equal(failure.xAttempt.updated, 0);
  assert.equal(failure.xAttempt.chargedUsd, 0.007);
  assert.equal(failure.xAttempt.chargeStatus, 'reported');
  assert.equal(failure.xAttempt.hasNextPage, false);
  assert.equal(config.store.itemCount(), 1);
  assert.equal(fake.calls.filter(call => call.args[0] === 'call').length, 1);
  assert.doesNotMatch(failure.message, /database detail/);
});

test('malformed stdout is retained privately without claiming a collected empty page', async t => {
  const config = await fixture(t);
  const fake = cli();
  const quote = await quoteX({ ...config, runner: fake.runner });
  const runner = async () => ({ stdout: '{"partial":', exitCode: 0 });
  let failure;
  try { await executeX({ ...config, runner, quoteId: quote.id, acceptUncappedEstimate: true }); }
  catch (error) { failure = error; }
  assert.equal(failure?.status, 502);
  assert.equal(failure.xAttempt.rawResponseSaved, true);
  assert.equal(failure.xAttempt.total, null);
  assert.equal(failure.xAttempt.chargedUsd, null);
  assert.equal(failure.xAttempt.chargeStatus, 'unknown');
  assert.equal(await readFile(join(config.dataDir, 'x-attempts', `${failure.xAttempt.attemptId}-response.json`), 'utf8'), '{"partial":');
  assert.equal(await countXAttempts(config.dataDir), 1);
});
