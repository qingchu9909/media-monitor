import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openTranslationStore, translateItems } from '../server/translations.mjs';

const NOW = new Date('2026-09-13T08:00:00Z');
const item = (id, changes = {}) => ({ id, url: `https://example.com/posts/${id}`, title: `Example release ${id}`, summary: 'The update fixes a read-only permission bug.', publishedAt: '2026-09-13T01:00:00Z', ...changes });
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'monitor-translations-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, now: NOW };
}
function model(override) {
  const calls = [];
  const analyze = async args => {
    const input = JSON.parse(args.prompt.split('\n\n').at(-1));
    calls.push({ ...args, input });
    const value = { translations: input.items.map(row => ({ id: row.id, url: row.url, titleZh: row.summary ? '示例版本更新' : '版本记录', summaryZh: row.summary ? '此更新修复只读权限问题。' : '来源未提供摘要。', sourceQuote: row.summary || row.title })) };
    return override ? override(value, input, calls.length) : value;
  };
  return { analyze, calls };
}

test('Chinese display text is cached privately without mutating originals or repeating unchanged calls', async t => {
  const config = await fixture(t), original = item('one'), before = structuredClone(original), fake = model();
  const result = await translateItems({ ...config, items: [original], analyze: fake.analyze });
  assert.deepEqual(original, before);
  assert.equal(result.translated, 1);
  assert.equal(result.status, 'success');
  const store = openTranslationStore(config.dataDir);
  const cached = store.getMap([original])[original.url];
  assert.equal(cached.titleZh, '示例版本更新');
  assert.equal(cached.status, 'ready');
  assert.equal(cached.verification, 'not-verified');
  assert.equal(cached.originalTitle, original.title);
  store.close();
  const again = await translateItems({ ...config, items: [original], analyze: fake.analyze });
  assert.equal(again.cached, 1);
  assert.equal(fake.calls.length, 1);
  assert.equal((await stat(join(config.dataDir, 'translations.sqlite'))).mode & 0o777, 0o600);
});

test('changed originals invalidate translation while a failed replacement preserves old successful cache', async t => {
  const config = await fixture(t), original = item('changed'), fake = model();
  await translateItems({ ...config, items: [original], analyze: fake.analyze });
  const changed = { ...original, summary: 'A different release with no described changes.' };
  const failed = await translateItems({ ...config, items: [changed], analyze: async () => { throw new Error('Bearer SECRET-CREDENTIAL'); } });
  assert.equal(failed.failed, 1);
  assert.equal(failed.status, 'failed');
  assert.doesNotMatch(JSON.stringify(failed), /SECRET-CREDENTIAL/);
  const store = openTranslationStore(config.dataDir);
  assert.equal(store.get(original).status, 'ready');
  assert.equal(store.get(changed).status, 'failed');
  assert.equal(store.get(changed).titleZh, null);
  assert.notEqual(store.get(original).contentHash, store.get(changed).contentHash);
  store.close();
});

test('mostly Chinese originals bypass models while a Chinese keyword in English and code-only versions translate', async t => {
  const config = await fixture(t), fake = model();
  const chinese = item('zh', { title: 'OpenAI 推出工具更新', summary: '这次更新修复了只读权限问题。' });
  const mixed = item('mixed', { title: '中文 Update explains a new release and fixes a permission issue', summary: 'The update fixes a read-only permission bug.' });
  const code = item('code', { title: 'v2.1.270', summary: '' });
  const result = await translateItems({ ...config, items: [chinese, mixed, code], analyze: fake.analyze });
  assert.equal(result.skipped, 1);
  assert.equal(result.translated, 2);
  assert.equal(fake.calls[0].input.items.length, 2);
  assert.equal(result.results[chinese.url].status, 'original');
  assert.equal(result.results[chinese.url].titleZh, chinese.title);
});

