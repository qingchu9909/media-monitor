import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/main.mjs';

async function fixture(t, analysisOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'monitor-jobs-'));
  const date = new Date().toUTCString();
  const summary = 'OpenAI agent release adds offline export, project history and useful developer diagnostics for content creators.';
  const server = await startServer({ port: 0, dataDir, projectDir: dataDir,
    collectorOptions: { fetchImpl: async url => new Response(String(url).includes('openai.com') ? `<rss><channel><item><title>OpenAI agent update</title><link>https://example.org/agent</link><description>${summary}</description><pubDate>${date}</pubDate></item></channel></rss>` : '<rss><channel><title>Fixture</title></channel></rss>') },
    operationsOptions: { translate: async ()=>({translated:0,cached:0,failed:0,remaining:0}), capabilities: async () => ({codexInstalled:true,codexAuthenticated:true}), analysisOptions: {
      fetchText: async () => ({text:`<article>${summary}</article>`}),
      analyze: async () => ({summary:'有一项工具更新', highlights:[{url:'https://example.org/agent',titleZh:'新增离线导出',summaryZh:'发布说明增加了离线导出和项目历史。',whyItMatters:'可做一次实际测试。',supportingQuote:'adds offline export'}],ideas:[]}), ...analysisOptions,
    } },
  });
  t.after(async () => { await server.jobManager.idle(); await new Promise(resolve => server.close(resolve)); await rm(dataDir,{recursive:true,force:true}); });
  const api = async (path, method='GET', body) => {
    const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json()};
  };
  return {server,api};
}

test('refresh API collects, analyzes, persists a brief, deduplicates notifications and keeps paid X disabled',async t=>{
  const {server,api}=await fixture(t);
  assert.equal((await api('/api/operations')).data.settings.x.enabled,false);
  const first=await api('/api/jobs','POST',{kind:'refresh'});
  assert.equal(first.status,202);
  assert.equal(first.data.input,undefined);
  assert.equal(first.data.ownerPid,undefined);
  await server.jobManager.idle();
  let operations=(await api('/api/operations')).data;
  assert.equal(operations.jobs[0].status,'success',JSON.stringify(operations.jobs[0]));
  assert.equal(operations.jobs[0].result.x,null);
  assert.equal(operations.jobs[0].result.analysis.highlights.length,1);
  assert.equal(operations.notifications.length,1);
  const briefDate=(await api('/api/briefs')).data.latest.date;
  assert.equal((await api('/api/briefs/'+briefDate)).data.highlights[0].url,'https://example.org/agent');
  await api('/api/jobs','POST',{kind:'refresh'}); await server.jobManager.idle();
  operations=(await api('/api/operations')).data;
  assert.equal(operations.notifications.length,1);
  assert.equal((await api('/api/notifications/read','POST',{ids:[operations.notifications[0].id]})).data.updated,1);
  assert.equal((await api('/api/operations')).data.notifications[0].read,true);
});

test('running analysis rejects overlap, cancels without publishing, and retains collection data',async t=>{
  let entered; const analyzing=new Promise(resolve=>{entered=resolve;});
  const {server,api}=await fixture(t,{analyze:async ({signal})=>{entered(); await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const first=await api('/api/jobs','POST',{kind:'refresh'}); await analyzing;
  assert.equal((await api('/api/jobs','POST',{kind:'refresh'})).status,409);
  assert.equal((await api('/api/collect','POST',{})).status,409);
  assert.equal((await api('/api/settings','PATCH',{x:{handles:['OpenAI']}})).status,409);
  assert.equal((await api('/api/jobs/'+first.data.id+'/cancel','POST',{})).status,200);
  await server.jobManager.idle();
  const state=(await api('/api/operations')).data;
  assert.equal(state.jobs[0].status,'cancelled');
  assert.equal(state.activeJob,null);
  assert.equal((await api('/api/state')).data.items.length,1);
  assert.equal((await api('/api/briefs')).data.latest,null);
});

test('an analysis failure reports partial success after collected data is saved',async t=>{
  const {server,api}=await fixture(t,{analyze:async ()=>{throw new Error('private engine diagnostic');}});
  await api('/api/jobs','POST',{kind:'refresh'}); await server.jobManager.idle();
  const state=(await api('/api/operations')).data;
  assert.equal(state.jobs[0].status,'partial');
  assert.equal(state.jobs[0].result.rss.inserted,1);
  assert.equal(state.notifications[0].level,'error');
  assert.ok(!JSON.stringify(state).includes('private engine diagnostic'));
  assert.equal((await api('/api/briefs')).data.latest,null);
});
