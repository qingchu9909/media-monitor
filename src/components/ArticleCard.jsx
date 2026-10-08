import React, { useState } from 'react';
import Icon from './Icon.jsx';
import { formatDate, safeUrl } from '../utils.js';
import { itemTime } from '../feed-filters.mjs';
import { isReadableChinese, useChineseContent } from '../chinese-content.js';

export default function ArticleCard({ item, onStar, pending, compact = false, translations, onTranslate, pendingTranslations, translationErrors }) {
  const [expanded, setExpanded] = useState(false);
  const content = useChineseContent(item, { translations, onTranslate, pendingTranslations, translationErrors });
  const href = safeUrl(item.url);
  const time = itemTime(item);
  const future = time.kind === 'published' && time.value > Date.now();
  return <article className={`article ${compact ? 'compact' : ''}`}>
    <div className="article-meta"><span className="source-name">{item.sourceName || item.sourceId || '来源未标注'}</span><span className="article-badges">
      {content.kind === 'editorial' && <span className="reviewed-label">选题解读</span>}
      {content.kind === 'research' && <span className="reviewed-label" title="公开网页的中文整理；引文匹配不代表独立实测。">{item.research?.verification === 'original-page' ? item.research?.contentKind === 'video-description' ? '视频描述整理 · 未核对画面' : '网页中文整理 · 有页面引文' : '搜索线索 · 待核验'}</span>}
      {content.kind === 'original' && <span className="reviewed-label" title="保留来源提供的中文标题与摘要，尚未独立核验事实。">中文原文 · 未核验</span>}
      {content.kind === 'translation' && <span className="reviewed-label" title="Codex 根据原文翻译，不代表完成事实核验。">中文译文 · 未核验</span>}
      {content.summaryMissing && <span className="future-label">摘要缺失</span>}
      {future && <span className="future-label">未来日期</span>}
    </span><button type="button" className={`icon-button star-button ${item.starred ? 'starred' : ''}`} onClick={() => onStar(item)} disabled={pending} title={item.starred ? '取消收藏' : '收藏信息'} aria-label={`${item.starred ? '取消收藏' : '收藏'}：${content.title}`} aria-pressed={Boolean(item.starred)}><Icon name="star" size={18} filled={Boolean(item.starred)}/></button></div>
    <h3>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{content.title}</a> : content.title}</h3>
    {content.summary && <><p className={`article-summary ${expanded ? 'expanded' : ''}`}>{content.summary}</p>{content.summary.length > 90 && <button type="button" className="text-button summary-toggle" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? '收起摘要' : '展开摘要'}</button>}</>}
    {content.needsTranslation && <div className="article-translation-state">
      {!content.original && <p className="article-summary">{content.pending ? 'Codex 正在整理中文标题和摘要，完成后会自动显示。' : content.translationReason === 'source-changed' ? '原文已更新，旧译文已停用，等待重新整理中文。' : content.translationReason === 'invalid-chinese' ? '已有中文结果不完整，等待重新整理标题和摘要。' : '等待中文整理。近期内容会随更新任务自动补充，可先阅读其他中文条目。'}</p>}
      {content.error && <p className="form-error" role="alert">{content.error}</p>}
      <button type="button" className="text-button" onClick={content.translate} disabled={content.pending || !content.canTranslate}>{content.pending ? <><span className="spinner small"/>翻译中…</> : content.error ? '重新翻译' : '翻译为中文'}</button>
      <p className="field-help" style={{ marginTop: 6 }}>使用现有 Codex 额度，不调用 AIsa；译文不等于事实核验。</p>
    </div>}
    {!content.original && isReadableChinese(content.analysis?.whyItMatters) && <p className="article-value"><span>值得关注</span>{content.analysis.whyItMatters}</p>}
    <div className="article-footer"><time dateTime={time.value === null ? undefined : new Date(time.value).toISOString()} title={time.kind === 'published' ? '原文发布时间（本地时区）' : '原文未提供发布时间，显示首次发现时间'}>{time.kind === 'published' ? formatDate(item.publishedAt) : time.value === null ? '发布时间未知' : `首次发现 ${formatDate(item.firstSeenAt)}`}</time><div className="article-links">
      {content.hasAlternate && <button type="button" className="text-button original-toggle" onClick={() => { content.setOriginal(value => !value); setExpanded(false); }} aria-pressed={content.original}>{content.original ? '返回中文视图' : '显示原文'}</button>}
      {href && <a className="original-link" href={href} target="_blank" rel="noopener noreferrer">打开原文<Icon name="external" size={13}/></a>}
    </div></div>
  </article>;
}
