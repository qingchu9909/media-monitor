import { InputError, plainText } from './store.mjs';
import { parseFeed } from './collector.mjs';
import { fetchPublicText, validatePublicUrl } from './public-fetch.mjs';
import { sourceCatalogEntries as entries } from './source-catalog.mjs';

const validating = new WeakSet();
export async function sourceRoutes({ path, method, req, res, store, jsonBody, sendJSON, fetchOptions = {} }) {
  if (path === '/api/source-catalog' && method === 'GET') {
    sendJSON(res, 200, {
      entries,
      youtube: {
        urlTemplate: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC频道ID',
        instructions: '目录中已有实测可读的 Runway 官方频道。其他频道需使用真实 UC 开头 ID 替换 channel_id，并先验证；不是 @用户名或主页链接。订阅仅提供近期视频信息，不代表字幕或视频内容已核验，可能出现临时 404。',
        documentationUrl: 'https://developers.google.com/youtube/v3/guides/push_notifications',
      },
    });
    return true;
  }
  if (path === '/api/sources/validate' && method === 'POST') {
    const body = await jsonBody(req);
    if (Object.keys(body).length !== 1 || !('url' in body)) throw new InputError('验证订阅仅接受 url，不接收账户或密钥');
    try { validatePublicUrl(body.url); } catch (error) { throw new InputError(error.message); }
    if (validating.has(store) || store.isCollecting()) throw new InputError('来源验证或采集正在进行，请稍后再试', 409);
    validating.add(store);
    try {
      const response = await fetchPublicText(body.url, fetchOptions);
      const items = parseFeed(response.text);
      sendJSON(res, 200, { ok: true, url: body.url, finalUrl: response.url, contentType: response.contentType, itemCount: items.length, samples: items.slice(0, 3).map(item => ({ title: item.title, url: item.url })), verifiedAt: new Date().toISOString(), note: items.length ? '订阅可解析；尚未保存来源或文章。' : '订阅可解析，目前返回 0 条；尚未保存来源。' });
      return true;
    } catch (error) { throw new InputError(plainText(error.message, 300) || '订阅验证失败', error instanceof InputError ? error.status : 422); }
    finally { validating.delete(store); }
  }
  if (path === '/api/sources' && method === 'POST') {
    sendJSON(res, 201, store.createSource(await jsonBody(req))); return true;
  }
  const action = path.match(/^\/api\/sources\/([^/]+)\/(archive|restore)$/);
  if (action && method === 'POST') {
    if (Object.keys(await jsonBody(req)).length) throw new InputError('归档和恢复只接受空 JSON 对象');
    sendJSON(res, 200, action[2] === 'archive' ? store.archiveSource(action[1]) : store.restoreSource(action[1])); return true;
  }
  const source = path.match(/^\/api\/sources\/([^/]+)$/);
  if (source && method === 'PATCH') {
    sendJSON(res, 200, store.updateSource(source[1], await jsonBody(req))); return true;
  }
  return false;
}
