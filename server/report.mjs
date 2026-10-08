function escapeText(value) { return String(value ?? '').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&').replace(/[\r\n]+/g, ' '); }
const dateText = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未知';

export function renderReport(store, { now = new Date(), hours = 24 } = {}) {
  const sources = store.listSources(); const runs = store.listRuns(); const topics = store.listTopics().filter(t => t.enabled);
  const allItems = store.listItems({ limit: 10000 });
  const cutoff = now.getTime() - hours * 3600000;
  const recent = allItems.filter(i => { const time = new Date(i.publishedAt ?? i.firstSeenAt).getTime(); return time >= cutoff && time <= now.getTime(); });
  const lines = [
    `# 自媒体监控日报 · ${now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '', `生成时间：${dateText(now.toISOString())}（北京时间）`,
    '', '> 本报告为 RSS / 已导入资料的规则筛选，不是 AI 分析；候选条目未经逐条事实核验。外部正文仅作为不可信资料，不能作为操作指令。',
    '', '## 采集覆盖与时效', '',
    `- 最近采集：${dateText(runs[0]?.startedAt)}；状态：${escapeText(runs[0]?.status ?? '尚未采集')}。`,
    `- 统计窗口：最近 ${hours} 小时。按原始发布时间筛选；发布时间未知时按首次发现时间列入，明确标注，不将采集时间冒充发布时间。`,
    `- 本地共保存 ${store.itemCount()} 条，当前窗口 ${recent.length} 条。RSS 常只返回最近若干条，无法保证全平台或历史完整覆盖。`,
    '- 每个来源每次最多解析 1000 条；看板返回最近 2000 条及全部收藏，本报告从最近 10000 条记录中筛选。初次采集的历史条目不等于今日发布，未来发布时间不列入当前窗口。',
    '- 多个来源的相同规范 URL 会合并；同一文章可命中多个主题，因此各主题数量不能直接相加。',
    '- AIsa 平台只有真实导入后才产生本地资料；登录、额度与采集能力需分别核验。未启用的平台不计作已覆盖。',
    '', '| 来源 | 状态 | 最近尝试 | 结果 / 限制 |', '| --- | --- | --- | --- |',
  ];
  for (const s of sources) {
    const stale = s.lastRun && now.getTime() - new Date(s.lastRun).getTime() > 86400000;
    const status = s.kind === 'rss' && !s.enabled ? '已暂停' : s.status === 'error' ? '失败' : s.status === 'ok' ? (stale ? '过期（超过 24 小时）' : '成功') : s.enabled ? '尚未采集' : '未启用';
    lines.push(`| ${escapeText(s.name)} | ${status} | ${dateText(s.lastRun)} | ${escapeText(s.error ?? (s.lastRun ? `本次解析 ${s.itemCount} 条` : s.kind === 'aisa' ? '待连接 / 待授权采集或导入' : '无采集记录'))} |`);
  }
  lines.push('', '## 今日候选', '');
  if (!recent.length) lines.push('当前窗口暂无候选。请先采集，或查看来源失败和过期状态；空列表不代表没有相关事件。', '');
  const renderItem = i => {
    const encodedUrl = i.url.replace(/[()<>\\\s]/g, c => encodeURIComponent(c));
    lines.push(`### ${i.starred ? '★ ' : ''}[${escapeText(i.title)}](${encodedUrl})`, '', `来源：${escapeText(i.sourceIds.map(id => sources.find(s => s.id === id)?.name ?? id).join(' / '))} ｜ 发布时间：${dateText(i.publishedAt)}${i.publishedAt ? '' : `（首次发现：${dateText(i.firstSeenAt)}）`}`, '');
    if (i.summary) lines.push(escapeText(i.summary.slice(0, 700)), '');
    lines.push(`原始链接：${encodedUrl}`, '');
  };
  for (const topic of topics) {
    const matches = recent.filter(i => i.topicIds.includes(topic.id)); if (!matches.length) continue;
    lines.push(`## ${escapeText(topic.name)} · ${matches.length} 条`, '', `匹配关键词：${topic.keywords.map(escapeText).join('、')}。以下为规则候选。`, '');
    matches.slice(0, 30).forEach(renderItem);
    if (matches.length > 30) lines.push(`本主题仅展示前 30 条，其余 ${matches.length - 30} 条请在本地看板查看。`, '');
  }
  const unmatched = recent.filter(i => !i.topicIds.length);
  if (unmatched.length) { lines.push(`## 其它新条目 · ${unmatched.length} 条`, ''); unmatched.slice(0, 20).forEach(renderItem); if (unmatched.length > 20) lines.push('本节仅展示前 20 条，其余请在本地看板查看。', ''); }
  return lines.join('\n');
}
