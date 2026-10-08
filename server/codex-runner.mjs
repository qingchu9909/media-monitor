import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { constants } from 'node:fs';
import { InputError } from './store.mjs';

const execute = promisify(execFile);
let cachedCapabilities;
export async function codexPath(env = process.env) {
  const candidates = [env.MEDIA_MONITOR_CODEX, ...String(env.PATH || '').split(':').filter(Boolean).map(dir => join(dir, 'codex')), '/Applications/ChatGPT.app/Contents/Resources/codex'];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installed executable. */ }
  }
  return null;
}
export async function codexCapabilities({ force = false } = {}) {
  if (!force && cachedCapabilities && Date.now() - cachedCapabilities.checkedAt < 60000) return cachedCapabilities.value;
  const command = await codexPath();
  let authenticated = false;
  if (command) {
    try {
      const result = await execute(command, ['login', 'status'], { timeout: 10000, maxBuffer: 8192 });
      authenticated = /logged in using chatgpt/i.test(result.stdout + '\n' + result.stderr);
    } catch { /* An installed executable is not authentication evidence. */ }
  }
  const value = { codexInstalled: Boolean(command), codexAuthenticated: authenticated };
  cachedCapabilities = { checkedAt: Date.now(), value };
  return value;
}

export async function runCodexAnalysis({ prompt, schema, signal, timeoutMs = 300000, spawnImpl = spawn }) {
  const executable = await codexPath();
  if (!executable) throw new InputError('未找到 Codex CLI，请先安装并使用 ChatGPT 登录', 503);
  const directory = await mkdtemp(join(tmpdir(), 'media-monitor-analysis-'));
  const schemaPath = join(directory, 'schema.json');
  const outputPath = join(directory, 'result.json');
  await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'multi_agent',
    '--disable', 'skill_search', '--enable', 'skip_host_skill_discovery',
    '-c', 'web_search="disabled"', '-c', 'approval_policy="never"', '-c', 'model_reasoning_effort="low"',
    '--cd', directory, '--output-schema', schemaPath, '--output-last-message', outputPath, '--color', 'never', '--json', '-'];
  try {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const child = spawnImpl(executable, args, { cwd: directory, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let settled = false, outputBytes = 0, failedEvent = false, completedEvent = false, timedOut = false;
      let stdout = '', errorClass = '';
      const parseEvent = line => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'turn.failed' || event.type === 'error') failedEvent = true;
          if (event.type === 'turn.started') completedEvent = false;
          if (event.type === 'turn.completed') completedEvent = true;
        } catch { /* Ignore progress text; only a parsed completion proves success. */ }
      };
      const stop = () => {
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 2000);
        force.unref();
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      const aborted = () => stop();
      signal?.addEventListener('abort', aborted, { once: true });
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        error ? reject(error) : resolve();
      };
      child.stdout.on('data', data => {
        outputBytes += data.length;
        if (outputBytes > 4 * 1024 * 1024) { errorClass = '输出超过限制'; stop(); return; }
        stdout += data.toString();
        const lines = stdout.split('\n'); stdout = lines.pop();
        for (const line of lines) parseEvent(line);
      });
      child.stderr.on('data', data => {
        const text = data.toString().toLowerCase();
        if (/rate.limit|usage.limit|quota|429/.test(text)) errorClass = 'Codex 可用额度或速率受限，请稍后再试';
        if (/not.logged.in|unauthorized|authentication|401/.test(text)) errorClass = 'Codex 登录需要重新验证';
      });
      child.on('error', () => finish(new InputError('Codex 无法启动，请检查本机安装和登录', 503)));
      child.on('close', code => {
        if (stdout.trim()) parseEvent(stdout);
        if (signal?.aborted) return finish(new DOMException('任务已取消', 'AbortError'));
        if (timedOut) return finish(new InputError('Codex 分析超过 5 分钟，已停止；上一份简报保留', 504));
        if (code !== 0 || failedEvent || !completedEvent || errorClass) return finish(new InputError(errorClass || 'Codex 分析未成功完成；上一份简报保留', 502));
        finish();
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
    signal?.throwIfAborted();
    let raw;
    try { raw = await readFile(outputPath, 'utf8'); }
    catch { throw new InputError('Codex 未写入结构化结果，上一份简报保留', 502); }
    if (!raw.trim() || Buffer.byteLength(raw) > 1024 * 1024) throw new InputError('Codex 返回为空或超过大小限制', 502);
    try { return JSON.parse(raw); } catch { throw new InputError('Codex 未返回有效结构化结果，上一份简报保留', 502); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
