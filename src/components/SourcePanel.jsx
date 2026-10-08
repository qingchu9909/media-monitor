import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import SourceDialog from './SourceDialog.jsx';
import { api, formatDate, safeUrl } from '../utils.js';

function sourceStatus(source, status) {
  if (source.archived) return ['已归档', 'muted'];
  if (source.kind === 'web-research') {
    if (source.error || ['error','failed'].includes(source.status)) return ['网页补充需检查','error'];
    return source.lastRun ? ['已入库 · 逐条看证据','success'] : ['等待搜索补充','muted'];
  }
  if (source.kind === 'web') {
    if (source.error || ['error', 'failed'].includes(source.status)) return ['核验失败', 'error'];
    return source.status === 'ok' && source.lastRun ? ['已核验入库', 'success'] : ['等待核验', 'muted'];
  }
  if (source.kind === 'aisa') {
    if (source.error || ['error', 'failed'].includes(source.status)) return ['最近采集 / 导入失败', 'error'];
    if (source.status === 'ok' && source.lastRun) return ['已有入库结果', 'success'];
    return [source.id === 'aisa-x' ? (status.aisaConnected ? '未采集 · 可选' : '未连接 · 可选') : '未配置 · 可选', 'muted'];
  }
  if (!source.enabled) return ['已暂停', 'muted'];
  if (source.status === 'running') return ['采集中', 'pending'];
  if (source.error || ['error', 'failed'].includes(source.status)) return ['采集失败', 'error'];
  if (['ok', 'success', 'healthy'].includes(source.status)) return [source.itemCount === 0 ? '成功 · 返回 0 条' : '采集正常', 'success'];
  return ['等待采集', 'muted'];
}
const tokens = value => [...new Set(value.split(/[,，;；\n]+/).map(item => item.trim()).filter(Boolean))];
const defaultX = { handles: [], keywords: [], enabled: false, maxEstimatedUsd: 0.02, maxDailyCalls: 1, acceptUncappedEstimate: false };

export function AisaNotice({ connected, onOpen }) {
  return <div className={`aisa-notice ${connected ? 'connected' : ''}`}><Icon name={connected ? 'check' : 'info'} size={24}/><div><strong>免费来源 + Codex，整理成中文选题</strong><p>公开订阅免费采集，外文内容由 Codex 翻译和整理。AIsa 是可选扩展，不影响这条免费采集流程。</p></div><button type="button" className="text-button" onClick={onOpen}>管理来源<Icon name="chevron" size={17}/></button></div>;
}

