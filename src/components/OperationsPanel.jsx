import React, { useState } from 'react';
import Icon from './Icon.jsx';
import { api, formatDate } from '../utils.js';

const STATUS = { queued: ['等待运行', 'pending'], running: ['正在运行', 'pending'], success: ['成功', 'success'], partial: ['部分成功', 'pending'], failed: ['失败', 'error'], cancelled: ['已取消', 'muted'], interrupted: ['运行中断', 'error'] };
const KINDS = { draft: '完善中文草稿', translation: '翻译为中文', refresh: '更新并生成选题', analysis: '生成中文选题', x: 'X 单次采集' };
const STAGES = { drafting: 'Codex 正在完善草稿', translating: 'Codex 正在翻译标题与摘要', queued: '等待执行', verifying: '核验原文证据', quoting_x: '查询 X 采集报价', collecting_x: '采集 X 数据', collecting: '采集来源', rss: '采集免费 RSS', x: '采集 X 数据', analyzing: '生成中文选题', analysis: '生成中文选题', completed: '已完成', complete: '已完成', done: '已完成', failed: '执行失败', cancelled: '任务已取消', interrupted: '服务重启后中断', starting: '准备运行', importing: '整理采集结果', saving: '保存选题', notifying: '生成通知' };
export function jobLabel(job) { return KINDS[job?.kind] || '更新任务'; }
export function jobStage(job) { return STAGES[job?.stage] || job?.stage || '等待执行'; }

