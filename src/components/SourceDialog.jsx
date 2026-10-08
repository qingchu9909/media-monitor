import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api, safeUrl } from '../utils.js';

function normalizeFeed(value) {
  const raw = value.trim();
  const channelId = /^UC[\w-]{22}$/.test(raw) ? raw : raw.match(/^https:\/\/(?:www\.)?youtube\.com\/channel\/(UC[\w-]{22})(?:[/?#]|$)/i)?.[1];
  if (channelId) return { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, platform: 'YouTube' };
  let url;
  try { url = new URL(raw); } catch { throw new Error('请填写完整 HTTPS RSS 地址，或有效的 YouTube UC 频道 ID。'); }
  if (url.protocol !== 'https:') throw new Error('公开订阅源需要使用 HTTPS 地址。');
  if (url.username || url.password) throw new Error('来源地址不能包含账号或密码。');
  if (/(^|\.)youtube\.com$/i.test(url.hostname) && !url.pathname.startsWith('/feeds/')) throw new Error('请使用 YouTube 的 UC 频道 ID 或 /channel/UC… 链接；@账号主页不能直接作为 RSS。');
  return { url: url.href };
}

export default function SourceDialog({ source, onSave, onClose }) {
  const [name, setName] = useState(source?.name || '');
  const [url, setUrl] = useState(source?.url || '');
  const [platform, setPlatform] = useState(source?.platform || '');
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [validation, setValidation] = useState(null);
  const [error, setError] = useState('');
  const busy = saving || verifying;
  const dialogRef = useRef(null);
  useEffect(() => {
    dialogRef.current.showModal();
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = before; };
  }, []);
  async function verify() {
    if (busy) return;
    setError(''); setValidation(null);
    try {
      const normalized = normalizeFeed(url);
      setUrl(normalized.url);
      if (normalized.platform) setPlatform(normalized.platform);
      setVerifying(true);
      const result = await api('/api/sources/validate', { method: 'POST', body: JSON.stringify({ url: normalized.url }), signal: AbortSignal.timeout(30000) });
      if (result.ok !== true || !Number.isInteger(result.itemCount) || result.itemCount < 0 || !Array.isArray(result.samples)) throw new Error('验证响应不完整，暂时无法确认订阅内容。');
      setValidation(result);
    } catch (err) { setError(`订阅验证未通过：${err.message}`); }
    finally { setVerifying(false); }
  }
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError('');
    try {
      if (!name.trim()) throw new Error('请填写来源名称。');
      const normalized = normalizeFeed(url);
      setSaving(true);
      await onSave({ name: name.trim(), url: normalized.url, platform: normalized.platform || platform.trim() || 'RSS', enabled, ...(source ? {} : { kind: 'rss' }) });
      onClose();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  return <dialog ref={dialogRef} className="topic-dialog source-dialog" aria-labelledby="source-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <div className="dialog-heading"><h2 id="source-dialog-title">{source ? '编辑来源' : '添加公开订阅源'}</h2><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭来源表单"><Icon name="close"/></button></div>
      <p className="dialog-description">可以先验证订阅，查看实际返回的内容；保存后再采集入库。</p>
      <label htmlFor="source-name">来源名称</label><input id="source-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} required autoFocus disabled={busy} placeholder="例如：我的 YouTube 关注频道"/>
      <label htmlFor="source-url">HTTPS RSS 地址 / YouTube 频道 ID</label><input id="source-url" type="text" value={url} onChange={event => { setUrl(event.target.value); setValidation(null); setError(''); }} maxLength={2000} required disabled={busy} placeholder="https://…/feed.xml 或 UC…" aria-describedby="source-url-help"/>
      <p className="field-help" id="source-url-help">支持 RSS / Atom；YouTube 的 UC 频道 ID 或 /channel/UC… 链接会转成官方视频订阅。普通网页、@账号主页不能直接作为 RSS。</p>
      <button type="button" className="button" onClick={verify} disabled={busy || !url.trim()}>{verifying ? <><span className="spinner small"/>正在验证订阅…</> : '验证订阅'}</button>
      {validation && <section className="terminal-instructions" aria-label="订阅验证结果" style={{ marginTop: 14 }}>
        <strong role="status">订阅可读取：本次返回 {validation.itemCount} 条</strong>
        <p className="field-help">这是一次实际读取结果，尚未保存来源或文章；验证成功不代表已经入库。</p>
        {validation.samples.length > 0 && <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.8, overflowWrap: 'anywhere' }}>{validation.samples.slice(0, 3).map((sample, index) => {
          const href = safeUrl(sample.url);
          return <li key={`${sample.url || ''}:${index}`} style={{ marginTop: 8 }}><strong>{sample.title || '原文未提供标题'}</strong>{href ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ display: 'block' }}>{href}</a> : <span style={{ display: 'block' }}>原文链接未提供</span>}</li>;
        })}</ul>}
      </section>}
      <label htmlFor="source-platform">平台名称</label><input id="source-platform" value={platform} onChange={event => setPlatform(event.target.value)} maxLength={60} disabled={busy} placeholder="例如：官方博客、YouTube"/>
      <label className="checkbox-label"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)}/><span>启用并加入免费定时采集</span></label>
      <p className="field-help">验证是可选的。来源暂时无法访问时，可取消勾选“启用”，先保存为暂停状态。</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={busy}>{saving ? '保存中…' : '保存来源'}</button></div>
    </form>
  </dialog>;
}
