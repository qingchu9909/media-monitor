import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { api, formatDate, safeUrl } from '../utils.js';
import { metricValue } from '../feed-filters.mjs';

const DRAFT_PREFIX = 'qingchu-media-draft-v1:';

function initialDraft(highlight, idea) {
  return { title: idea?.title || highlight.titleZh, angle: idea?.angle || '', hook: idea?.hook || '', notes: '', body: '', questions: '核对引用事实是否仍然成立；\n补充自己的实际体验或独立验证。', sourceUrls: (idea?.sourceUrls?.length ? idea.sourceUrls : [highlight.url]).join('\n') };
}

function readDraft(key, fallback) {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (!saved || saved.version !== 1 || !saved.draft) return null;
    const draft = Object.fromEntries(Object.keys(fallback).map(field => [field, typeof saved.draft[field] === 'string' ? saved.draft[field].slice(0, 50000) : fallback[field]]));
    return draft;
  } catch { return null; }
}

function DraftEditor({ highlight, idea, briefDate, onError, leadingAction, operations, onDraftStarted }) {
  const key = `${DRAFT_PREFIX}${briefDate}:${highlight.url}`;
  const seed = initialDraft(highlight, idea);
  const [draft, setDraft] = useState(() => readDraft(key, seed) || seed);
  const [open, setOpen] = useState(() => Boolean(readDraft(key, seed)));
  const [saved, setSaved] = useState(() => readDraft(key, seed) ? '已恢复本机草稿' : '');
  const jobKey = `${key}:generation`;
  const [generationId, setGenerationId] = useState(() => { try { return localStorage.getItem(jobKey) || ''; } catch { return ''; } });
  const [submitting, setSubmitting] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [preview, setPreview] = useState(null);
  const generation = operations?.jobs?.find(job => job.id === generationId && job.kind === 'draft');
  const generating = submitting || ['queued', 'running'].includes(generation?.status);
  useEffect(() => {
    if (generation?.status === 'success' && generation.result?.draft) { setPreview(generation.result.draft); setGenerationError(''); }
    else if (generation && ['failed', 'partial', 'interrupted', 'cancelled'].includes(generation.status)) setGenerationError(generation.message || '初稿未完成，已有内容保留。');
  }, [generation?.id, generation?.status]);
  async function generate() {
    if (generating || operations?.activeJob) return;
    setSubmitting(true); setGenerationError(''); setPreview(null);
    try {
      const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ kind: 'draft', briefDate, sourceUrl: highlight.url,
        draft: { title: draft.title.slice(0,500), angle: draft.angle.slice(0,2000), hook: draft.hook.slice(0,1000), notes: [draft.notes, draft.body ? '我现有的草稿：\n'+draft.body : '', draft.questions].filter(Boolean).join('\n').slice(0,6000) } }) });
      setGenerationId(job.id); try { localStorage.setItem(jobKey,job.id); } catch { /* Current session still tracks it. */ }
      onDraftStarted?.(job);
    } catch (error) { setGenerationError('提交未确认：'+error.message+'。请先查看运行记录，已有草稿保留。'); }
    finally { setSubmitting(false); }
  }
  function adopt() {
    if (!preview) return;
    persist({ ...draft, title: preview.title, body: preview.body, questions: preview.questions.join('\n'), sourceUrls: preview.sourceUrls.join('\n') });
    dismissPreview(); setSaved('已采用 Codex 初稿，可继续编辑');
  }
  function dismissPreview() {
    setPreview(null); setGenerationId('');
    try { localStorage.removeItem(jobKey); } catch { /* The completed job remains in the project history. */ }
  }
  function persist(next) {
    setDraft(next);
    try { localStorage.setItem(key, JSON.stringify({ version: 1, draft: next, updatedAt: new Date().toISOString() })); setSaved('已保存到本机浏览器'); }
    catch { setSaved('本机保存失败，请下载备份'); }
  }
  function download() {
    try {
      const text = [`# ${draft.title}`, '', draft.body ? '状态：待审阅初稿，事实与实测结果请按来源核对。' : '状态：选题草稿，尚未写成文章。', '', '## 创作角度', draft.angle, '', '## 开头', draft.hook, '', '## 正文', draft.body, '', '## 我的补充', draft.notes, '', '## 待验证的问题', draft.questions, '', '## 原始来源', ...draft.sourceUrls.split('\n').filter(Boolean).map(url => `- ${url}`), ''].join('\n');
      const objectUrl = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      const link = document.createElement('a'); link.href = objectUrl; link.download = `选题草稿-${briefDate}.md`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch { onError('草稿下载失败，请重试或手动复制。'); }
  }
  return <section className="draft-workspace"><div className="draft-entry-actions">{leadingAction}<button type="button" className="button primary" onClick={() => { setOpen(value => !value); if (!open) persist(draft); }} aria-expanded={open}><Icon name={open ? 'close' : 'plus'} size={16}/>{open ? '收起草稿' : '开始创作'}</button></div>{open && <div className="draft-editor"><div className="draft-heading"><div><h4>选题草稿</h4><p>补充你的想法，Codex 会按本条原文依据完善初稿。</p></div><span role="status">{saved}</span></div>
    <div className="draft-generation-actions"><button type="button" className="button primary" disabled={generating || Boolean(operations?.activeJob) || !operations?.capabilities?.codexAuthenticated} onClick={generate}>{generating ? 'Codex 正在完善…' : '用 Codex 完善草稿'}</button>{generating && generationId && <button type="button" className="text-button" onClick={() => api(`/api/jobs/${encodeURIComponent(generationId)}/cancel`,{method:'POST',body:'{}'}).catch(error=>setGenerationError(error.message))}>取消生成</button>}</div>
    <p className="field-help">使用已登录 Codex 的可用额度。会重新读取来源，区分原文陈述和未验证事项；生成后先预览，再采用。</p>
    {generationError && <p className="form-error" role="alert">{generationError}</p>}
    {preview && <section className="draft-generation-preview" aria-label="Codex 初稿预览"><h4>{preview.title}</h4><p>待审阅初稿 · {{'original-page':'已重新读取原文，效果仍待实测','feed-excerpt':'仅依据 RSS 摘要，原文正文未能读取','video-description':'仅依据视频描述，尚未观看视频'}[preview.verification] || '来源证据仍需人工复核'}</p><pre>{preview.body}</pre>{preview.questions?.length > 0 && <details><summary>发布前需要核对</summary><ul>{preview.questions.map((q,i)=><li key={i}>{q}</li>)}</ul></details>}<div className="draft-generation-actions"><button type="button" className="button primary" onClick={adopt}>采用这份初稿</button><button type="button" className="button" onClick={dismissPreview}>保留原草稿</button></div></section>}
    {[['title','标题',2],['angle','创作角度',3],['hook','开头',3],['notes','我的补充与要求',3],['body','正文初稿',10],['questions','待验证的问题',3],['sourceUrls','原始来源链接（每行一条）',3]].map(([field,label,rows])=><label className="draft-field" key={field}><span>{label}</span><textarea rows={rows} value={draft[field]} onChange={event=>persist({...draft,[field]:event.target.value})}/></label>)}<div className="draft-footer"><p>编辑内容保存在当前浏览器，Codex 生成记录另存本项目；可下载备份。</p><button type="button" className="button" onClick={download}><Icon name="download" size={16}/>下载草稿</button></div></div>}</section>;
}

