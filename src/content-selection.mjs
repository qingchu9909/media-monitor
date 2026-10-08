// Shared, local editorial heuristics. They select a reading view; they do not
// change source records, verify claims or manufacture model analysis.
const DAY = 86400000;
const DEFAULT_IDS = new Set(['ai', 'tools', 'video']);
const text = value => String(value ?? '').normalize('NFKC').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const words = value => text(value).toLowerCase();
const versionOnly = value => /^(?:release\s+)?v?\d[\w.\-]*$/i.test(value);
const knownTool = /\b(?:codex|claude code|gemini cli|github copilot|mcp|sdk|cli|agent|agents|open[ -]source|docker|comfyui)\b|智能体|开源|开发工具|编程助手/i;
const aiName = /\b(?:openai|gpt(?:[ -]?\d)?|chatgpt|claude|anthropic|gemini|deepmind|qwen|kimi|llm|ai)\b|大模型|人工智能|模型|千问|豆包|智谱|深度求索/i;
const videoBrand = /\b(?:comfyui|runway|sora|veo|kling|ltx|pika|heygen|elevenlabs|wan|diffusers)\b|可灵|即梦/i;
const visualWork = /\b(?:video(?:s)?|shots?|storyboard|timed prompts?|character (?:swap|consistency)|multi[ -]reference|image generation|text.to.speech|voice cloning|lip[ -]sync|subtitles?|dubbing)\b|视频|分镜|剪辑|配音|字幕|口型|角色一致|多参考|生成影像|图生视频|文生视频/i;
const productionTitle = /\b(?:(?:ai |generated |short |multi[ -]shot |long[ -]form )videos?|video (?:generat\w*|edit\w*|workflow|creation|prompt\w*)|generat\w* videos?|character swap|multi[ -]reference (?:shot|workflow)|storyboard|text.to.speech|voice clon\w*|lip[ -]sync|dubbing|subtitle\w*)\b|视频(?:生成|创作|剪辑|工作流|裁剪|拼接)|生成视频|分镜|角色一致|多参考.*(?:镜头|工作流)|配音|字幕|口型/i;
const practical = /\b(?:tutorial|guide|how to|workflow|example|benchmark|fix(?:es|ed)?|introduc\w*|add(?:s|ed)?|support\w*|automat\w*|releas\w*|node|tool|generat\w*|compare|comparing|build|built)\b|教程|实测|新增|修复|开源|工作流|支持|使用|步骤|生成|对比|剪辑|发布|上线|更新|工具/i;
const update = /\b(?:introduc\w*|launch\w*|unveil\w*|announc\w*|add(?:s|ed)?|available|updat\w*|releas\w*|improv\w*|enable\w*)\b|发布|推出|上线|开放|升级|更新|新增|支持|降价/i;

