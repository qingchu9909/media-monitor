import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateValue } from '../server/editorial.mjs';

import * as module from '../src/content-selection.mjs';
const topics = [{ id: 'ai', name: 'AI 产品发布', enabled: true }, { id: 'tools', name: 'Agent / 开源工具', enabled: true }, { id: 'video', name: 'AI 视频创作', enabled: true }];
const row = (id, title, summary, extra = {}) => ({ id, title, summary, url: `https://example.org/${id}`, publishedAt: '2026-09-13T03:00:00Z', topicIds: ['ai', 'tools', 'video'], sourceId: 'sample', ...extra });
const video = row('video', 'ComfyUI PromptSync compares generated videos with timed prompts', 'The new node plays the generated video next to its timed prompts so creators can compare intended actions and scenes.');
const tools = row('tool', 'Claude Code fixes permissions in read-only git commands', 'This release fixes a regression that requested permissions after existing coding sessions had been running for a while.');
const product = row('product', 'OpenAI introduces a new voice model for its API', 'The new model supports streaming voice responses and adds language controls for developers using the public API.');

test('wide topic matches become one grounded category without altering database objects', () => {
  assert.equal(typeof module.selectConciseFeed, 'function', 'shared concise selection must exist');
  const input = [video, tools, product]; const before = structuredClone(input);
  const result = module.selectConciseFeed(input, topics);
  assert.deepEqual(result.groups.map(g => [g.topic.id, g.items.map(i => i.id)]), [['ai', ['product']], ['tools', ['tool']], ['video', ['video']]]);
  assert.equal(new Set(result.items.map(i => i.id)).size, 3);
  assert.deepEqual(input, before);
});

test('VR demos, support questions, boilerplate, nightly builds and generic promotions stay in raw data', () => {
  assert.equal(typeof module.classifyContent, 'function');
  const cases = [
    row('vr', 'Creating a spatial UI in VR using UE 5.7', 'I am rebuilding the entire frontend from scratch; it now recognizes workflows and arranges all the panels.', { sourceName: 'Reddit · ComfyUI' }),
    row('help', 'Suggestions on making highlight reels on an older machine?', 'I am experimenting with ComfyUI and looking for advice on what my old hardware can realistically handle.', { sourceName: 'Reddit · ComfyUI' }),
    row('time', 'Comfyui Krea 2 Generating time', 'Hai guys, I just downloaded Krea 2. My PC takes 140 seconds to generate an image. Any suggestions?', { sourceName: 'Reddit · ComfyUI' }),
    row('empty', 'How to Create a RefMod for MiniMax H3 in ComfyUI', 'submitted by /u/Someone [link] [comments]'),
    row('placeholder', 'AI Coding 实践教程', '点击查看原文>'),
    row('nightly', 'Release v0.61.0-nightly.20260913', 'Fixed runtime flags and improved sandbox permission settings for developers.'),
    row('version', 'v2.1.270', 'Full Changelog: v2.1.269...v2.1.270', { sourceName: 'Claude Code' }),
    row('promotion', 'ComfyUI masterclass: buy tickets now', 'Grab your in-person pass to our exclusive AI video event. Register now for the early bird price.'),
  ];
  for (const item of cases) assert.equal(module.classifyContent(item).eligible, false, item.title);
  const result = module.selectConciseFeed(cases, topics);
  assert.equal(result.excludedCount, cases.length);
  assert.equal(result.items.length, 0);
  assert.equal(cases.length, 8);
});

