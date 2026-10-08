import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chineseContent, useChineseContent } from '../src/chinese-content.js';
import { openStore } from '../server/store.mjs';
import { openOperations } from '../server/operation-store.mjs';
import { createJobManager } from '../server/job-manager.mjs';
import { openTranslationStore, translateItems } from '../server/translations.mjs';
import { generateBrief, validateAnalysis } from '../server/analysis.mjs';
import { getBrief, renderBriefMarkdown } from '../server/briefs.mjs';
import { validateEditorial } from '../server/editorial.mjs';

const DATE = '2026-09-13';
const NOW = new Date(`${DATE}T08:00:00Z`);
const PUBLIC_ITEM = { url: 'https://example.org/old-openai-guide', title: 'OpenAI video editing guide', summary: 'This public guide explains a workflow for editing and exporting short videos.', publishedAt: '2026-07-01T01:00:00Z' };
const NO_TRANSLATION = { status: 'success', translated: 0, cached: 0, skipped: 0, failed: 0, remaining: 0, modelCalls: 0, results: {} };

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-translation-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function managerFixture(t, translate = async () => NO_TRANSLATION) {
  const dir = await directory(t);
  const store = openStore(dir);
  store.upsertItems('openai', [PUBLIC_ITEM]);
  const item = store.listItems()[0];
  let paidCalls = 0;
  const manager = createJobManager({
    store, projectDir: dir, translate,
    capabilities: async () => ({ codexInstalled: true, codexAuthenticated: true }),
    collectorOptions: { fetchImpl: async () => { throw new Error('No real network in this fixture'); } },
    analysisOptions: { analyze: async () => { throw new Error('No real analysis in this fixture'); }, fetchText: async () => { throw new Error('No real page requests in this fixture'); } },
    xOptions: { runner: async () => { paidCalls++; throw new Error('No AIsa calls in this fixture'); } },
  });
  t.after(async () => { await manager.close(); store.close(); });
  return { dir, store, manager, item, paidCalls: () => paidCalls };
}

test('uncached translation pending is idle, while the selected active item alone shows translating', async t => {
  const dir = await directory(t);
  const item = { ...PUBLIC_ITEM, id: 'old-item' };
  const cache = openTranslationStore(dir);
  try { item.translation = cache.get(item); } finally { cache.close(); }
  assert.equal(item.translation.status, 'pending');
  function Probe({ pendingTranslations }) {
    const result = useChineseContent(item, { onTranslate: async () => {}, pendingTranslations });
    return React.createElement('div', { 'data-pending': result.pending, 'data-needs-translation': result.needsTranslation });
  }
  const idle = renderToStaticMarkup(React.createElement(Probe, { pendingTranslations: new Set() }));
  const active = renderToStaticMarkup(React.createElement(Probe, { pendingTranslations: new Set([item.id]) }));
  assert.match(idle, /data-pending="false"/);
  assert.match(idle, /data-needs-translation="true"/);
  assert.match(active, /data-pending="true"/);
});

test('requested historical translation keeps the exact source date and never performs analysis or AIsa calls', async t => {
  const calls = [];
  const fixture = await managerFixture(t, async options => { calls.push(options); return { ...NO_TRANSLATION, translated: options.items.length }; });
  const started = fixture.manager.start({ kind: 'translation', itemIds: [fixture.item.id, fixture.item.id] });
  await fixture.manager.idle();
  const finished = (await fixture.manager.snapshot()).jobs.find(job => job.id === started.id);
  assert.equal(finished.status, 'success');
  assert.equal(calls.length, 1); assert.equal(calls[0].mode, 'requested');
  assert.deepEqual(calls[0].items.map(item => item.id), [fixture.item.id]);
  assert.equal(calls[0].items[0].publishedAt, fixture.item.publishedAt);
  assert.equal(finished.result.analysis, null); assert.equal(finished.result.x, null);
  assert.equal(fixture.paidCalls(), 0);
});