function XSettings({ status, settings, onRefresh, onOperationsRefresh, activeJob, onJobStarted, focusX, sourceBusy, settingsError, onSettingsSaved }) {
  const [form, setForm] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [quotation, setQuotation] = useState(null);
  const [accepted, setAccepted] = useState(false);
  const [quoteExpired, setQuoteExpired] = useState(false);
  const blocked = Boolean(activeJob || sourceBusy);
  useEffect(() => {
    if (!quotation) { setQuoteExpired(false); return; }
    const remaining = Date.parse(quotation.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) { setQuoteExpired(true); return; }
    setQuoteExpired(false);
    const timeout = setTimeout(() => setQuoteExpired(true), remaining);
    return () => clearTimeout(timeout);
  }, [quotation]);
  useEffect(() => {
    if (!settings || dirty) return;
    const next = { ...defaultX, ...settings };
    setForm({ ...next, handles: next.handles.join(', '), keywords: next.keywords.join('，') });
  }, [settings, dirty]);
  useEffect(() => { if (focusX) document.getElementById('x-configuration')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [focusX]);
  function change(key, value) { setForm(current => ({ ...current, [key]: value })); setDirty(true); setQuotation(null); setAccepted(false); setNotice(null); }
  async function run(key, execute) {
    if (busy) return;
    setBusy(key); setNotice(null);
    try { await execute(); }
    catch (err) { setNotice({ good: false, text: err.message }); }
    finally { setBusy(''); }
  }
  async function save(event) {
    event.preventDefault();
    await run('save', async () => {
      const handles = tokens(form.handles).map(value => value.replace(/^@/, ''));
      const keywords = tokens(form.keywords);
      if (!handles.length || handles.length > 20) throw new Error('请填写 1–20 个 X 账号。');
      if (keywords.length > 10) throw new Error('最多填写 10 个 X 搜索关键词。');
      if (handles.some(value => !/^[A-Za-z0-9_]{1,15}$/.test(value))) throw new Error('X 账号只填写 @ 后的用户名，用逗号分隔。');
      const saved = await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ x: { ...form, enabled: false, acceptUncappedEstimate: false, handles, keywords, maxEstimatedUsd: Number(form.maxEstimatedUsd), maxDailyCalls: Number(form.maxDailyCalls) } }) });
      onSettingsSaved(saved);
      await onOperationsRefresh();
      setDirty(false); setQuotation(null); setAccepted(false);
      setNotice({ good: true, text: '单次采集设置已保存。日常更新不调用 AIsa；每次付费请求仍须单独确认报价。' });
    });
  }
  const expired = Boolean(quotation && (quoteExpired || Date.parse(quotation.expiresAt) <= Date.now()));
  return <section className="connection-panel x-configuration" id="x-configuration" aria-label="X 采集配置">
    <div className="connection-title"><div><h2>X 热帖：关注账号与关键词</h2><p>AIsa 读取真实帖子、作者和互动数，Codex 整理中文选题。当前这条链路无需登录本地 Grok。</p></div><span className={`status-label ${status.aisaConnected ? 'success' : 'pending'}`}><span className="status-dot"/>{status.aisaConnected ? '连接已验证' : '等待连接验证'}</span></div>
    <div className="panel-actions connection-actions"><button type="button" className="button" disabled={Boolean(busy) || blocked} onClick={() => run('verify', async () => {
      const result = await api('/api/aisa/verify', { method: 'POST', body: '{}', signal: AbortSignal.timeout(30000) });
      setNotice({ good: result.connected, text: result.message || (result.connected ? '账号连接验证成功。' : '请先完成 AIsa 登录。') }); await onRefresh();
    })}>{busy === 'verify' ? '正在验证…' : '检查 AIsa 连接'}</button><a className="text-button inline-link" href="https://console.aisa.one/" target="_blank" rel="noopener noreferrer">AIsa 控制台<Icon name="external" size={14}/></a></div>
    <p className="connection-note">连接验证不代表已采集。AIsa 接口单独计费，本页不会自动充值或购买订阅；可在控制台查看实际余额。榜单按本地采集到的真实互动排序，范围由下面的账号和关键词决定，不是 X 全站官方热榜。</p>
    {!form ? <div className="panel-message"><p>{settingsError ? "X 设置尚未读取，请重新获取本地状态。" : "正在读取 X 设置…"}</p>{settingsError && <button type="button" className="text-button" onClick={onOperationsRefresh}>重新读取 X 设置</button>}</div> : <form className="x-settings-form" onSubmit={save}>
      <div className="settings-grid"><label htmlFor="x-handles">关注账号<input disabled={Boolean(busy) || blocked} id="x-handles" value={form.handles} onChange={event => change('handles', event.target.value)} maxLength={1000} placeholder="OpenAI, AnthropicAI, GoogleDeepMind"/><span className="field-help">填写 1–20 个用户名，逗号分隔；可带 @。</span></label><label htmlFor="x-keywords">关注关键词<input disabled={Boolean(busy) || blocked} id="x-keywords" value={form.keywords} onChange={event => change('keywords', event.target.value)} maxLength={2000} placeholder="AI 视频，AI agent"/><span className="field-help">可选，最多 10 个；进一步筛选这些账号发布的内容。</span></label></div>
      <fieldset className="paid-settings"><legend>X 单次采集设置</legend><p className="field-help">日常更新不执行付费接口；以下仅设置单次报价范围。</p>
        <div className="settings-grid compact"><label htmlFor="x-estimate">单次估价筛选线（美元）<input disabled={Boolean(busy) || blocked} id="x-estimate" type="number" min="0.000001" max="5" step="0.000001" value={form.maxEstimatedUsd} required onChange={event => change('maxEstimatedUsd', event.target.value)}/><span className="field-help">估价超过此数值则跳过；不是实际扣费硬上限。</span></label><label htmlFor="x-daily">每天最多付费请求数<input disabled={Boolean(busy) || blocked} id="x-daily" type="number" min="1" max="24" step="1" value={form.maxDailyCalls} required onChange={event => change('maxDailyCalls', event.target.value)}/><span className="field-help">每次只请求一页，不自动翻页或重试付费请求。</span></label></div>
      </fieldset>
      <div className="panel-actions"><button type="submit" className="button primary" disabled={Boolean(busy) || blocked || !dirty}>{busy === 'save' ? '正在保存…' : '保存 X 设置'}</button><span className="settings-save-state">{dirty ? '有未保存的设置，请先保存再报价' : '每次需单独确认报价'}</span></div>
    </form>}
    <div className="single-x-action"><h3>先采集一次</h3><p className="connection-note">先取得当前范围的报价，确认费用后才执行。单次采集同样遵循估价筛选线与每日请求数，不会自动开启每日付费。</p><button type="button" className="button" disabled={Boolean(busy) || dirty || !form || !status.aisaConnected || blocked} onClick={() => run('quote', async () => {
      setQuotation(null); setAccepted(false);
      const result = await api('/api/x/quote', { method: 'POST', body: '{}', signal: AbortSignal.timeout(90000) });
      setQuotation(result); setNotice({ good: true, text: '已取得报价，尚未执行付费采集。' });
    })}>{busy === 'quote' ? '正在查询报价…' : '获取 X 单次报价'}</button>
    {quotation && <div className="x-quote-box"><div className="source-title"><h3>本次预计 ${Number(quotation.estimatedUsd).toFixed(6)} 美元</h3><span className={`status-label ${expired ? 'error' : 'pending'}`}>{expired ? '报价已过期' : '尚未执行'}</span></div><p>一次搜索、最多一页。实际费用可能超过估价，未提供费用硬上限。</p><p>报价有效至 {formatDate(quotation.expiresAt)}；执行成功后查看 X 热帖榜。</p><dl className="quote-scope"><div><dt>账号</dt><dd>{quotation.handles?.length ? quotation.handles.map(value => `@${value}`).join('、') : '未限制账号'}</dd></div><div><dt>关键词</dt><dd>{quotation.keywords?.join('、') || '未设置关键词'}</dd></div></dl><details><summary>查看查询范围与官方报价</summary><p className="query-preview">{quotation.query}</p><pre>{JSON.stringify(quotation.quote, null, 2)}</pre></details><label className="checkbox-label consent-label"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} disabled={expired || Boolean(busy)}/><span>我接受实际费用可能超过估价，确认按本次范围执行一次付费采集。</span></label><button type="button" className="button primary" disabled={!accepted || expired || Boolean(busy) || blocked} onClick={() => run('execute', async () => {
      const quoteId = quotation.id;
      setQuotation(null); setAccepted(false);
      setNotice({ good: true, text: '正在提交本次 X 请求…' });
      try {
        const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ kind: 'x', quoteId, acceptUncappedEstimate: true }) });
        onJobStarted?.(job); await onOperationsRefresh();
      } catch (err) {
        await onOperationsRefresh();
        throw new Error(`X 提交结果未确认：${err.message}。请先查看“运行与通知”和费用记录，确认前不要再次付费采集。`);
      }
    })}>{busy === 'execute' ? '正在提交…' : '确认费用并采集一次'}</button></div>}
    </div>
    {notice && <p className={`operation-feedback ${notice.good ? '' : 'is-error'}`} role={notice.good ? 'status' : 'alert'}>{notice.text}</p>}
    <details className="source-help-details"><summary>登录失效怎么办</summary><p>请让当前 Codex 任务发起 AIsa 官方登录，或在本项目终端运行 <code>npm run aisa -- login</code>。登录完成后再点“检查 AIsa 连接”。</p></details>
  </section>;
}

