import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore,plainText} from '../server/store.mjs';
import {normalizeAisa,aisaSourceId} from '../server/aisa-normalize.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));

export function importAisaFile(platform,file,{dataDir=resolve(root,'data')}={}) {
  const sourceId=aisaSourceId(platform);
  if(!sourceId||!file) throw new Error('Usage: node scripts/aisa-import.mjs <x|reddit|youtube|web> <endpoint-response.json>');
  const store=openStore(dataDir);
  let runId;
  let counts={inserted:0,updated:0,total:0};
  const startedAt=new Date().toISOString();
  try {
    runId=store.beginRun([sourceId],{kind:'aisa-import'});
    const raw=readFileSync(file,'utf8');
    if(Buffer.byteLength(raw)>20*1024*1024) throw new Error('Response exceeds 20 MB');
    let response;
    try {response=JSON.parse(raw);} catch {throw new Error('Response is not valid JSON; no content imported');}
    const items=normalizeAisa(platform,response);
    counts=store.upsertItems(sourceId,items);
    store.recordSourceResult(runId,sourceId,{status:'ok',startedAt,error:null,itemCount:counts.total,inserted:counts.inserted,updated:counts.updated});
    const run=store.finishRun(runId);
    return {platform,kind:'aisa-import',runId:run.id,...counts,note:'Imported a supplied endpoint response; no live or paid AIsa call was made and authentication was not checked.'};
  } catch(error) {
    if(runId) {
      const message=plainText(error.message,300);
      try {store.recordSourceResult(runId,sourceId,{status:'error',startedAt,error:message,itemCount:counts.total,inserted:counts.inserted,updated:counts.updated});}
      finally {store.finishRun(runId,message);}
    }
    throw error;
  } finally {store.close();}
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(importAisaFile(...process.argv.slice(2))));}
  catch(error) {console.error(error.message);process.exitCode=1;}
}
