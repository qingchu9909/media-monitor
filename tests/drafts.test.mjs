import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { createJobManager } from '../server/job-manager.mjs';

const date='2026-09-13', url='https://example.org/video-guide';
const page='The official guide explains shot planning, character reference sheets and video editing. It recommends checking continuity between shots and reviewing the final sequence, rather than assuming that individual clips form a coherent story.';
const body='做一段能看下去的视频，除了把单个镜头生成出来，还得检查镜头之间能不能接上。这份官方指南把注意力放在镜头规划、角色参考表和剪辑顺序上。它建议先明确每个镜头要表现什么，再检查前后人物的状态和动作是否连贯。这是来源提供的方法，我还没有实际验证它能改善多少效果。对我们做内容来说，可以先拿同一组素材做一个小对照：保留原来的剪辑顺序，再按参考表重新检查角色和镜头的衔接。展示调整了哪些地方，也保留没有解决的问题。这样观众看到的是可复查的制作过程，不必只听一句效果更好的评价。至于实际需要多长时间、适不适合自己的工作流，还要等完成测试后再判断。';
const modelOutput=()=>({title:'把镜头接起来之前，先检查这些细节',body,questions:['镜头衔接调整后是否更连贯？'],sourceUrls:[url],supportingQuote:'It recommends checking continuity between shots'});
const input=()=>({kind:'draft',briefDate:date,sourceUrl:url,draft:{title:'我的标题',angle:'做一次镜头衔接对照',hook:'镜头单独好看，连起来就一定好看吗？',notes:'先做待审阅口播'}});

async function fixture(t,{fetchText=async()=>({text:`<article>${page}</article>`}),analyze=async()=>modelOutput(),sourceId='openai',summary=page,xRunner}={}) {
  const dir=await mkdtemp(join(tmpdir(),'monitor-draft-'));
  const store=openStore(dir);
  store.upsertItems(sourceId,[{url,title:'OpenAI video workflow guide',summary,publishedAt:date+'T02:00:00Z'}]);
  await mkdir(join(dir,'briefs'));
  await writeFile(join(dir,'briefs',date+'.json'),JSON.stringify({date,title:'今日机会',generatedAt:date+'T04:00:00Z',status:'reviewed',summary:'创作指南',generationMethod:'公开证据',highlights:[{url,titleZh:'镜头连续性指南',summaryZh:'根据来源整理',whyItMatters:'可以对照测试',sourceName:'官方',supportingQuote:'checking continuity between shots'}],ideas:[],coverage:[],caveats:[]}));
  const manager=createJobManager({store,projectDir:dir,draftOptions:{fetchText,analyze},capabilities:async()=>({codexInstalled:true,codexAuthenticated:true}),
    translate:async()=>({translated:0,cached:0,failed:0,remaining:0}),
    collectorOptions:{fetchImpl:async()=>new Response('<rss><channel><title>Test</title></channel></rss>')},
    analysisOptions:{fetchText:async()=>({text:`<article>${page}</article>`}),analyze:async()=>({summary:'本次没有新机会',highlights:[],ideas:[]})},
    xOptions:{runner:xRunner || (async()=>{throw new Error('AIsa must never be called');})}});
  t.after(async()=>{await manager.close();store.close();await rm(dir,{recursive:true,force:true});});
  return {dir,store,manager};
}

test('draft job re-reads selected evidence, persists a review suggestion and leaves brief/input unchanged',async t=>{
  let reads=0, modelCalls=0;
  const f=await fixture(t,{fetchText:async requested=>{reads++;assert.equal(requested,url);return {text:`<article>${page}</article>`};},analyze:async({prompt,schema})=>{
    modelCalls++;assert.match(prompt,/待审阅/);assert.match(prompt,/没有实际验证/);assert.deepEqual(schema.properties.sourceUrls.items.enum,[url]);return modelOutput();}});
  const oldBrief=await readFile(join(f.dir,'briefs',date+'.json'),'utf8'), request=input(), prior=structuredClone(request);
  const job=f.manager.start(request); await f.manager.idle();
  const result=f.manager.ops.getJob(job.id);
  assert.equal(result.status,'success',result.message);assert.equal(result.result.x,null);assert.equal(result.result.rss,null);
  assert.equal(result.result.draft.verification,'original-page');assert.deepEqual(result.result.draft.sourceUrls,[url]);
  assert.ok(Number.isFinite(Date.parse(result.result.draft.generatedAt)));assert.equal(reads,1);assert.equal(modelCalls,1);
  const stored=JSON.parse(await readFile(join(f.dir,'drafts',job.id+'.json'),'utf8'));
  assert.equal(stored.status,'needs-review');assert.equal(stored.body,body);assert.equal(stored.evidence.text,page);
  assert.equal(stored.evidence.supportingQuote,modelOutput().supportingQuote);
  assert.match(await readFile(join(f.dir,'drafts',job.id+'.md'),'utf8'),/待审阅/);
  assert.equal(await readFile(join(f.dir,'briefs',date+'.json'),'utf8'),oldBrief);assert.deepEqual(request,prior);
});