test('a product name or incidental video word cannot turn unrelated material into video production', () => {
  assert.equal(typeof module.classifyContent, 'function');
  assert.equal(module.classifyContent(row('runtime', 'ComfyUI on Docker: benchmark and fix the shared-memory crash', 'This practical guide benchmarks GPU computation and explains how to fix the Docker shared-memory setting for stable inference.')).category, 'tools');
  assert.equal(module.classifyContent(row('release', 'v2.1.270', 'Fixed read-only git commands unexpectedly asking for permission during long-running Claude Code sessions. The release restores the previous permission behavior.', { sourceName: 'Claude Code 发布记录', url: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.270' })).category, 'tools');
  assert.equal(module.classifyContent(row('general', 'OpenAI comments on the future of work', 'The company discusses employment and the economy in a conference video, without announcing any product changes.')).eligible, false);
  assert.equal(module.classifyContent(row('reference', 'I built a Character Swap and Multi Reference Shot workflow', 'Two ComfyUI workflows let creators combine lighting, composition and character references into one consistent generated shot.')).category, 'video');
});

test('deduplication merges URL and high-confidence repeated coverage, preserving starred original identity', () => {
  assert.equal(typeof module.deduplicateContent, 'function');
  const sameUrl = { ...video, id: 'tracking', url: `${video.url}?utm_source=news#top`, starred: true, sourceId: 'secondary' };
  const sameTitle = { ...tools, id: 'repost', url: 'https://another.example/repost', sourceId: 'another' };
  const nearTitle = { ...tools, id: 'coverage', title: 'Claude Code fixes permissions for read-only git commands', url: 'https://third.example/news', sourceId: 'third' };
  const original = [video, sameUrl, tools, sameTitle, nearTitle];
  const result = module.deduplicateContent(original);
  assert.equal(result.items.length, 2);
  assert.equal(result.duplicateCount, 3);
  const saved = result.items.find(i => i.id === 'tracking');
  assert.equal(saved.starred, true);
  assert.equal(saved.selection.relatedItems.length, 2);
  assert.equal(original.length, 5);
});

test('different news about one product and unrelated version tags never collapse', () => {
  assert.equal(typeof module.deduplicateContent, 'function');
  const items = [
    row('new', 'OpenAI releases GPT-6 model with new reasoning controls', 'Developers can use the new model through the API and configure how much reasoning to use.'),
    row('price', 'OpenAI cuts GPT-6 model API prices for developers', 'The company reduces token prices for existing API customers without changing the model capabilities.'),
    row('voice', 'OpenAI releases GPT-6 voice responses to all users', 'All users can now access streaming voice responses in the existing assistant interface.'),
    row('v1', 'v1.2.3', 'A detailed release with several important fixes.', { sourceName: 'Project A', url: 'https://github.com/a/a/releases/tag/v1.2.3' }),
    row('v2', 'v1.2.3', 'A detailed release with several important fixes.', { sourceName: 'Project B', url: 'https://github.com/b/b/releases/tag/v1.2.3' }),
  ];
  assert.equal(module.deduplicateContent(items).items.length, 5);
});

test('each group is bounded while overflow and exclusions remain auditable', () => {
  assert.equal(typeof module.selectConciseFeed, 'function');
  const items = Array.from({ length: 9 }, (_, i) => row(`feature${i}`, `ComfyUI video workflow ${i}: generating a distinct scene`, `This tutorial ${i} explains its own distinct camera motion and shows how to generate consistent shots using references.`, { sourceId: `source-${i % 3}` }));
  const result = module.selectConciseFeed(items, topics, { limitPerTopic: 6 });
  assert.equal(result.groups.find(g => g.topic.id === 'video').items.length, 6);
  assert.equal(result.overflowCount, 3);
  assert.equal(result.eligibleItems.length, 9);
  assert.equal(result.counts.input, result.counts.shown + result.counts.overflow + result.counts.excluded + result.counts.duplicates);
});

test('automatic recommendations use the same noise boundary as the concise view', () => {
  assert.equal(candidateValue(row('vr', 'Creating a spatial UI in VR using UE 5.7', 'Rebuilding the frontend from scratch to display workflow panels in a virtual room.', { sourceName: 'Reddit · ComfyUI' })), null);
  assert.equal(candidateValue(row('ask', 'Audio Lora for H3? Question for you smart people...', 'submitted by /u/Someone [link] [comments]', { sourceName: 'Reddit · ComfyUI' })), null);
  assert.equal(candidateValue(video).category, 'video');
});

test('reapplying the view selector retains duplicate provenance and short specific titles can merge', () => {
  const first = module.deduplicateContent([video, { ...video, id: 'again', url: 'https://another.example/same-story' }]);
  const second = module.deduplicateContent(first.items);
  assert.equal(second.items[0].selection.duplicateCount, 1);
  assert.equal(second.items[0].selection.relatedItems.length, 2);
  const short = row('short', 'OpenAI launches GPT-6', product.summary);
  assert.equal(module.deduplicateContent([short, { ...short, id: 'short2', url: 'https://news.example/gpt-launch' }]).items.length, 1);
});

test('the word new is not a product announcement and one release stream cannot fill a column', () => {
  assert.equal(module.classifyContent(row('grant', 'Funding grants for new research into AI and teen development', 'The program funds academic studies about young people and technology without releasing a product or feature.')).eligible, false);
  assert.equal(module.classifyContent(row('case', 'How a researcher uses Codex and ChatGPT to search for new antimicrobial molecules', 'A researcher describes a scientific project about discovering potential treatments and evaluating molecular structures.')).eligible, false);
  const releases = Array.from({ length: 5 }, (_, i) => row(`release-${i}`, `v2.1.${270 - i}`, tools.summary, { sourceId: 'claude', sourceName: 'Claude Code 发布记录', url: `https://github.com/anthropics/claude-code/releases/tag/v2.1.${270 - i}` }));
  const result = module.selectConciseFeed(releases, topics);
  assert.equal(result.groups.find(g => g.topic.id === 'tools').items.length, 2);
  assert.equal(result.overflowCount, 3);
});

test('a long changelog retains its concrete video feature while a long help request stays excluded', () => {
  const changelog = `${'Dependency and compatibility maintenance. '.repeat(24)} feat: add VideoTrim and VideoCrop nodes with VIDEO_EDIT widget inputs. Support video editing in the existing ComfyUI workflow.`;
  assert.equal(module.classifyContent(row('trim', 'v0.35.0', changelog, { sourceName: 'ComfyUI 官方发布记录', url: 'https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.35.0' })).category, 'video');
  const request = `${'I tried several workflows and compared the generated video with the original reference. '.repeat(12)} HELP NEEDED: Can anyone tell me if I am doing something wrong with this workflow?`;
  assert.equal(module.classifyContent(row('long-help', "Best Ref2Vid Minimax H3 Workflow I've seen except for the outcome", request, { sourceName: 'Reddit · ComfyUI' })).eligible, false);
});

test('video quality advice requests stay out of the concise view while how-to tutorials remain', () => {
  const source = { sourceName: 'Reddit · ComfyUI', url: 'https://www.reddit.com/r/comfyui/comments/1wf2q86/wan_22_t2v_generation_any_tips_to_improve_the/' };
  const body = "Hey, this is a video generated with Wan 2.2 T2V. The result isn't that good honestly. There are quite a few artifacts, especially with the mirror. The reflection doesn't really match the person properly. The generation took about 3 hours 30 minutes in total.";
  for (const title of [
    'Wan 2.2 T2V generation – any tips to improve the quality?',
    'Wan 2.2 video generation: tips needed',
    'Wan 2.2 video generation: advice needed',
    'Wan 2.2 video generation: looking for advice',
    'Wan 2.2 video generation: need some tips',
  ]) {
    const request = row('wan-help', title, body, source);
    assert.equal(module.classifyContent(request).eligible, false, title);
    assert.equal(module.classifyContent(request).reason, '社区求助或未解决问题', title);
    assert.equal(module.selectConciseFeed([request], topics).items.length, 0, title);
    assert.equal(candidateValue(request), null, title);
  }
  const tutorial = row('wan-guide', 'How to improve Wan 2.2 video quality: a workflow guide', 'This tutorial explains camera prompts and reference settings, shows the resulting generated video, and compares methods for improving mirror reflections.', { sourceName: 'Reddit · ComfyUI' });
  assert.equal(module.classifyContent(tutorial).category, 'video');
  assert.equal(module.selectConciseFeed([tutorial], topics).items.length, 1);
});

test('whitespace normalization handles tabs and newlines before matching advice requests', () => {
  const request = row('spaced-request', 'Wan 2.2 video generation – any\t tips\nfor better results?', 'This generated video has mirror artifacts, and the render takes several hours on my current graphics card.', { sourceName: 'Reddit · ComfyUI' });
  const before = structuredClone(request);
  assert.equal(module.classifyContent(request).eligible, false);
  assert.equal(module.classifyContent(request).reason, '社区求助或未解决问题');
  assert.deepEqual(request, before);
  const tutorial = row('spaced-guide', 'How\tto\nimprove Runway video quality: workflow guide', 'This tutorial compares camera prompts and motion controls for creators generating and editing cinematic video scenes.');
  assert.equal(module.classifyContent(tutorial).category, 'video');
});

test('separate Runway production guides remain distinct content', () => {
  const guides = [
    row('runway-camera', 'How to improve Runway video quality with camera motion prompts', 'This tutorial explains camera movement prompts and compares shots with pan, tilt and dolly settings for generated video.'),
    row('runway-character', 'How to improve Runway video quality with character reference images', 'This tutorial explains character references and shows how to maintain the same face and clothing across generated video shots.'),
  ];
  const result = module.deduplicateContent(guides);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.items.length, 2);
  assert.deepEqual(new Set(result.items.map(item => item.id)), new Set(guides.map(item => item.id)));
});

test('observed workflow requests, hardware questions and adult solicitations are excluded without altering raw records', () => {
  const community = { sourceName: 'Reddit · ComfyUI', sourceId: 'reddit-comfyui' };
  const requests = [
    row('wanted-workflow', 'Seen this video on X and I want this workflow so bad', 'Basically you use a one shot video, to create different angle clips along the whole video. submitted by /u/badjano [link] [comments]', { ...community, url: 'https://www.reddit.com/r/comfyui/comments/1wfpg1q/seen_this_video_on_x_and_i_want_this_workflow_so/' }),
    row('adult-request', 'Share your personal porn workflow', 'I discovered local image and video generation two days ago. So what is your workflow? Are there such long workflows somewhere to download?', { ...community, url: 'https://www.reddit.com/r/comfyui/comments/1wfh062/share_your_personal_porn_workflow/' }),
    row('pc-question', 'Is this PC good for local AI video gen?', 'I have a budget of approximately 2500 euros for a PC with 32gb ram and rtx 5070ti 16gb. My main purpose is local AI video gen. I would really appreciate some opinions on this.', { ...community, url: 'https://www.reddit.com/r/comfyui/comments/1wfknbt/is_this_pc_good_for_local_ai_video_gen/' }),
  ];
  const before = structuredClone(requests);
  assert.deepEqual(requests.map(item => module.classifyContent(item).reason), ['社区求助或未解决问题', '成人内容推广或征集', '社区求助或未解决问题']);
  assert.equal(module.selectConciseFeed(requests, topics).items.length, 0);
  assert.deepEqual(requests.map(candidateValue), [null, null, null]);
  assert.deepEqual(requests, before);
});

test('community question and request forms require a supplied method rather than merely mentioning a workflow', () => {
  const body = 'I am exploring local ComfyUI video generation on my current hardware and have not found a suitable workflow to use yet.';
  const titles = [
    'Are these settings good for ComfyUI video generation?',
    'Is my PC enough for ComfyUI video generation?',
    'Can ComfyUI generate this video on my PC?',
    'Could this ComfyUI video workflow work on my hardware?',
    'Does this ComfyUI video workflow exist?',
    'Do I need another model for ComfyUI video generation?',
    'Looking for a ComfyUI video workflow',
    'I want a ComfyUI video workflow like this',
    'Where can I download this ComfyUI video workflow?',
    'Share your ComfyUI video workflow settings',
    'Requesting a ComfyUI video workflow',
  ];
  for (const [index, title] of titles.entries()) {
    const request = row(`community-form-${index}`, title, body, { sourceName: 'Reddit · ComfyUI' });
    assert.equal(module.classifyContent(request).eligible, false, title);
    assert.equal(module.classifyContent(request).reason, '社区求助或未解决问题', title);
  }
  const onlyBody = row('body-recommendation', 'My ComfyUI video workflow experiment', 'I have been exploring several different local video generation options for this project. Could someone recommend a workflow and share the settings?', { sourceName: 'Reddit · ComfyUI' });
  assert.equal(module.classifyContent(onlyBody).reason, '社区求助或未解决问题');
});

test('community tutorials, shared builds, measurements and resolved fixes remain useful despite question wording or feedback requests', () => {
  const cases = [
    row('working-guide', 'How to improve ComfyUI video quality: a workflow guide', 'This tutorial shows the nodes and settings for camera control, then explains how to connect reference images and export the video.'),
    row('working-build', 'I built a ComfyUI video workflow for character shots', 'The workflow JSON is attached with download instructions and source code. It generates consistent character shots from reference images. I would appreciate suggestions.'),
    row('working-release', 'I released a ComfyUI video workflow for dialogue scenes', 'The repository includes the workflow, a download link and instructions for configuring character references, camera movement and video export.'),
    row('working-review', 'Is this PC good for ComfyUI video generation? Benchmark review', 'I measured three video workflows on the same hardware and recorded latency in a results table. The comparison includes settings and output resolution.'),
    row('working-measurements', 'Can this ComfyUI video workflow run on a small GPU?', 'We benchmarked the workflow with different memory settings. The results table compares latency and output resolution for each generated video.'),
    row('working-fix', 'ComfyUI video workflow not working: fixed the permission error', 'The cause was a configuration mismatch. This patch changes the permission setting and explains the command needed to restore video export.'),
  ];
  for (const item of cases) assert.equal(module.classifyContent({ ...item, sourceName: 'Reddit · ComfyUI' }).category, 'video', item.title);
});

test('adult creation promotions are excluded while copyright and safety product news are retained', () => {
  const promotional = row('adult-promo', 'ComfyUI workflow for generating NSFW videos', 'This workflow includes downloadable models and prompts for generating adult videos with local image and video generation tools.');
  assert.equal(module.classifyContent(promotional).reason, '成人内容推广或征集');
  const news = [
    row('copyright-news', 'OpenAI adds copyright safeguards for image generation', 'The product update adds controls for copyrighted material and explains the new safety behavior for creators using the image generation tools.'),
    row('safety-news', 'OpenAI adds NSFW detection safeguards for image generation', 'The update improves detection of sexually explicit content and adds safety controls to prevent abusive image generation requests.'),
  ];
  for (const item of news) assert.equal(module.classifyContent(item).category, 'ai', item.title);
});

test('each concise column keeps at most three items from one source and fills remaining places from other sources', () => {
  const create = (id, sourceId) => row(id, `ComfyUI video workflow ${id}: generating a distinct scene`, 'This tutorial explains camera motion settings and shows how to connect references for consistent generated video shots.', { sourceId });
  const crowded = Array.from({ length: 6 }, (_, index) => create(`a${index}`, 'reddit-comfyui'));
  const alternatives = Array.from({ length: 3 }, (_, index) => create(`b${index}`, 'official-guides'));
  const input = [...crowded, ...alternatives], before = structuredClone(input);
  const result = module.selectConciseFeed(input, topics, { limitPerTopic: 6 });
  const group = result.groups.find(group => group.topic.id === 'video');
  assert.equal(group.items.length, 6);
  assert.equal(group.items.filter(item => item.sourceId === 'reddit-comfyui').length, 3);
  assert.equal(group.items.filter(item => item.sourceId === 'official-guides').length, 3);
  assert.equal(group.totalCount, 9);
  assert.equal(group.hiddenCount, 3);
  assert.equal(result.eligibleItems.length, 9);
  assert.equal(result.overflowCount, 3);
  assert.equal(module.selectConciseFeed(crowded, topics).items.length, 3);
  assert.deepEqual(input, before);
});

test('source caps are per column and coexist with the two-release limit', () => {
  const sameSource = [
    ...Array.from({ length: 4 }, (_, index) => row(`video-source-${index}`, `ComfyUI video workflow ${index}: generating camera shots`, video.summary, { sourceId: 'shared-source' })),
    ...Array.from({ length: 4 }, (_, index) => row(`tool-source-${index}`, `Claude Code guide ${index}: fix a permission command`, tools.summary, { sourceId: 'shared-source' })),
  ];
  const across = module.selectConciseFeed(sameSource, topics);
  assert.equal(across.groups.find(group => group.topic.id === 'video').items.length, 3);
  assert.equal(across.groups.find(group => group.topic.id === 'tools').items.length, 3);
  const releases = Array.from({ length: 4 }, (_, index) => row(`cap-release-${index}`, `v2.1.${280 - index}`, tools.summary, { sourceId: 'official-tools', sourceName: 'Claude Code 发布记录', url: `https://github.com/anthropics/claude-code/releases/tag/v2.1.${280 - index}` }));
  const guides = [row('cap-guide-one', 'Claude Code workflow guide: safe permission settings', tools.summary, { sourceId: 'official-tools' }), row('cap-guide-two', 'Claude Code workflow guide: project configuration commands', tools.summary, { sourceId: 'official-tools' })];
  const capped = module.selectConciseFeed([...releases, ...guides], topics);
  assert.equal(capped.items.length, 3);
  assert.ok(capped.items.filter(item => item.url.includes('/releases/')).length <= 2);
});

test('Chinese teasers without concrete information are missing summaries regardless of the headline or publisher', () => {
  const summaries = [
    '这家中国公司，刚跑完了物理闭环里最难的一段路',
    '这个团队迈出了最关键的一步，背后的故事值得看看。',
    '这款新工具终于来了，一切答案都将在文中揭晓。',
  ];
  for (const [index, summary] of summaries.entries()) {
    const item = row(`chinese-teaser-${index}`, 'PhysBrain 新模型登顶全球开源榜一', summary, { sourceName: index ? '另一家中文媒体' : '量子位' });
    const before = structuredClone(item);
    assert.equal(module.classifyContent(item).reason, '缺少实质摘要');
    assert.equal(module.selectConciseFeed([item], topics).items.length, 0);
    assert.equal(candidateValue(item), null);
    assert.deepEqual(item, before);
  }
});

test('short Chinese summaries with concrete changes remain useful, including from the same publisher', () => {
  for (const [index, summary] of [
    '这款工具新增视频裁剪',
    '这个版本修复导出错误',
    '这个工具终于来了，新增视频裁剪和字幕导出。',
  ].entries()) {
    const item = row(`specific-short-${index}`, 'ComfyUI 视频剪辑工作流更新', summary, { sourceName: '量子位' });
    assert.equal(module.classifyContent(item).category, 'video', summary);
  }
});