export default function SourcePanel({ sources, status, onRefresh, operations, onOperationsRefresh, onOpenOperations, onJobStarted, focusX, operationsError, onSettingsSaved }) {
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [catalogError, setCatalogError] = useState('');
  useEffect(() => {
    let cancelled = false;
    api('/api/source-catalog').then(result => { if (!cancelled) setCatalog(result.entries || []); }).catch(err => { if (!cancelled) setCatalogError(err.message); });
    return () => { cancelled = true; };
  }, []);
  const active = sources.filter(source => !source.archived);
  const rss = active.filter(source => source.kind === 'rss');
  const webs = active.filter(source => source.kind === 'web');
  const research = active.filter(source => source.kind === 'web-research');
  const aisa = active.filter(source => source.kind === 'aisa');
  const optionalAisa = aisa.filter(source => source.id !== 'aisa-x' && !source.enabled && !source.lastRun && !source.error && !['error', 'failed', 'running'].includes(source.status));
  const usedAisa = aisa.filter(source => !optionalAisa.includes(source) && (source.lastRun || source.error || ['error', 'failed', 'running'].includes(source.status)));
  const hasXFailure = aisa.some(source => source.id === 'aisa-x' && (source.error || ['error', 'failed'].includes(source.status)));
  const archived = sources.filter(source => source.archived);
  const collecting = Boolean(status.running || operations?.activeJob);
  async function mutate(key, path, method, body, message) {
    if (busy) return;
    setBusy(key); setNotice(null);
    try { const result = await api(path, { method, body: JSON.stringify(body) }); await onRefresh(); setNotice({ good: true, text: message }); return result; }
    catch (err) { setNotice({ good: false, text: err.message }); }
    finally { setBusy(''); }
  }
  async function saveSource(payload) {
    await api(dialog?.source ? `/api/sources/${encodeURIComponent(dialog.source.id)}` : '/api/sources', { method: dialog?.source ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    await onRefresh(); setNotice({ good: true, text: dialog?.source ? '来源已更新，下次采集使用新设置。' : '来源已添加。可以点“采集一次”验证实际内容。' });
  }
  function renderSource(source) {
    const [label, tone] = sourceStatus(source, status);
    const href = safeUrl(source.url);
    const canManage = source.kind === 'rss';
    return <article className="source-row managed-source-row" key={source.id}><span className="source-symbol"><Icon name="source"/></span><div className="source-details"><div className="source-title"><h3>{source.name}</h3><span className={`status-label ${tone}`}><span className="status-dot"/>{label}</span></div>
      {href && <a href={href} target="_blank" rel="noopener noreferrer">{new URL(href).hostname}<Icon name="external" size={12}/></a>}
      <p>{source.kind === 'web-research' ? '最近搜索导入' : source.kind === 'web' ? '最近核验' : source.kind === 'aisa' ? '最近采集 / 导入尝试' : '最近采集'}：{source.lastRun ? formatDate(source.lastRun) : '尚无记录'}{Number.isFinite(source.itemCount) && source.lastRun && ['ok', 'success', 'healthy'].includes(source.status) ? ` · 最近返回 ${source.itemCount} 条` : ''}</p>
      <p>{source.kind === 'web-research' ? 'Codex 主动搜索补充；页面证据与待核验线索逐条区分，不依赖 AIsa' : source.kind === 'web' ? '手工核验的公开网页记录，不会自动订阅后续更新' : source.kind === 'aisa' ? source.id === 'aisa-x' ? '通过上方账号与关键词配置采集，费用另计' : '可选数据扩展；自动采集尚未配置，不影响免费 RSS 与 Codex' : source.archived ? '已停止采集，历史内容和收藏保留；恢复后仍暂停，需点“启用”恢复采集' : '免费 RSS / Atom · 启用后加入每日采集'}</p>
      {source.error && <p className="source-error">{!source.enabled || source.archived ? '上次采集错误：' : ''}{source.error}</p>}
      {canManage && <div className="source-row-actions">{source.archived ? <button type="button" className="button subtle" disabled={Boolean(busy) || collecting} onClick={() => mutate(`restore:${source.id}`, `/api/sources/${encodeURIComponent(source.id)}/restore`, 'POST', {}, '来源已恢复，当前仍暂停；点“启用”可恢复采集。')}>恢复来源</button> : <>
        <button type="button" className="button subtle" disabled={Boolean(busy) || collecting || !source.enabled} onClick={() => mutate(`collect:${source.id}`, '/api/collect', 'POST', { sourceIds: [source.id] }, '已启动单源免费采集，完成后会更新来源状态。')}>{busy === `collect:${source.id}` ? '正在提交…' : '采集一次'}</button>
        <button type="button" className="text-button" disabled={Boolean(busy) || collecting} onClick={() => setDialog({ source })}>编辑</button><button type="button" className="text-button" disabled={Boolean(busy) || collecting} onClick={() => mutate(`toggle:${source.id}`, `/api/sources/${encodeURIComponent(source.id)}`, 'PATCH', { enabled: !source.enabled }, source.enabled ? '来源已暂停。' : '来源已启用。')}>{source.enabled ? '暂停' : '启用'}</button><button type="button" className="text-button archive-button" disabled={Boolean(busy) || collecting} onClick={() => mutate(`archive:${source.id}`, `/api/sources/${encodeURIComponent(source.id)}/archive`, 'POST', {}, '来源已归档，历史内容保留，可在下方恢复。')}>归档</button>
      </>}</div>}
    </div></article>;
  }
  return <div className="source-panel">
    <section className="connection-panel source-intro"><div className="connection-title"><div><h2>免费来源与 Codex，可以直接运行</h2><p>已启用的 RSS 自动采集，Codex 翻译外文并整理中文选题。未配置的可选接口不影响免费来源。</p></div><button type="button" className="button" onClick={onOpenOperations}>查看运行与通知</button></div><div className="source-status-guide"><span><i className="status-dot success-dot"/>正常：最近请求成功，可能没有新内容</span><span><i className="status-dot pending-dot"/>等待：尚未执行或尚未连接</span><span><i className="status-dot error-dot"/>失败：请看具体错误并重试</span><span>暂停 / 归档：停止后续采集，历史内容保留</span></div></section>
    {notice && <p className={`operation-feedback ${notice.good ? '' : 'is-error'}`} role={notice.good ? 'status' : 'alert'}>{notice.text}</p>}
    <section className="source-list" aria-label="自动采集的免费 RSS 来源"><div className="panel-heading panel-heading-actions"><div><h2>免费自动订阅 <span className="count-pill">{rss.length}</span></h2><p>支持公开 RSS、Atom 和 YouTube 频道订阅。</p></div><button type="button" className="button primary" onClick={() => setDialog({ source: null })} disabled={Boolean(busy) || collecting}><Icon name="plus" size={16}/>添加来源</button></div>{rss.length ? rss.map(renderSource) : <p className="panel-message">还没有自动订阅源。添加公开 RSS，或从下方免费来源目录开始。</p>}
      <details className="source-catalog"><summary>从免费来源目录添加</summary>{catalogError && <p className="form-error" role="alert">目录暂时无法加载：{catalogError}。仍可手动添加 RSS。</p>}<div className="catalog-grid">{catalog.map(entry => {
        const exists = sources.find(source => source.url === entry.url);
        return <article key={entry.id}><div><h3>{entry.name}</h3><p>{entry.description}</p><small>{({official:"官方",media:"媒体",community:"社区"})[entry.publisherType] || "公开来源"} · {entry.language === "zh" ? "中文" : "外文可译"}</small></div><button type="button" className="button subtle" disabled={Boolean(busy) || collecting || Boolean(exists)} aria-label={`添加免费来源：${entry.name}`} onClick={() => mutate(`catalog:${entry.id}`, '/api/sources', 'POST', { name: entry.name, url: entry.url, platform: entry.platform, kind: 'rss', enabled: entry.enabled !== false }, `已添加 ${entry.name}。采集一次可检查返回内容。`)}>{exists ? exists.archived ? '已归档，可在下方恢复' : '已添加' : busy === `catalog:${entry.id}` ? '添加中…' : '添加'}</button></article>;
      })}</div></details>
      <p className="source-platform-note">微信公众号、B 站、小红书等平台目前没有自动连接器。如已有合法公开 RSS，可通过“添加来源”接入；普通账号主页不等于可采集订阅源。</p>
    </section>
    <details className="source-list archived-sources" open={Boolean(focusX || operations?.settings?.x?.enabled || hasXFailure)}><summary>X 数据扩展（可选，单次另付费） · 日常更新不调用</summary><p className="source-platform-note">免费 RSS 与 Codex 不依赖 AIsa。每日和一键更新均不调用 X 付费接口；已保存的 X 帖子、译文和收藏保留。手动付费采集始终需要单独确认报价。</p><XSettings status={status} settings={operations?.settings?.x} onRefresh={onRefresh} onOperationsRefresh={onOperationsRefresh} activeJob={operations?.activeJob} onJobStarted={onJobStarted} focusX={focusX} sourceBusy={Boolean(status.running)} settingsError={operationsError} onSettingsSaved={onSettingsSaved}/></details>
    <section className="source-list" aria-label="Codex 主动搜索的网页"><div className="panel-heading"><h2>Codex 网页补充 <span className="count-pill">{research.length}</span></h2><p>每日 Codex 任务搜索官网、教程、发布记录与公开社区，补充没有 RSS 的内容。原文打不开或只取得搜索摘要时会保留为待核验线索。</p></div>{research.length ? research.map(renderSource) : <p className="panel-message">尚无本流程的导入记录。</p>}</section>
    <section className="source-list" aria-label="已核验公开网页"><div className="panel-heading"><h2>手工核验的公开网页 <span className="count-pill">{webs.length}</span></h2><p>保留已有事实核验记录。这些网页不是自动订阅源。</p></div>{webs.length ? webs.map(renderSource) : <p className="panel-message">暂无手工核验的公开网页。</p>}</section>
    {usedAisa.length > 0 && <section className="source-list" aria-label="已有 AIsa 采集记录"><div className="panel-heading"><h2>已有扩展来源的记录与问题</h2><p>保留真实采集记录。出现过的采集失败会在这里显示，需要单独处理。</p></div>{usedAisa.map(renderSource)}</section>}
    {optionalAisa.length > 0 && <details className="source-list archived-sources"><summary>可选扩展（未配置，不影响免费运行） · {optionalAisa.length} 项</summary><p className="source-platform-note">这些 AIsa 接口目前没有自动采集，不代表系统故障，也不表示已覆盖对应平台。YouTube 频道可用上方免费 RSS 添加；其他站点如提供公开 RSS，也可以直接接入。没有订阅或连接器的平台仍存在覆盖缺口。</p>{optionalAisa.map(renderSource)}</details>}
    <details className="source-list archived-sources"><summary>已归档来源（{archived.length}）</summary>{archived.length ? archived.map(renderSource) : <p className="panel-message">没有已归档来源。归档不会删除历史文章或收藏。</p>}</details>
    {dialog && <SourceDialog source={dialog.source} onSave={saveSource} onClose={() => setDialog(null)}/>}
  </div>;
}
