const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Guard rail: no test may ever create the default 'D:/Comfy/...' tree locally.
// Must be set BEFORE anything requires src/paths (which snapshots env at import).
process.env.COMFY_DIR = process.env.COMFY_DIR || path.join(os.tmpdir(), 'fashion-test-comfy');

test('loadEnv() hydrates process.env from .env before any env snapshot', () => {
  const envPath = path.join(ROOT, '.env');
  const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const readDotEnv = (key) => {
    const m = raw.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
  };

  // Simulate the refactored boot order: nothing set → loadEnv() → snapshot.
  // (On a fresh clone without .env this asserts the loadEnv contract shape only.)
  const saved = { remote: process.env.COMFY_REMOTE, url: process.env.COMFY_URL };
  delete process.env.COMFY_REMOTE;
  delete process.env.COMFY_URL;
  const { loadEnv } = require('../../services/config');
  loadEnv();

  if (readDotEnv('COMFY_REMOTE') !== undefined) {
    assert.equal(process.env.COMFY_REMOTE, readDotEnv('COMFY_REMOTE'),
      '.env COMFY_REMOTE must survive the loadEnv() → src/paths snapshot order');
  }
  if (readDotEnv('COMFY_URL') !== undefined) {
    assert.equal(process.env.COMFY_URL, readDotEnv('COMFY_URL'));
  }
  // restore so the paths-snapshot test below controls its own env
  if (saved.remote === undefined) delete process.env.COMFY_REMOTE; else process.env.COMFY_REMOTE = saved.remote;
  if (saved.url === undefined) delete process.env.COMFY_URL; else process.env.COMFY_URL = saved.url;
});

test('src/paths honors env set BEFORE its import (remote mode sanity)', () => {
  const saved = process.env.COMFY_REMOTE;
  delete require.cache[require.resolve('../../src/paths')];
  process.env.COMFY_REMOTE = '1';
  const p = require('../../src/paths');
  assert.equal(p.COMFY_REMOTE, true);
  assert.equal(p.COMFY_WS_URL, p.COMFY_URL.replace(/^http/, 'ws'));
  // restore: env AND module cache, so later tests get an unbiased instance
  if (saved === undefined) delete process.env.COMFY_REMOTE; else process.env.COMFY_REMOTE = saved;
  delete require.cache[require.resolve('../../src/paths')];
});

test('ensureStorageDirs: project storage always; COMFY dirs only in local mode', () => {
  const saved = process.env.COMFY_REMOTE;
  delete require.cache[require.resolve('../../src/paths')];
  delete process.env.COMFY_REMOTE; // force local mode so the COMFY branch is deterministic
  const { ensureStorageDirs, COMFY_DIR, COMFY_REMOTE, COMFY_TEMP_INPUT_DIR } = require('../../src/paths');
  try {
    assert.equal(COMFY_REMOTE, false, 'test must run paths in local mode');
    assert.ok(COMFY_DIR.startsWith(os.tmpdir()), `COMFY_DIR must be redirected in tests, got: ${COMFY_DIR}`);
    ensureStorageDirs();
    ensureStorageDirs();
    assert.ok(fs.existsSync(path.join(ROOT, 'storage', 'outputs', 'videos')));
    assert.ok(fs.existsSync(COMFY_TEMP_INPUT_DIR), 'local mode must create the Comfy temp input dir');
  } finally {
    if (saved === undefined) delete process.env.COMFY_REMOTE; else process.env.COMFY_REMOTE = saved;
    delete require.cache[require.resolve('../../src/paths')];
  }
});

test('startTaskCleanupTimer / startIdleReleaseTimer are singletons', () => {
  const { startTaskCleanupTimer } = require('../../src/store/tasks');
  const { startIdleReleaseTimer } = require('../../src/comfy/idleRelease');
  const t1 = startTaskCleanupTimer();
  const t2 = startTaskCleanupTimer();
  assert.equal(t1, t2);
  const i1 = startIdleReleaseTimer();
  const i2 = startIdleReleaseTimer();
  assert.equal(i1, i2);
  // unref'd so they never hold the process open (graceful shutdown friendly)
  assert.equal(typeof t1.hasRef, 'function');
  assert.equal(t1.hasRef(), false);
  assert.equal(i1.hasRef(), false);
});

