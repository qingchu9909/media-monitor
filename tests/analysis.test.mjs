import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import * as analysis from '../server/analysis.mjs';
import { getBrief, readBriefCatalog, renderBriefMarkdown } from '../server/briefs.mjs';

const date = '2026-09-13';
const url = 'https://example.org/release';
const page = 'The release adds an offline export option and fixes the startup crash. The official notes explain how to enable export in the settings panel.';
const excerpt = 'The feed says automatic cloud backups are available for every user. This separate summary also explains changes that do not appear on the fetched page.';
const output = quote => ({ summary: '一项可核对的更新', highlights: [{ url, titleZh: '这项更新值得测试', summaryZh: '按照来源说明验证变化。', whyItMatters: '编辑判断：可以实测。', supportingQuote: quote }], ideas: [{ title: '实际测试', angle: '按来源说明测试', hook: '这次到底改了什么？', sourceUrls: [url] }] });

test('analysis gives duplicate coverage only one candidate slot and ignores out-of-window mirrors', () => {
  const item = { id: 'release', url, title: 'OpenAI launches offline export for ChatGPT projects', summary: page, sourceId: 'openai', topicIds: ['ai'], publishedAt: `${date}T02:00:00Z` };
  const mirror = { ...item, id: 'mirror', url: 'https://example.org/mirror', sourceId: 'other' };
  const future = { ...item, id: 'future', starred: true, url: 'https://example.org/future', publishedAt: '2027-01-01T00:00:00Z' };
  const separate = { ...item, id: 'separate', url: 'https://example.org/pricing', title: 'OpenAI releases new pricing for ChatGPT business' };
  const selected = analysis.selectCandidates([item, mirror, future, separate], new Date(`${date}T04:00:00Z`));
  assert.equal(selected.length, 2);
  assert.equal(selected.filter(value => value.title === item.title).length, 1);
  assert.equal(selected.some(value => value.id === 'future'), false);
  assert.equal(selected.some(value => value.id === 'separate'), true);
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-analysis-'));
  const store = openStore(dir);
  await mkdir(join(dir, 'briefs')); await mkdir(join(dir, 'reports'));
  const jsonPath = join(dir, 'briefs', `${date}.json`); const markdownPath = join(dir, 'reports', `${date}-brief.md`);
  store.upsertItems('openai', [{ url, title: 'OpenAI product update', summary: excerpt, publishedAt: `${date}T02:00:00Z` }]);
  const previous = { date, title: '旧简报', generatedAt: `${date}T01:00:00Z`, status: 'reviewed', generationMethod: '旧版核验', summary: '保留的旧结果', highlights: [{ url, titleZh: '旧机会', summaryZh: '旧事实', whyItMatters: '旧判断', sourceName: 'Official', publishedAt: `${date}T00:00:00Z` }], ideas: [], coverage: [], caveats: [] };
  const oldJson = JSON.stringify(previous); const oldMarkdown = renderBriefMarkdown(previous);
  await writeFile(jsonPath, oldJson); await writeFile(markdownPath, oldMarkdown);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, jsonPath, markdownPath, oldJson, oldMarkdown, previous };
}

test('a quote found only in the RSS summary is never promoted to original-page evidence', async t => {
  const { store } = await fixture(t);
  const result = await analysis.generateBrief({ store, now: new Date(`${date}T04:00:00Z`), fetchText: async () => ({ text: `<article>${page}</article>` }), analyze: async () => output('automatic cloud backups are available for every user') });
  assert.equal(result.highlights[0].verification, 'feed-excerpt');
});

test('a web research search snippet cannot become RSS evidence when its page is readable', async t => {
  const { store, jsonPath, oldJson } = await fixture(t);
  const researchUrl = 'https://example.org/research-video-workflow';
  const source = store.ensureResearchSource({ name: 'Official website', url: researchUrl });
  store.upsertResearchItems([{ sourceId: source.id, url: researchUrl, title: 'OpenAI video workflow guide', summary: excerpt, publishedAt: `${date}T02:00:00Z`, research: { verification: 'research-lead', evidenceType: 'search-snippet' } }]);
  const value = output('automatic cloud backups are available for every user');
  value.highlights[0].url = researchUrl; value.ideas[0].sourceUrls = [researchUrl];
  await assert.rejects(analysis.generateBrief({ store, now: new Date(`${date}T04:00:00Z`), fetchText: async () => ({ text: `<article>${page}</article>` }), analyze: async () => value }), /支持引文/);
  assert.equal(await readFile(jsonPath, 'utf8'), oldJson);
  value.highlights[0].supportingQuote = 'adds an offline export option';
  const result = await analysis.generateBrief({ store, now: new Date(`${date}T04:00:00Z`), fetchText: async () => ({ text: `<article>${page}</article>` }), analyze: async ({ prompt }) => {
    const evidence = JSON.parse(prompt.split('\n\n').at(-1)).evidence.find(item => item.url === researchUrl);
    assert.equal(evidence.feedEvidenceText, undefined);
    return value;
  } });
  assert.equal(result.highlights[0].verification, 'original-page');
});

