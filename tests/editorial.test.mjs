import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateValue,validateEditorial} from '../server/editorial.mjs';
import {selectCandidates} from '../server/analysis.mjs';

test('creator priorities rank practical video evidence above generic tool updates',()=>{
 const video=candidateValue({title:'ComfyUI video editing workflow guide',summary:'The open source example shows how to crop generated footage and connect shots into a continuous video.'});
 const generic=candidateValue({title:'OpenAI service configuration update',summary:'The service adds deployment configuration settings and lets developers choose their default API behavior.'});
 assert.ok(video.score>generic.score);assert.equal(video.category,'video');
});
test('promotion and content-free builds stay out of recommendations without deleting source items',()=>{
 assert.equal(candidateValue({title:'GitHub Universe',summary:'Grab your in-person pass and secure your hackable badge'}),null);
 assert.equal(candidateValue({title:'Release v0.61.0-nightly.20260913',summary:'Full Changelog: v0.61.0...'}),null);
 assert.ok(candidateValue({title:'Claude Code fixes permissions in read-only commands',summary:'The release fixes a regression affecting existing sessions.'}));
});
test('preferences are bounded and cannot grant paid capabilities',()=>{
 assert.throws(()=>validateEditorial({windowDays:365})); assert.throws(()=>validateEditorial({paid:true}));
 assert.equal(validateEditorial({focus:'tools'}).focus,'tools');
});
test('expanded recommendation window preserves real dates and excludes unknown or future publications',()=>{
 const now=new Date('2026-09-13T04:00:00Z');
 const base={sourceId:'video',sourceIds:['video'],topicIds:['video'],title:'ComfyUI video workflow guide',summary:'A practical tutorial for generating consistent shots.'};
 const items=[{...base,url:'https://example.org/older',publishedAt:'2026-09-10T02:00:00Z'}, {...base,url:'https://example.org/future',publishedAt:'2099-01-01'}, {...base,url:'https://example.org/unknown',publishedAt:null}];
 assert.deepEqual(selectCandidates(items,now,validateEditorial({windowDays:7})).map(x=>x.url),['https://example.org/older']);
 assert.deepEqual(selectCandidates(items,now,validateEditorial({windowDays:1})),[]);
});
