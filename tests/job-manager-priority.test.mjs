import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { createJobManager } from '../server/job-manager.mjs';

async function fixture(t,translate,{collectorOptions}={}) {
  const dir=await mkdtemp(join(tmpdir(),'monitor-priority-'));const store=openStore(dir);
  const items=Array.from({length:61},(_,i)=>({url:`https://example.org/video-${i}`,title:`OpenAI video editing workflow ${i}`,summary:'A practical guide explains character references and shot continuity checks for video editing and generation workflows.',publishedAt:new Date().toISOString()}));
  items.push({url:'https://example.org/other',title:'OpenAI announces a conference',summary:'Buy tickets for the upcoming conference and reserve your place today.',publishedAt:new Date().toISOString()});
  store.upsertItems('openai',items);
  const manager=createJobManager({store,projectDir:dir,translate,capabilities:async()=>({}),collectorOptions:collectorOptions ?? {fetchImpl:async()=>new Response('<rss><channel><title>Fixture</title></channel></rss>')},analysisOptions:{fetchText:async()=>({text:'<article>'+items[0].summary+'</article>'}),analyze:async()=>({summary:'本次没有新增推荐',highlights:[],ideas:[]})}});
  t.after(async()=>{await manager.close();store.close();await rm(dir,{recursive:true,force:true});});
  return manager;
}

for(const kind of ['translation','refresh']) test(`${kind} sends all related items with useful priority URLs and reports unfinished translation as partial`,async t=>{
  let calls=0;
  const manager=await fixture(t,async({items,priorityUrls})=>{
    calls++;assert.equal(items.length,62);assert.equal(priorityUrls.length,61);
    assert.ok(!priorityUrls.includes('https://example.org/other'));
    return {status:'partial',translated:50,cached:0,failed:0,remaining:12,deferred:12,missingSummary:0};
  });
  manager.start({kind});await manager.idle();const job=manager.ops.jobs()[0];
  assert.equal(calls,1);assert.equal(job.status,'partial');assert.equal(job.result.translation.remaining,12);assert.match(job.message,/12.*待/);
  assert.match(job.message,/队列.*下次/);assert.deepEqual(job.result.warnings,[]);assert.equal(manager.ops.notifications().length,0);
});

test('missing source summaries remain informational across repeated successful refreshes',async t=>{
  const manager=await fixture(t,async()=>({status:'success',translated:0,cached:50,failed:0,remaining:0,deferred:0,missingSummary:12}));
  for(let i=0;i<2;i++){
    manager.start({kind:'refresh'});await manager.idle();const job=manager.ops.jobs()[0];
    assert.equal(job.status,'success');assert.equal(job.result.translation.missingSummary,12);assert.match(job.message,/12.*摘要/);assert.deepEqual(job.result.warnings,[]);
  }
  assert.equal(manager.ops.notifications().length,0);
});

test('real translation errors retain partial status and deduplicate by failure content, not job ID',async t=>{
  let reason='引文未命中原文';
  const manager=await fixture(t,async()=>({status:'partial',translated:48,cached:0,failed:2,remaining:14,deferred:12,missingSummary:3,failureReasons:[{count:2,reason}]}));
  manager.start({kind:'refresh'});await manager.idle();const first=manager.ops.jobs()[0];
  assert.equal(first.status,'partial');assert.equal(first.result.notificationCount,1);assert.equal(manager.ops.notifications().length,1);
  assert.equal(manager.ops.notifications()[0].level,'error');assert.match(manager.ops.notifications()[0].message,/翻译/);
  manager.start({kind:'refresh'});await manager.idle();const second=manager.ops.jobs()[0];
  assert.notEqual(first.id,second.id);assert.equal(second.status,'partial');assert.equal(second.result.translation.failed,2);assert.equal(second.result.notificationCount,0);assert.equal(manager.ops.notifications().length,1);
  reason='模型调用未完成';manager.start({kind:'refresh'});await manager.idle();
  assert.equal(manager.ops.notifications().length,2);assert.equal(manager.ops.jobs()[0].result.notificationCount,1);
});

test('RSS errors stay visible but unchanged source errors do not send repeated notifications',async t=>{
  let status=503;
  const manager=await fixture(t,async()=>({status:'success',translated:0,cached:0,failed:0,remaining:0,missingSummary:0}),{collectorOptions:{fetchImpl:async input=>String(input).includes('openai.com')?new Response('',{status}):new Response('<rss><channel><title>Fixture</title></channel></rss>')}});
  for(let i=0;i<2;i++){
    manager.start({kind:'refresh'});await manager.idle();const job=manager.ops.jobs()[0];
    assert.equal(job.status,'partial');assert.equal(job.result.rss.results.filter(source=>source.status==='error').length,1);
  }
  assert.equal(manager.ops.notifications().length,1);
  status=404;manager.start({kind:'refresh'});await manager.idle();assert.equal(manager.ops.notifications().length,2);
});
