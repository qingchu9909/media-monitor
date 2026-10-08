import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAisa } from '../server/aisa-normalize.mjs';

test('X retains original URL and real publication time', () => {
  const items = normalizeAisa('x', {tweets:[{id:'123',url:'https://x.com/demo/status/123',text:'A new model',createdAt:'2026-09-11T10:00:00Z'}]});
  assert.equal(items[0].url,'https://x.com/demo/status/123');
  assert.equal(items[0].publishedAt,'2026-09-11T10:00:00.000Z');
});
test('YouTube relative publication dates stay unknown and duplicate sections collapse', () => {
  const v={id:'abcdefghijk',title:'Agent tutorial',link:'https://www.youtube.com/watch?v=abcdefghijk',published_time:'2 days ago'};
  const items=normalizeAisa('youtube',{videos:[v],sections:[{items:[v]}]});
  assert.equal(items.length,1);
  assert.equal(items[0].publishedAt,null);
});
test('Reddit resolves public relative permalink and epoch date', () => {
  const items=normalizeAisa('reddit',{success:true,posts:[{title:'AI discussion',permalink:'/r/artificial/comments/abc/test/',created_utc:0,selftext:'Discussion'}]});
  assert.equal(items[0].url,'https://www.reddit.com/r/artificial/comments/abc/test/');
  assert.equal(items[0].publishedAt,'1970-01-01T00:00:00.000Z');
});
test('Reddit missing permalink preserves distinct fallback URLs', () => {
  const items=normalizeAisa('reddit',{posts:[{title:'One',url:'https://www.reddit.com/r/ai/comments/abc/one'},{title:'Two',permalink:'',url:'https://www.reddit.com/r/ai/comments/def/two'}]});
  assert.equal(items.length,2);
  assert.equal(items[0].url,'https://www.reddit.com/r/ai/comments/abc/one');
});
test('Failed and unknown envelopes never become successful empty collections', () => {
  assert.throws(()=>normalizeAisa('x',{success:false,error:'not authenticated'}));
  assert.throws(()=>normalizeAisa('x',{message:'quota exceeded'}));
  assert.throws(()=>normalizeAisa('web',{results:[{successful:false,error:'failed'}]}));
  assert.throws(()=>normalizeAisa('web',{results:[{call_id:'c1',tool:'post_tavily_search',successful:true,data:{results:[{title:'Valid',url:'https://example.com/a'}]}}]}),/batch|批量/i);
});
test('Importer rejects unsafe schemes, and supports a successful explicit data envelope', () => {
  const items=normalizeAisa('web',{data:{results:[{title:'bad',url:'javascript:alert(1)'},{title:'Research',url:'https://example.org/article',content:'Summary'}]}});
  assert.equal(items.length,1);
  assert.equal(items[0].title,'Research');
  assert.equal(items[0].publishedAt,null);
});
