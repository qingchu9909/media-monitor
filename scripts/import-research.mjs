#!/usr/bin/env node
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, InputError } from '../server/store.mjs';
import { importWebResearch, validateResearchPayload, MAX_RESEARCH_BYTES } from '../server/web-research.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function importResearchFile(file, { dataDir = join(root, 'data'), ...options } = {}) {
  if (typeof file !== 'string' || !file) throw new InputError('需要网页研究 JSON 文件路径');
  const handle = await open(resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  let payload;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_RESEARCH_BYTES) throw new InputError('网页研究文件必须为不超过 1 MB 的普通文件');
    try { payload = JSON.parse(await handle.readFile('utf8')); } catch { throw new InputError('网页研究文件不是有效 JSON'); }
  } finally { await handle.close(); }
  validateResearchPayload(payload, options.now ?? new Date());
  const store = openStore(dataDir);
  try { return await importWebResearch({ store, payload, ...options }); }
  finally { store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, ...args] = process.argv.slice(2);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    if (!file || (args.length && (args.length !== 2 || args[0] !== '--data-dir' || !args[1]))) throw new InputError('用法：node scripts/import-research.mjs <网页研究.json> [--data-dir 目录]');
    console.log(JSON.stringify(await importResearchFile(file, { ...(args.length ? { dataDir: resolve(args[1]) } : {}), signal: controller.signal }), null, 2));
  } catch (error) { console.error(error.name === 'AbortError' ? '网页研究导入已取消' : error.message); process.exitCode = 1; }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
