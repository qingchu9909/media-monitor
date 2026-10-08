import React, { useState } from 'react';
import Icon from './Icon.jsx';
import ArticleCard from './ArticleCard.jsx';
import { chineseContent } from '../chinese-content.js';
import { selectConciseFeed } from '../content-selection.mjs';
export { default as ArticleCard } from './ArticleCard.jsx';

const PAGE_SIZE = 20;
const descriptions = { ai: '模型、应用发生了什么变化，对使用者有什么影响。', tools: '能实际使用的 Agent、开源工具和自动化方法。', video: '生成、角色一致性、分镜、配音与剪辑的具体做法。' };
const topicDescription = topic => descriptions[topic.id] || '按这个主题筛选的具体工具与实践线索。';
export function EmptyState({ icon = 'report', title = '这个范围内还没有信息', description = '试试近 7 天或全部，或采集一次免费来源。' }) {
  return <div className="empty-state"><Icon name={icon} size={40}/><h3>{title}</h3><p>{description}</p></div>;
}
function ArticleBatch({ items, onStar, pendingStars, compact = false, empty, translations, onTranslate, pendingTranslations, translationErrors }) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  if (!items.length) return <EmptyState {...empty}/>;
  return <>{items.slice(0, limit).map(item => <ArticleCard key={item.id} item={item} compact={compact} onStar={onStar} pending={pendingStars.has(item.id)} translations={translations} onTranslate={onTranslate} pendingTranslations={pendingTranslations} translationErrors={translationErrors}/>)}{items.length > PAGE_SIZE && <div className="pagination-footer"><span>已显示 {Math.min(limit, items.length)} / {items.length} 条</span>{limit < items.length && <button type="button" className="button load-more" onClick={() => setLimit(value => value + PAGE_SIZE)}>再看 {Math.min(PAGE_SIZE, items.length - limit)} 条</button>}</div>}</>;
}
export default function FeedBoard({ items, topics, layout, currentTopic, page, query, onEditTopic, onStar, pendingStars, connectionNotice, translations, onTranslate, pendingTranslations, translationErrors }) {
  const [concise, setConcise] = useState(true);
  const activeTopics = topics.filter(topic => topic.enabled);
  const customTopic = currentTopic && !['ai','tools','video'].includes(currentTopic.id);
  const selectionTopics = customTopic ? [currentTopic] : activeTopics;
  const selectionItems = customTopic ? items.filter(item => item.topicIds?.includes(currentTopic.id)) : items;
  const selection = selectConciseFeed(selectionItems, selectionTopics, { limitPerTopic: 6 });
  const readable = selection.eligibleItems.filter(item => {
    const content = chineseContent(item, translations);
    return content.isReadable;
  });
  const chineseSelection = selectConciseFeed(readable, selectionTopics, { limitPerTopic: 6 });
  const chinesePending = selection.eligibleItems.length - readable.length;
  const compactMode = concise && page !== 'starred';
  const groups = chineseSelection.groups;
  const rawItems = currentTopic ? items.filter(item => item.topicIds?.includes(currentTopic.id)) : items;
  const displayed = compactMode ? currentTopic ? groups.find(group => group.topic.id === currentTopic.id)?.items || [] : chineseSelection.items : rawItems;
  const noMatch = query.trim() ? { icon: 'search', title: '没有找到相关信息', description: '试试其他关键词，或切换到全部资料。' } : page === 'starred' ? { icon: 'star', title: '留住值得再看的信息', description: '点击信息旁的星标，就能在这里找到它。' } : compactMode ? { title: '这个范围暂无值得展开的中文线索', description: '更新时会自动筛选和补译；可以切换到全部资料查看待整理内容。' } : {};
  const props = { onStar, pendingStars, translations, onTranslate, pendingTranslations, translationErrors };
  const toolbar = page !== 'starred' && <div className="concise-toolbar"><div className="view-toggle" aria-label="阅读方式"><button type="button" className={concise ? 'selected' : ''} aria-pressed={concise} onClick={() => setConcise(true)}>精简中文</button><button type="button" className={!concise ? 'selected' : ''} aria-pressed={!concise} onClick={() => setConcise(false)}>全部资料</button></div><p>{compactMode ? `每栏最多 6 条，同一内容只放一栏。已合并 ${selection.duplicateCount} 条重复，过滤 ${selection.excludedCount} 条低相关资料。${chinesePending ? `另有 ${chinesePending} 条等待完整中文，后续更新会继续整理。` : ''}` : '这里保留全部采集结果，可能含求助、重复报道、待译和低相关内容。'}</p></div>;
  const isColumns = layout === 'columns' && page === 'all' && activeTopics.length > 0;
  if (!isColumns || !compactMode) return <>{toolbar}<section className="feed-list" aria-label="信息列表">{currentTopic && <div className="list-topic-heading"><div><h2>{currentTopic.name}{!currentTopic.enabled && <span className="muted-label">已暂停</span>}</h2><p>{topicDescription(currentTopic)}</p></div><button type="button" className="text-button" onClick={() => onEditTopic(currentTopic)}>编辑主题<Icon name="more" size={18}/></button></div>}<ArticleBatch items={displayed} compact {...props} empty={noMatch}/></section>{connectionNotice}</>;
  return <>{toolbar}<div className="feed-board" style={{ '--column-count': Math.min(activeTopics.length, 3) }}>{groups.map(({topic,items:topicItems}) => <section className="topic-column" key={topic.id} aria-label={topic.name}><div className="column-heading"><div><h2>{topic.name}<span className="column-count">{topicItems.length}</span></h2><p>{topicDescription(topic)}</p></div><button type="button" className="icon-button" aria-label={`编辑主题：${topic.name}`} title="编辑主题" onClick={() => onEditTopic(topic)}><Icon name="more"/></button></div><div className="column-content"><ArticleBatch items={topicItems} {...props} empty={noMatch}/></div></section>)}</div>{connectionNotice}</>;
}