test('evictStale drops finished tasks/batches but never in-flight ones', () => {
  const { tasks, batchJobs, evictStale } = require('../../src/store/tasks');
  const now = Date.now();
  const old = new Date(now - 3 * 60 * 60 * 1000).toISOString(); // 3h ago > 2h maxAge
  const mark = `evict-test-${now}`;
  const entries = {
    tDone: { id: `${mark}-t-done`, status: 'completed', createdAt: old },
    tRun: { id: `${mark}-t-run`, status: 'running', createdAt: old },
    tQueue: { id: `${mark}-t-queue`, status: 'queued', createdAt: old },
    bDone: { id: `${mark}-b-done`, status: 'completed', createdAt: old },
    bRun: { id: `${mark}-b-run`, status: 'running', createdAt: old },
    bQueue: { id: `${mark}-b-queue`, status: 'queued', createdAt: old }
  };
  tasks.set(entries.tDone.id, entries.tDone);
  tasks.set(entries.tRun.id, entries.tRun);
  tasks.set(entries.tQueue.id, entries.tQueue);
  batchJobs.set(entries.bDone.id, entries.bDone);
  batchJobs.set(entries.bRun.id, entries.bRun);
  batchJobs.set(entries.bQueue.id, entries.bQueue);

  try {
    evictStale(now);
    assert.equal(tasks.has(entries.tDone.id), false, 'finished task must be evicted');
    assert.equal(tasks.has(entries.tRun.id), true, 'running task must survive');
    assert.equal(tasks.has(entries.tQueue.id), true, 'queued task must survive');
    assert.equal(batchJobs.has(entries.bDone.id), false, 'finished batch must be evicted');
    assert.equal(batchJobs.has(entries.bRun.id), true, 'running batch must survive');
    assert.equal(batchJobs.has(entries.bQueue.id), true, 'queued batch must survive');
  } finally {
    for (const e of Object.values(entries)) {
      tasks.delete(e.id);
      batchJobs.delete(e.id);
    }
  }
});

test('evictStale respects recent createdAt (young finished entries survive)', () => {
  const { tasks, evictStale } = require('../../src/store/tasks');
  const now = Date.now();
  const young = { id: `young-${now}`, status: 'completed', createdAt: new Date(now - 60 * 1000).toISOString() };
  tasks.set(young.id, young);
  try {
    evictStale(now);
    assert.equal(tasks.has(young.id), true, '1-minute-old finished task must survive the 2h window');
  } finally {
    tasks.delete(young.id);
  }
});

test('FIFO queue serializes runners strictly (max 1 concurrent)', async () => {
  const { enqueueJob } = require('../../src/queue/fifo');
  const order = [];
  let maxConcurrent = 0;
  let concurrent = 0;
  const jobs = ['a', 'b', 'c'].map(label => enqueueJob(async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(r => setTimeout(r, label === 'b' ? 40 : 5)); // b is slowest but runs middle
    concurrent--;
    order.push(label);
  }));
  await Promise.all(jobs);
  assert.deepEqual(order, ['a', 'b', 'c'], 'start order must be FIFO regardless of duration');
  assert.equal(maxConcurrent, 1, 'no two runners may overlap');
});

test('FIFO queue survives a throwing runner', async () => {
  const { enqueueJob } = require('../../src/queue/fifo');
  const order = [];
  await enqueueJob(async () => { throw new Error('boom'); });
  await enqueueJob(async () => { order.push('after'); });
  assert.deepEqual(order, ['after']);
});

test('saveConfig synchronizes OPENAI_IMAGE_MODEL to process.env and allows clearing key', () => {
  const os = require('os');
  const { saveConfig, getRawConfig, reloadConfig } = require('../../services/config');
  const savedModel = process.env.OPENAI_IMAGE_MODEL;
  const savedKey = process.env.OPENAI_API_KEY;
  const testConfigFile = path.join(os.tmpdir(), `fashion-test-config-${Date.now()}.json`);
  process.env.CONFIG_FILE = testConfigFile;

  try {
    saveConfig({ openaiImageModel: 'test-custom-model', openaiApiKey: '' });
    assert.equal(process.env.OPENAI_IMAGE_MODEL, 'test-custom-model');
    assert.equal(getRawConfig().openaiImageModel, 'test-custom-model');
    assert.equal(process.env.OPENAI_API_KEY, '');
    assert.equal(getRawConfig().openaiApiKey, '');
  } finally {
    try { if (fs.existsSync(testConfigFile)) fs.unlinkSync(testConfigFile); } catch (e) {}
    delete process.env.CONFIG_FILE;
    if (savedModel === undefined) delete process.env.OPENAI_IMAGE_MODEL;
    else process.env.OPENAI_IMAGE_MODEL = savedModel;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    reloadConfig();
  }
});

test('submitComfyWorkflowWithProgress aborts immediately when signal is aborted', async () => {
  const { submitComfyWorkflowWithProgress } = require('../../src/comfy/client');
  const ac = new AbortController();
  ac.abort();

  await assert.rejects(
    async () => {
      await submitComfyWorkflowWithProgress({}, () => {}, { signal: ac.signal });
    },
    /任务已被用户取消/
  );
});

test('ensureStorageDirs seeds presets into PROJECT_INPUT_DIR', () => {
  const { ensureStorageDirs, PROJECT_INPUT_DIR } = require('../../src/paths');
  ensureStorageDirs();
  assert.ok(fs.existsSync(path.join(PROJECT_INPUT_DIR, 'test_outfit.png')));
  assert.ok(fs.existsSync(path.join(PROJECT_INPUT_DIR, 'outfit-streetwear.png')));
  assert.ok(fs.existsSync(path.join(PROJECT_INPUT_DIR, 'green_dress.png')));
  assert.ok(fs.existsSync(path.join(PROJECT_INPUT_DIR, 'safari_outfit.png')));
});