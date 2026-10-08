import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { startServer } from '../server/main.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-briefs-'));
  const store = openStore(dir);
  const server = await startServer({ store, port: 0, projectDir: dir, homeDir: dir });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); await rm(dir, { recursive: true, force: true }); });
  const get = path => fetch(`http://127.0.0.1:${server.address().port}${path}`);
  async function save(date, data, type = 'json') {
    const folder = join(dir, type === 'json' ? 'briefs' : 'reports');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, type === 'json' ? `${date}.json` : `${date}-brief.md`), type === 'json' ? JSON.stringify(data) : data);
  }
  return { dir, store, get, save };
}

const brief = (date, title = '今天值得看的变化') => ({
  date, title, generatedAt: `${date}T04:00:00Z`, status: 'reviewed', summary: '已核对原始来源的中文摘要。', generationMethod: 'Codex 核验整理',
  highlights: [{ id: 'one', url: 'https://example.org/story?utm_source=x#top', titleZh: title, summaryZh: '明确的事实。', whyItMatters: '可用于验证自己的工作流。', sourceName: '来源示例', publishedAt: `${date}T01:00:00Z` }],
  ideas: [{ title: '做一次实际测试', angle: '说明验证方法和结果', hook: '代码写完以后，怎么证明它真的能用？', sourceUrls: ['https://example.org/story?utm_campaign=sample'] }], coverage: ['已核对 1 个来源'], caveats: ['厂商案例并非独立基准'],
});

test('no authored brief returns a truthful empty list and analysis map', async t => {
  const { get } = await fixture(t);
  const response = await get('/api/briefs');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { briefs: [], latest: null });
  assert.equal((await get('/api/briefs/2026-09-12')).status, 404);
  const state = await (await get('/api/state')).json();
  assert.deepEqual(state.analysisByUrl, {});
  assert.equal(state.latestBrief, null);
});

test('structured reviewed brief takes precedence, generates readable Markdown and removes unsafe links', async t => {
  const { get, save } = await fixture(t);
  const value = brief('2026-09-12');
  value.highlights.push({ ...value.highlights[0], url: 'javascript:alert(1)' }, { ...value.highlights[0], url: 'https://127.0.0.1/private' });
  value.ideas[0].sourceUrls.push('file:///private/secret', 'https://user:secret@example.org/story');
  await save('2026-09-12', '# 旧版本 Markdown', 'md');
  await save('2026-09-12', value);
  const response = await get('/api/briefs/2026-09-12');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'reviewed');
  assert.equal(body.metadata.format, 'structured');
  assert.equal(body.highlights.length, 1);
  assert.equal(body.highlights[0].url, 'https://example.org/story');
  assert.deepEqual(body.ideas[0].sourceUrls, ['https://example.org/story']);
  assert.equal(body.ideas[0].hook, '代码写完以后，怎么证明它真的能用？');
  assert.match(body.markdown, /今天值得看的变化/);
  assert.match(body.markdown, /https:\/\/example.org\/story/);
  assert.ok(!body.markdown.includes('javascript:'));
  assert.ok(!body.markdown.includes('旧版本'));
  assert.equal(body.metadata.generationMethod, 'Codex 核验整理');
});

test('legacy Markdown remains readable without inventing review state, analysis or generation time', async t => {
  const { get, save } = await fixture(t);
  await save('2026-09-11', '# 本地中文样报\n\n有原始链接的样报。', 'md');
  const response = await get('/api/briefs/2026-09-11');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.metadata.title, '本地中文样报');
  assert.equal(body.metadata.status, 'markdown-only');
  assert.equal(body.metadata.generatedAt, null);
  assert.equal(body.metadata.format, 'markdown');
  assert.match(body.markdown, /有原始链接的样报/);
  assert.deepEqual(body.highlights, []);
  assert.deepEqual((await (await get('/api/state')).json()).analysisByUrl, {});
});

test('brief dates sort newest first and latest reviewed analysis wins for a canonical source URL', async t => {
  const { get, save } = await fixture(t);
  await save('2026-09-10', brief('2026-09-10', '旧版分析'));
  await save('2026-09-12', brief('2026-09-12', '新版分析'));
  await save('2026-09-11', '# 中间一天的简报', 'md');
  const response = await get('/api/briefs');
  assert.equal(response.status, 200);
  const listing = await response.json();
  assert.deepEqual(listing.briefs.map(x => x.date), ['2026-09-12', '2026-09-11', '2026-09-10']);
  assert.equal(listing.latest.title, '新版分析');
  const state = await (await get('/api/state')).json();
  assert.equal(state.analysisByUrl['https://example.org/story'].titleZh, '新版分析');
  assert.equal(state.analysisByUrl['https://example.org/story'].brief.date, '2026-09-12');
  assert.equal(state.latestBrief.summary, '已核对原始来源的中文摘要。');
  assert.equal((await get('/api/report')).headers.get('content-type'), 'text/markdown; charset=utf-8');
});

test('invalid date, malformed JSON and symlink escapes cannot expose arbitrary local files or claim review', async t => {
  const { get, save, dir } = await fixture(t);
  await save('2026-02-30', brief('2026-02-30'));
  await save('2026-09-12', { ...brief('2026-09-12'), status: 'draft' });
  await writeFile(join(dir, 'briefs', '2026-09-10.json'), '{bad json');
  const secret = join(dir, 'secret.txt');
  await writeFile(secret, 'PRIVATE-MUST-NOT-LEAK');
  await symlink(secret, join(dir, 'briefs', '2026-09-11.json'));
  assert.equal((await get('/api/briefs/2026-02-30')).status, 400);
  assert.equal((await get('/api/briefs/not-a-date')).status, 400);
  assert.equal((await get('/api/briefs/2026-09-10')).status, 422);
  assert.equal((await get('/api/briefs/2026-09-12')).status, 422);
  const escaped = await get('/api/briefs/2026-09-11');
  assert.equal(escaped.status, 404);
  assert.ok(!(await escaped.text()).includes('PRIVATE'));
  const traversal = await get('/api/briefs/..%2fsecret.txt');
  assert.ok([400, 403, 404].includes(traversal.status));
  assert.ok(!(await traversal.text()).includes('PRIVATE'));
  assert.deepEqual(await (await get('/api/briefs')).json(), { briefs: [], latest: null });
});
