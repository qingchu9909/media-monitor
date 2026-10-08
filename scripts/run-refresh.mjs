#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE_URL = 'http://127.0.0.1:4318';
const MAX_WAIT_MS = 10 * 60 * 1000;
const TERMINAL = new Set(['success', 'partial', 'failed', 'cancelled', 'interrupted']);
const ACTIVE = new Set(['queued', 'running']);
const text = value => typeof value === 'string' ? value.slice(0, 1200) : '';

class RefreshError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Dependencies are injectable for offline tests. The CLI always uses the fixed local service.
export async function runRefresh({ fetchImpl = globalThis.fetch, now = () => performance.now(), sleep = delay, timeoutMs = MAX_WAIT_MS, pollMs = 3000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_WAIT_MS || !Number.isFinite(pollMs) || pollMs <= 0) {
    return { status: 'configuration_error', message: '等待时间必须在 10 分钟以内，轮询间隔必须大于 0。', shouldNotify: true };
  }
  const started = now();
  const deadline = started + timeoutMs;
  let job = null;
  let adopted = false;
  let postAttempted = false;
  let latestOperations = null;
  let baseline = new Set();
  const elapsedMs = () => Math.max(0, Math.round(now() - started));
  async function request(path, options = {}) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new RefreshError('timeout', '等待已达到 10 分钟。任务可能仍在本机运行；请查看“运行与通知”，不要重复启动更新。');
    let response;
    try {
      response = await fetchImpl(BASE_URL + path, {
        ...options, redirect: 'error', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(15000, remaining)))),
      });
    } catch {
      if (now() >= deadline) throw new RefreshError('timeout', '等待超过时限，未重复提交任务。服务中的任务可能继续运行，请查看“运行与通知”。');
      throw new RefreshError(postAttempted ? 'unconfirmed' : 'unavailable', postAttempted ? '本地服务响应未确认，未重复提交任务。请查看“运行与通知”确认执行结果。' : '无法连接本地服务 http://127.0.0.1:4318，请先启动服务。');
    }
    let body;
    try { body = await response.json(); } catch { throw new RefreshError('unconfirmed', '本地服务没有返回有效 JSON，未重复提交任务。'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RefreshError('unconfirmed', '本地服务返回格式异常，未重复提交任务。');
    return { response, body };
  }
  async function operations() {
    const { response, body } = await request('/api/operations');
    if (!response.ok) throw new RefreshError(postAttempted ? 'unconfirmed' : 'unavailable', text(body.error) || `读取运行状态失败（HTTP ${response.status}）。`);
    if (!Array.isArray(body.jobs) || !Array.isArray(body.notifications)) throw new RefreshError('unconfirmed', '运行状态缺少任务或通知列表，不能确认结果。');
    latestOperations = body;
    return body;
  }
  const newNotifications = () => (latestOperations?.notifications || [])
    .filter(item => item.jobId === job?.id && !baseline.has(item.id))
    .map(item => ({ id: item.id, level: item.level, title: text(item.title), message: text(item.message) }));
  try {
    const before = await operations();
    baseline = new Set(before.notifications.map(item => item.id));
    postAttempted = true;
    const submitted = await request('/api/jobs', { method: 'POST', body: JSON.stringify({ kind: 'refresh' }) });
    if (submitted.response.status === 409) {
      const existing = await operations();
      if (existing.activeJob?.kind !== 'refresh' || !ACTIVE.has(existing.activeJob?.status)) throw new RefreshError('busy', '本地服务正忙，当前没有可跟随的 refresh 任务。没有重试 POST，也没有接管 X 或仅分析任务。');
      job = existing.activeJob;
      adopted = true;
    } else {
      if (!submitted.response.ok) throw new RefreshError('failed', text(submitted.body.error) || `更新任务未启动（HTTP ${submitted.response.status}）。`);
      job = submitted.body;
    }
    if (!job?.id || job.kind !== 'refresh' || (!ACTIVE.has(job.status) && !TERMINAL.has(job.status))) throw new RefreshError('unconfirmed', '服务没有返回可识别的 refresh 任务，未重复提交。');
    while (true) {
      const snapshot = await operations();
      const current = snapshot.jobs.find(item => item.id === job.id) || (snapshot.activeJob?.id === job.id ? snapshot.activeJob : null);
      if (!current || current.kind !== 'refresh') throw new RefreshError('unconfirmed', '运行记录中找不到本次 refresh 任务，不能确认完成；未重复提交。');
      job = current;
      if (TERMINAL.has(job.status)) break;
      if (!ACTIVE.has(job.status)) throw new RefreshError('unconfirmed', '任务返回未知状态，不能确认完成。');
      const remaining = deadline - now();
      if (remaining <= 0) throw new RefreshError('timeout', '等待超过时限，任务可能仍在运行。请查看“运行与通知”；脚本不会重试 POST 或取消现有任务。');
      await sleep(Math.min(pollMs, remaining));
    }
    const notifications = newNotifications();
    const analysis = job.result?.analysis;
    let briefDate = analysis?.date || null;
    let selectedCount = Array.isArray(analysis?.highlights) ? analysis.highlights.length : null;
    let briefLookupError = null;
    try {
      const listing = await request('/api/briefs');
      if (!listing.response.ok) throw new Error();
      if (!briefDate) briefDate = listing.body.latest?.date || null;
      if (selectedCount === null) selectedCount = listing.body.latest?.highlightCount ?? null;
    } catch { briefLookupError = '任务终态已确认，但未能读取当前简报信息。'; }
    const accountedNotifications = Array.isArray(job.result?.warnings) && Number.isInteger(job.result?.notificationCount);
    return {
      status: job.status, jobId: job.id, adoptedExistingRefresh: adopted, stage: job.stage,
      message: text(job.message), error: text(job.error) || null, elapsedMs: elapsedMs(),
      briefDate, selectedCount, briefUpdated: analysis?.published === true,
      newNotificationCount: notifications.length, newNotifications: notifications,
      shouldNotify: notifications.length > 0 || Boolean(briefLookupError) || (accountedNotifications ? job.result.notificationCount > 0 : job.status !== 'success'),
      ...(briefLookupError ? { briefLookupError } : {}),
    };
  } catch (error) {
    const notifications = newNotifications();
    return {
      status: error instanceof RefreshError ? error.status : 'unconfirmed', jobId: job?.id || null,
      adoptedExistingRefresh: adopted, stage: job?.stage || null, elapsedMs: elapsedMs(),
      message: error instanceof RefreshError ? error.message : '无法确认任务结果，未重复提交；请查看本地运行记录。',
      taskMayStillBeRunning: postAttempted && !TERMINAL.has(job?.status),
      newNotificationCount: notifications.length, newNotifications: notifications, shouldNotify: true,
    };
  }
}

export function refreshExitCode(result) { return result.status === 'success' && !result.briefLookupError ? 0 : 1; }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 2) {
    console.log(JSON.stringify({ status: 'configuration_error', message: '用法：node scripts/run-refresh.mjs（固定访问本机 4318 端口，最长等待 10 分钟）', shouldNotify: true }));
    process.exitCode = 1;
  } else {
    const result = await runRefresh();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = refreshExitCode(result);
  }
}