test('recent mode excludes unknown, old and future dates while requested mode translates selected old items', async t => {
  const config = await fixture(t), fake = model();
  const old = item('old', { publishedAt: '2026-07-01T00:00:00Z' });
  const unknown = item('unknown', { publishedAt: null });
  const future = item('future', { publishedAt: '2027-01-01T00:00:00Z' });
  const result = await translateItems({ ...config, items: [old, unknown, future, item('new')], analyze: fake.analyze });
  assert.equal(result.translated, 1);
  assert.equal(result.skipped, 3);
  const requested = await translateItems({ ...config, items: [old], mode: 'requested', analyze: fake.analyze });
  assert.equal(requested.translated, 1);
  assert.equal(fake.calls.length, 2);
});

test('bounded batches stop after configured cap and only send public input content', async t => {
  const config = await fixture(t), fake = model();
  const items = Array.from({ length: 7 }, (_, i) => item(String(i), { secret: 'NEVER-SEND', account: 'PRIVATE', content: 'This is public article text.' }));
  const result = await translateItems({ ...config, items, maxItems: 5, batchSize: 2, analyze: fake.analyze });
  assert.equal(result.translated, 5);
  assert.equal(result.remaining, 2);
  assert.deepEqual(fake.calls.map(call => call.input.items.length), [2, 2, 1]);
  for (const call of fake.calls) {
    assert.doesNotMatch(call.prompt, /NEVER-SEND|PRIVATE/);
    assert.match(call.prompt, /不可信/);
    assert.equal(call.schema.additionalProperties, false);
  }
});

test('missing, extra, duplicated or mismatched IDs and URLs reject the whole batch', async t => {
  for (const corrupt of [
    value => ({ translations: value.translations.slice(1) }),
    value => ({ translations: [...value.translations, value.translations[0]] }),
    value => ({ translations: value.translations.map(row => ({ ...row, url: 'https://other.example/news' })) }),
    value => ({ translations: value.translations.map(row => ({ ...row, id: 'invented' })) }),
  ]) {
    const config = await fixture(t), fake = model(corrupt);
    const result = await translateItems({ ...config, items: [item('a'), item('b')], analyze: fake.analyze });
    assert.equal(result.translated, 0);
    assert.equal(result.failed, 2);
    assert.equal(result.status, 'failed');
  }
});

test('English-only output, invented quantities and unsupported source quotes are rejected', async t => {
  for (const corrupt of [
    row => ({ ...row, titleZh: 'New update', summaryZh: 'The update fixes a bug.' }),
    row => ({ ...row, titleZh: '中文 Update explains a new release and fixes a permission issue', summaryZh: 'The update fixes a read-only permission bug.' }),
    row => ({ ...row, summaryZh: '性能提高 999 倍。' }),
    row => ({ ...row, sourceQuote: 'An invented source quotation.' }),
  ]) {
    const config = await fixture(t), fake = model(value => ({ translations: value.translations.map(corrupt) }));
    const result = await translateItems({ ...config, items: [item('bad')], analyze: fake.analyze });
    assert.equal(result.failed, 1);
    assert.equal(result.results[item('bad').url].titleZh, null);
  }
});

test('a later batch failure leaves earlier successes available and reports partial completion', async t => {
  const config = await fixture(t), fake = model((value, input, call) => { if (call === 2) throw new Error('model failed'); return value; });
  const result = await translateItems({ ...config, items: [item('a'), item('b'), item('c')], batchSize: 1, analyze: fake.analyze });
  assert.equal(result.translated, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.remaining, 1);
  assert.equal(result.status, 'partial');
  assert.equal(result.results[item('a').url].status, 'ready');
  assert.equal(result.results[item('b').url].status, 'failed');
});