test('job polling stores translation statistics while the independent cache still supplies Chinese display', async t => {
  let modelCalls = 0;
  const fixture = await managerFixture(t, options => translateItems({ ...options, analyze: async ({ schema }) => {
    modelCalls++;
    const [id] = schema.properties.translations.required;
    return { translations: { [id]: { titleZh: '公开视频剪辑指南', summaryZh: '这份公开指南介绍短视频剪辑和导出的工作流程。', sourceQuote: 'workflow for editing and exporting short videos' } } };
  } }));
  const job = fixture.manager.start({ kind: 'translation', itemIds: [fixture.item.id] });
  await fixture.manager.idle();
  const completed = (await fixture.manager.snapshot()).jobs.find(entry => entry.id === job.id);
  assert.equal(completed.status, 'success');
  assert.equal(completed.result.translation.translated, 1);
  assert.equal(Object.hasOwn(completed.result.translation, 'results'), false);
  assert.equal(JSON.stringify(completed.result).includes('公开视频剪辑指南'), false);
  const cache = openTranslationStore(fixture.dir);
  let translationMap;
  try { translationMap = cache.getMap([fixture.item]); } finally { cache.close(); }
  assert.equal(translationMap[fixture.item.url].status, 'ready');
  assert.equal(translationMap[fixture.item.url].verification, 'not-verified');
  const display = chineseContent(fixture.item, translationMap);
  assert.equal(display.title, '公开视频剪辑指南');
  assert.equal(display.summary, '这份公开指南介绍短视频剪辑和导出的工作流程。');
  assert.equal(modelCalls, 1);
  assert.equal(fixture.paidCalls(), 0);
});

