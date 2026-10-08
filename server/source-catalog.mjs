// Read-only recommendations. Verification records are snapshots, not a promise of uptime.
const originalVerifiedAt = '2026-09-13T03:27:30.000Z';
const originalEntries = [
  { id: 'openai', name: 'OpenAI News', url: 'https://openai.com/news/rss.xml', platform: 'OpenAI', description: 'OpenAI 官方新闻与产品更新；可能含历史文章。' },
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', platform: 'Hugging Face', description: 'Hugging Face 官方博客、开源模型和工具实践。' },
  { id: 'github', name: 'GitHub Blog', url: 'https://github.blog/feed/', platform: 'GitHub', description: 'GitHub 官方博客和开发者产品更新。' },
  { id: 'arxiv', name: 'arXiv · cs.AI', url: 'https://rss.arxiv.org/rss/cs.AI', platform: 'arXiv', description: 'arXiv 人工智能论文；内容密集，可单独暂停。' },
  { id: 'claude-code-releases', name: 'Claude Code 发布记录', url: 'https://github.com/anthropics/claude-code/releases.atom', platform: 'Anthropic', description: 'Anthropic 官方 Claude Code 仓库的发布记录。' },
  { id: 'gemini-cli-releases', name: 'Gemini CLI 发布记录', url: 'https://github.com/google-gemini/gemini-cli/releases.atom', platform: 'Google', description: 'Google Gemini CLI 官方发布记录，包含 nightly 版本。' },
  { id: 'comfyui-releases', name: 'ComfyUI 发布记录', url: 'https://github.com/Comfy-Org/ComfyUI/releases.atom', platform: 'ComfyUI', description: 'ComfyUI 官方仓库的发布记录和版本说明。' },
].map(entry => ({ ...entry, verifiedAt: originalVerifiedAt }));

export const freeSourceAdditions = [
  {
    id: 'comfy-blog', name: 'ComfyUI 官方博客', url: 'https://blog.comfy.org/feed', platform: 'ComfyUI',
    description: '官方视频、图像、音频工作流与模型接入教程，适合 AI 短剧制作；部分教程使用收费模型，订阅资讯本身免费。',
    publisherType: 'official', language: 'en', category: 'creative-ai', homepageUrl: 'https://blog.comfy.org/',
    verifiedAt: '2026-09-13T03:57:59.489Z', verifiedItemCount: 20,
  },
  {
    id: 'fal-blog', name: 'fal AI 视频与创作', url: 'https://blog.fal.ai/rss/', platform: 'fal',
    description: 'fal 官方模型更新、镜头控制和 AI 视频流程教程；包含供应商宣传，效果需自行核验，模型使用可能收费。',
    publisherType: 'official', language: 'en', category: 'creative-ai', homepageUrl: 'https://blog.fal.ai/',
    verifiedAt: '2026-09-13T03:57:59.430Z', verifiedItemCount: 15,
  },
  {
    id: 'replicate-blog', name: 'Replicate 创作教程', url: 'https://replicate.com/blog/rss', platform: 'Replicate',
    description: '官方图像、视频提示词和角色一致性教程；含历史实践与供应商宣传，适合研究创作方法，不全是当日新闻。',
    publisherType: 'official', language: 'en', category: 'creative-ai', homepageUrl: 'https://replicate.com/blog',
    verifiedAt: '2026-09-13T03:57:59.487Z', verifiedItemCount: 124,
  },
  {
    id: 'deepmind-blog', name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', platform: 'Google DeepMind',
    description: 'DeepMind 官方研究与模型发布，覆盖 Gemini、Veo 等；部分条目没有 RSS 摘要，需读取原文。',
    publisherType: 'official', language: 'en', category: 'ai-products', homepageUrl: 'https://deepmind.google/blog/',
    verifiedAt: '2026-09-13T03:58:01.302Z', verifiedItemCount: 100,
  },
  {
    id: 'google-ai-blog', name: 'Google AI 产品动态', url: 'https://blog.google/innovation-and-ai/technology/ai/rss/', platform: 'Google',
    description: 'Google 官方 AI 产品、创作应用和使用案例；范围比视频更广，部分条目没有 RSS 摘要。',
    publisherType: 'official', language: 'en', category: 'ai-products', homepageUrl: 'https://blog.google/innovation-and-ai/technology/ai/',
    verifiedAt: '2026-09-13T03:58:01.117Z', verifiedItemCount: 20,
  },
  {
    id: 'diffusers-releases', name: 'Diffusers 发布记录', url: 'https://github.com/huggingface/diffusers/releases.atom', platform: 'Hugging Face',
    description: 'Hugging Face 官方图像、视频、音频生成库版本说明；适合跟踪本地开源模型支持，技术内容较多。',
    publisherType: 'official', language: 'en', category: 'creative-ai', homepageUrl: 'https://github.com/huggingface/diffusers',
    verifiedAt: '2026-09-13T03:58:02.848Z', verifiedItemCount: 10,
  },
  {
    id: 'qbitai', name: '量子位', url: 'https://www.qbitai.com/feed', platform: '量子位',
    description: '中文 AI 科技媒体，补充国内产品、研究与行业资讯；媒体报道须回查官方原文，标题不等于已核实结论。',
    publisherType: 'media', language: 'zh', category: 'chinese-ai', homepageUrl: 'https://www.qbitai.com/',
    verifiedAt: '2026-09-13T03:58:03.856Z', verifiedItemCount: 10,
  },
  {
    id: 'sspai', name: '少数派', url: 'https://sspai.com/feed', platform: '少数派',
    description: '中文工具实践、效率与创作者经验，包含作者观点；混有生活和硬件内容，按主题筛选使用。',
    publisherType: 'media', language: 'zh', category: 'creator-tools', homepageUrl: 'https://sspai.com/',
    verifiedAt: '2026-09-13T03:58:03.881Z', verifiedItemCount: 10,
  },
  {
    id: 'infoq-cn', name: 'InfoQ 中文', url: 'https://www.infoq.cn/feed', platform: 'InfoQ',
    description: '中文 AI 应用与工程实践媒体；RSS 摘要较少，偶有未来时间条目，保留原始日期并由时间筛选排除。',
    publisherType: 'media', language: 'zh', category: 'chinese-ai', homepageUrl: 'https://www.infoq.cn/',
    verifiedAt: '2026-09-13T03:58:03.769Z', verifiedItemCount: 20,
  },
  {
    id: 'reddit-comfyui', name: 'Reddit · ComfyUI', url: 'https://www.reddit.com/r/comfyui/new/.rss', platform: 'Reddit',
    description: 'ComfyUI 社区新帖、工作流与创作讨论；用户发言未经核验，不代表官方观点或热度榜，公开订阅可能限流。',
    publisherType: 'community', language: 'en', category: 'creative-ai', homepageUrl: 'https://www.reddit.com/r/comfyui/',
    verifiedAt: '2026-09-13T03:58:06.193Z', verifiedItemCount: 25,
  },
  {
    id: 'runway-youtube', enabled: false, name: 'Runway 官方视频', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCUBqu_z5uP0AZhYtuyFZB3g', platform: 'YouTube',
    description: '官网确认的 Runway 视频频道；仅采集标题、链接和发布时间，不含字幕或视频内容核验。实测可读，但曾出现 404。',
    publisherType: 'official', language: 'en', category: 'creative-ai', homepageUrl: 'https://www.youtube.com/c/RunwayML',
    verifiedAt: '2026-09-13', verifiedItemCount: 15,
  },
];

export const sourceCatalogEntries = [...originalEntries, ...freeSourceAdditions];