test('cancellation preserves prior batches and carries explicit partial results without further calls', async t => {
  const config = await fixture(t), controller = new AbortController();
  const fake = model((value, input, call) => { if (call === 2) controller.abort(); return value; });
  let error;
  try { await translateItems({ ...config, items: [item('a'), item('b'), item('c')], batchSize: 1, analyze: fake.analyze, signal: controller.signal }); }
  catch (failure) { error = failure; }
  assert.equal(error?.name, 'AbortError');
  assert.equal(error.translationResult.translated, 1);
  assert.equal(error.translationResult.remaining, 2);
  assert.equal(error.translationResult.status, 'cancelled');
  assert.equal(fake.calls.length, 2);
  const store = openTranslationStore(config.dataDir);
  assert.equal(store.get(item('a')).status, 'ready');
  assert.equal(store.get(item('b')).status, 'failed');
  store.close();
});

test('symlinked cache files and directories are rejected without reading through them', async t => {
  const config = await fixture(t), outside = await fixture(t);
  const target = join(outside.dataDir, 'secret');
  await writeFile(target, 'DO-NOT-READ');
  await symlink(target, join(config.dataDir, 'translations.sqlite'));
  assert.throws(() => openTranslationStore(config.dataDir), error => error.status === 409);
  const linked = join(outside.dataDir, 'linked');
  await symlink(config.dataDir, linked);
  assert.throws(() => openTranslationStore(linked), error => error.status === 409);
});

test('content changes also invalidate the key and pre-cancelled work never calls a model', async t => {
  const config = await fixture(t), fake = model(), original = item('content', { content: 'Original public body.' });
  await translateItems({ ...config, items: [original], analyze: fake.analyze });
  const store = openTranslationStore(config.dataDir);
  assert.equal(store.get({ ...original, content: 'Changed body.' }).status, 'pending');
  store.close();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(translateItems({ ...config, items: [item('cancel')], signal: controller.signal, analyze: fake.analyze }), error => error.name === 'AbortError' && error.translationResult.modelCalls === 0);
  assert.equal(fake.calls.length, 1);
});

test('saving failed state cannot erase a successful cache from another connection', async t => {
  const config = await fixture(t), original = item('race'), fake = model();
  const result = await translateItems({ ...config, items: [original], analyze: fake.analyze });
  const cache = result.results[original.url];
  const first = openTranslationStore(config.dataDir), second = openTranslationStore(config.dataDir);
  second.saveBatch([{ source: { ...original, originalTitle: original.title, originalSummary: original.summary, originalContent: '', contentHash: cache.contentHash }, value: { status: 'failed', method: 'codex', updatedAt: NOW.toISOString(), error: 'failure' } }]);
  assert.equal(first.get(original).status, 'ready');
  assert.equal(first.get(original).titleZh, cache.titleZh);
  first.close(); second.close();
});

test('a long Chinese title cannot conceal an English summary from validation', async t => {
  const config = await fixture(t);
  const fake = model(value => ({ translations: value.translations.map(row => ({ ...row, titleZh: '面向创作者的视频工作流更新与功能说明'.repeat(5), summaryZh: 'The update fixes a bug.' })) }));
  const result = await translateItems({ ...config, items: [item('mixed-fields')], analyze: fake.analyze });
  assert.equal(result.translated, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.remaining, 1);
  assert.equal(result.results[item('mixed-fields').url].status, 'failed');
});

test('legacy ready caches with invalid or overlong summaries are rejected and repaired, not reused forever', async t => {
  const config = await fixture(t), original = item('legacy');
  const cache = openTranslationStore(config.dataDir);
  const source = cache.get(original);
  cache.saveBatch([{ source, value: { status: 'ready', method: 'codex', titleZh: '中文标题'.repeat(15), summaryZh: 'The update fixes a bug.', sourceQuote: original.summary, updatedAt: NOW.toISOString() } }]);
  assert.equal(cache.get(original).status, 'pending');
  assert.equal(cache.get(original).reason, 'invalid-chinese');
  cache.saveBatch([{ source, value: { status: 'ready', method: 'codex', titleZh: '视频编辑功能更新', summaryZh: '这条记录说明如何使用视频工具。'.repeat(50), sourceQuote: original.summary, updatedAt: NOW.toISOString() } }]);
  assert.equal(cache.get(original).status, 'pending');
  assert.equal(cache.get(original).reason, 'invalid-chinese');
  cache.close();
  const fake = model();
  const repaired = await translateItems({ ...config, items: [original], analyze: fake.analyze });
  assert.equal(repaired.cached, 0);
  assert.equal(repaired.translated, 1);
  assert.equal(repaired.remaining, 0);
  assert.equal(repaired.results[original.url].isReadable, true);
});

