import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCodexAnalysis, codexPath } from '../server/codex-runner.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-codex-fixture-'));
  const executable = join(dir, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const previous = process.env.MEDIA_MONITOR_CODEX;
  process.env.MEDIA_MONITOR_CODEX = executable;
  t.after(async () => { if (previous === undefined) delete process.env.MEDIA_MONITOR_CODEX; else process.env.MEDIA_MONITOR_CODEX = previous; await rm(dir, { recursive: true, force: true }); });
}

function fakeSpawn({ chunks = ['{"type":"turn.completed"}\n'], exitCode = 0, result = '{"summary":"fixture"}', controller, hang = false } = {}) {
  return (_file, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false;
    const close = code => { if (!closed) { closed = true; child.emit('close', code); } };
    child.kill = () => { queueMicrotask(() => close(null)); return true; };
    setImmediate(async () => {
      try {
        if (result !== null) await writeFile(args[args.indexOf('--output-last-message') + 1], result);
        for (const chunk of chunks) child.stdout.write(chunk);
        if (controller) controller.abort();
        if (!hang && !controller) close(exitCode);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  };
}

test('a final failure without newline rejects despite an existing valid output file', async t => {
  await fixture(t);
  await assert.rejects(runCodexAnalysis({ prompt: 'fixture', schema: {}, spawnImpl: fakeSpawn({ chunks: ['{"type":"turn.completed"}\n', '{"type":"turn.failed"}'] }) }), error => error.status === 502);
});

test('a valid output file and zero exit are insufficient without explicit completion', async t => {
  await fixture(t);
  await assert.rejects(runCodexAnalysis({ prompt: 'fixture', schema: {}, spawnImpl: fakeSpawn({ chunks: ['{"type":"item.completed"}\n'] }) }), error => error.status === 502);
});

test('a split final completion without newline succeeds', async t => {
  await fixture(t);
  assert.deepEqual(await runCodexAnalysis({ prompt: 'fixture', schema: {}, spawnImpl: fakeSpawn({ chunks: ['{"type":"turn.', 'completed"}'] }) }), { summary: 'fixture' });
});

test('nonzero exit, cancellation and timeout never accept a completed result', async t => {
  await fixture(t);
  await assert.rejects(runCodexAnalysis({ prompt: 'fixture', schema: {}, spawnImpl: fakeSpawn({ exitCode: 1 }) }), error => error.status === 502);
  const controller = new AbortController();
  await assert.rejects(runCodexAnalysis({ prompt: 'fixture', schema: {}, signal: controller.signal, spawnImpl: fakeSpawn({ controller }) }), error => error.name === 'AbortError');
  await assert.rejects(runCodexAnalysis({ prompt: 'fixture', schema: {}, timeoutMs: 20, spawnImpl: fakeSpawn({ hang: true }) }), error => error.status === 504);
});

test('a completed process with no final output fails with a safe application error', async t => {
  await fixture(t);
  await assert.rejects(runCodexAnalysis({ prompt: 'fixture', schema: {}, spawnImpl: fakeSpawn({ result: null }) }), error => error.status === 502 && !error.message.includes('media-monitor-analysis-'));
});

// A launchd service can retain a minimal PATH after an app updates its bundle layout.
test('a service without Codex in PATH finds the current desktop app CLI bundle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'monitor-apps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  await mkdir(join(executable, '..'), { recursive: true });
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(await codexPath({ PATH: '/usr/bin:/bin' }, { applicationRoots: [root] }), executable);
});

test('an explicit CLI override wins over desktop discovery and broken installs are skipped', async t => {
  const root = await mkdtemp(join(tmpdir(), 'monitor-apps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'custom-codex');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(await codexPath({ PATH: '', MEDIA_MONITOR_CODEX: executable }, { applicationRoots: [root] }), executable);
  assert.equal(await codexPath({ PATH: '', MEDIA_MONITOR_CODEX: join(root, 'missing') }, { applicationRoots: [root] }), null);
});