function meaningfulSummary(value) {
  const body = text(value)
    .replace(/submitted by\s+\/?u\/[^\s]+/gi, '')
    .replace(/\[(?:link|comments)\]/gi, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/(?:点击)?(?:查看|阅读)(?:完整)?(?:原文|全文)|read more|view (?:the )?full (?:article|post)/gi, '')
    .replace(/[\s>.…]+/g, ' ').trim();
  if (!body || /^(?:full changelog|what'?s changed)\s*:?\s*v?[\d.\w\s-]*$/i.test(body)) return false;
  if (/Matrix首页推荐.*Matrix是少数派的写作社区/.test(body)) return false;
  // Judge the excerpt itself, without borrowing a specific claim from its
  // headline. Short promotional teasers are not a usable article summary.
  const concreteChange = /(?:新增|增加|支持|修复|开放|提供|允许|可用于|可以|通过|使用).{0,18}(?:视频|音频|图像|图片|字幕|镜头|角色|模型|接口|代码|命令|权限|导出|裁剪|剪辑|配音|识别|搜索|文件|节点|参考图|崩溃|错误)/.test(body);
  const vaguePreview = /(?:最难|关键|重要).{0,12}(?:一段路|一步|一关|一环)|(?:背后|其中).{0,8}(?:秘密|故事)|(?:答案|真相).{0,8}(?:这里|文中|揭晓)|(?:重磅消息|又有大动作|终于来了|改变一切|无限可能)/.test(body);
  if (body.length <= 180 && vaguePreview && !concreteChange && !/\d/.test(body)) return false;
  const han = body.match(/\p{Script=Han}/gu)?.length ?? 0;
  return han >= 12 || (han >= 8 && concreteChange) || (body.length >= 45 && (body.match(/[a-z]{2,}/gi)?.length ?? 0) >= 6);
}

function providesMethod(title, body) {
  // Merely mentioning a workflow, hardware settings or an attempted test does
  // not establish a useful answer. Look for instruction, a shared artifact,
  // reported measurements or a resolved fix before keeping a question title.
  const tutorial = /\b(?:how to|tutorial|guide|step.by.step)\b|教程|步骤/i.test(title)
    && /\b(?:explains?|shows?|steps?|instructions?|connect|configure|settings?|commands?|nodes?|references?)\b|介绍|步骤|连接|配置|参数|节点|参考图/i.test(body);
  const shipped = /\b(?:i|we)(?:['’]ve| have)? (?:built|released|published|created)\b|我(?:做了|制作了|发布了|开源了)/i.test(`${title} ${body}`)
    && /\b(?:attached|included|download|repository|source code|github|available|lets? creators|enables? users)\b|附上|下载|仓库|代码|开源地址|可复现/i.test(body);
  const measured = /\b(?:benchmark|review)\b|评测|实测/i.test(title) || /\b(?:i|we)(?:['’]ve| have)? (?:benchmarked|measured)\b|我(?:实测|测试并记录)/i.test(body);
  const results = /\b(?:results?|measurements?|compared|comparison|latency|seconds?|throughput|table)\b|结果|耗时|对比|延迟|吞吐|表格/i.test(body);
  const fixed = /\b(?:fixed|fixes|resolved|solved)\b|已解决|修复/i.test(title)
    && /\b(?:patch|settings?|cause|commands?|nodes?|permissions?|configuration)\b|补丁|参数|原因|命令|节点|权限|配置/i.test(body);
  return tutorial || shipped || (measured && results) || fixed;
}

function supportRequest(title, body, community) {
  const adviceTitle = /\b(?:need help|help me|question for|anyone (?:know|else)|any tips|(?:tips|advice) needed|(?:need|looking for) (?:some )?(?:tips|advice)|how (?:do|can) i|why (?:is|does|do)|suggestions? (?:on|for)|generating time|not working|which .+ should i)\b|求助|请教|怎么解决|有没有人|报错怎么办/i.test(title);
  const questionTitle = /^(?:(?:is|are) (?:this|these|my|the|there)|can|could|does|do|should|would)\b|^(?:这个|这些|我的).*(?:可以吗|够用吗|怎么样|能不能)/i.test(title);
  const requestingTitle = /\b(?:looking for|i (?:want|need)|where (?:can|could|do) i).{0,100}\b(?:workflows?|models?|nodes?|tools?|prompts?|settings?|download)\b|^(?:share your|requesting|request for)\b|求(?:工作流|模型|推荐)|分享一下你的/i.test(title);
  const adviceBody = /\b(?:looking for advice|any suggestions|help needed|can anyone tell me|can someone help|anyone knows|my (?:pc|gpu|computer|machine).{0,80}(?:slow|takes|problem))\b|\b(?:looking for|asking for|appreciate|need).{0,60}\b(?:opinions?|advice|recommendations?|suggestions?|help)\b|\b(?:can|could|would) (?:someone|anyone|you).{0,60}\b(?:recommend|suggest|share|help|find|link)\b|求助|有谁知道|求推荐/i.test(body);
  return (adviceTitle || (community && (questionTitle || requestingTitle || adviceBody))) && !providesMethod(title, body);
}

function adultPromotion(title, body) {
  const explicitSubject = /\b(?:porn(?:ography|ographic)?|hentai|nsfw|sexually explicit)\b|色情|成人视频|成人内容/i.test(title);
  const creationOrRequest = /\b(?:workflows?|generat\w*|lora|models?|prompts?|tutorials?|share your|requesting|looking for|download|subscribe)\b|工作流|生成|模型|教程|征集|推广|下载/i.test(`${title} ${body.slice(0, 850)}`);
  const protectionNews = /\b(?:copyright|consent|safety|moderation|safeguards?|detection|abuse|policy|lawsuit|watermark)\b|版权|同意|安全|审核|检测|防护|滥用|政策|诉讼|水印/i.test(title)
    && !/\b(?:bypass|disable|evade|remove safeguards?)\b|绕过|关闭防护|规避审核/i.test(title);
  return explicitSubject && creationOrRequest && !protectionNews;
}

export function classifyContent(item, { excludePromotions = true, excludeNightly = true } = {}) {
  const title = text(item?.title), body = text(item?.summary);
  const titleLower = words(title), lead = body.slice(0, 850), combined = `${title} ${lead}`;
  const reject = reason => ({ eligible: false, category: null, score: 0, reason });
  const accept = (category, score) => ({ eligible: true, category, score, reason: category === 'video' ? '实际影像或声音制作方法' : category === 'tools' ? '可用的工具、工作流或具体修复' : '明确的 AI 产品变化' });
  if (!title || !meaningfulSummary(body)) return reject('缺少实质摘要');
  if (item.sourceIds?.includes('arxiv') || item.sourceId === 'arxiv' || /arxiv/i.test(String(item.platform))) return reject('论文原始资料');
  if (excludeNightly && /nightly|每日构建|每夜构建/i.test(title)) return reject('每日构建');
  if (adultPromotion(title, body)) return reject('成人内容推广或征集');
  if (excludePromotions && /\b(?:buy tickets?|grab your|in.person pass|hackable badge|register now|early.bird|limited.time offer|subscribe now)\b|限时抢购|购买门票|活动报名|早鸟票|扫码报名|加入付费|立即订阅/i.test(combined)) return reject('泛宣传或活动广告');
  if (/\b(?:vr|virtual reality|spatial ui|user interface|ui theme|frontend layout)\b|虚拟现实|空间界面|界面换肤/i.test(title)) return reject('普通 VR 或界面展示');
  const community = /reddit|\/r\/|community|社区/i.test(`${item.url ?? ''} ${item.sourceName ?? ''} ${item.platform ?? ''}`);
  if (supportRequest(title, body, community)) return reject('社区求助或未解决问题');
  const isVersion = versionOnly(title);
  const projectHint = isVersion ? `${item.sourceName ?? ''} ${item.url ?? ''}`.replaceAll('-', ' ') : '';
  const usefulChange = /\b(?:add(?:ed)?|fixed|fixes|introduc\w*|support\w*)\b|新增|修复|支持/.test(words(body)) && /\b(?:permissions?|commands?|prompts?|contexts?|sandbox|sessions?|agents?|workflows?|videos?|audio|crop|trim|export|render|references?|api|mcp)\b|权限|工作流|导出|裁剪|视频|命令|上下文|会话/i.test(body);
  if (isVersion && !usefulChange) return reject('只有版本记录，缺少具体用途');
  // Source labels alone cannot make a post video-related. Require an actual
  // production subject in its title, or an explicit change to that workflow.
  const directVideo = productionTitle.test(title) && practical.test(combined);
  const namedVideoWorkflow = videoBrand.test(title) && visualWork.test(lead) && /\b(?:workflow|guide|tutorial|node|prompt|generat\w*|editing|trim|crop)\b|教程|工作流|节点|生成|裁剪|剪辑/i.test(title);
  const versionVideo = isVersion && /comfyui|diffusers/i.test(projectHint) && /(?:video|audio).{0,45}(?:trim|crop|edit|generat)|(?:trim|crop|edit|generat).{0,45}(?:video|audio)|视频|音频|配音|字幕/i.test(body);
  if (directVideo || namedVideoWorkflow || versionVideo) return accept('video', versionVideo ? 12 : 8 + (/workflow|guide|tutorial|教程|工作流/i.test(combined) ? 3 : 1));
  const toolSubject = knownTool.test(title + ' ' + projectHint) || /\b(?:workflow|automation|automating|coding|developer tool)\b|自动化|工作流|编程|开源|开发工具/i.test(title);
  if (toolSubject && practical.test(combined)) return accept('tools', 6 + (/tutorial|guide|workflow|fix|教程|工作流|修复/i.test(combined) ? 2 : 0));
  if (aiName.test(title) && update.test(titleLower) && !/\b(?:no|without) (?:new )?(?:product )?(?:changes|updates|announcement)/i.test(lead)) return accept('ai', 5);
  return reject('不属于具体产品变化或可用创作方法');
}

function canonicalIdentity(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.protocol = 'https:'; url.hostname = url.hostname.replace(/^www\./, ''); url.hash = '';
    if (['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com'].includes(url.hostname)) {
      const status = url.pathname.match(/\/status\/(\d+)/); if (status) return `https://x.com/i/status/${status[1]}`;
    }
    if (['youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)) {
      const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)/)?.[1];
      if (id && /^[\w-]{6,}$/.test(id)) return `https://youtube.com/watch?v=${id}`;
    }
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|ref_url|mkt_tok)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort(); url.pathname = url.pathname.replace(/\/$/, '') || '/';
    return url.href;
  } catch { return null; }
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'in', 'on', 'for', 'to', 'of', 'and', 'with', 'its', 'at', 'by', 'from']);
function titleTokens(value) {
  const lower = words(value);
  const tokens = (lower.match(/[a-z0-9]+(?:[.-][a-z0-9]+)*/g) ?? []).filter(token => !STOP_WORDS.has(token));
  for (const chunk of lower.match(/\p{Script=Han}+/gu) ?? []) for (let n = 0; n < chunk.length - 1; n++) tokens.push(chunk.slice(n, n + 2));
  return [...new Set(tokens)];
}
function comparable(item) {
  const title = text(item.title);
  const tokens = titleTokens(title);
  return { item, url: canonicalIdentity(item.url), title: words(title).replace(/[\p{P}\p{Z}\s]+/gu, ''), tokens: new Set(tokens), numbers: (title.match(/\d+(?:\.\d+)*/g) ?? []).join('|'), time: Date.parse(item.publishedAt), substantial: !versionOnly(title) && (title.match(/\p{Script=Han}/gu)?.length >= 8 || (title.length >= 18 && tokens.length >= 3)) };
}
function sameCoverage(a, b) {
  if (!a.substantial || !b.substantial || a.numbers !== b.numbers) return false;
  const bothDated = Number.isFinite(a.time) && Number.isFinite(b.time);
  if (bothDated && Math.abs(a.time - b.time) > DAY * 3) return false;
  if (a.title === b.title) return true;
  if (!bothDated) return false;
  let shared = 0; for (const token of a.tokens) if (b.tokens.has(token)) shared++;
  // High overlap plus matching numeric details prevents merging all news about
  // a named product. Distinct launch, pricing and tutorial stories stay apart.
  return shared >= 5 && shared / Math.max(a.tokens.size, b.tokens.size) >= 0.88 && shared / (a.tokens.size + b.tokens.size - shared) >= 0.8;
}
function representative(items) {
  const priority = item => (item.starred ? 10000 : 0) + (item.research?.isStale === false && item.research?.verification === 'original-page' ? 2000 : 0) + (meaningfulSummary(item.summary) ? 1000 : 0) + Math.min(text(item.summary).length, 500);
  return [...items].sort((a, b) => priority(b) - priority(a) || String(a.id ?? a.url).localeCompare(String(b.id ?? b.url)))[0];
}

export function deduplicateContent(items = []) {
  const groups = [], urls = new Map(), titles = new Map(), tokens = new Map();
  for (const item of items) {
    const candidate = comparable(item);
    let groupIndex = candidate.url ? urls.get(candidate.url) : undefined;
    if (groupIndex === undefined && candidate.substantial) groupIndex = (titles.get(candidate.title) ?? []).find(index => sameCoverage(candidate, groups[index].key));
    if (groupIndex === undefined && candidate.substantial) {
      const shared = new Map();
      for (const token of candidate.tokens) for (const index of tokens.get(token) ?? []) shared.set(index, (shared.get(index) ?? 0) + 1);
      for (const [index, count] of shared) if (count >= 5 && sameCoverage(candidate, groups[index].key)) { groupIndex = index; break; }
    }
    if (groupIndex === undefined) {
      groupIndex = groups.length; groups.push({ key: candidate, items: [] });
      if (candidate.substantial) { if (!titles.has(candidate.title)) titles.set(candidate.title, []); titles.get(candidate.title).push(groupIndex); }
      if (candidate.substantial) for (const token of candidate.tokens) { if (!tokens.has(token)) tokens.set(token, new Set()); tokens.get(token).add(groupIndex); }
    }
    groups[groupIndex].items.push(item);
    if (candidate.url) urls.set(candidate.url, groupIndex);
  }
  return { items: groups.map(group => {
    const selected = representative(group.items);
    const related = group.items.flatMap(i => i.selection?.relatedItems ?? [{ id: i.id, url: i.url, title: i.title, sourceId: i.sourceId, sourceName: i.sourceName, starred: !!i.starred }]);
    const relatedItems = [...new Map(related.map(i => [i.id ?? i.url, i])).values()];
    return { ...selected, selection: { ...selected.selection, duplicateCount: relatedItems.length - 1, relatedItems } };
  }), duplicateCount: items.length - groups.length };
}

export function selectConciseFeed(items = [], topics = [], { limitPerTopic = 6, ...options } = {}) {
  const limit = Math.max(1, Math.min(50, Number(limitPerTopic) || 6));
  const activeTopics = topics.filter(topic => topic.enabled);
  const groups = activeTopics.map(topic => ({ topic, items: [], totalCount: 0, hiddenCount: 0 }));
  const { items: unique, duplicateCount } = deduplicateContent(items);
  const excluded = [], ranked = [];
  for (const item of unique) {
    const value = classifyContent(item, options);
    const group = groups.find(g => g.topic.id === value.category) ?? groups.find(g => !DEFAULT_IDS.has(g.topic.id) && item.topicIds?.includes(g.topic.id));
    if (!value.eligible || !group) { excluded.push({ item, reason: value.reason || '对应主题已暂停' }); continue; }
    ranked.push({ group, value, item: { ...item, selection: { ...item.selection, category: value.category, reason: value.reason } } });
  }
  ranked.sort((a, b) => b.value.score - a.value.score || (Date.parse(b.item.publishedAt) || 0) - (Date.parse(a.item.publishedAt) || 0) || String(a.item.id ?? a.item.url).localeCompare(String(b.item.id ?? b.item.url)));
  const releaseStreams = new Map(), sourceCounts = new Map();
  for (const { group, item } of ranked) {
    group.totalCount++;
    const releaseProject = versionOnly(text(item.title)) ? String(item.url).match(/github\.com\/([^/]+\/[^/]+)\/releases\//)?.[1] ?? item.sourceId : null;
    const stream = releaseProject ? `${group.topic.id}:${releaseProject}` : null;
    const source = item.sourceId || item.sourceName;
    const sourceKey = source ? `${group.topic.id}:${source}` : null;
    if (group.items.length < limit && (!stream || (releaseStreams.get(stream) ?? 0) < 2) && (!sourceKey || (sourceCounts.get(sourceKey) ?? 0) < 3)) {
      group.items.push(item);
      if (stream) releaseStreams.set(stream, (releaseStreams.get(stream) ?? 0) + 1);
      if (sourceKey) sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) ?? 0) + 1);
    } else group.hiddenCount++;
  }
  const shown = groups.flatMap(group => group.items), eligibleItems = ranked.map(entry => entry.item);
  const overflowCount = eligibleItems.length - shown.length;
  return { groups, items: shown, eligibleItems, excluded, excludedCount: excluded.length, duplicateCount, overflowCount,
    counts: { input: items.length, unique: unique.length, eligible: eligibleItems.length, shown: shown.length, excluded: excluded.length, duplicates: duplicateCount, overflow: overflowCount } };
}
