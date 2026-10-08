#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openStore, InputError } from '../server/store.mjs';
import { collect } from '../server/collector.mjs';
import { renderReport } from '../server/report.mjs';
import { PROJECT_DIR, aisaStatus } from '../server/main.mjs';

const [command = 'status', ...args] = process.argv.slice(2);
const options = {};
for (let n = 0; n < args.length; n++) {
  if (['--data-dir', '--out', '--source'].includes(args[n]) && args[n + 1] && !args[n + 1].startsWith('--')) options[args[n].slice(2)] = args[++n];
  else { console.error('用法：node scripts/monitor.mjs collect|report|status [--data-dir 路径] [--source 来源ID] [--out 日报路径]'); process.exit(1); }
}
const dataDir = options['data-dir'] ? resolve(options['data-dir']) : join(PROJECT_DIR, 'data');
const store = openStore(dataDir);
try {
  if (command === 'collect') {
    const result = await collect(store, options.source ? { sourceIds: options.source.split(',') } : {});
    console.log(JSON.stringify(result, null, 2)); if (result.status === 'failed') process.exitCode = 1;
  } else if (command === 'report') {
    const report = renderReport(store);
    if (options.out) { const path = resolve(options.out); await mkdir(dirname(path), { recursive: true }); await writeFile(path, report, 'utf8'); console.log(`日报已保存：${path}`); }
    else process.stdout.write(`${report}\n`);
  } else if (command === 'status') {
    console.log(JSON.stringify({ running: store.isCollecting(), items: store.itemCount(), topics: store.listTopics(), sources: store.listSources(), latestRun: store.listRuns(1)[0] ?? null, ...aisaStatus({ dataDir }) }, null, 2));
  } else throw new InputError('命令须为 collect、report 或 status');
} catch (error) { console.error(error instanceof InputError ? error.message : '操作失败，请检查来源连接或本地数据目录。'); process.exitCode = 1; }
finally { store.close(); }
