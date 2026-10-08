import { useEffect, useState } from 'react';

// Check each displayed field independently. One Chinese tag must not make a
// release note or an English paragraph count as readable Chinese.
export function isReadableChinese(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const text = value.replace(/https?:\/\/\S+/gi, '');
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  const words = (text.match(/[A-Za-z]{2,}/g) || []).length;
  const englishSentence = /\b[A-Za-z][A-Za-z'-]*(?:[ \t]+[A-Za-z][A-Za-z'-]*){5,}\b/.test(text);
  return han >= Math.max(2, words * 2) && !englishSentence;
}

export function isMissingSummary(value) {
  if (typeof value !== 'string') return true;
  // Keep this source-evidence rule aligned with server/translations.mjs.
  const text = value.replace(/<[^>]*>/g, '')
    .replace(/\s*submitted\s+by\s+(?:\/?u\/[A-Za-z0-9_-]+|\[deleted\])(?:\s*\[(?:link|comments)\])*\s*$/iu, '')
    .replace(/(?:\s*\[(?:link|comments)\])+\s*$/iu, '')
    .replace(/https?:\/\/\S+/gi, '').trim();
  if (!text) return true;
  return /^(?:(?:点击)?(?:查看|阅读)(?:原文|全文|详情)|阅读全文|了解更多|read\s+more|continue\s+reading|view\s+(?:original|article)|来源未提供(?:有效)?摘要(?:[，,]\s*可打开原文查看)?)[\s>»→.。…!！]*$/iu.test(text);
}

const MISSING_SUMMARY = '来源未提供有效摘要，可打开原文查看。';
const translationAnalysis = value => value?.type === 'translation' || value?.kind === 'translation' || ['translation', 'translation-only'].includes(value?.verification);

export function chineseContent(item, translations = {}) {
  const analysis = item.analysis && !item.analysis.isStale && !translationAnalysis(item.analysis) ? item.analysis : null;
  const research = !item.research?.isStale && item.research?.titleZh && item.research?.summaryZh ? { ...item.research, status: 'ready', method: 'web-research' } : null;
  const cached = translations[item.url] || item.translation || (translationAnalysis(item.analysis) ? item.analysis : null);
  const stale = Boolean(cached?.isStale || cached?.status === 'stale'
    || (typeof cached?.originalTitle === 'string' && cached.originalTitle !== item.title)
    || (typeof cached?.originalSummary === 'string' && cached.originalSummary !== (item.summary || ''))
    || (typeof cached?.originalContent === 'string' && cached.originalContent !== (item.content || '')));
  const cacheReady = cached && !stale && ['ready', 'success', 'original'].includes(cached.status || 'ready');
  const candidates = [
    { kind: 'editorial', value: analysis },
    { kind: 'research', value: research },
    { kind: cached?.status === 'original' ? 'original' : 'translation', value: cacheReady ? cached : null },
    { kind: 'original', value: { titleZh: item.title, summaryZh: item.summary } },
  ];
  const titleSource = candidates.find(({ value }) => isReadableChinese(value?.titleZh));
  const summarySource = candidates.find(({ value }) => isReadableChinese(value?.summaryZh) && !isMissingSummary(value.summaryZh));
  const titleReady = Boolean(titleSource);
  const summaryReady = Boolean(summarySource);
  const summaryMissing = !summaryReady && isMissingSummary(item.summary) && isMissingSummary(item.content);
  const needsTranslation = !titleReady || (!summaryReady && !summaryMissing);
  const isReadable = titleReady && summaryReady;
  const kind = !isReadable ? summaryMissing && titleReady ? 'incomplete' : 'pending'
    : [titleSource, summarySource].find(source => source.kind !== 'original')?.kind || 'original';
  const translation = research || cached;
  const invalidTranslation = cacheReady && (!isReadableChinese(cached.titleZh) || (!isMissingSummary(cached.summaryZh) && !isReadableChinese(cached.summaryZh)));
  return {
    kind, analysis, translation,
    title: titleSource?.value.titleZh || '外文资讯 · 等待中文整理',
    summary: summarySource?.value.summaryZh || (summaryMissing ? MISSING_SUMMARY : ''),
    titleReady, summaryReady, summaryMissing, isReadable, needsTranslation,
    translationReason: stale ? 'source-changed' : invalidTranslation ? 'invalid-chinese' : cached?.reason || (needsTranslation ? 'not-translated' : summaryMissing ? 'missing-summary' : null),
    hasAlternate: kind !== 'original' || Boolean(item.analysis) || Boolean(item.research),
  };
}

export function useChineseContent(item, { translations = {}, onTranslate, pendingTranslations, translationErrors } = {}) {
  const content = chineseContent(item, translations);
  const [original, setOriginal] = useState(false);
  const [localPending, setLocalPending] = useState(false);
  const [localError, setLocalError] = useState('');
  const pending = localPending || Boolean(pendingTranslations?.has(item.id)) || content.translation?.status === 'running';
  const error = content.needsTranslation ? translationErrors?.[item.id] || content.translation?.error || localError || (content.translation?.status === 'failed' ? '翻译暂未完成，请重试。' : '') : '';
  useEffect(() => { if (!content.needsTranslation) setLocalError(''); }, [content.needsTranslation]);
  useEffect(() => { setOriginal(false); }, [item.id, item.url, content.translation?.translatedAt]);
  async function translate() {
    if (pending || !onTranslate) return;
    setLocalPending(true); setLocalError('');
    try { await onTranslate(item); }
    catch (err) { setLocalError(err.message || '翻译请求未完成，请重试。'); }
    finally { setLocalPending(false); }
  }
  return {
    ...content, original, setOriginal, pending, error, translate, canTranslate: Boolean(onTranslate),
    title: original ? item.title || '原文未提供标题' : !content.titleReady && content.needsTranslation ? pending ? '正在整理中文标题…' : error ? '中文整理暂未完成' : content.title : content.title,
    summary: original ? item.summary : content.summary,
  };
}