test('placeholder summaries are explicitly missing and do not trigger title-based fabricated abstracts', async t => {
  const config = await fixture(t), original = item('placeholder', { title: '新的视频编辑指南', summary: '点击查看原文>' }), fake = model();
  const result = await translateItems({ ...config, items: [original], analyze: fake.analyze });
  assert.equal(fake.calls.length, 0);
  assert.equal(result.missingSummary, 1);
  assert.equal(result.results[original.url].summaryStatus, 'missing');
  assert.equal(result.results[original.url].isReadable, false);
  assert.equal(result.results[original.url].summaryZh, '来源未提供有效摘要，可打开原文查看。');
});

test('failed prefixes do not consume every future batch and remaining counts the entire eligible queue', async t => {
  const config = await fixture(t);
  const items = Array.from({ length: 6 }, (_, index) => item(`queued-${index}`));
  const failed = await translateItems({ ...config, items, maxItems: 3, batchSize: 1, analyze: async () => { throw new Error('offline fixture'); } });
  assert.equal(failed.remaining, 6);
  assert.equal(failed.deferred, 3);
  const fake = model();
  const next = await translateItems({ ...config, items, maxItems: 3, batchSize: 1, analyze: fake.analyze });
  assert.deepEqual(fake.calls.flatMap(call => call.input.items.map(row => row.url)), items.slice(3).map(row => row.url));
  assert.equal(next.translated, 3);
  assert.equal(next.remaining, 3);
  assert.equal(next.status, 'partial');
});

test('useful items receive priority while a reserved slot prevents custom-topic starvation', async t => {
  const config = await fixture(t), fake = model();
  const items = Array.from({ length: 10 }, (_, index) => item(`priority-${index}`));
  const priorityUrls = items.slice(0, 7).map(row => row.url);
  const result = await translateItems({ ...config, items, priorityUrls, maxItems: 5, analyze: fake.analyze });
  assert.deepEqual(fake.calls[0].input.items.map(row => row.url), [...items.slice(0, 4), items[7]].map(row => row.url));
  assert.equal(result.candidateCount, 10);
  assert.equal(result.selected, 5);
  assert.equal(result.remaining, 5);
  assert.equal(result.deferred, 5);
});

test('full mixed-language originals cannot bypass translation through a truncated Chinese prefix', async t => {
  const config = await fixture(t), original = item('long', { title: '视频工具更新', summary: `${'这是中文内容。'.repeat(2000)} The update adds a feature for video projects.` });
  const cache = openTranslationStore(config.dataDir);
  assert.equal(cache.get(original).status, 'pending');
  cache.close();
});

test('Reddit author and navigation tails are not summaries, while preceding text remains usable', async t => {
  const config = await fixture(t), fake = model();
  const footer = 'submitted by /u/robomar_ai_art [link] [comments]';
  const noBody = item('reddit-empty', { title: 'TaoMate H3 3 Step LoRA now working in ComfyUI', summary: footer });
  const withBody = item('reddit-body', { summary: `The update fixes a read-only permission bug. ${footer}` });
  const result = await translateItems({ ...config, items: [noBody, withBody], analyze: fake.analyze });
  assert.equal(result.translated, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.remaining, 0);
  assert.equal(result.missingSummary, 1);
  assert.equal(result.results[noBody.url].summaryStatus, 'missing');
  assert.equal(result.results[noBody.url].isReadable, false);
  assert.equal(result.results[noBody.url].originalSummary, footer);
  assert.equal(result.results[withBody.url].isReadable, true);
  assert.equal(result.results[withBody.url].sourceQuote, 'The update fixes a read-only permission bug.');
  const inputs = fake.calls[0].input.items;
  assert.equal(inputs[0].summaryAvailable, false);
  assert.equal(inputs[0].summary, '');
  assert.equal(inputs[1].summaryAvailable, true);
  assert.equal(inputs[1].summary, 'The update fixes a read-only permission bug.');
  const again = await translateItems({ ...config, items: [noBody, withBody], analyze: fake.analyze });
  assert.equal(again.cached, 2);
  assert.equal(fake.calls.length, 1);
});

