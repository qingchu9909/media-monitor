import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const root=fileURLToPath(new URL('../',import.meta.url));
const label='com.qingchu.media-monitor';
const domain=`gui/${process.getuid()}`;
const file=join(homedir(),'Library/LaunchAgents',`${label}.plist`);
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const action=process.argv[2]??'status';
async function verifyOwner() {
  const existing=await readFile(file,'utf8').catch(()=>null);
  if(existing&&!existing.includes(esc(root))) throw new Error('同名系统服务属于其它目录，已停止以避免覆盖。');
}
async function waitHealthy() {
  for(let i=0;i<20;i++) {
    const info=await run('launchctl',['print',`${domain}/${label}`]).catch(()=>({stdout:''}));
    if(info.stdout.includes(join(root,'server/main.mjs')) && /state = running/.test(info.stdout)) {
      const health=await fetch('http://127.0.0.1:4318/api/health',{signal:AbortSignal.timeout(800)}).then(r=>r.ok?r.json():null).catch(()=>null);
      if(health?.ok && health.app==='qingchu-media-monitor') return;
    }
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  throw new Error('服务已注册，但尚未通过运行状态与 HTTP 健康检查。请查看 .runtime/server-error.log。');
}
try {
  if(process.platform!=='darwin') throw new Error('此服务管理脚本适用于 macOS；其他系统请使用 npm start。');
  if(action==='start') {
    await access(join(root,'dist/index.html'));
    await verifyOwner();
    const live=await run('launchctl',['print',`${domain}/${label}`]).then(()=>true,()=>false);
    if(live) {await waitHealthy();console.log('服务运行正常：http://127.0.0.1:4318');process.exit(0);}
    await mkdir(join(root,'.runtime'),{recursive:true});
    await mkdir(join(homedir(),'Library/LaunchAgents'),{recursive:true});
    const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(join(root,'server/main.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${esc(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH??'/usr/bin:/bin')}</string><key>NODE_ENV</key><string>production</string></dict>
<key>StandardOutPath</key><string>${esc(join(root,'.runtime/server.log'))}</string>
<key>StandardErrorPath</key><string>${esc(join(root,'.runtime/server-error.log'))}</string>
</dict></plist>\n`;
    await writeFile(file,plist,{mode:0o600});
    await run('launchctl',['bootstrap',domain,file]);
    await waitHealthy();
    console.log('已启动登录后常驻服务：http://127.0.0.1:4318');
  } else if(action==='stop') {
    await verifyOwner();
    const info=await run('launchctl',['print',`${domain}/${label}`]);
    if(!info.stdout.includes(join(root,'server/main.mjs'))) throw new Error('运行中服务不属于此项目，停止操作已取消。');
    await run('launchctl',['bootout',`${domain}/${label}`]);
    console.log('已停止本次服务。下次登录仍自动启动；如不需要自启，将对应 plist 移出 ~/Library/LaunchAgents。');
  } else if(action==='status') {
    await verifyOwner();
    await waitHealthy();
    const result=await run('launchctl',['print',`${domain}/${label}`]);
    console.log(result.stdout.split('\n').filter(l=>/^\s*(state|pid|last exit code|runs) =/.test(l)).join('\n'));
  } else throw new Error('Use start, stop, or status');
} catch(error) {
  console.error(action==='status'?'服务未注册或未运行。':error.message);
  process.exitCode=1;
}