export default function OperationsPanel({ operations, loading, error, onRefresh, onStartJob, starting, browserEnabled, onBrowserToggle }) {
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const jobs = operations?.jobs || [];
  const notifications = operations?.notifications || [];
  const unread = notifications.filter(item => !item.read);
  const shown = onlyUnread ? unread : notifications;
  const active = operations?.activeJob;
  const capabilities = operations?.capabilities;
  const browserAvailable = typeof Notification !== 'undefined';
  const permission = browserAvailable ? Notification.permission : 'unsupported';
  async function action(key, path, body, success) {
    if (busy) return;
    setBusy(key); setActionError(''); setNotice('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      await onRefresh(); setNotice(success);
    } catch (err) { setActionError(err.message); }
    finally { setBusy(''); }
  }
  return <div className="operations-panel">
    <section className="connection-panel">
      <div className="connection-title"><div><h2>更新、分析和通知，在这里看进度</h2><p>任务的结果会保存在本机。失败原因和未完成的环节会单独列出。</p></div><button type="button" className="button" onClick={onRefresh} disabled={loading}>刷新状态</button></div>
      <div className="operations-summary">
        <div><span>当前任务</span><strong>{active ? jobLabel(active) : '空闲'}</strong><p>{active ? jobStage(active) : '可以开始新的一次更新'}</p></div>
        <div><span>本地 Codex</span><strong>{!capabilities ? '读取状态中' : !capabilities.codexInstalled ? '未安装' : capabilities.codexAuthenticated ? '已登录' : '需要登录'}</strong><p>用于中文翻译与选题，使用 Codex 可用额度</p></div>
        <div><span>每日检查</span><strong>{operations?.schedule?.mode === 'codex' ? `每天 ${String(operations.schedule.hour ?? 8).padStart(2, '0')}:00` : '等待读取调度状态'}</strong><p>北京时间 · 由既有 Codex 每日任务运行</p></div>
      </div>
      <p className="connection-note">本机需要开机并保持唤醒。日常更新使用免费来源和已登录 Codex，翻译、选题与草稿均不依赖 AIsa。X 付费采集只保留单次报价入口，不会随更新自动执行。</p>
      <div className="panel-actions"><button type="button" className="button primary" disabled={Boolean(active) || Boolean(starting) || !operations} onClick={() => onStartJob('refresh')}>{starting === 'refresh' ? '正在提交…' : '更新并生成选题'}</button><button type="button" className="button" disabled={Boolean(active) || Boolean(starting) || !capabilities?.codexAuthenticated} onClick={() => onStartJob('analysis')}>{starting === 'analysis' ? '正在提交…' : '仅分析已采集内容'}</button></div>
      {(error || actionError) && <p className="form-error" role="alert">{actionError || error}</p>}{notice && <p className="operation-feedback" role="status">{notice}</p>}
    </section>
    <section className="source-list" aria-label="运行记录"><div className="panel-heading"><h2>运行记录</h2><p>{active ? '正在运行时每 3 秒更新' : '页面开启时每 15 秒更新'} · 取消后已入库内容会保留</p></div>
      {!jobs.length && <p className="panel-message">{loading ? '正在读取运行记录…' : '还没有从网页启动的任务。点击“更新并生成选题”开始。'}</p>}
      {jobs.map(job => {
        const [label, tone] = STATUS[job.status] || ['状态未知', 'muted'];
        return <article className="job-row" key={job.id}><div className="job-main"><div className="source-title"><h3>{jobLabel(job)}</h3><span className={`status-label ${tone}`}><span className="status-dot"/>{label}</span></div><p className="job-stage">{jobStage(job)}</p>{job.message && <p>{job.message}</p>}{job.result?.x && <p className="job-cost">X 数据：{Number.isFinite(job.result.x.total) ? `${job.result.x.total} 条，新增 ${job.result.x.inserted ?? 0} 条` : '结果未确认'} · {job.result.x.chargeStatus === 'reported' && Number.isFinite(job.result.x.chargedUsd) ? `实际费用 $${job.result.x.chargedUsd}` : job.result.x.requestStarted === false || job.result.x.chargeStatus === 'not-started' ? '尚未发起付费请求' : '实际扣费未知，请核对 AIsa 账单'}{job.result.x.hasNextPage && ' · 供应商还有下一页，本次未翻页'}{job.result.x.attemptId && <small>请求编号：{job.result.x.attemptId}</small>}</p>}<p className="job-time">开始 {formatDate(job.createdAt)}{job.finishedAt ? ` · 结束 ${formatDate(job.finishedAt)}` : ''}</p>{job.error && <p className="source-error" role="status">{job.error}</p>}</div>{['queued', 'running'].includes(job.status) && <button type="button" className="button subtle" disabled={Boolean(busy)} onClick={() => action(`cancel:${job.id}`, `/api/jobs/${encodeURIComponent(job.id)}/cancel`, {}, '已提交取消。正在执行的环节会停止，请查看最终状态。')}>{busy === `cancel:${job.id}` ? '正在取消…' : '取消任务'}</button>}</article>;
      })}
    </section>
    <section className="source-list" aria-label="站内通知">
      <div className="panel-heading panel-heading-actions"><div><h2>站内通知 <span className="count-pill">{unread.length} 条未读</span></h2><p>有值得关注的新内容、故障或需要处理的事项时提醒。</p></div><button type="button" className="button" disabled={!unread.length || Boolean(busy)} onClick={() => action('read-all', '/api/notifications/read', { ids: unread.map(item => item.id) }, '所有通知已标记为已读。')}>全部已读</button></div>
      <div className="notification-options"><label className="checkbox-label"><input type="checkbox" checked={onlyUnread} onChange={event => setOnlyUnread(event.target.checked)}/><span>只看未读</span></label><button type="button" className="text-button" disabled={!browserAvailable} onClick={onBrowserToggle}>{!browserAvailable ? '浏览器不支持系统通知' : browserEnabled ? '关闭浏览器通知' : permission === 'denied' ? '查看通知权限说明' : '开启浏览器通知'}</button><p>{browserEnabled ? '已开启：页面保持打开时，新的站内通知可显示为浏览器通知。' : '浏览器通知需要你点击授权；关闭页面后不承诺后台推送。'}每日 Codex 提醒由 Codex 处理，外部手机推送渠道尚未配置。</p></div>
      {!shown.length && <p className="panel-message">{onlyUnread ? '没有未读通知。' : '暂无通知。任务运行后，有需要关注的结果会显示在这里。'}</p>}
      {shown.map(item => <article key={item.id} className={`notification-row ${item.read ? 'is-read' : 'is-unread'}`}><Icon name={item.level === 'error' ? 'info' : 'check'} size={20}/><div><h3>{item.title}</h3><p>{item.message}</p><time>{formatDate(item.createdAt)}</time></div>{!item.read && <button type="button" className="text-button" aria-label={`标记已读：${item.title}`} disabled={Boolean(busy)} onClick={() => action(`read:${item.id}`, '/api/notifications/read', { ids: [item.id] }, '通知已读。')}>标为已读</button>}</article>)}
    </section>
  </div>;
}