export default function OpportunityWorkbench({ brief, items = [], onStar, pendingStars = new Set(), onError, operations, onDraftStarted }) {
  const [selected, setSelected] = useState(0);
  const [copied, setCopied] = useState(false);
  const highlights = brief.highlights || [];
  useEffect(() => { setSelected(0); setCopied(false); }, [brief.date]);
  const highlight = highlights[Math.min(selected, highlights.length - 1)];
  if (!highlight) return null;
  const idea = (brief.ideas || []).find(value => value.sourceUrls?.includes(highlight.url));
  const storedItem = items.find(item => item.url === highlight.url);
  const href = safeUrl(highlight.url);
  const verificationLabel = { 'video-description': '仅依据公开视频描述', 'original-page': '已核对网页引文', 'feed-excerpt': '依据订阅摘要', 'provider-post': '依据 X 原帖数据', 'manual-review': '人工审阅记录' }[highlight.verification] || '历史审阅记录';
  async function copyHook() {
    try { await navigator.clipboard.writeText(idea.hook); setCopied(true); }
    catch { onError('未能复制开头，请选中文字复制。'); }
  }
  const currentNumber = Math.min(selected, highlights.length - 1) + 1;
  const starAction = storedItem && onStar ? <button type="button" className={`button ${storedItem.starred ? 'saved' : ''}`} disabled={pendingStars.has(storedItem.id)} onClick={() => onStar(storedItem)} aria-pressed={Boolean(storedItem.starred)}><Icon name="star" size={16} filled={Boolean(storedItem.starred)}/>{storedItem.starred ? '已收藏' : '收藏线索'}</button> : null;
  return <section className="opportunity-workbench radar-opportunities" aria-label="选题机会"><div className="opportunity-list"><div className="radar-opportunity-heading"><h3>今日机会<Icon name="info" size={15}/></h3><span>按编辑顺序</span></div><div className="opportunity-table-head" aria-hidden="true"><span>序号</span><span>机会主题</span><span>浏览量</span></div>{highlights.map((item, index) => {
    const entry = items.find(value => value.url === item.url);
    const views = metricValue(entry?.metrics?.views);
    return <button type="button" key={item.url} className={`opportunity-choice ${selected === index ? 'selected' : ''}`} aria-pressed={selected === index} onClick={() => { setSelected(index); setCopied(false); }}><span className="opportunity-number">{index + 1}</span><span className="opportunity-choice-content"><strong>{item.titleZh}</strong><small><Icon name="report" size={12}/>{item.sourceName || '来源未标注'}</small><time>{item.publishedAt ? formatDate(item.publishedAt) : '发布时间未知'}</time></span><span className="opportunity-choice-metric"><strong>{views === null ? '—' : views.toLocaleString('zh-CN')}</strong><small>{views === null ? '来源未提供' : '来源快照'}</small></span></button>;
  })}<div className="opportunity-list-footnote">已筛选 {highlights.length} 条机会 · 顺序为编辑判断</div></div><article className="opportunity-detail"><div className="opportunity-detail-top"><span className="opportunity-rank-label">机会 {currentNumber}</span><span className="opportunity-evidence"><Icon name="check" size={14}/>{verificationLabel}</span></div><h3>{highlight.titleZh}</h3>{highlight.whyItMatters && <section className="opportunity-section recommendation-section"><h4><Icon name="search" size={21}/>推荐理由</h4><p>{highlight.whyItMatters}</p></section>}{idea && <section className="opportunity-section angle-section"><h4><Icon name="brain" size={21}/>创作角度<span>编辑建议</span></h4><div className="radar-angle-card"><div><strong>{idea.title}</strong><Icon name="check" size={17}/></div><p>{idea.angle}</p></div></section>}{idea?.hook && <section className="opportunity-hook"><div className="hook-heading"><h4><Icon name="report" size={19}/>口播开头</h4><button type="button" className="button" onClick={copyHook} aria-label={copied ? '开头已复制' : '复制开头'}><Icon name="report" size={15}/>{copied ? '开头已复制' : '复制开头'}</button></div><blockquote>{idea.hook}</blockquote></section>}<section className="opportunity-section signal-section"><h4><Icon name="source" size={21}/>来源线索<span>{verificationLabel}</span></h4><div className="radar-signal-card"><div className="signal-source-mark"><Icon name="report" size={19}/></div><div className="signal-source-body"><strong>{highlight.sourceName || '来源未标注'}</strong><span>{highlight.publishedAt ? formatDate(highlight.publishedAt) : '原文发布时间未知'}</span><p>{highlight.summaryZh}</p>{highlight.supportingQuote && <details className="evidence-quote"><summary>查看依据引文（原文语言）</summary><blockquote>{highlight.supportingQuote}</blockquote></details>}{highlight.verification === 'feed-excerpt' && <small>原文页面暂未成功读取；写作前请打开原文复核。</small>}{href && <a className="original-link" href={href} target="_blank" rel="noopener noreferrer">核对原文<Icon name="external" size={14}/></a>}</div></div></section><DraftEditor key={`${brief.date}:${highlight.url}`} highlight={highlight} idea={idea} briefDate={brief.date} onError={onError} leadingAction={starAction} operations={operations} onDraftStarted={onDraftStarted}/></article></section>;
}
