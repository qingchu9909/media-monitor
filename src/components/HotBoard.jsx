import React, { useMemo, useState } from 'react';
import { EmptyState } from './FeedBoard.jsx';
import Icon from './Icon.jsx';
import { formatDate, safeUrl } from '../utils.js';
import { metricValue, rankXItems, xPostIdentity, xPostOrigin } from '../feed-filters.mjs';
import { useChineseContent } from '../chinese-content.js';

const METRICS = [['views', '浏览量'], ['likes', '赞'], ['reposts', '转发'], ['replies', '回复']];

function XPost({ item, rank, onStar, pending, translations, onTranslate, pendingTranslations, translationErrors }) {
  const content = useChineseContent(item, { translations, onTranslate, pendingTranslations, translationErrors });
  const href = safeUrl(item.url);
  const origin = xPostOrigin(item);
  const handle = item.author?.handle?.replace(/^@/, '') || xPostIdentity(item.url)?.handle;
  const author = item.author?.name || (handle ? `@${handle}` : '作者未提供');
  return <tr><td className="hot-table-rank">{rank}</td><td className="hot-table-post">
    <div className="hot-table-author"><span className="author-initial">{item.author?.name?.slice(0, 1) || handle?.slice(0, 1) || 'X'}</span><div><strong>{author}</strong><span>{item.author?.name && handle ? `@${handle} · ` : ''}{item.publishedAt ? formatDate(item.publishedAt) : '发布时间未知'} · {origin === 'public-web' ? '公开网页' : 'AIsa 数据'}</span></div></div>
    <h3>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{content.title}</a> : content.title}</h3>
    {content.summary && content.summary !== content.title && <p>{content.summary}</p>}
    <div className="hot-post-language" style={{ margin: '10px 0 0 51px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
      {content.kind === 'editorial' && <span className="reviewed-label">选题解读</span>}
      {content.kind === 'research' && <span className="reviewed-label" title="中文整理所用的原样引文已匹配公开页面，不代表独立事实核验。">网页中文整理 · 有原帖引文</span>}
      {content.kind === 'translation' && <span className="reviewed-label" title="按原帖翻译，未进行事实核验。">中文译文 · 未核验</span>}
      {content.hasAlternate && <button type="button" className="text-button original-toggle" aria-pressed={content.original} onClick={() => content.setOriginal(value => !value)}>{content.original ? '返回中文视图' : '显示原帖'}</button>}
      {content.needsTranslation && <button type="button" className="text-button" onClick={content.translate} disabled={content.pending || !content.canTranslate}>{content.pending ? <><span className="spinner small"/>翻译中…</> : content.error ? '重新翻译' : '翻译为中文'}</button>}
      {href && <a className="text-button inline-link" href={href} target="_blank" rel="noopener noreferrer">查看原帖与媒体<Icon name="external" size={12}/></a>}
    </div>
    {content.needsTranslation && !content.original && <p>{content.pending ? 'Codex 正在翻译，原帖与媒体链接仍可打开。' : '暂无中文译文；可用现有 Codex 翻译，不调用 AIsa。'}</p>}
    {content.error && <p className="form-error" role="alert">{content.error}</p>}
  </td>{METRICS.map(([field, label]) => {
    const value = metricValue(item.metrics?.[field]);
    return <td className={`hot-table-metric ${field === 'views' ? 'primary-metric' : ''}`} key={field} title={value === null ? '来源未提供' : `${label}：${value}`}>{value === null ? '—' : value.toLocaleString('zh-CN')}</td>;
  })}<td className="hot-table-actions"><button type="button" className={`icon-button ${item.starred ? 'starred' : ''}`} onClick={() => onStar(item)} disabled={pending} aria-label={`${item.starred ? '取消收藏' : '收藏'}：${content.title}`} aria-pressed={Boolean(item.starred)}><Icon name="star" size={17} filled={Boolean(item.starred)}/></button>{href && <a className="icon-button" href={href} target="_blank" rel="noopener noreferrer" aria-label={`打开原文：${content.title}`}><Icon name="external" size={17}/></a>}</td></tr>;
}

export default function HotBoard({ items, range = '24h', onRangeChange, onOpenSources, onStar, pendingStars, translations, onTranslate, pendingTranslations, translationErrors }) {
  const [limit, setLimit] = useState(20);
  const ranked = useMemo(() => rankXItems(items, { range }), [items, range]);
  const anyX = items.some(item => xPostOrigin(item));
  const rangeTitle = range === '24h' ? '过去 24 小时' : range === '7d' ? '过去 7 天' : '全部已采集';
  return <section className="hot-board radar-hot-board">
    <header className="hot-heading"><div className="hot-board-title"><span className="x-source-mark">X</span><div><h2>X {rangeTitle}原帖</h2><p>公开网页与已保存数据 · 已知浏览量、赞数优先，其余按原帖发布时间</p></div></div><div className="range-filter" aria-label="X 原帖时间范围">{[['24h', '近 24 小时'], ['7d', '近 7 天'], ['all', '全部']].map(([value, label]) => <button type="button" key={value} className={range === value ? 'selected' : ''} aria-pressed={range === value} onClick={() => { onRangeChange(value); setLimit(20); }}>{label}</button>)}</div></header>
    <div className="hot-table-scroll"><table className={`hot-table ${ranked.length ? '' : 'is-empty'}`}><thead><tr><th scope="col">序号</th><th scope="col">原帖与作者</th>{METRICS.map(([key, label]) => <th scope="col" key={key}>{label}</th>)}<th scope="col"><span className="sr-only">操作</span></th></tr></thead><tbody>
      {ranked.length ? ranked.slice(0, limit).map((item, index) => <XPost key={item.id} item={item} rank={index + 1} onStar={onStar} pending={pendingStars.has(item.id)} translations={translations} onTranslate={onTranslate} pendingTranslations={pendingTranslations} translationErrors={translationErrors}/>) : <tr><td colSpan={7} className="hot-table-empty"><div className="hot-empty"><EmptyState icon="source" title={anyX ? '这个时间范围没有 X 原帖' : '暂未收录可展示的 X 原帖'} description={anyX ? '可以扩大时间范围查看历史原帖。时间筛选使用原帖发布时间，不使用搜索或入库时间。' : 'Codex 可从公开网页寻找 X 原帖。只有引文已匹配原文的记录才会在这里展示；尚未核验的搜索线索保留在信息流中。'}/><button type="button" className="button" onClick={onOpenSources}>查看来源与采集状态</button></div></td></tr>}
    </tbody></table></div>
    <div className="hot-coverage"><button type="button" className="text-button hot-config-button" onClick={onOpenSources}>查看来源与采集状态</button>{ranked.length ? `已显示 ${Math.min(limit, ranked.length)} / ${ranked.length} 条 · ` : ''}这里展示本地已收录原帖，不代表全站热榜。公开网页未提供的互动数字显示 —；引文匹配与中文整理不代表独立事实核验。Codex 网页研究无需 AIsa，历史 AIsa 数据继续保留。</div>
    {limit < ranked.length && <div className="pagination-footer"><button type="button" className="button" onClick={() => setLimit(value => value + 20)}>再看 20 条</button></div>}
  </section>;
}
