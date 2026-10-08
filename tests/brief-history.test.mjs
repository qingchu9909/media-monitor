import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as briefs from '../server/briefs.mjs';
import { generateBrief } from '../server/analysis.mjs';
import { openStore } from '../server/store.mjs';

const url=name=>'https://example.org/'+name;
const document=(date,names)=>({date,title:'当天的内容机会',generatedAt:date+'T04:00:00Z',status:'reviewed',summary:'根据已有原文整理。',generationMethod:'Codex 根据公开证据整理',highlights:names.map(name=>({url:url(name),titleZh:'镜头制作 '+name,summaryZh:'介绍镜头规划方法。',whyItMatters:'可以对照检查制作流程。',sourceName:'官方',publishedAt:'2026-09-01T01:02:03Z',verification:'original-page',supportingQuote:'checking shot continuity'})),ideas:[],coverage:[],caveats:[]});
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'monitor-brief-history-'));await mkdir(join(dir,'briefs'));await mkdir(join(dir,'reports'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const save=async value=>writeFile(join(dir,'briefs',value.date+'.json'),JSON.stringify(value));
  return {dir,save};
}

test('legacy daily briefs derive first recommendation by canonical URL while keeping original publication dates',async t=>{
  const {dir,save}=await fixture(t);
  const old=document('2026-09-12',['follow']);old.highlights[0].url+='?utm_source=test#top';await save(old);
  await save(document('2026-09-13',['follow','yesterday']));await save(document('2026-09-14',['follow','yesterday','today']));
  const current=await briefs.getBrief(dir,'2026-09-14');
  assert.deepEqual(current.highlights.map(h=>[h.firstRecommendedDate,h.newToBrief]),[['2026-09-12',false],['2026-09-13',false],['2026-09-14',true]]);
  assert.ok(current.highlights.every(h=>h.publishedAt==='2026-09-01T01:02:03.000Z'));
  assert.match(current.markdown,/继续跟进.*2026-09-12/);assert.match(current.markdown,/本日新增/);
  const first=await briefs.getBrief(dir,'2026-09-12');assert.equal(first.highlights[0].newToBrief,true);
  const saved=JSON.parse(await readFile(join(dir,'briefs','2026-09-14.json'),'utf8'));
  assert.equal(saved.highlights[0].firstRecommendedDate,undefined,'read-only lookup must not rewrite old files');
});

test('current and future briefs, nested history and symlink files cannot masquerade as earlier daily recommendations',async t=>{
  const {dir,save}=await fixture(t);await save(document('2026-09-14',['today']));await save(document('2026-09-15',['today']));
  await mkdir(join(dir,'briefs','history'));await writeFile(join(dir,'briefs','history','2026-09-10.json'),JSON.stringify(document('2026-09-10',['today'])));
  await writeFile(join(dir,'other.json'),JSON.stringify(document('2026-09-09',['today'])));await symlink(join(dir,'other.json'),join(dir,'briefs','2026-09-09.json'));
  await writeFile(join(dir,'briefs','2026-09-11.json'),'{broken');
  const current=await briefs.getBrief(dir,'2026-09-14');
  assert.equal(current.highlights[0].firstRecommendedDate,'2026-09-14');assert.equal(current.highlights[0].newToBrief,true);
});

test('decoration is non-mutating and persisted first-date metadata survives missing older files',async t=>{
  const {dir,save}=await fixture(t);await save(document('2026-09-12',['follow']));
  const current=document('2026-09-14',['follow','today']);const before=structuredClone(current);
  const decorated=await briefs.decorateBriefHistory(dir,current);
  assert.deepEqual(current,before);assert.equal(decorated.highlights[0].publishedAt,before.highlights[0].publishedAt);
  assert.deepEqual({...decorated,highlights:decorated.highlights.map(({firstRecommendedDate,newToBrief,...h})=>h)},before);
  await save(decorated);await rm(join(dir,'briefs','2026-09-12.json'));
  const reopened=await briefs.getBrief(dir,'2026-09-14');assert.equal(reopened.highlights[0].firstRecommendedDate,'2026-09-12');assert.equal(reopened.highlights[0].newToBrief,false);
  const invalid=document('2026-09-15',['new']);invalid.highlights[0].firstRecommendedDate='2026-02-30';invalid.highlights[0].newToBrief=false;
  assert.equal((await briefs.decorateBriefHistory(dir,invalid)).highlights[0].newToBrief,true);
  invalid.highlights[0].firstRecommendedDate='2026-09-16';assert.equal((await briefs.decorateBriefHistory(dir,invalid)).highlights[0].firstRecommendedDate,'2026-09-15');
});

test('catalog and detail views agree on first recommendation without treating the latest brief as history',async t=>{
  const {dir,save}=await fixture(t);await save(document('2026-09-13',['follow']));await save(document('2026-09-14',['follow','today']));
  const catalog=await briefs.readBriefCatalog(dir), current=await briefs.getBrief(dir,'2026-09-14');
  assert.deepEqual(catalog.briefs.map(b=>b.date),['2026-09-14','2026-09-13']);
  assert.deepEqual(current.highlights.map(h=>[h.firstRecommendedDate,h.newToBrief]),[['2026-09-13',false],['2026-09-14',true]]);
  for(const h of current.highlights){assert.equal(catalog.analysisByUrl[h.url].firstRecommendedDate,h.firstRecommendedDate);assert.equal(catalog.analysisByUrl[h.url].newToBrief,h.newToBrief);}
});

test('new daily analysis automatically persists recommendation metadata in JSON and Markdown',async t=>{
  const {dir,save}=await fixture(t);const store=openStore(dir);t.after(()=>store.close());
  await save(document('2026-09-13',['follow']));
  const page='The official video editing guide explains character reference sheets and checking shot continuity across a sequence. It recommends reviewing the final edit before sharing the video.';
  for(const name of ['follow','today'])store.upsertItems('openai',[{url:url(name),title:'OpenAI video editing workflow '+name,summary:page,publishedAt:'2026-09-14T01:00:00Z'}]);
  const result=await generateBrief({store,now:new Date('2026-09-14T04:00:00Z'),fetchText:async()=>({text:'<article>'+page+'</article>'}),analyze:async()=>({summary:'两份可以对照的创作指南。',highlights:['follow','today'].map(name=>({url:url(name),titleZh:'镜头制作 '+name,summaryZh:'来源介绍镜头连续性检查。',whyItMatters:'可以对照检查剪辑。',supportingQuote:'checking shot continuity'})),ideas:[]})});
  const saved=JSON.parse(await readFile(join(dir,'briefs','2026-09-14.json'),'utf8'));
  assert.deepEqual(saved.highlights.map(h=>[h.firstRecommendedDate,h.newToBrief]),[['2026-09-13',false],['2026-09-14',true]]);
  assert.deepEqual(result.highlights.map(h=>h.newToBrief),[false,true]);
  const md=await readFile(join(dir,'reports','2026-09-14-brief.md'),'utf8');assert.match(md,/本日新增/);assert.match(md,/继续跟进.*2026-09-13/);
});