test('draft input rejects paths, invalid dates, private URLs, extra fields and non-string or oversized text before scheduling',async t=>{
  const {manager}=await fixture(t);
  for(const request of [
    {...input(),briefDate:'../2026-09-13'}, {...input(),briefDate:'2026-02-30'},
    {...input(),sourceUrl:'https://127.0.0.1/private'}, {...input(),sourceUrl:'https://example.org/video-guide#part'},
    {...input(),draft:{...input().draft,notes:[]}},{...input(),draft:{...input().draft,notes:'x'.repeat(12001)}},
    {...input(),draft:{...input().draft,secret:'extra'}},{...input(),quoteId:'wrong-kind'},
    {kind:'refresh',draft:input().draft},
  ])assert.throws(()=>manager.start(request));
  assert.equal(manager.ops.jobs().length,0);
});

test('draft refuses an unselected or missing source without fetching or invoking Codex',async t=>{
  let calls=0;const {manager}=await fixture(t,{fetchText:async()=>{calls++;throw new Error();},analyze:async()=>{calls++;return modelOutput();}});
  manager.start({...input(),sourceUrl:'https://example.org/unselected'});await manager.idle();
  assert.equal(manager.ops.jobs()[0].status,'failed');assert.equal(calls,0);
  manager.start({...input(),briefDate:'2026-09-12'});await manager.idle();
  assert.equal(manager.ops.jobs()[0].status,'failed');assert.equal(calls,0);
});

test('unreadable page uses only an explicitly marked RSS excerpt; unavailable non-feed evidence fails',async t=>{
  const f=await fixture(t,{fetchText:async()=>{throw new Error('unreadable');},analyze:async({prompt})=>{assert.match(prompt,/feed-excerpt/);assert.match(prompt,/未读取原文正文/);return {...modelOutput(),body:body+'我还没有阅读全文，之后需要对照原文核查。'};}});
  f.manager.start(input());await f.manager.idle();assert.equal(f.manager.ops.jobs()[0].result.draft.verification,'feed-excerpt');
  const noFeed=await fixture(t,{sourceId:'aisa-x',fetchText:async()=>{throw new Error('unreadable');},analyze:async()=>{assert.fail('must not invoke model');}});
  noFeed.manager.start(input());await noFeed.manager.idle();assert.equal(noFeed.manager.ops.jobs()[0].status,'failed');
});

test('invalid model prose, unsupported quantities and invented sources fail without saving drafts',async t=>{
  let output;const {dir,manager}=await fixture(t,{analyze:async()=>output});
  for(const invalid of [
    {...modelOutput(),sourceUrls:['https://example.org/not-evidence']},
    {...modelOutput(),body:body+' https://evil.example/unrelated'},
    {...modelOutput(),title:'English only'}, {...modelOutput(),questions:['English only']},
    {...modelOutput(),supportingQuote:'not present in the source'},
    {...modelOutput(),body:body+'处理速度提升了99%。'},
    {...modelOutput(),body:body+'我亲自实测，确实更加好用。'},
    {...modelOutput(),body:body+'我实测后发现，这个方法确实好用。'},
    {...modelOutput(),body:'太短了。'},
  ]){
    output=invalid;manager.start(input());await manager.idle();assert.equal(manager.ops.jobs()[0].status,'failed',JSON.stringify(invalid));
  }
  assert.deepEqual(await readdir(join(dir,'drafts')).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e)),[]);
});

test('draft respects job exclusion and cancellation before saving',async t=>{
  let enter;const entered=new Promise(resolve=>{enter=resolve;});
  const {manager,dir}=await fixture(t,{analyze:async({signal})=>{enter();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const job=manager.start(input());await entered;
  assert.throws(()=>manager.start({kind:'refresh'}),/正在|任务/);manager.cancel(job.id);await manager.idle();
  assert.equal(manager.ops.getJob(job.id).status,'cancelled');assert.equal(manager.activeJob(),null);
  assert.deepEqual(await readdir(join(dir,'drafts')).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e)),[]);
});

test('free refresh never quotes or calls AIsa even when legacy automatic X is enabled',async t=>{
  let calls=0;const {manager}=await fixture(t,{xRunner:async()=>{calls++;throw new Error('unexpected paid dependency');}});
  manager.saveSettings({x:{enabled:true,acceptUncappedEstimate:true,handles:['OpenAI']}});
  manager.start({kind:'refresh'});await manager.idle();
  assert.equal(calls,0);assert.equal(manager.ops.jobs()[0].result.x,null);assert.equal(manager.ops.jobs()[0].status,'success');
});
