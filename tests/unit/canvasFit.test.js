const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 头部裁切修复的回归守卫。
// 注意（经实验验证）：conformImageToCanvas 的冒烟测试抓不住"丢失 require"类
// 回归——runPythonScript 在 try 块内调用，ReferenceError 会被自身 catch 吞掉
// 后落入直接复制回退。因此下方用 require.cache 注入 stub 并断言"pythonBin
// 被委派"（delegating test），这才是该回归类型的真正守卫。

const { mapAspectRatioToSize } = require('../../services/imagegen/gptImage2');
const { conformImageToCanvas } = require('../../src/images/conform');
const { readPngDims } = require('../../src/images/canvas');

// 合成一张最小合法 PNG（单色 1x1 放大到目标尺寸仅用于占位测试）
function makePng(path, w, h) {
  // PNG: signature + IHDR(w,h,8bit,color3) + IDAT(zlib 0-fill) + IEND
  const zlib = require('zlib');
  const width = Buffer.alloc(4); width.writeUInt32BE(w);
  const height = Buffer.alloc(4); height.writeUInt32BE(h);
  const ihdr = Buffer.concat([Buffer.from('IHDR'), width, height,
    Buffer.from([8, 2, 0, 0, 0])]);
  // raw scanlines: filter byte 0 + RGB triplets per pixel
  const raw = Buffer.alloc(h * (1 + w * 3));
  const idat = Buffer.concat([Buffer.from('IDAT'), zlib.deflateSync(raw)]);
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  fs.writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr.slice(4)), chunk('IDAT', idat.slice(4)),
    chunk('IEND', Buffer.alloc(0))
  ]));
}

test('mapAspectRatioToSize requests the exact video canvas size', () => {
  const AC = { '3:4': { width: 832, height: 1088 }, '9:16': { width: 704, height: 1280 }, '1:1': { width: 960, height: 960 } };
  assert.equal(mapAspectRatioToSize('3:4', AC), '832x1088');
  assert.equal(mapAspectRatioToSize('9:16', AC), '704x1280');
  assert.equal(mapAspectRatioToSize('1:1', AC), '960x960');
});

test('mapAspectRatioToSize falls back to 3:4 canvas on unknown ratio and to official sizes without a table', () => {
  const AC = { '3:4': { width: 832, height: 1088 }, '9:16': { width: 704, height: 1280 }, '1:1': { width: 960, height: 960 } };
  assert.equal(mapAspectRatioToSize('4:3', AC), '832x1088'); // 非法比例 → 3:4 画布（切头最后防线）
  assert.equal(mapAspectRatioToSize('3:4', undefined), '1024x1536');
  assert.equal(mapAspectRatioToSize('9:16', undefined), '1024x1536'); // default 分支
  assert.equal(mapAspectRatioToSize('1:1', undefined), '1024x1024');
});

test('conformImageToCanvas delegates to pythonBin and survives its failure via copy fallback', async () => {
  // 用 require.cache 注入 stub：runPythonScript 必然 reject。
  // 若 conform.js 丢失对 pythonBin 的 require（本轮回归类型），
  // runPythonScript 调用变成 ReferenceError 且被 catch 吞掉 → calls 停留 0 → 本测试失败。
  const calls = [];
  const pbPath = require.resolve('../../src/images/pythonBin');
  const conformPath = require.resolve('../../src/images/conform');
  const savedPb = require.cache[pbPath];
  const savedConform = require.cache[conformPath];
  require.cache[pbPath] = {
    id: pbPath, filename: pbPath, loaded: true,
    exports: {
      getPythonBin: () => 'stub-python',
      ensurePilPreflight: async () => ({ ok: false, bin: 'stub-python', reason: 'stub' }),
      runPythonScript: async (...args) => { calls.push(args); throw new Error('stub failure'); }
    }
  };
  delete require.cache[conformPath];
  try {
    const { conformImageToCanvas: conformWithStub } = require('../../src/images/conform');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conform-stub-'));
    const src = path.join(dir, 'src.png');
    const dst = path.join(dir, 'staged.png');
    makePng(src, 900, 1100); // 源尺寸 ≠ 目标：复制回退后尺寸不一致可区分
    try {
      await conformWithStub(src, dst, 832, 1088);
      assert.equal(calls.length, 1, 'pythonBin.runPythonScript must be delegated exactly once');
      assert.ok(fs.existsSync(dst), 'copy fallback must still produce dst');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    if (savedPb) require.cache[pbPath] = savedPb; else delete require.cache[pbPath];
    if (savedConform) require.cache[conformPath] = savedConform; else delete require.cache[conformPath];
  }
});
