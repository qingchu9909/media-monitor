import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { EmptyState } from './FeedBoard.jsx';
import { api, formatDate } from '../utils.js';
import OpportunityWorkbench from './OpportunityWorkbench.jsx';

function saveMarkdown(text, filename) {
  const objectUrl = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = objectUrl; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export default function ReportPanel({ lastCollectedAt, latestBrief, items, onStar, pendingStars, onError, operations, onDraftStarted }) {
  const [catalog, setCatalog] = useState([]);
  const [date, setDate] = useState('');
  const [followLatest, setFollowLatest] = useState(true);
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [opportunityScope, setOpportunityScope] = useState('new');
  useEffect(() => { setOpportunityScope('new'); }, [date]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api('/api/briefs', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) }).then(result => {
      if (controller.signal.aborted) return;
      const entries = Array.isArray(result.briefs) ? result.briefs : [];
      setCatalog(entries);
      setDate(current => !followLatest && entries.some(entry => entry.date === current) ? current : result.latest?.date || entries[0]?.date || '');
      if (!entries.length) { setBrief(null); setLoading(false); }
    }).catch(err => { if (!controller.signal.aborted) { setError(err.message); setLoading(false); } });
    return () => controller.abort();
  }, [lastCollectedAt, latestBrief?.generatedAt, revision, followLatest]);
  useEffect(() => {
    if (!date) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setBrief(null);
    api(`/api/briefs/${encodeURIComponent(date)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) }).then(result => {
      if (!controller.signal.aborted) setBrief(result.brief || result);
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [date, lastCollectedAt, latestBrief?.generatedAt, revision]);

  async function downloadRaw() {
    setDownloading(true);
    try {
      const response = await fetch('/api/report', { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('原始资料下载失败');
      saveMarkdown(await response.text(), `媒体观察-原始资料-${new Date().toLocaleDateString('sv-SE')}.md`);
    } catch (err) { onError(err.message); }
    finally { setDownloading(false); }
  }
  const reviewed = brief?.status === 'reviewed';
  const emptyReviewed = reviewed && !brief.highlights.length;
  const hasHistoryInfo = reviewed && brief.highlights.every(item => typeof item.newToBrief === 'boolean');
  const newCount = hasHistoryInfo ? brief.highlights.filter(item => item.newToBrief).length : 0;
  const followupCount = hasHistoryInfo ? brief.highlights.length - newCount : 0;
  const visibleHighlights = hasHistoryInfo ? brief.highlights.filter(item => opportunityScope === 'new' ? item.newToBrief : !item.newToBrief) : brief?.highlights || [];
  const visibleUrls = new Set(visibleHighlights.map(item => item.url));
  const visibleBrief = brief && { ...brief, highlights: visibleHighlights, ideas: brief.ideas.filter(idea => idea.sourceUrls.some(url => visibleUrls.has(url))) };
  const previousWithOpportunities = catalog.find(entry => entry.date < date && entry.highlightCount > 0);
  return <section className="report-panel radar-report-panel"><div className="report-heading radar-report-toolbar"><p>{hasHistoryInfo ? `${newCount} 条本日新增 · ${followupCount} 条继续跟进` : reviewed ? `${brief.highlights.length} 条中文机会 · 创作建议由 Codex 整理` : '中文简报与原始资料'}</p><div className="report-actions"><label className="brief-date-label"><span>{followLatest ? '自动跟随最新简报' : '历史简报日期'}</span><select aria-label="简报日期" value={date} disabled={!catalog.length} onChange={event => { setFollowLatest(event.target.value === catalog[0]?.date); setDate(event.target.value); }}>{catalog.length ? catalog.map(entry => <option key={entry.date} value={entry.date}>{entry.date}</option>) : <option value="">暂无简报</option>}</select></label><button type="button" className="button" onClick={downloadRaw} disabled={downloading}><Icon name="download" size={16}/>{downloading ? '下载中…' : '原始资料'}</button>{brief?.markdown && <button type="button" className="button primary" onClick={() => saveMarkdown(brief.markdown, `媒体观察-中文简报-${brief.date}.md`)}><Icon name="download" size={16}/>下载简报</button>}</div></div>
    {loading ? <div className="loading-state" role="status"><span className="spinner"/>正在读取中文简报…</div> : error ? <div className="report-error"><EmptyState icon="info" title="暂时无法读取简报" description={error}/><button type="button" className="button" onClick={() => setRevision(value => value + 1)}>重新读取</button></div> : !brief ? <div className="brief-empty"><EmptyState title="还没有经过整理的中文简报" description="点击顶部“更新并生成选题”，采集来源并由 Codex 整理中文解读和创作建议。"/><p>运行进度和错误可在“运行与通知”查看。</p></div> : <div className="brief-content">
      {hasHistoryInfo && !emptyReviewed && <div className="concise-toolbar"><div className="view-toggle" aria-label="机会阅读范围"><button type="button" className={opportunityScope === 'new' ? 'selected' : ''} aria-pressed={opportunityScope === 'new'} onClick={() => setOpportunityScope('new')}>新增机会（{newCount}）</button><button type="button" className={opportunityScope === 'followup' ? 'selected' : ''} aria-pressed={opportunityScope === 'followup'} onClick={() => setOpportunityScope('followup')}>继续跟进（{followupCount}）</button></div><p>新增指本日首次入选；以前推荐过的内容放在“继续跟进”，原始发布时间保留。</p></div>}
      {emptyReviewed ? <div className="brief-empty" role="status"><EmptyState title={brief.title || '本次没有可展示的已核验机会'} description={brief.summary || '这次简报没有已核验的选题。可以查看检查范围，或切换日期阅读之前的机会。'}/><p>这里只反映本次已检查来源的结果，不代表全网没有新内容。</p>{previousWithOpportunities && <button type="button" className="button" onClick={() => { setFollowLatest(false); setDate(previousWithOpportunities.date); }}>查看 {previousWithOpportunities.date} 的 {previousWithOpportunities.highlightCount} 条机会</button>}</div> : !visibleHighlights.length ? <div className="brief-empty" role="status"><EmptyState title={opportunityScope === 'new' ? '这份简报没有新入选的机会' : '这份简报没有此前推荐的内容'} description={opportunityScope === 'new' ? '本次没有找到新的入选内容。此前值得继续做的选题仍可查看。' : '可以切回新增机会，查看本日首次入选的内容。'}/><button type="button" className="button" onClick={() => setOpportunityScope(opportunityScope === 'new' ? 'followup' : 'new')}>{opportunityScope === 'new' ? '查看继续跟进' : '查看新增机会'}</button></div> : <OpportunityWorkbench key={brief.date + ':' + opportunityScope} brief={visibleBrief} items={items} onStar={onStar} pendingStars={pendingStars} onError={onError} operations={operations} onDraftStarted={onDraftStarted}/>}
      <details className="radar-brief-method"><summary>简报说明与核验范围<span>{brief.date} · {brief.generationMethod || '整理方式未提供'}</span></summary><div className="brief-intro"><h2>{brief.title}</h2>{brief.summary && <p>{brief.summary}</p>}<small>{brief.generatedAt ? `整理于 ${formatDate(brief.generatedAt)}` : '旧版文稿，未提供生成时间'}</small></div>
      {!reviewed && brief.markdown && <details className="legacy-brief"><summary>查看已有文稿 · 尚未结构化核验</summary><pre>{brief.markdown}</pre></details>}
      {(brief.coverage?.length > 0 || brief.caveats?.length > 0) && <aside className="brief-coverage">{brief.coverage?.length > 0 && <div><h3>这份简报看了哪些信息</h3><ul>{brief.coverage.map((value, index) => <li key={index}>{value}</li>)}</ul></div>}{brief.caveats?.length > 0 && <div><h3>需要留意</h3><ul>{brief.caveats.map((value, index) => <li key={index}>{value}</li>)}</ul></div>}</aside>}
      </details>
    </div>}
  </section>;
}