test('an RSS primary source retains its summary fallback after research is attached', async t => {
  const { store } = await fixture(t);
  const source = store.ensureResearchSource({ name: 'Official website', url });
  store.upsertResearchItems([{ sourceId: source.id, url, title: 'Different research title', summary: 'Research snippet must not replace the feed.', publishedAt: null, research: { verification: 'research-lead', evidenceType: 'search-snippet' } }]);
  assert.equal(store.listItems()[0].sourceKind, 'rss');
  assert.ok(store.listItems()[0].research);
  const result = await analysis.generateBrief({ store, now: new Date(`${date}T04:00:00Z`), fetchText: async () => { throw new Error('page unavailable'); }, analyze: async () => output('automatic cloud backups are available for every user') });
  assert.equal(result.highlights[0].verification, 'feed-excerpt');
});

test('page-body evidence retains its quote and verification through brief and catalog serialization', async t => {
  const { store, dir, markdownPath } = await fixture(t);
  const quote = 'adds an offline export option and fixes the startup crash';
  await analysis.generateBrief({ store, now: new Date(`${date}T04:00:00Z`), fetchText: async () => ({ text: `<article>${page}</article>` }), analyze: async () => output(quote) });
  const brief = await getBrief(dir, date);
  assert.equal(brief.highlights[0].verification, 'original-page');
  assert.equal(brief.highlights[0].supportingQuote, quote);
  assert.equal((await readBriefCatalog(dir)).analysisByUrl[url].verification, 'original-page');
  assert.equal(await readFile(markdownPath, 'utf8'), brief.markdown);
});

test('feed, provider and legacy provenance remain distinct after loading saved briefs', async t => {
  const { dir, jsonPath, previous } = await fixture(t);
  const kinds = ['feed-excerpt', 'provider-post', 'legacy', 'unknown'];
  const highlights = kinds.map((verification, index) => ({ ...previous.highlights[0], url: `https://example.org/evidence-${index}`, verification, supportingQuote: 'A quoted source statement' }));
  await writeFile(jsonPath, JSON.stringify({ ...previous, highlights }));
  const brief = await getBrief(dir, date);
  assert.deepEqual(brief.highlights.map(item => item.verification), ['feed-excerpt', 'provider-post', 'legacy', 'legacy']);
  assert.ok(brief.highlights.every(item => item.supportingQuote === 'A quoted source statement'));
});

test('cancelling at the saving stage leaves both the previous JSON and Markdown unchanged', async t => {
  const { store, jsonPath, markdownPath, oldJson, oldMarkdown } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(analysis.generateBrief({ store, signal: controller.signal, now: new Date(`${date}T04:00:00Z`), fetchText: async () => ({ text: `<article>${page}</article>` }), analyze: async () => output('adds an offline export option'), onStage: stage => { if (stage === 'saving') controller.abort(); } }), error => error.name === 'AbortError');
  assert.equal(await readFile(jsonPath, 'utf8'), oldJson);
  assert.equal(await readFile(markdownPath, 'utf8'), oldMarkdown);
});

test('failure committing the Markdown rolls the JSON back to the previous brief', async t => {
  const { jsonPath, markdownPath, oldJson, oldMarkdown } = await fixture(t);
  assert.equal(typeof analysis.commitBriefFiles, 'function');
  let failed = false;
  await assert.rejects(analysis.commitBriefFiles({ jsonPath, markdownPath, json: '{"new":true}', markdown: '# New' }, {
    renameImpl: async (from, to) => {
      if (to === markdownPath && !failed) { failed = true; throw Object.assign(new Error('simulated disk error'), { code: 'EIO' }); }
      return rename(from, to);
    },
  }), /disk error/);
  assert.equal(await readFile(jsonPath, 'utf8'), oldJson);
  assert.equal(await readFile(markdownPath, 'utf8'), oldMarkdown);
  assert.deepEqual((await readdir(join(jsonPath, '..'))).filter(name => name.endsWith('.tmp')), []);
});

test('a legacy mixed evidence string cannot claim original-page verification', () => {
  const result = analysis.validateAnalysis(output('automatic cloud backups are available for every user'), [{ url, sourceName: 'Legacy', publishedAt: `${date}T02:00:00Z`, verification: 'original-page', evidenceText: `${excerpt}\n${page}` }]);
  assert.equal(result.highlights[0].verification, 'legacy');
});