test('translation shares the exclusive task lock and cancellation releases it without paid requests', async t => {
  let entered;
  const translating = new Promise(resolve => { entered = resolve; });
  const fixture = await managerFixture(t, async ({ signal }) => {
    entered();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const job = fixture.manager.start({ kind: 'translation', itemIds: [fixture.item.id] });
  await translating;
  for (const input of [{ kind: 'translation', itemIds: [fixture.item.id] }, { kind: 'analysis' }, { kind: 'refresh' }, { kind: 'x', quoteId: 'fake-quote', acceptUncappedEstimate: true }]) {
    assert.throws(() => fixture.manager.start(input), error => error.status === 409);
  }
  assert.throws(() => fixture.manager.saveSettings({ editorial: { focus: 'tools' } }), error => error.status === 409);
  await assert.rejects(fixture.manager.quote(), error => error.status === 409);
  fixture.manager.cancel(job.id); await fixture.manager.idle();
  assert.equal(fixture.manager.activeJob(), null);
  assert.equal((await fixture.manager.snapshot()).jobs[0].status, 'cancelled');
  assert.equal(fixture.store.listItems()[0].url, PUBLIC_ITEM.url);
  assert.equal(fixture.paidCalls(), 0);
});

test('a translation with zero successful items is failed, not partial success', async t => {
  const { manager, item } = await managerFixture(t, async () => ({ ...NO_TRANSLATION, status: 'failed', failed: 1 }));
  manager.start({ kind: 'translation', itemIds: [item.id] }); await manager.idle();
  const state = await manager.snapshot();
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[0].result.translation.translated, 0);
});

test('editorial preference changes preserve paid settings and invalid combined settings are atomic', async t => {
  const dir = await directory(t);
  const ops = openOperations(dir);
  t.after(() => ops.close());
  const paid = ops.saveSettings({ x: { handles: ['OpenAI'], enabled: false, acceptUncappedEstimate: false, maxEstimatedUsd: 0.03, maxDailyCalls: 2 } }).x;
  const changed = ops.saveSettings({ editorial: { focus: 'tools', windowDays: 3, excludePromotions: false } });
  assert.deepEqual(changed.x, paid);
  const before = structuredClone(ops.settings());
  assert.throws(() => ops.saveSettings({ editorial: { focus: 'balanced' }, x: { enabled: true, acceptUncappedEstimate: false } }));
  assert.deepEqual(ops.settings(), before);
  const next = ops.saveSettings({ x: { maxDailyCalls: 3 } });
  assert.deepEqual(next.editorial, before.editorial);
  assert.equal(next.x.enabled, false); assert.equal(next.x.acceptUncappedEstimate, false);
});

test('English-only analysis cannot bypass the Chinese display requirement via titleZh fields', () => {
  const text = 'The public release adds offline export and fixes a read-only permission issue.';
  const evidence = [{ url: PUBLIC_ITEM.url, sourceName: 'Official', publishedAt: `${DATE}T01:00:00Z`, pageEvidenceText: text }];
  const english = { summary: 'A useful release.', highlights: [{ url: PUBLIC_ITEM.url, titleZh: 'A new release', summaryZh: 'The release adds offline export.', whyItMatters: 'Useful for a workflow tutorial.', supportingQuote: 'adds offline export' }], ideas: [] };
  assert.throws(() => validateAnalysis(english, evidence), error => error.status === 502);
});

async function previousBriefFixture(t, item) {
  const dir = await directory(t);
  const store = openStore(dir);
  t.after(() => store.close());
  store.upsertItems('openai', [item]);
  await mkdir(join(dir, 'briefs')); await mkdir(join(dir, 'reports'));
  const previous = { date: DATE, title: '上一次推荐', generatedAt: `${DATE}T01:00:00Z`, status: 'reviewed', generationMethod: '先前偏好', summary: '之前的候选结果', highlights: [{ url: item.url, titleZh: '旧候选', summaryZh: '上次保留的内容', whyItMatters: '编辑建议', sourceName: 'Official', publishedAt: item.publishedAt }], ideas: [{ title: '旧选题', angle: '旧角度', hook: '旧开头', sourceUrls: [item.url] }], coverage: [], caveats: [] };
  await writeFile(join(dir, 'briefs', `${DATE}.json`), JSON.stringify(previous));
  await writeFile(join(dir, 'reports', `${DATE}-brief.md`), renderBriefMarkdown(previous));
  return { dir, store };
}

for (const scenario of [
  { name: 'narrower observation window', item: { ...PUBLIC_ITEM, publishedAt: '2026-09-10T01:00:00Z' }, preferences: { windowDays: 1 } },
  { name: 'promotion exclusion', item: { ...PUBLIC_ITEM, title: 'OpenAI creator event tickets', summary: 'Register now and buy tickets for the creator event. Grab your in-person pass and early bird offer.', publishedAt: `${DATE}T02:00:00Z` }, preferences: { excludePromotions: true } },
]) test(`old highlights and ideas excluded by ${scenario.name} leave the current brief and remain in history`, async t => {
  const { dir, store } = await previousBriefFixture(t, scenario.item);
  let modelCalls = 0, pageCalls = 0;
  await generateBrief({ store, now: NOW, preferences: validateEditorial(scenario.preferences), analyze: async () => { modelCalls++; throw new Error('No model expected without eligible candidates'); }, fetchText: async () => { pageCalls++; throw new Error('No source page expected'); } });
  const current = await getBrief(dir, DATE);
  assert.deepEqual(current.highlights, []);
  assert.deepEqual(current.ideas, []);
  assert.equal(modelCalls, 0); assert.equal(pageCalls, 0);
  const history = await readdir(join(dir, 'briefs', 'history'));
  assert.ok(history.length > 0);
  const archived = JSON.parse(await readFile(join(dir, 'briefs', 'history', history[0]), 'utf8'));
  assert.equal(archived.highlights[0].url, scenario.item.url);
  assert.equal(archived.ideas[0].sourceUrls[0], scenario.item.url);
});
