import { InputError } from './store.mjs';
import { classifyContent } from '../src/content-selection.mjs';

export const DEFAULT_EDITORIAL = Object.freeze({ focus: 'creator', windowDays: 7, excludePromotions: true, excludeNightly: true });
export function validateEditorial(input = {}, previous = DEFAULT_EDITORIAL) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(DEFAULT_EDITORIAL,k))) throw new InputError('推荐偏好字段无效');
  const value={...DEFAULT_EDITORIAL,...previous,...input};
  if (!['creator','tools','balanced'].includes(value.focus)) throw new InputError('推荐方向无效');
  if (![1,3,7].includes(value.windowDays)) throw new InputError('资料范围可选 1、3 或 7 天');
  for(const key of ['excludePromotions','excludeNightly']) if(typeof value[key]!=='boolean') throw new InputError('推荐过滤开关需为布尔值');
  return value;
}
export function candidateValue(item, preferences = DEFAULT_EDITORIAL) {
  const value = classifyContent(item, preferences);
  if (!value.eligible) return null;
  const preferred = preferences.focus === 'creator' ? 'video' : preferences.focus === 'tools' ? 'tools' : null;
  return { score: value.score + (value.category === preferred ? 5 : 0), category: value.category === 'ai' ? 'products' : value.category };
}
export function editorialDescription(preferences = DEFAULT_EDITORIAL) {
  const focus={creator:'优先 AI 视频、短剧、配音剪辑、自媒体创作和能直接使用的工作流',tools:'优先 AI 产品、Agent、Codex 和可实际使用的工具',balanced:'兼顾 AI 产品、Agent 工具与 AI 视频创作'}[preferences.focus];
  return focus+'；面向中文内容创作者，减少纯开发者内部细节。'+(preferences.excludePromotions?'不推荐售票、活动广告或泛泛宣传。':'')+(preferences.excludeNightly?'不推荐没有具体功能说明的每日构建和纯版本号。':'');
}