test('real body text overrides a missing RSS summary and may supply the Chinese abstract', async t => {
  const config = await fixture(t);
  const original = item('body-only', { summary: 'submitted by /u/author [link] [comments]', content: 'The update fixes a read-only permission bug.' });
  const fake = model((value, input) => ({ translations: value.translations.map((row, index) => ({ ...row, summaryZh: '此更新修复只读权限问题。', sourceQuote: input.items[index].content })) }));
  const result = await translateItems({ ...config, items: [original], analyze: fake.analyze });
  assert.equal(fake.calls[0].input.items[0].summaryAvailable, true);
  assert.equal(result.translated, 1);
  assert.equal(result.missingSummary, 0);
  assert.equal(result.results[original.url].isReadable, true);
});

test('semantic failures are isolated by row and diagnostics identify the original item and invalid field', async t => {
  const config = await fixture(t);
  const originals = [item('valid'), item('false-placeholder'), item('english-summary')];
  const fake = model(value => ({ translations: value.translations.map((row, index) => index === 1 ? { ...row, summaryZh: '来源未提供有效摘要，可打开原文查看。' }
    : index === 2 ? { ...row, summaryZh: 'The update fixes a bug.' } : row) }));
  const result = await translateItems({ ...config, items: originals, analyze: fake.analyze });
  assert.equal(result.translated, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.remaining, 2);
  assert.equal(result.status, 'partial');
  assert.equal(result.results[originals[0].url].status, 'ready');
  assert.equal(result.results[originals[1].url].status, 'failed');
  assert.equal(result.results[originals[2].url].status, 'failed');
  assert.deepEqual(result.failureReasons.map(({ count, field, items }) => ({ count, field, items })), originals.slice(1).map((row, index) => ({ count: 1, field: 'summaryZh', items: [{ id: row.id, url: row.url, requestId: `t${index + 2}` }] })));
  assert.match(result.failureReasons[0].reason, /原文有内容/);
  assert.match(result.failureReasons[1].reason, /摘要没有转为可读中文/);
  assert.doesNotMatch(JSON.stringify(result.failureReasons), /The update/);
  const repair = model();
  const retried = await translateItems({ ...config, items: originals, analyze: repair.analyze });
  assert.equal(retried.cached, 1);
  assert.equal(retried.translated, 2);
  assert.equal(retried.remaining, 0);
  assert.deepEqual(repair.calls[0].input.items.map(row => row.url), originals.slice(1).map(row => row.url));
});

test('a malformed or duplicated later row prevents accepting an earlier valid row', async t => {
  for (const corrupt of [
    rows => [rows[0], { ...rows[1], id: rows[0].id, url: rows[0].url }],
    rows => [rows[0], { ...rows[1], extra: 'unexpected' }],
  ]) {
    const config = await fixture(t), fake = model(value => ({ translations: corrupt(value.translations) }));
    const originals = [item('safe-first'), item('bad-last')];
    const result = await translateItems({ ...config, items: originals, analyze: fake.analyze });
    assert.equal(result.translated, 0);
    assert.equal(result.failed, 2);
    assert.equal(result.remaining, 2);
    assert.equal(result.results[originals[0].url].status, 'failed');
    assert.equal(result.failureReasons[0].count, 2);
    assert.ok(['identity', 'schema'].includes(result.failureReasons[0].field));
    assert.deepEqual(result.failureReasons[0].items.map(row => row.id), originals.map(row => row.id));
  }
});

