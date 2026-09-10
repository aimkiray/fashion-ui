const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

test('submitComfyWorkflowWithProgress trips circuit breaker after 10 consecutive 502 responses', async () => {
  const { submitComfyWorkflowWithProgress } = require('../../src/comfy/client');
  const originalFetch = global.fetch;
  const origSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => origSetTimeout(fn, 1);

  let pollCount = 0;
  global.fetch = async (url, opts) => {
    if (url.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'test-cb-prompt' }), { status: 200 });
    if (url.includes('/history/')) {
      pollCount++;
      return new Response('502 Bad Gateway', { status: 502, statusText: 'Bad Gateway' });
    }
    return originalFetch(url, opts);
  };

  try {
    await assert.rejects(
      async () => {
        await submitComfyWorkflowWithProgress({}, () => {});
      },
      /ComfyUI 服务响应异常 \(HTTP 502/
    );
    assert.equal(pollCount, 10, 'must abort at exactly 10 consecutive failures');
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = origSetTimeout;
  }
});

test('submitComfyWorkflowWithProgress resets consecutive errors upon receiving 200 OK', async () => {
  const { submitComfyWorkflowWithProgress } = require('../../src/comfy/client');
  const originalFetch = global.fetch;
  const origSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => origSetTimeout(fn, 1);

  let pollCount = 0;
  global.fetch = async (url, opts) => {
    if (url.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'test-cb-reset' }), { status: 200 });
    if (url.includes('/history/')) {
      pollCount++;
      if (pollCount < 10) {
        return new Response('502 Bad Gateway', { status: 502, statusText: 'Bad Gateway' });
      }
      return new Response(JSON.stringify({ 'test-cb-reset': { status: { completed: true } } }), { status: 200 });
    }
    return originalFetch(url, opts);
  };

  try {
    const entry = await submitComfyWorkflowWithProgress({}, () => {});
    assert.ok(entry && entry.status && entry.status.completed);
    assert.equal(pollCount, 10, 'must have recovered on the 10th attempt without tripping breaker');
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = origSetTimeout;
  }
});

test('cancelBatchJob returns false when batch is already completed, error, or cancelled', () => {
  const { batchJobs, cancelBatchJob } = require('../../src/store/tasks');
  const bComp = `test-b-comp-${Date.now()}`;
  batchJobs.set(bComp, { id: bComp, status: 'completed' });
  assert.equal(cancelBatchJob(bComp), false);
  assert.equal(batchJobs.get(bComp).status, 'completed');

  const bErr = `test-b-err-${Date.now()}`;
  batchJobs.set(bErr, { id: bErr, status: 'error' });
  assert.equal(cancelBatchJob(bErr), false);
  assert.equal(batchJobs.get(bErr).status, 'error');

  const bCanc = `test-b-canc-${Date.now()}`;
  batchJobs.set(bCanc, { id: bCanc, status: 'cancelled' });
  assert.equal(cancelBatchJob(bCanc), false);
  assert.equal(batchJobs.get(bCanc).status, 'cancelled');

  batchJobs.delete(bComp);
  batchJobs.delete(bErr);
  batchJobs.delete(bCanc);
});

test('generateReferenceImage respects aborted signal immediately across image engines', async () => {
  const { generateReferenceImage } = require('../../services/imagegen');
  const ac = new AbortController();
  ac.abort();

  await assert.rejects(
    () => generateReferenceImage({
      engine: 'gpt_image_2',
      task: { image: 'test.png', aspect_ratio: '3:4', scene: { id: 'street' } },
      taskId: 't-aborted-gpt',
      prompt: 'test prompt',
      signal: ac.signal
    }),
    /任务已被用户取消/
  );

  await assert.rejects(
    () => generateReferenceImage({
      engine: 'krea2',
      task: { image: 'test.png', aspect_ratio: '3:4', scene: { id: 'street' } },
      taskId: 't-aborted-krea',
      prompt: 'test prompt',
      signal: ac.signal,
      context: { workflowsDir: require('../../src/paths').WORKFLOWS_DIR }
    }),
    /任务已被用户取消/
  );
});

test('server.js boots without HOST ReferenceError and shuts down cleanly on SIGTERM', async () => {
  const testPort = 3899;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(testPort), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { output += d.toString(); });

  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server failed to boot in 3s. Output: ${output}`)), 3000);
    const interval = setInterval(() => {
      if (output.includes('AI Fashion Studio Web UI is running at')) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(true);
      }
    }, 50);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearInterval(interval);
      clearTimeout(timer);
      reject(new Error(`Server exited prematurely with code ${code}. Output: ${output}`));
    });
  });

  assert.ok(started, 'server should output startup banner');
  assert.ok(output.includes(`http://localhost:${testPort}`));

  const exitPromise = new Promise(resolve => child.on('exit', resolve));
  child.kill('SIGTERM');
  const exitCode = await exitPromise;
  assert.equal(exitCode, 0, 'server should exit with code 0 on SIGTERM');
});
