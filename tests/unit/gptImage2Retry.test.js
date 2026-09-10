const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// gptImage2 的 400-size 回退重试分支（本轮核心修复）：上游拒绝自定义画布
// 尺寸（400 + 错误文案含 size）时，必须用官方尺寸重试一次并成功出图。

process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';

const { generateGptImage2, mapAspectRatioToSize } = require('../../services/imagegen/gptImage2');

function makePng(w, h) {
  const width = Buffer.alloc(4); width.writeUInt32BE(w);
  const height = Buffer.alloc(4); height.writeUInt32BE(h);
  const ihdr = Buffer.concat([width, height, Buffer.from([8, 2, 0, 0, 0])]);
  const raw = Buffer.alloc(h * (1 + w * 3));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

test('gptImage2 retries with the official size after a 400 size rejection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt2-retry-'));
  const inputDir = path.join(dir, 'input');
  const imageDir = path.join(dir, 'images');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(imageDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, 'garment.png'), makePng(64, 64));

  const capturedBodies = [];
  const pngB64 = makePng(1024, 1536).toString('base64');
  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body);
    capturedBodies.push(body);
    if (body.size === '832x1088') {
      return {
        ok: false,
        status: 400,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ error: { message: 'Invalid size: 832x1088, must be one of 1024x1024, 1024x1536, 1536x1024' } })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => ({ data: [{ b64_json: pngB64 }] })
    };
  };

  try {
    const result = await generateGptImage2({
      task: { scene: { id: 'street' }, image: 'garment.png', aspect_ratio: '3:4' },
      taskId: 'retry-test',
      prompt: 'test prompt',
      projectInputDir: inputDir,
      projectImageDir: imageDir,
      aspectCanvas: { '3:4': { width: 832, height: 1088 }, '9:16': { width: 704, height: 1280 }, '1:1': { width: 960, height: 960 } }
    });
    assert.ok(result.filename.startsWith('gpt2_street_'), 'result should be saved');
    assert.equal(capturedBodies.length, 2, 'exactly one retry');
    assert.equal(capturedBodies[0].size, '832x1088');
    assert.equal(capturedBodies[1].size, '1024x1536', 'retry must use the official size');
    assert.ok(fs.existsSync(result.destPath), 'output file must exist');
  } finally {
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
