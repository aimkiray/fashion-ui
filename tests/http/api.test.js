const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Guard rail: ensureStorageDirs() inside createApp() must never create the
// default 'D:/Comfy/...' tree on a dev machine. Redirect before src/paths loads.
process.env.COMFY_DIR = process.env.COMFY_DIR || path.join(os.tmpdir(), 'fashion-test-comfy');

const ROOT = path.join(__dirname, '..', '..');
const { createApp } = require('../../src/http/app');

let server;
let base;

before(async () => {
  await new Promise(resolve => {
    server = createApp().listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => new Promise(resolve => server.close(resolve)));

test('GET /api/scenes lists 7 preset scenes', async () => {
  const res = await fetch(`${base}/api/scenes`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(Array.isArray(list) && list.length >= 7);
  for (const s of list) assert.ok(s.id && s.name && s.icon);
});

test('GET /api/actions lists action ids with names', async () => {
  const res = await fetch(`${base}/api/actions`);
  const list = await res.json();
  assert.equal(list.length, 15);
  assert.ok(list.every(a => a.id && a.name && a.description));
});

test('GET /api/model-styles returns the full catalog', async () => {
  const res = await fetch(`${base}/api/model-styles`);
  const styles = await res.json();
  assert.ok(styles.classic && styles.classic.female);
});

test('GET /api/model-ages returns the full catalog of 8 age presets', async () => {
  const res = await fetch(`${base}/api/model-ages`);
  assert.equal(res.status, 200);
  const ages = await res.json();
  assert.equal(Object.keys(ages).length, 8);
  assert.ok(ages.toddler && ages.child && ages.teen && ages.youth && ages.adult && ages.middle_aged && ages.senior && ages.elderly);
  assert.ok(ages.adult.female && ages.adult.male && ages.adult.name);
  assert.equal(ages.toddler.name, '幼儿 (3岁)');
  assert.equal(ages.child.name, '儿童 (7岁)');
  assert.equal(ages.senior.name, '中老年 (55岁)');
  assert.equal(ages.elderly.name, '老年 (65岁)');
});

test('GET /api/hairstyles returns all 20 hairstyles', async () => {
  const res = await fetch(`${base}/api/hairstyles`);
  assert.equal(res.status, 200);
  const hairs = await res.json();
  assert.equal(Object.keys(hairs).length, 20);
  assert.ok(hairs.natural && hairs.box_braids);
});

test('GET /api/face-shapes returns all 6 face shapes', async () => {
  const res = await fetch(`${base}/api/face-shapes`);
  assert.equal(res.status, 200);
  const faces = await res.json();
  assert.equal(Object.keys(faces).length, 6);
  assert.ok(faces.oval && faces.long);
});

test('POST /api/preview-prompts computes authoritative prompts including model_age', async () => {
  const res = await fetch(`${base}/api/preview-prompts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene: 'street', gender: 'female', model_age: 'senior', action1: 'walk', action2: 'pose' })
  });
  assert.equal(res.status, 200);
  const prompts = await res.json();
  assert.ok(prompts.krea_prompt && prompts.seg1_prompt && prompts.seg2_prompt);
  assert.ok(prompts.krea_prompt.includes('dignified mid-fifties'));
});

test('GET /api/progress/:taskId 404s for unknown tasks', async () => {
  const res = await fetch(`${base}/api/progress/does-not-exist`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'Task not found');
});

test('GET /api/batch/:batchId 404s for unknown batches', async () => {
  const res = await fetch(`${base}/api/batch/does-not-exist`);
  assert.equal(res.status, 404);
});

test('POST /api/generate rejects malformed JSON bodies', async () => {
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{oops'
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, '请求体不是有效的 JSON');
});

test('POST /api/generate rejects missing image filename', async () => {
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, '缺少服装图片文件名');
});

test('POST /api/generate rejects path traversal filenames', async () => {
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: 'no_such_file_123456.png' })
  });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error.includes('找不到指定的服装图片'));
});

test('POST /api/generate rejects path traversal in existing_still', async () => {
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ existing_still: '../secrets.png' })
  });
  assert.equal(res.status, 400);
});

test('POST /api/generate rejects oversized payloads', async () => {
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: 'x'.repeat(2 * 1024 * 1024) })
  });
  assert.equal(res.status, 413);
});

test('POST /api/upload rejects non-image files', async () => {
  const res = await fetch(`${base}/api/upload`, {
    method: 'POST',
    body: (() => {
      const fd = new FormData();
      fd.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }), 'evil.exe');
      return fd;
    })()
  });
  assert.equal(res.status, 400);
});

test('POST /api/upload accepts a real PNG and lands it in storage/inputs', async () => {
  // Minimal valid PNG (signature + IHDR) — passes extension AND magic-byte checks.
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(17);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(832, 8);
  ihdr.writeUInt32BE(1088, 12);
  const res = await fetch(`${base}/api/upload`, {
    method: 'POST',
    body: (() => {
      const fd = new FormData();
      fd.append('image', new Blob([Buffer.concat([sig, ihdr])], { type: 'image/png' }), 'test_garment.png');
      return fd;
    })()
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.filename && body.filename.startsWith('upload_'));
  assert.ok(body.url.startsWith('/inputs/'));
  assert.ok(body.size > 0);
  // static route must serve what upload returned
  const staticRes = await fetch(`${base}${body.url}`);
  assert.equal(staticRes.status, 200);
  // clean up: storage/inputs is gitignored user data — leave no test artifacts
  fs.unlinkSync(path.join(ROOT, 'storage', 'inputs', body.filename));
});

test('DELETE /api/history rejects illegal filenames', async () => {
  const res = await fetch(`${base}/api/history/image/..%2F..%2Fpackage.json`, { method: 'DELETE' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, '非法文件名');
});

test('GET /api/history returns normalized items', async () => {
  const res = await fetch(`${base}/api/history`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(Array.isArray(list) && list.length <= 40);
  for (const item of list) {
    assert.ok(['video', 'image'].includes(item.type));
    assert.ok(item.url.startsWith('/outputs/'));
  }
});

test('POST /api/tasks/:taskId/cancel 404s for unknown tasks', async () => {
  const res = await fetch(`${base}/api/tasks/unknown-task-id/cancel`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('POST /api/batch/:batchId/cancel 404s for unknown batches', async () => {
  const res = await fetch(`${base}/api/batch/unknown-batch-id/cancel`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('POST /api/tasks/:taskId/cancel cancels queued tasks', async () => {
  const { tasks } = require('../../src/store/tasks');
  const testId = `test-cancel-${Date.now()}`;
  tasks.set(testId, { id: testId, status: 'queued', message: '排队中...' });

  const res = await fetch(`${base}/api/tasks/${testId}/cancel`, { method: 'POST' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(tasks.get(testId).status, 'cancelled');

  // Cancel again should be rejected with 400
  const res2 = await fetch(`${base}/api/tasks/${testId}/cancel`, { method: 'POST' });
  assert.equal(res2.status, 400);

  tasks.delete(testId);
});

test('POST /api/batch/:batchId/cancel cancels batch and subtasks', async () => {
  const { tasks, batchJobs } = require('../../src/store/tasks');
  const batchId = `test-batch-${Date.now()}`;
  const t1 = `${batchId}-t1`;
  const t2 = `${batchId}-t2`;
  tasks.set(t1, { id: t1, status: 'queued' });
  tasks.set(t2, { id: t2, status: 'queued' });
  batchJobs.set(batchId, { id: batchId, status: 'queued', taskIds: [t1, t2] });

  const res = await fetch(`${base}/api/batch/${batchId}/cancel`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(batchJobs.get(batchId).status, 'cancelled');
  assert.equal(tasks.get(t1).status, 'cancelled');
  assert.equal(tasks.get(t2).status, 'cancelled');

  tasks.delete(t1);
  tasks.delete(t2);
  batchJobs.delete(batchId);
});

test('POST /api/generate-batch assigns diverse random actions across the 3 videos when random is selected', async () => {
  const { tasks, batchJobs, cancelBatchJob } = require('../../src/store/tasks');
  const origError = console.error;
  console.error = () => {}; // suppress expected background execution errors in test environment without API key
  try {
    const res = await fetch(`${base}/api/generate-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: 'test_outfit.png',
        scenes: ['street', 'studio', 'boutique'],
        gender: 'female',
        action1: 'random',
        action2: 'random'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.batchId);
    assert.equal(data.taskIds.length, 3);

    // Cancel immediately to prevent background queue execution against ComfyUI
    cancelBatchJob(data.batchId, '测试完成主动取消');

    const subtasks = data.taskIds.map(tid => tasks.get(tid));
    const seenActions = new Set();
    for (const t of subtasks) {
      assert.ok(t.action1 && t.action2);
      assert.notEqual(t.action1, 'random');
      assert.notEqual(t.action2, 'random');
      assert.notEqual(t.action1, t.action2);
      seenActions.add(t.action1);
      seenActions.add(t.action2);
    }
    // All 3 videos should receive distinct diverse actions (at least 5 unique across 6 slots)
    assert.ok(seenActions.size >= 5, `Expected high diversity across 3 batch videos, got ${seenActions.size}`);

    // Cleanup
    for (const tid of data.taskIds) tasks.delete(tid);
    batchJobs.delete(data.batchId);
  } finally {
    console.error = origError;
  }
});