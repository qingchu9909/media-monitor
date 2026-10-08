import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Icon from './components/Icon.jsx';
import FeedBoard, { EmptyState } from './components/FeedBoard.jsx';
import SourcePanel from './components/SourcePanel.jsx';
import ReportPanel from './components/ReportPanel.jsx';
import HotBoard from './components/HotBoard.jsx';
import TopicDialog from './components/TopicDialog.jsx';
import RecommendationSettings from './components/RecommendationSettings.jsx';
import OperationsPanel, { jobLabel, jobStage } from './components/OperationsPanel.jsx';
import { api, formatDate } from './utils.js';
import { attachAnalysis, completedRunSummary, filterFeed } from './feed-filters.mjs';

const EMPTY = { topics: [], sources: [], items: [], runs: [], status: {}, analysisByUrl: {}, translationByUrl: {}, latestBrief: null };
const PAGE_TITLES = { all: '全部信息', starred: '我的收藏', sources: '来源状态', operations: '运行与通知', report: '今天最值得做什么内容？', hot: '过去 24 小时的 X 原帖' };
const PAGE_DESCRIPTIONS = { all: '按主题看信息，找到值得继续追的线索。', starred: '留住线索，慢慢打磨下一篇内容。', sources: '添加、管理和验证来源，按自己的关注范围采集。', operations: '看清每一次更新的进度、结果和需要处理的事项。', report: '依据公开资料整理，逐条标注来源证据', hot: '公开原帖与已有采集记录 · 未提供互动时显示未知' };
const RANGES = [['24h', '近 24 小时'], ['7d', '近 7 天'], ['all', '全部']];

