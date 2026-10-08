import React,{useEffect,useState} from 'react';
import {api} from '../utils.js';

const DEFAULT={focus:'creator',windowDays:7,excludePromotions:true,excludeNightly:true};
const NAMES={creator:'AI 视频与自媒体优先',tools:'AI 产品与 Agent 优先',balanced:'三个方向兼顾'};
export default function RecommendationSettings({settings,onSaved,busy}){
 const [draft,setDraft]=useState(settings||DEFAULT),[saving,setSaving]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 useEffect(()=>{if(settings)setDraft(settings);},[settings?.focus,settings?.windowDays,settings?.excludePromotions,settings?.excludeNightly]);
 const change=(key,value)=>{setDraft(old=>({...old,[key]:value}));setMessage('');setError('');};
 async function save(){setSaving(true);setMessage('');setError('');try{const result=await api('/api/settings',{method:'PATCH',body:JSON.stringify({editorial:draft})});onSaved(result);setMessage('推荐偏好已保存，下次“更新并生成选题”生效。');}catch(e){setError(e.message);}finally{setSaving(false);}}
 return <details className="reading-preferences"><summary>推荐偏好 · {NAMES[settings?.focus||'creator']} · 资料范围近 {settings?.windowDays||7} 天</summary><div className="reading-preferences-body"><p>今天的推荐可以来自最近几天，始终显示原始发布时间。优先选择能做成实测、教程或改善创作流程的内容；中文翻译不等于事实核验。</p><div className="reading-preferences-fields"><label>优先方向<select aria-label="推荐优先方向" value={draft.focus} disabled={saving||busy} onChange={e=>change('focus',e.target.value)}>{Object.entries(NAMES).map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></label><label>选题资料范围<select aria-label="选题资料范围" value={draft.windowDays} disabled={saving||busy} onChange={e=>change('windowDays',Number(e.target.value))}>{[1,3,7].map(n=><option key={n} value={n}>近 {n} 天</option>)}</select></label></div><label className="checkbox-label"><input type="checkbox" checked={draft.excludePromotions} disabled={saving||busy} onChange={e=>change('excludePromotions',e.target.checked)}/>不推荐售票和活动广告</label><label className="checkbox-label"><input type="checkbox" checked={draft.excludeNightly} disabled={saving||busy} onChange={e=>change('excludeNightly',e.target.checked)}/>不推荐每日构建和没有具体变化的版本号</label><button type="button" className="button" disabled={saving||busy||!settings} onClick={save}>{saving?'正在保存…':'保存推荐偏好'}</button>{message&&<p role="status">{message}</p>}{error&&<p role="alert" className="form-error">{error}</p>}</div></details>;
}
