import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

export default function TopicDialog({ topic, onClose, onSave }) {
  const [name, setName] = useState(topic?.name || '');
  const [keywords, setKeywords] = useState(topic?.keywords?.join('，') || '');
  const [enabled, setEnabled] = useState(topic?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = before; };
  }, []);
  async function submit(event) {
    event.preventDefault();
    const parsed = [...new Set(keywords.split(/[,，;；\n]/).map(value => value.trim()).filter(Boolean))];
    if (!name.trim()) return setError('请填写主题名称');
    if (!parsed.length) return setError('请至少填写一个关键词');
    if (parsed.length > 30) return setError('最多设置 30 个关键词');
    setError(''); setSaving(true);
    try { await onSave({ name: name.trim(), keywords: parsed, ...(topic ? { enabled } : {}) }); onClose(); }
    catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  return <dialog ref={dialogRef} className="topic-dialog" aria-labelledby="topic-dialog-title" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }} onClick={event => { if (event.target === dialogRef.current && !saving) { const rect = dialogRef.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}><form onSubmit={submit}><div className="dialog-heading"><h2 id="topic-dialog-title">{topic ? '编辑主题' : '新增主题'}</h2><button type="button" className="icon-button" onClick={onClose} disabled={saving} aria-label="关闭对话框"><Icon name="close"/></button></div><p className="dialog-description">用关键词把关注的信息归到同一个主题。</p><label htmlFor="topic-name">主题名称</label><input id="topic-name" value={name} onChange={event => setName(event.target.value)} maxLength={60} autoFocus placeholder="例如：AI 视频创作" required/><label htmlFor="topic-keywords">匹配关键词</label><textarea id="topic-keywords" value={keywords} onChange={event => setKeywords(event.target.value)} maxLength={3000} rows={4} placeholder="例如：video，视频，Sora" required/><p className="field-help">用逗号或换行分隔。文章标题、摘要命中任一关键词时归入主题；匹配结果只是候选信息。</p>{topic && <label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)}/><span>启用这个监控主题</span></label>}{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button" onClick={onClose} disabled={saving}>取消</button><button type="submit" className="button primary" disabled={saving}>{saving && <span className="spinner"/>}{saving ? '保存中…' : '保存主题'}</button></div></form></dialog>;
}
