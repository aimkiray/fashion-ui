const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPngDims, nearestCanvasKey } = require('../../src/images/canvas');
const { requireNodes } = require('../../src/comfy/nodes');
const { looksLikeImage } = require('../../src/http/uploads');

// Minimal PNG fixture built from the IHDR header layout — no storage/ dependency,
// so `npm test` works on a fresh clone (storage/ is gitignored).
function makePngFixture(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(17);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([sig, ihdr]);
}

test('readPngDims reads IHDR dimensions of a synthetic PNG', () => {
  const tmp = path.join(os.tmpdir(), `dims_${Date.now()}.png`);
  fs.writeFileSync(tmp, makePngFixture(1024, 1365));
  assert.deepEqual(readPngDims(tmp), { w: 1024, h: 1365 });
  assert.equal(readPngDims(path.join(os.tmpdir(), `missing_${Date.now()}.png`)), null);
  // truncated / non-IHDR header → null
  fs.writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]));
  assert.equal(readPngDims(tmp), null);
  fs.unlinkSync(tmp);
});

test('nearestCanvasKey picks the closest aspect ratio', () => {
  assert.equal(nearestCanvasKey(832, 1088), '3:4');
  assert.equal(nearestCanvasKey(704, 1280), '9:16');
  assert.equal(nearestCanvasKey(960, 960), '1:1');
  assert.equal(nearestCanvasKey(1024, 1365), '3:4'); // 0.75 vs 0.7647
  assert.equal(nearestCanvasKey(1080, 1920), '9:16');
  assert.equal(nearestCanvasKey(2000, 2000), '1:1');
});

test('requireNodes fails fast listing missing workflow nodes', () => {
  const wf = { '5': { inputs: {} }, '7': { inputs: {} } };
  assert.throws(() => requireNodes(wf, 'Krea-2', ['5', '9']), /缺少节点: 9/);
  assert.throws(() => requireNodes(null, 'X', ['1']), /缺少节点: 1/);
  assert.doesNotThrow(() => requireNodes(wf, 'Krea-2', ['5', '7']));
});

test('looksLikeImage verifies magic bytes, not extensions', () => {
  const tmp = path.join(require('os').tmpdir(), `magic_${Date.now()}.png`);
  fs.writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]));
  assert.ok(looksLikeImage(tmp));
  fs.writeFileSync(tmp, Buffer.from([0x42, 0x4D, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert.ok(looksLikeImage(tmp));
  fs.writeFileSync(tmp, Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]));
  assert.ok(looksLikeImage(tmp)); // RIFF....WEBP
  fs.writeFileSync(tmp, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  assert.ok(!looksLikeImage(tmp));
  fs.unlinkSync(tmp);
});