test('cancellation after commit begins finishes a consistent JSON and Markdown pair', async t => {
  const { jsonPath, markdownPath } = await fixture(t);
  const controller = new AbortController();
  await analysis.commitBriefFiles({ jsonPath, markdownPath, json: '{"new":true}', markdown: '# New', signal: controller.signal }, {
    renameImpl: async (from, to) => { await rename(from, to); if (to === jsonPath) controller.abort(); },
  });
  assert.equal(await readFile(jsonPath, 'utf8'), '{"new":true}');
  assert.equal(await readFile(markdownPath, 'utf8'), '# New');
});

test('a failed first publication removes its new JSON instead of exposing a partial brief', async t => {
  const { jsonPath, markdownPath } = await fixture(t);
  await rm(jsonPath); await rm(markdownPath);
  await assert.rejects(analysis.commitBriefFiles({ jsonPath, markdownPath, json: '{"new":true}', markdown: '# New' }, {
    renameImpl: async (from, to) => { if (to === markdownPath) throw new Error('simulated disk error'); await rename(from, to); },
  }), /disk error/);
  await assert.rejects(readFile(jsonPath), { code: 'ENOENT' });
  await assert.rejects(readFile(markdownPath), { code: 'ENOENT' });
});

test('ideas can cite supplied cross-check evidence without inventing external URLs', () => {
  const extra='https://example.org/second-source';
  const value=output('adds an offline export option');
  value.ideas[0].sourceUrls.push(extra);
  const evidence=[{url,pageEvidenceText:page},{url:extra,pageEvidenceText:'A separate source confirms the export behavior.'}];
  assert.deepEqual(analysis.validateAnalysis(value,evidence).ideas[0].sourceUrls,[url,extra]);
  value.ideas[0].sourceUrls.push('https://example.org/not-provided');
  assert.throws(()=>analysis.validateAnalysis(value,evidence),/未提供/);
  value.ideas[0].sourceUrls=[extra];
  assert.throws(()=>analysis.validateAnalysis(value,evidence),/已入选机会/);
});

test('source URL restrictions leave Chinese prose and supporting quotes unconstrained', async t => {
  const {store}=await fixture(t);
  let inspected=false;
  await analysis.generateBrief({store,now:new Date(`${date}T04:00:00Z`),fetchText:async()=>({text:`<article>${page}</article>`}),analyze:async({schema})=>{
    const enumPaths=[];
    const visit=(node,path='')=>{if(node && typeof node==='object') for(const [key,value] of Object.entries(node)){if(key==='enum') {enumPaths.push(path);assert.deepEqual(value,[url]);}else visit(value,`${path}.${key}`);}};
    visit(schema);
    assert.deepEqual(enumPaths,['.properties.highlights.items.properties.url','.properties.ideas.items.properties.sourceUrls.items']);
    assert.equal(analysis.ANALYSIS_SCHEMA.properties.highlights.items.properties.url.enum,undefined);
    inspected=true;
    return output('adds an offline export option');
  }});
  assert.equal(inspected,true);
});

test('empty, English or URL-only summaries cannot replace a valid saved brief', async t => {
  const {store,jsonPath,markdownPath,oldJson,oldMarkdown}=await fixture(t);
  for(const summary of ['', 'No useful updates.', url, 'https://example.org/中文路径', 'Source: https://example.org/中文路径']) {
    await assert.rejects(analysis.generateBrief({store,now:new Date(`${date}T04:00:00Z`),fetchText:async()=>({text:`<article>${page}</article>`}),analyze:async()=>({summary,highlights:[],ideas:[]})}),/中文综述/);
    assert.equal(await readFile(jsonPath,'utf8'),oldJson);
    assert.equal(await readFile(markdownPath,'utf8'),oldMarkdown);
  }
});

test('creative suggestions must contain Chinese explanations', () => {
  for(const key of ['title','angle','hook']) {
    const value=output('adds an offline export option');
    value.ideas[0][key]='English only';
    assert.throws(()=>analysis.validateAnalysis(value,[{url,pageEvidenceText:page}]),/中文说明/);
  }
});

test('video description evidence stays distinct from video viewing and ordinary page evidence', async t => {
  const {dir,jsonPath,previous}=await fixture(t);
  const value=analysis.validateAnalysis(output('adds an offline export option'),[{url,videoDescriptionText:page}]);
  assert.equal(value.highlights[0].verification,'video-description');
  await writeFile(jsonPath,JSON.stringify({...previous,...value}));
  const brief=await getBrief(dir,date);
  assert.equal(brief.highlights[0].verification,'video-description');
  assert.match(brief.markdown,/仅依据公开视频描述/);
});
