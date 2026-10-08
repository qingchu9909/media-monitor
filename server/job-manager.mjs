import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { InputError, plainText } from './store.mjs';
import { collect } from './collector.mjs';
import { readBriefCatalog } from './briefs.mjs';
import { renderReport } from './report.mjs';
import { generateBrief, atomicWrite } from './analysis.mjs';
import { openOperations } from './operation-store.mjs';
import { quoteX, executeX, countXAttempts } from './x-monitor.mjs';
import { codexCapabilities } from './codex-runner.mjs';
import { translateItems } from './translations.mjs';
import { generateDraft, validateDraftInput } from './drafts.mjs';
import { classifyContent } from '../src/content-selection.mjs';

export function createJobManager({ store, projectDir, collectorOptions = {}, analysisOptions = {}, xOptions = {}, translationOptions = {}, draftOptions = {}, translate = translateItems, capabilities = codexCapabilities }) {
  const ops = openOperations(store.dataDir);
  const controllers = new Map();
  const pending = new Map();
  let quoting = false, closing = false;
  const config = () => ({ ...xOptions, projectDir, dataDir: store.dataDir, settings: ops.settings().x });
  const cleanJob = job => {
    if (!job) return null;
    const { input, ownerPid, ownerToken, ...publicJob } = job;
    return publicJob;
  };
  const failedX = error => error.xAttempt ?? (error.attemptId ? {
    attemptId: error.attemptId, quoteId: error.quoteId, runId: error.runId,
    chargeStatus: 'unknown', chargedUsd: null, requestStarted: true,
  } : null);
  async function enforceDailyLimit() {
    if (await countXAttempts(store.dataDir) >= ops.settings().x.maxDailyCalls) throw new InputError('今天已达到设定的 X 请求次数限制，未执行新的付费调用', 429);
  }
  const translationStats = result => result && Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'results'));
  const translationPriority = items => items.filter(item => classifyContent(item, ops.settings().editorial).eligible).map(item => item.url);
  const translationProgress = translation => {
    if (!translation) return [];
    const notes = [];
    if (translation.remaining > 0) notes.push(translation.failed > 0
      ? '仍有 '+translation.remaining+' 条中文内容待整理（含失败与未处理条目）'
      : '仍有 '+translation.remaining+' 条中文内容待整理，已保留在队列，下次更新继续处理');
    else if (translation.status === 'partial' && !translation.failed) notes.push('部分中文内容尚未完成，已保存的结果保留');
    if (translation.missingSummary > 0) notes.push(translation.missingSummary+' 条来源未提供有效摘要，已保留标题与链接');
    return notes;
  };
  async function run(job, signal) {
    const result = { warnings: [], rss: null, x: null, analysis: null, translation: null, draft: null, notificationCount: 0 };
    const notify = notification => { result.notificationCount += ops.addNotification(notification); };
    const faultKey = (kind, message) => kind + ':' + createHash('sha256').update(JSON.stringify({
      kind: job.kind, message,
      sources: (result.rss?.results || []).filter(source => source.status === 'error').map(source => ({ id: source.sourceId, error: source.error })).sort((a,b) => a.id.localeCompare(b.id)),
      translation: [...new Set((result.translation?.failureReasons || []).map(failure => failure.reason))].sort(),
      // A newly authorized paid attempt must not hide a new uncertain charge.
      paidAttempt: result.x?.attemptId ?? null,
      sourceUrl: job.kind === 'draft' ? job.input.sourceUrl : null,
    })).digest('hex');
    const stage = (value, message) => {
      signal.throwIfAborted();
      ops.updateJob(job.id, { status: 'running', stage: value, message });
    };
    try {
      stage('starting', '正在准备任务');
      if (job.kind === 'draft') {
        result.draft = await generateDraft({ ...draftOptions, store, dataDir: store.dataDir, input: job.input, jobId: job.id, signal, onStage: stage });
        // A committed draft is retained even if cancellation arrives just after
        // the atomic save. It is still a suggestion; no editor text is changed.
        ops.updateJob(job.id, { status: 'success', stage: 'complete', message: '口播草稿已保存为待审阅建议，可预览后采用', result, finishedAt: new Date().toISOString() });
        return;
      }
      if (job.kind === 'translation') {
        stage('translating', 'Codex 正在整理中文标题和摘要');
        const allItems=store.listItems({limit:10000,includeStarred:true});
        const requested=job.input.itemIds ? allItems.filter(item=>job.input.itemIds.includes(item.id)) : allItems.filter(item=>item.topicIds?.length && !item.sourceIds?.includes('arxiv'));
        result.translation=translationStats(await translate({...translationOptions,items:requested,priorityUrls:translationPriority(requested),dataDir:store.dataDir,signal,mode:job.input.itemIds?'requested':'recent',onStage:stage}));
        signal.throwIfAborted();
        const failed=result.translation.failed > 0;
        const message=['本次中文整理结束：新增 '+result.translation.translated+' 条，复用 '+result.translation.cached+' 条',...(failed?[result.translation.failed+' 条翻译失败，可在条目上重试']:[]),...translationProgress(result.translation)].join('；');
        const status=failed ? (result.translation.translated || result.translation.cached ? 'partial' : 'failed') : result.translation.remaining > 0 || result.translation.status === 'partial' ? 'partial' : 'success';
        ops.updateJob(job.id,{status,stage:status==='failed'?'failed':'complete',message,result,finishedAt:new Date().toISOString()});
        return;
      }
      const catalog = await readBriefCatalog(store.dataDir);
      ops.rememberUrls(Object.keys(catalog.analysisByUrl));
      if (job.kind === 'refresh') {
        stage('collecting', '正在采集已启用的免费来源');
        result.rss = await collect(store, { ...collectorOptions, signal });
        signal.throwIfAborted();
        if (result.rss.status === 'failed') throw new InputError('免费来源采集失败，请查看来源错误；上一份简报保留', 502);
        if (result.rss.status === 'partial') result.warnings.push('部分免费来源采集失败，已保留成功来源的结果');
      }
      if (job.kind === 'x') {
        await enforceDailyLimit();
        stage('collecting_x', '正在执行已确认的 X 请求，不翻页、不自动重试');
        ops.updateJob(job.id, { result: { ...result, x: { quoteId: job.input.quoteId, chargeStatus: 'not-started', chargedUsd: null } } });
        result.x = await executeX({ ...config(), store, signal, quoteId: job.input.quoteId, acceptUncappedEstimate: job.input.acceptUncappedEstimate });
      }
      ops.updateJob(job.id, { result });
      signal.throwIfAborted();
      if (result.x?.inserted > 0) {
        notify({ key: 'x:' + result.x.attemptId, jobId: job.id, title: 'X 热帖已更新', message: '新增 ' + result.x.inserted + ' 条真实帖子；榜单按本次互动快照排序。' });
      }
      stage('translating', '正在补充近 7 天相关内容的中文摘要，已有译文直接复用');
      try {
        const relatedItems=store.listItems({limit:10000,includeStarred:true}).filter(item=>item.topicIds?.length && !item.sourceIds?.includes('arxiv'));
        result.translation=translationStats(await translate({...translationOptions,items:relatedItems,priorityUrls:translationPriority(relatedItems),dataDir:store.dataDir,signal,mode:'recent',onStage:stage}));
        if(result.translation.failed > 0) result.warnings.push(result.translation.failed+' 条中文翻译未完成，已保存的译文和原始资料保留');
      } catch(error) {
        if(error.translationResult) result.translation=translationStats(error.translationResult);
        signal.throwIfAborted();
        result.warnings.push('中文摘要整理未完成，原始资料已保留，可稍后补译');
      }
      ops.updateJob(job.id,{result});
      await mkdir(join(store.dataDir, 'reports'), { recursive: true });
      await atomicWrite(join(store.dataDir, 'reports', 'latest.md'), renderReport(store));
      result.analysis = await generateBrief({ ...analysisOptions, store, dataDir: store.dataDir, signal, onStage: stage, jobId: job.id, preferences: ops.settings().editorial });
      signal.throwIfAborted();
      const newUrls = ops.newUrls(result.analysis.newHighlights.map(item => item.url));
      if (newUrls.length) {
        notify({ key: 'brief:' + createHash('sha256').update(newUrls.join('\n')).digest('hex'), jobId: job.id, title: '有 ' + newUrls.length + ' 条新的内容机会', message: result.analysis.newHighlights.filter(item => newUrls.includes(item.url)).map(item => item.titleZh).join('；') });
        ops.rememberUrls(newUrls);
      }
      const status = result.warnings.length || result.translation?.remaining > 0 || result.translation?.status === 'partial' ? 'partial' : 'success';
      const message = [result.analysis.message,...result.warnings,...translationProgress(result.translation)].join('；');
      if (result.warnings.length) {
        const warning = result.warnings.join('；');
        notify({ key: faultKey('warning', warning), jobId: job.id, level: 'error', title: '更新完成，但有步骤未成功', message: warning });
      }
      ops.updateJob(job.id, { status, stage: 'complete', message, result, finishedAt: new Date().toISOString() });
    } catch (error) {
      result.x = failedX(error) ?? result.x;
      if(error.translationResult) result.translation=translationStats(error.translationResult);
      const cancelled = signal.aborted;
      const hasCollection = Boolean(Number.isFinite(result.x?.total) || result.rss?.status === 'success' || result.rss?.status === 'partial');
      const paidUncertain = result.x?.attemptId && result.x.requestStarted !== false && result.x.chargeStatus !== 'reported';
      const message = (cancelled ? '任务已取消，已保存的数据与简报保留；付费请求不会自动重试' : error instanceof InputError ? error.message : '任务处理失败，请查看来源状态后重新运行；上一份简报保留') + (paidUncertain ? '；X 请求可能已经计费，实际扣费未知，请先核对费用记录' : '');
      if (!cancelled) notify({ key: faultKey('error', message), jobId: job.id, level: 'error', title: hasCollection ? '采集已保存，后续步骤未完成' : '更新任务需要处理', message });
      ops.updateJob(job.id, { status: cancelled ? 'cancelled' : hasCollection ? 'partial' : 'failed', stage: cancelled ? 'cancelled' : 'failed', error: plainText(message, 1000), message, result, finishedAt: new Date().toISOString() });
    }
  }
  return {
    ops,
    activeJob: () => cleanJob(ops.activeJob()),
    async snapshot() {
      return { jobs: ops.jobs().map(cleanJob), activeJob: cleanJob(ops.activeJob()), settings: ops.settings(), notifications: ops.notifications(),
        capabilities: await capabilities(), schedule: { hour: 8, timeZone: 'Asia/Shanghai', mode: 'codex' } };
    },
    saveSettings(input) {
      if (ops.activeJob() || quoting) throw new InputError('任务或报价正在进行，请完成后再修改配置', 409);
      return ops.saveSettings(input);
    },
    async quote() {
      if (ops.activeJob() || quoting || store.isCollecting()) throw new InputError('已有任务、采集或报价正在进行', 409);
      quoting = true;
      try { return await quoteX(config()); } finally { quoting = false; }
    },
    start(input) {
      if (closing) throw new InputError('服务正在停止，请稍后再试', 503);
      if (!input || !['refresh', 'analysis', 'x', 'translation', 'draft'].includes(input.kind) || Object.keys(input).some(key => !['kind', 'quoteId', 'acceptUncappedEstimate', 'itemIds', 'briefDate', 'sourceUrl', 'draft'].includes(key))) throw new InputError('任务参数无效');
      if (input.kind === 'draft') input = validateDraftInput(input);
      else if (['briefDate', 'sourceUrl', 'draft'].some(key => key in input)) throw new InputError('只有草稿任务接受日期、来源和草稿内容');
      if (input.kind === 'x' && (typeof input.quoteId !== 'string' || input.acceptUncappedEstimate !== true)) throw new InputError('执行 X 前需要确认具体报价和可能超出估价的费用');
      if (input.kind !== 'x' && ('quoteId' in input || 'acceptUncappedEstimate' in input)) throw new InputError('此任务不接受 X 报价参数');
      if ('itemIds' in input) {
        if(input.kind!=='translation' || !Array.isArray(input.itemIds) || !input.itemIds.length || input.itemIds.length>60 || input.itemIds.some(id=>typeof id!=='string')) throw new InputError('翻译任务需要 1–60 个已入库条目 ID');
        const known=new Set(store.listItems({limit:10000,includeStarred:true}).map(item=>item.id));
        if(input.itemIds.some(id=>!known.has(id))) throw new InputError('部分翻译条目不存在或不在可读取范围',404);
        input={...input,itemIds:[...new Set(input.itemIds)]};
      }
      if (ops.activeJob() || store.isCollecting() || quoting) throw new InputError('已有任务正在运行，请等待完成或取消', 409);
      const job = ops.createJob(input.kind, input);
      const controller = new AbortController();
      controllers.set(job.id, controller);
      const promise = Promise.resolve().then(() => run(job, controller.signal)).finally(() => { controllers.delete(job.id); pending.delete(job.id); });
      pending.set(job.id, promise);
      return cleanJob(job);
    },
    cancel(id) {
      const job = ops.getJob(id);
      if (!job) throw new InputError('任务不存在', 404);
      const controller = controllers.get(id);
      if (controller) {
        ops.updateJob(id, { message: '正在取消任务，等待当前操作停止' });
        controller.abort();
      }
      return cleanJob(ops.getJob(id));
    },
    markRead: ids => ({ updated: ops.markRead(ids) }),
    async idle() { await Promise.allSettled([...pending.values()]); },
    async close() {
      closing = true;
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled([...pending.values()]);
      ops.close();
    },
  };
}