test('missing source bodies cannot acquire invented abstracts through new or legacy translations', async t => {
  const config = await fixture(t);
  const original = item('invented-abstract', { summary: 'submitted by /u/author [link] [comments]' });
  const fake = model(value => ({ translations: value.translations.map(row => ({ ...row, summaryZh: '此更新修复只读权限问题。' })) }));
  const result = await translateItems({ ...config, items: [original], analyze: fake.analyze });
  assert.equal(result.translated, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.failureReasons[0].field, 'summaryZh');
  assert.match(result.failureReasons[0].reason, /不能根据标题生成摘要/);
  const cache = openTranslationStore(config.dataDir);
  const source = cache.get(original);
  cache.saveBatch([{ source, value: { status: 'ready', method: 'codex', titleZh: '工具的新版本说明', summaryZh: '此更新修复只读权限问题。', updatedAt: NOW.toISOString() } }]);
  assert.equal(cache.get(original).status, 'pending');
  assert.equal(cache.get(original).reason, 'invalid-chinese');
  cache.close();
});

test('formal wire schema fixes item keys and trusted code restores IDs and URLs regardless of key order', async t => {
  const config = await fixture(t);
  const originals = [item('wire-one'), item('wire-two', { summary: 'The update introduces a new video export workflow.' })];
  const fake = model(value => ({ translations: Object.fromEntries(value.translations.toReversed().map(({ id, url, ...content }) => [id, content])) }));
  const result = await translateItems({ ...config, items: originals, analyze: fake.analyze });
  assert.equal(result.translated, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.remaining, 0);
  for (const original of originals) {
    assert.equal(result.results[original.url].sourceQuote, original.summary);
    assert.equal(result.results[original.url].url, original.url);
  }
  const outer = fake.calls[0].schema;
  assert.equal(outer.additionalProperties, false);
  assert.deepEqual(outer.required, ['translations']);
  const wire = outer.properties.translations;
  assert.equal(wire.type, 'object');
  assert.equal(wire.additionalProperties, false);
  assert.deepEqual(wire.required, ['t1', 't2']);
  assert.deepEqual(Object.keys(wire.properties), ['t1', 't2']);
  for (const fields of Object.values(wire.properties)) {
    assert.equal(fields.additionalProperties, false);
    assert.deepEqual(fields.required, ['titleZh', 'summaryZh', 'sourceQuote']);
    assert.deepEqual(Object.keys(fields.properties), ['titleZh', 'summaryZh', 'sourceQuote']);
    assert.equal(fields.properties.id, undefined);
    assert.equal(fields.properties.url, undefined);
  }
});

test('fixed-key wire responses reject missing or unknown keys and extra identity fields before saving', async t => {
  for (const corrupt of [
    output => { delete output.translations.t2; return output; },
    output => ({ translations: { ...output.translations, invented: output.translations.t2 } }),
    output => ({ translations: { t1: output.translations.t1, invented: output.translations.t2 } }),
    output => { output.translations.t2.url = 'https://other.example/swapped'; return output; },
    output => { output.translations.t2.id = 't1'; return output; },
    output => { output.translations.t2.summaryZh = null; return output; },
  ]) {
    const config = await fixture(t);
    const fake = model(value => corrupt({ translations: Object.fromEntries(value.translations.map(({ id, url, ...content }) => [id, content])) }));
    const originals = [item('wire-valid-first'), item('wire-invalid-second')];
    const result = await translateItems({ ...config, items: originals, analyze: fake.analyze });
    assert.equal(result.translated, 0);
    assert.equal(result.failed, 2);
    assert.equal(result.remaining, 2);
    assert.equal(result.results[originals[0].url].status, 'failed');
    assert.ok(['identity', 'schema'].includes(result.failureReasons[0].field));
    assert.doesNotMatch(JSON.stringify(result.failureReasons), /other\.example|invented/);
  }
});