export default function App() {
  const [data, setData] = useState(EMPTY);
  const [loadedBuild] = useState(() => Array.from(document.scripts).map(script=>script.getAttribute('src')).find(src=>src?.startsWith('/assets/index-')) || null);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [page, setPage] = useState('report');
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState('columns');
  const [range, setRange] = useState('7d');
  const [source, setSource] = useState('all');
  const [includePapers, setIncludePapers] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [pendingStars, setPendingStars] = useState(new Set());
  const [operations, setOperations] = useState(null);
  const [operationsLoading, setOperationsLoading] = useState(true);
  const [operationsError, setOperationsError] = useState('');
  const [starting, setStarting] = useState('');
  const [focusX, setFocusX] = useState(0);
  const [pendingTranslations,setPendingTranslations]=useState(new Set());
  const [translationErrors,setTranslationErrors]=useState({});
  const translationJob=useRef(null);
  const [browserEnabled, setBrowserEnabled] = useState(() => {
    try { return localStorage.getItem('media-monitor-browser-notifications') === 'true' && typeof Notification !== 'undefined' && Notification.permission === 'granted'; } catch { return false; }
  });
  const mounted = useRef(true);
  const previousRunning = useRef(false);
  const previousCompletedRun = useRef(null);
  const refreshing = useRef(null);
  const operationsRefreshing = useRef(null);
  const previousJob = useRef(null);
  const seenNotifications = useRef(null);
  const { topics, sources, items, status, runs, latestBrief } = data;
  const busy = collecting || Boolean(status.running) || Boolean(operations?.activeJob) || Boolean(starting);
  const feedPage = !['sources', 'report', 'hot', 'operations'].includes(page);
  const currentTopic = topics.find(topic => `topic:${topic.id}` === page);

  const refresh = useCallback(async ({ silent = false, afterMutation = false } = {}) => {
    if (refreshing.current) {
      if (!afterMutation) return refreshing.current;
      await refreshing.current;
    }
    const request = (async () => {
    try {
      const result = await api('/api/state');
      if (!mounted.current) return;
      const next = { ...EMPTY, ...result, status: result.status || {} };
      setData(next);
      setOnline(true);
      if (!silent) setError('');
      const finishedRun = next.runs.find(run => run.finishedAt);
      if (previousRunning.current && !next.status.running && finishedRun?.id && finishedRun.id !== previousCompletedRun.current && !previousJob.current) {
        const summary = completedRunSummary(finishedRun);
        setToast(summary ? `${finishedRun?.kind === 'aisa-import' ? '导入' : '采集'}结束：新增 ${summary.inserted} 条${summary.failures ? `，${summary.failures} 个来源失败` : summary.failed ? '，采集未完成，请查看来源' : '。'}` : '采集已结束，请查看来源状态。');
      }
      previousCompletedRun.current = finishedRun?.id || null;
      previousRunning.current = Boolean(next.status.running);
      return next;
    } catch (err) {
      if (mounted.current) { setOnline(false); setError(`无法读取本地服务：${err.message}`); }
    } finally {
      if (mounted.current) setLoading(false);
    }
    })();
    refreshing.current = request;
    try { return await request; } finally { if (refreshing.current === request) refreshing.current = null; }
  }, []);
  const refreshOperations = useCallback(async ({ afterMutation = false } = {}) => {
    if (operationsRefreshing.current) {
      if (!afterMutation) return operationsRefreshing.current;
      await operationsRefreshing.current;
    }
    const request = (async () => {
    try {
      const result = await api('/api/operations');
      if (!mounted.current) return;
      setOperations(result); setOperationsError('');
      const notifications = result.notifications || [];
      if (seenNotifications.current === null) seenNotifications.current = new Set(notifications.map(item => item.id));
      else for (const item of notifications) {
        if (seenNotifications.current.has(item.id)) continue;
        seenNotifications.current.add(item.id);
        if (browserEnabled && !item.read && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try { const notification = new Notification(item.title, { body: item.message, tag: item.id }); notification.onclick = () => { window.focus(); setPage('operations'); notification.close(); }; } catch { /* The notification remains available in the local inbox. */ }
        }
      }
      if (previousJob.current && result.activeJob?.id !== previousJob.current) {
        const finished = result.jobs?.find(job => job.id === previousJob.current);
        if (finished) setToast(`${jobLabel(finished)}：${finished.message || jobStage(finished)}`);
        await refresh({ silent: true, afterMutation: true });
        if(translationJob.current?.id===finished?.id){
          const selected=translationJob.current.itemIds;
          setPendingTranslations(new Set());
          if(['failed','partial','interrupted','cancelled'].includes(finished.status))setTranslationErrors(old=>({...old,...Object.fromEntries(selected.map(id=>[id,finished.message||'翻译未完成，可稍后重试']))}));
          translationJob.current=null;
        }
      }
      previousJob.current = result.activeJob?.id || null;
      return result;
    } catch (err) { if (mounted.current) setOperationsError(`无法读取运行状态：${err.message}`); }
    finally { if (mounted.current) setOperationsLoading(false); }
    })();
    operationsRefreshing.current = request;
    try { return await request; } finally { if (operationsRefreshing.current === request) operationsRefreshing.current = null; }
  }, [refresh, browserEnabled]);
  useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; }; }, [refresh]);
  useEffect(() => {
    refreshOperations();
    const interval = setInterval(() => { if (document.visibilityState !== 'hidden' || browserEnabled) refreshOperations(); }, operations?.activeJob ? 3000 : 15000);
    const visible = () => { if (document.visibilityState !== 'hidden') { refreshOperations(); refresh({ silent: true }); } };
    document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', visible); };
  }, [refreshOperations, refresh, Boolean(operations?.activeJob)]);
  useEffect(() => {
    const interval = setInterval(() => refresh({ silent: true }), busy ? 1800 : 15000);
    return () => clearInterval(interval);
  }, [refresh, busy]);
  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(''), 6500); return () => clearTimeout(timeout); }, [toast]);

  const enrichedItems = useMemo(() => attachAnalysis(items, data.analysisByUrl).map(item=>({...item,translation:data.translationByUrl?.[item.url]||null})), [items, data.analysisByUrl, data.translationByUrl]);
  const visibleItems = useMemo(() => filterFeed(enrichedItems, { query, range, source, includePapers, starredOnly: page === 'starred' }), [enrichedItems, query, range, source, includePapers, page, currentTopic?.id]);

  function navigate(destination) {
    setPage(destination); setQuery(''); setSource('all');
    setRange(destination === 'starred' ? 'all' : '7d');
    setIncludePapers(destination === 'starred');
  }
  function openXSettings() { setFocusX(value => value + 1); navigate('sources'); }
  function jobStarted(job) {
    setOperations(value => ({ ...value, activeJob: job, jobs: [job, ...(value?.jobs || []).filter(item => item.id !== job.id)] }));
    previousJob.current = job.id;
    navigate('operations');
  }
  function draftStarted(job) {
    setOperations(value=>({...value,activeJob:job,jobs:[job,...(value?.jobs||[]).filter(item=>item.id!==job.id)]}));
    previousJob.current=job.id;
    refreshOperations({afterMutation:true});
  }
  async function startJob(kind = 'refresh') {
    if (busy) return;
    setStarting(kind); setError('');
    try {
      const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ kind }) });
      jobStarted(job); await refreshOperations({ afterMutation: true });
    } catch (err) {
      setError(`任务提交未确认：${err.message}。请先查看运行记录，避免重复提交。`);
      await refreshOperations({ afterMutation: true }); navigate('operations');
    }
    finally { setStarting(''); }
  }
  async function translate(item) {
    if(busy) throw new Error('已有任务正在进行，完成后即可翻译。');
    const ids=item?[item.id]:[];
    setStarting('translation'); setPendingTranslations(new Set(ids));
    setTranslationErrors(old=>{const next={...old};ids.forEach(id=>delete next[id]);return next;});
    try {
      const job=await api('/api/jobs',{method:'POST',body:JSON.stringify({kind:'translation',...(item?{itemIds:[item.id]}:{})})});
      translationJob.current={id:job.id,itemIds:ids}; previousJob.current=job.id;
      setOperations(value=>({...value,activeJob:job,jobs:[job,...(value?.jobs||[]).filter(j=>j.id!==job.id)]}));
      setToast(item?'正在翻译这条内容，完成后会自动显示中文。':'正在补充近 7 天相关外文的中文摘要；已有译文会复用。');
      await refreshOperations({afterMutation:true});
    } catch(err) {
      setPendingTranslations(new Set());
      setTranslationErrors(old=>({...old,...Object.fromEntries(ids.map(id=>[id,'提交未确认，请先查看运行记录：'+err.message]))}));
      await refreshOperations({afterMutation:true});
      throw err;
    } finally {setStarting('');}
  }
  async function toggleBrowserNotifications() {
    if (browserEnabled) {
      setBrowserEnabled(false);
      try { localStorage.setItem('media-monitor-browser-notifications', 'false'); } catch { /* Optional preference. */ }
      setToast('浏览器通知已关闭，站内通知会继续保留。'); return;
    }
    if (typeof Notification === 'undefined') return setToast('当前浏览器不支持系统通知，请使用站内通知。');
    try {
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (permission !== 'granted') return setToast('通知权限未开启。可在浏览器对此网站的权限设置中允许通知；站内通知不受影响。');
      setBrowserEnabled(true);
      try { localStorage.setItem('media-monitor-browser-notifications', 'true'); } catch { /* Permission remains active for this page. */ }
      setToast('已开启浏览器通知。页面保持打开时，有新通知会提醒。');
    } catch (err) { setError(`无法开启浏览器通知：${err.message}`); }
  }
  async function collect() {
    if (busy) return;
    setCollecting(true); setError('');
    try {
      await api('/api/collect', { method: 'POST', body: '{}' });
      previousRunning.current = true;
      setData(value => ({ ...value, status: { ...value.status, running: true } }));
      await refresh({ afterMutation: true });
    } catch (err) {
      setError(`采集请求未完成确认：${err.message}。请查看来源状态。`);
      await refresh({ silent: true, afterMutation: true });
    }
    finally { setCollecting(false); }
  }
  async function star(item) {
    if (pendingStars.has(item.id)) return;
    setPendingStars(value => new Set(value).add(item.id));
    try {
      await api(`/api/items/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ starred: !item.starred }) });
      setData(value => ({ ...value, items: value.items.map(existing => existing.id === item.id ? { ...existing, starred: !item.starred } : existing) }));
    } catch (err) { setError(`收藏未更新：${err.message}`); }
    finally { setPendingStars(value => { const next = new Set(value); next.delete(item.id); return next; }); }
  }
  async function saveTopic(payload) {
    const saved = await api(dialog?.topic ? `/api/topics/${encodeURIComponent(dialog.topic.id)}` : '/api/topics', { method: dialog?.topic ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    if (saved?.id) setData(value => ({ ...value, topics: dialog?.topic ? value.topics.map(topic => topic.id === saved.id ? saved : topic) : [...value.topics, saved] }));
    await refresh();
    setToast(dialog?.topic ? '主题已更新。' : '主题已添加。');
  }
  const failures = sources.filter(item => !item.archived && (item.kind !== 'rss' || item.enabled) && (item.error || ['failed', 'error'].includes(item.status))).length;
  const lastFinishedRun = runs.find(run => run.finishedAt);
  const lastRun = completedRunSummary(lastFinishedRun);
  const filterKey = [page, range, source, includePapers, query].join('|');

  const radarPage = page === 'report' || page === 'hot';
  const pageTitle = page === 'hot' && range !== '24h' ? (range === '7d' ? '过去 7 天的 X 原帖' : '已采集的 X 原帖') : currentTopic?.name || PAGE_TITLES[page] || '全部信息';
  return <div className="app-shell radar-shell"><Sidebar topics={topics} page={page} onNavigate={navigate} online={online} latestBrief={latestBrief} sources={sources} status={status} range={page === 'report' ? 'report' : range} onCollect={collect} busy={busy} loading={loading} onNewTopic={() => setDialog({ topic: null })} onStartJob={() => startJob('refresh')} unreadCount={(operations?.notifications || []).filter(item => !item.read).length} operationsReady={Boolean(operations)}/><main className="workspace radar-workspace" id="main-content">
    <header className={`page-header radar-page-header ${radarPage ? 'radar-primary-page' : ''}`}><div><h1>{pageTitle}</h1><p>{currentTopic ? '中文精简阅读，同一条内容只归入一个主要方向。' : PAGE_DESCRIPTIONS[page]}</p></div><nav className="radar-tabs" aria-label="雷达视图"><button type="button" className={page === 'report' ? 'selected' : ''} aria-pressed={page === 'report'} onClick={() => navigate('report')}>今日机会</button><button type="button" className={page === 'hot' ? 'selected' : ''} aria-pressed={page === 'hot'} onClick={() => navigate('hot')}>X 原帖</button></nav></header>
    {loadedBuild && data.uiBuild && loadedBuild !== data.uiBuild && <div className="active-job-banner" role="status"><p>网站有新版本，更新页面后即可使用。已编辑草稿保存在本机浏览器。</p><button type="button" className="button" onClick={()=>window.location.reload()}>更新页面</button></div>}
    {error && <div className="error-banner" role="alert"><Icon name="info" size={19}/><span>{error}</span><button type="button" className="text-button" onClick={() => refresh()}>重新连接</button><button type="button" className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><Icon name="close" size={16}/></button></div>}
    {operations?.activeJob && <div className="active-job-banner" role="status"><span className="spinner small"/><div><strong>{jobLabel(operations.activeJob)}</strong><span>{jobStage(operations.activeJob)}</span></div><button type="button" className="text-button" onClick={() => navigate('operations')}>查看进度</button></div>}
    {operationsError && page !== 'operations' && <div className="operations-error-note" role="alert"><span>{operationsError}</span><button type="button" className="text-button" onClick={refreshOperations}>重试</button></div>}
    {(page==='report'||feedPage) && <RecommendationSettings settings={operations?.settings?.editorial} busy={busy} onSaved={settings=>setOperations(value=>({...value,settings}))}/>}
    {feedPage && lastRun && <div className="radar-run-status">最近{lastFinishedRun?.kind === 'aisa-import' ? '导入' : '采集'}新增 {lastRun.inserted} 条<span>·</span>{formatDate(lastRun.finishedAt)}{lastRun.failures > 0 && <button type="button" className="text-button has-failure" onClick={() => navigate('sources')}>{lastRun.failures} 个来源失败</button>}</div>}
    {feedPage && <><div className="feed-toolbar"><label className="search-field"><Icon name="search" size={20}/><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索中文解读、原文或来源" aria-label="搜索标题、摘要或来源"/>{query && <button type="button" className="icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><Icon name="close" size={16}/></button>}</label>{page === 'all' && <div className="view-toggle" aria-label="信息布局"><button type="button" className={layout === 'list' ? 'selected' : ''} onClick={() => setLayout('list')} aria-pressed={layout === 'list'} aria-label="列表布局"><Icon name="list" size={18}/>列表</button><button type="button" className={layout === 'columns' ? 'selected' : ''} onClick={() => setLayout('columns')} aria-pressed={layout === 'columns'} aria-label="多栏布局"><Icon name="columns" size={17} filled/>多栏</button></div>}</div>
    <div className="feed-filters"><div className="range-filter" aria-label="时间范围">{RANGES.map(([value, label]) => <button type="button" key={value} className={range === value ? 'selected' : ''} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>)}</div><label className="source-filter"><span>来源</span><select aria-label="筛选来源" value={source} onChange={event => { setSource(event.target.value); if (event.target.value === 'arxiv') setIncludePapers(true); }}><option value="all">全部来源</option>{sources.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label className="paper-filter"><input type="checkbox" checked={includePapers} onChange={event => setIncludePapers(event.target.checked)}/>包含论文</label></div>
    <div className="collection-status" aria-live="polite"><span>{visibleItems.length} 条符合条件<span className="metadata-divider">·</span>{page === 'starred' && range === 'all' ? '收藏不受默认日期限制' : range === 'all' ? '含历史内容，未来日期单独标注' : '无发布时间时按首次发现筛选'}{!includePapers && ' · 已隐藏论文'}</span><button type="button" className={`text-button ${failures ? 'has-failure' : ''}`} onClick={() => navigate('sources')}>{failures ? `${failures} 个来源采集异常` : '查看来源'}<Icon name="chevron" size={15}/></button></div></>}
    {feedPage && <div className="translation-toolbar"><span>中文优先 · 近 7 天相关外文自动整理，历史内容可逐条翻译。</span><button type="button" className="button" disabled={busy||!online||!operations?.capabilities?.codexAuthenticated} onClick={()=>translate().catch(err=>setError('中文整理提交未确认：'+err.message))}>补齐近期中文</button></div>}
    {feedPage && status.totalItems > items.length && <p className="coverage-note">本机共 {status.totalItems.toLocaleString()} 条，当前加载最近 {(status.returnedItemsLimit || items.length).toLocaleString()} 条及全部收藏；搜索覆盖已加载内容。</p>}
    {loading ? <div className="loading-state" role="status"><span className="spinner"/>正在连接本地工作台…</div> : !online && items.length === 0 && topics.length === 0 ? <div className="offline-panel"><EmptyState icon="source" title="本地服务暂时不可用" description="确认服务已启动后，重新连接即可继续。"/><button type="button" className="button" onClick={() => { setLoading(true); refresh(); }}>重新连接</button></div> : page === 'sources' ? <SourcePanel sources={sources} status={status} onRefresh={() => refresh({ afterMutation: true })} operations={operations} operationsError={operationsError} onSettingsSaved={settings => setOperations(value => ({ ...value, settings }))} onOperationsRefresh={() => refreshOperations({ afterMutation: true })} onOpenOperations={() => navigate('operations')} onJobStarted={jobStarted} focusX={focusX}/> : page === 'operations' ? <OperationsPanel operations={operations} loading={operationsLoading} error={operationsError} onRefresh={() => refreshOperations({ afterMutation: true })} onStartJob={startJob} starting={starting || (status.running && !operations?.activeJob ? 'collecting' : '')} browserEnabled={browserEnabled} onBrowserToggle={toggleBrowserNotifications}/> : page === 'report' ? <ReportPanel operations={operations} onDraftStarted={draftStarted} lastCollectedAt={status.lastCollectedAt} latestBrief={latestBrief} items={enrichedItems} onStar={star} pendingStars={pendingStars} onError={setError}/> : page === 'hot' ? <HotBoard translations={data.translationByUrl} onTranslate={busy ? undefined : translate} pendingTranslations={pendingTranslations} translationErrors={translationErrors} range={range} onRangeChange={setRange} items={enrichedItems} onOpenSources={openXSettings} onStar={star} pendingStars={pendingStars}/> : <FeedBoard translations={data.translationByUrl} onTranslate={busy ? undefined : translate} pendingTranslations={pendingTranslations} translationErrors={translationErrors} key={filterKey} items={visibleItems} topics={topics} layout={layout} currentTopic={currentTopic} page={page} query={query} onEditTopic={topic => setDialog({ topic })} onStar={star} pendingStars={pendingStars} connectionNotice={null}/>}
    {toast && <div className="toast" role="status"><Icon name="check" size={17}/>{toast}</div>}
  </main>{dialog && <TopicDialog topic={dialog.topic} onClose={() => setDialog(null)} onSave={saveTopic}/>}</div>;
}
