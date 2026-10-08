import { sanitizeSocialMetadata } from './store.mjs';

const fields = {x:'tweets',reddit:'posts',youtube:'videos',web:'results'};
const sources = {x:'aisa-x',reddit:'aisa-reddit',youtube:'aisa-youtube',web:'aisa-web'};
export const aisaSourceId = platform => sources[platform];
function date(value) {
  if(value === null || value === undefined || value === '') return null;
  // Relative dates supplied by search providers are not reliable timestamps.
  if(typeof value === 'string' && !/^\d{4}-\d\d-\d\d/.test(value) && !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[ ,]/.test(value)) return null;
  const ms=typeof value === 'number' ? value*1000 : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function url(value,base) {
  if(typeof value!=='string' || !value.trim()) return null;
  try {const u=new URL(value,base);return u.protocol==='https:' ? u.href : null;} catch {return null;}
}
export function normalizeAisa(platform, input) {
  if(!fields[platform]) throw new Error('Supported platforms: x, reddit, youtube, web');
  let body=input;
  for(let depth=0;depth<4;depth++) {
    if(!body || typeof body!=='object' || Array.isArray(body)) throw new Error('Expected one endpoint JSON response');
    if(body.success===false || body.successful===false || body.error) throw new Error('AIsa response reports failure; no data imported');
    if(Array.isArray(body.results) && body.results.some(r=>r && ('call_id' in r || 'tool' in r || 'successful' in r))) throw new Error('Router batch detected: extract the matching successful item.data before importing; quotes are not collected content');
    if(Array.isArray(body[fields[platform]]) || (platform==='youtube' && (Array.isArray(body.sections)||Array.isArray(body.shorts)))) break;
    const nested=['data','result','output','response'].find(k=>body[k] && typeof body[k]==='object');
    if(!nested) throw new Error(`Response has no documented ${fields[platform]} array; extract the matching successful endpoint result first`);
    body=body[nested];
  }
  let rows=body[fields[platform]];
  if(platform==='youtube') rows=[...(body.videos??[]),...(body.sections??[]).flatMap(s=>s.items??[]),...(body.shorts??[]).flatMap(s=>s.items??[])];
  if(!Array.isArray(rows)) throw new Error('Unsupported endpoint envelope');
  const seen=new Set();
  return rows.flatMap(row=>{
    if(row.success===false || row.successful===false) throw new Error('A failed batch cannot be imported as content');
    let target, title, summary, published;
    if(platform==='x') {
      target=url(row.url);title=row.text;summary=row.text;published=row.createdAt;
    } else if(platform==='reddit') {
      target=url(row.permalink,'https://www.reddit.com') || url(row.url);title=row.title;summary=row.selftext;published=row.created_at_iso??row.created_utc;
    } else if(platform==='youtube') {
      target=url(row.link??row.url);title=row.title;summary=row.description;published=row.published_at??row.published_time;
    } else {
      target=url(row.url);title=row.title;summary=row.content;published=row.published_date;
    }
    if(!target || !title || typeof title!=='string' || seen.has(target)) return [];
    seen.add(target);
    const item={title:title.slice(0,500),url:target,summary:typeof summary==='string'?summary.slice(0,5000):'',publishedAt:date(published)};
    if(platform==='x') Object.assign(item,sanitizeSocialMetadata({
      author:{name:row.author?.name,handle:row.author?.userName},
      metrics:{views:row.viewCount,likes:row.likeCount,reposts:row.retweetCount,replies:row.replyCount},
    }));
    return [item];
  });
}