test('fixed item keys do not let swapped source quotations bypass per-item validation', async t => {
  const config = await fixture(t);
  const originals = [item('wire-quotes-one'), item('wire-quotes-two', { summary: 'The update introduces a new video export workflow.' })];
  const fake = model(value => ({ translations: Object.fromEntries(value.translations.map(({ id, url, ...content }, index) => [id, { ...content, sourceQuote: value.translations[1 - index].sourceQuote }])) }));
  const result = await translateItems({ ...config, items: originals, analyze: fake.analyze });
  assert.equal(result.translated, 0);
  assert.equal(result.failed, 2);
  assert.equal(result.remaining, 2);
  assert.deepEqual(result.failureReasons.map(failure => failure.field), ['sourceQuote', 'sourceQuote']);
  assert.deepEqual(result.failureReasons.flatMap(failure => failure.items.map(source => source.url)), originals.map(source => source.url));
});

test('fixed-key wire quality failures remain isolated without relaxing the separate Chinese-field checks', async t => {
  const config = await fixture(t);
  const originals = [item('wire-ok'), item('wire-short-chinese', { title: 'Introducing ChatGPT Images 2.5' }), item('wire-english-summary')];
  const fake = model(value => ({ translations: Object.fromEntries(value.translations.map(({ id, url, ...content }, index) => [id, index === 1 ? { ...content, titleZh: 'ChatGPT Images 2.5 发布' }
    : index === 2 ? { ...content, titleZh: '面向创作者的视频工具功能说明'.repeat(4), summaryZh: '中文 The update introduces a new video export workflow.' } : content])) }));
  const result = await translateItems({ ...config, items: originals, analyze: fake.analyze });
  assert.equal(result.translated, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.remaining, 2);
  assert.equal(result.results[originals[0].url].isReadable, true);
  assert.deepEqual(result.failureReasons.map(failure => failure.field), ['titleZh', 'summaryZh']);
});

test('title prompt requires substantial Chinese explanations while preserving product versions and missing-body semantics', async t => {
  const config = await fixture(t);
  const originals = [
    item('images', { title: 'Introducing ChatGPT Images 2.5', summary: 'Introducing the new image product and its creation tools.' }),
    item('nightly', { title: 'Gemini CLI v0.33.0-nightly.20260913.abc123', summary: 'Full Changelog: v0.32.0...v0.33.0-nightly.20260913.abc123' }),
    item('gradio', { title: 'Gradio Workflow', summary: '' }),
  ];
  const titles = ['ChatGPT Images 2.5 产品发布内容介绍', 'Gemini CLI 工具每日构建的版本记录 v0.33.0-nightly.20260913.abc123', 'Gradio 工作流相关内容的标题信息'];
  const summaries = ['原文介绍新的图像产品与创作工具。', '这是每日构建的版本记录，来源提供版本比较链接。', '来源未提供有效摘要，可打开原文查看。'];
  const fake = model((value, input) => ({ translations: Object.fromEntries(input.items.map((source, index) => [source.id, { titleZh: titles[index], summaryZh: summaries[index], sourceQuote: source.title }])) }));
  const result = await translateItems({ ...config, items: originals, analyze: fake.analyze });
  assert.equal(result.translated, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.results[originals[0].url].titleZh, titles[0]);
  assert.equal(result.results[originals[1].url].titleZh, titles[1]);
  assert.equal(result.results[originals[2].url].summaryStatus, 'missing');
  assert.equal(result.results[originals[2].url].isReadable, false);
  assert.match(fake.calls[0].prompt, /至少包含 8 个汉字/);
  assert.match(fake.calls[0].prompt, /汉字数量至少为英文单词数的两倍/);
  assert.match(fake.calls[0].prompt, /不要输出 id 或 url 字段/);
  assert.match(fake.calls[0].prompt, /保留原有数字、日期、版本的字面写法/);
});
