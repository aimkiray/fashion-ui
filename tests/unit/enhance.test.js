const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Spawn-layer tests inject fake ffmpeg/ffprobe executables. These must be in
// place BEFORE services/enhance is required (it reads the env at module load).
const SHIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'enhance-shims-'));
const ffprobeShim = path.join(SHIM_DIR, 'ffprobe');
fs.writeFileSync(ffprobeShim, '#!/bin/sh\necho \'{"format":{"duration":"0.5"}}\'\n');
const ffmpegShim = path.join(SHIM_DIR, 'ffmpeg');
// Last argv is the output path: create a >1024B artifact, emit one progress
// token, then linger briefly so cancel-abort can land mid-run.
fs.writeFileSync(ffmpegShim, '#!/bin/sh\nout="$#"\nfor a in "$@"; do out="$a"; done\nhead -c 2048 /dev/zero > "$out"\necho "out_time_us=250000"\nsleep 0.3\nexit 0\n');
fs.chmodSync(ffprobeShim, 0o755);
fs.chmodSync(ffmpegShim, 0o755);
process.env.FFMPEG_PATH = ffmpegShim;
process.env.FFPROBE_PATH = ffprobeShim;

const { requireNodes } = require('../../src/comfy/nodes');
const {
  startEnhanceJob,
  getEnhanceJob,
  cancelEnhanceJob,
  deriveEnhancedName,
  isEnhancedVideo
} = require('../../services/enhance');
const { PROJECT_VIDEO_DIR } = require('../../src/paths');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(jobId, statuses, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = getEnhanceJob(jobId);
    if (job && statuses.includes(job.status)) return job;
    if (Date.now() > deadline) return job;
    await sleep(50);
  }
}

const WORKFLOWS_DIR = path.join(__dirname, '..', '..', 'workflows');
const baseWf = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, 'fashion_streetwear_10s_extend.json'), 'utf-8'));
const hdWf = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, 'fashion_streetwear_10s_extend_hd.json'), 'utf-8'));

function assertLinksResolve(wf) {
  const bad = [];
  for (const [id, node] of Object.entries(wf)) {
    for (const [input, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === 'string' && !wf[value[0]]) {
        bad.push(`${id}.${input} -> ${value[0]}`);
      }
    }
  }
  assert.deepEqual(bad, []);
}

test('HD workflow keeps the shared base graph nodes intact', () => {
  for (const id of ['1', '2', '40', '41', '53', '70', '75', '76', '77', '78', '80', '81', '82', '84', '86', '89']) {
    assert.ok(hdWf[id], `HD 模板缺少基础节点 ${id}`);
  }
});

test('HD workflow drops the base-res seg2 decode and debug combine', () => {
  assert.equal(hdWf['87'], undefined);
  assert.equal(hdWf['96'], undefined);
});

test('HD workflow upscales both segment latents with identical scale', () => {
  for (const [sepId, upId, decId, samplerId] of [['104', '100', '102', '53'], ['105', '101', '103', '86']]) {
    // H3 sampler emits a NestedTensor AV latent: split -> upscale video part -> concat back
    assert.equal(hdWf[sepId].class_type, 'LTXVSeparateAVLatent');
    assert.deepEqual(hdWf[sepId].inputs.av_latent, [samplerId, 1]); // denoised_output slot
    const up = hdWf[upId];
    assert.equal(up.class_type, 'MinimaxH3LatentUpscaler3D');
    assert.deepEqual(up.inputs.latent, [sepId, 0]); // video_latent
    assert.equal(up.inputs.mode, 'scale by multiplier');
    assert.equal(up.inputs['mode.scale'], 1.5);
    assert.equal(up.inputs.align, 32);
    assert.equal(up.inputs.model_name, 'minimax_h3_latent_upscaler_3d_fp16.safetensors');
    const concat = hdWf[decId === '102' ? '106' : '107'];
    assert.equal(concat.class_type, 'LTXVConcatAVLatent');
    assert.deepEqual(concat.inputs.video_latent, [upId, 0]);
    assert.deepEqual(concat.inputs.audio_latent, [sepId, 1]);
    assert.deepEqual(hdWf[decId].inputs.samples, [concat.class_type === 'LTXVConcatAVLatent' ? (decId === '102' ? '106' : '107') : upId, 0]);
    assert.deepEqual(hdWf[decId].inputs.vae, ['21', 0]);
  }
});

test('HD workflow final combine consumes upscaled frames from both segments', () => {
  assert.deepEqual(hdWf['89'].inputs.source_images, ['102', 0]);
  assert.deepEqual(hdWf['89'].inputs.new_images, ['103', 0]);
});

test('HD workflow keeps the base-res guide/extend conditioning path', () => {
  // seg1 base decode still feeds frame-count math and the seg2 guide image
  assert.deepEqual(hdWf['70'].inputs.samples, ['53', 0]);
  assert.deepEqual(hdWf['82'].inputs.image, ['77', 0]);
  assert.deepEqual(hdWf['82'].inputs.latent, ['81', 1]); // MiniMaxH3ImageToVideo latent output slot
});

test('HD workflow ships an optional RIFE branch wired into the final combine', () => {
  assert.equal(hdWf['110'].class_type, 'FrameInterpolationModelLoader');
  assert.equal(hdWf['111'].class_type, 'FrameInterpolate');
  assert.deepEqual(hdWf['111'].inputs.interp_model, ['110', 0]);
  assert.deepEqual(hdWf['111'].inputs.images, ['89', 2]); // extended_images output slot
  assert.deepEqual(hdWf['80'].inputs.images, ['111', 0]);
});

test('requireNodes passes with the runtime-enhanced whitelist on the HD template', () => {
  assert.doesNotThrow(() => requireNodes(hdWf, 'MiniMax H3', ['1', '40', '41', '80', '81', '84', '100', '101', '102', '103', '104', '105', '106', '107', '110', '111']));
});

test('base workflow is untouched by the HD variant', () => {
  assert.equal(baseWf['100'], undefined);
  assert.deepEqual(baseWf['80'].inputs.images, ['89', 2]);
  assert.equal(baseWf['80'].inputs.bitrate, 30);
  assertLinksResolve(baseWf);
});

test('HD workflow has no dangling links', () => {
  assertLinksResolve(hdWf);
});

test('workflows apply quality tuning: 8 steps, fp16 VAE, delayed block-sparse', () => {
  for (const wf of [baseWf, hdWf]) {
    assert.equal(wf['21'].inputs.vae_name, 'minimax_h3_video_vae_fp16.safetensors');
    assert.equal(wf['51'].inputs.steps, 8);
    assert.equal(wf['85'].inputs.steps, 8);
    assert.equal(wf['14'].inputs.start_percent, 0.6);
  }
});

test('deriveEnhancedName strips the VHS audio twin suffix', () => {
  assert.equal(deriveEnhancedName('outfit_street_10s_x-audio.mp4'), 'outfit_street_10s_x_1080p60.mp4');
  assert.equal(deriveEnhancedName('outfit_street_10s_x.mp4'), 'outfit_street_10s_x_1080p60.mp4');
  assert.equal(deriveEnhancedName('outfit_street_10s_x_hd_00001-audio.mp4'), 'outfit_street_10s_x_hd_00001_1080p60.mp4');
});

test('isEnhancedVideo detects enhanced outputs only', () => {
  assert.ok(isEnhancedVideo('outfit_street_10s_x_1080p60.mp4'));
  assert.ok(!isEnhancedVideo('outfit_street_10s_x-audio.mp4'));
  assert.ok(!isEnhancedVideo('outfit_street_10s_x.png'));
});

// ── spawn 层：校验矩阵 / in-flight 复用 / 取消生命周期 / 完成产出 ──

test('startEnhanceJob rejects invalid filenames with proper status codes', () => {
  // basename aliasing (paths, backslash, dotfiles, NUL) — history.js 同标准
  for (const bad of ['/abs/x.mp4', 'sub/../x.mp4', 'a\\b.mp4', '.hidden.mp4', 'x\0.mp4', 'video.mp4.txt', '']) {
    const r = startEnhanceJob(bad);
    assert.equal(r.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.ok(r.error);
  }
  // Windows reserved device names
  assert.equal(startEnhanceJob('nul.mp4').statusCode, 400);
  // enhanced outputs are rejected outright
  assert.equal(startEnhanceJob('already_1080p60.mp4').statusCode, 400);
  // missing source file → 404
  const missing = startEnhanceJob('zz_no_such_source.mp4');
  assert.equal(missing.statusCode, 404);
});

test('in-flight dedupe returns the same jobId instead of racing a second ffmpeg', async () => {
  const src = path.join(PROJECT_VIDEO_DIR, 'zz_enhance_test_src-audio.mp4');
  const dst = path.join(PROJECT_VIDEO_DIR, 'zz_enhance_test_src_1080p60.mp4');
  const png = dst.replace(/\.mp4$/, '.png');
  for (const f of [src, dst, png]) { try { fs.unlinkSync(f); } catch (e) {} }
  fs.writeFileSync(src, Buffer.alloc(4096));

  try {
    const first = startEnhanceJob('zz_enhance_test_src-audio.mp4');
    assert.ok(first.jobId, 'first start should succeed');
    assert.equal(first.output, 'zz_enhance_test_src_1080p60.mp4');

    const second = startEnhanceJob('zz_enhance_test_src-audio.mp4');
    assert.equal(second.resumed, true, 'second start must be a resume, not a new job');
    assert.equal(second.jobId, first.jobId);

    // 取消生命周期: running/queued → cancelled
    assert.equal(cancelEnhanceJob(first.jobId), true);
    const job = await waitFor(first.jobId, ['cancelled']);
    assert.equal(job.status, 'cancelled');
    // 落盘文件不应存在（commit boundary 前被取消）
    assert.equal(fs.existsSync(dst), false);
  } finally {
    for (const f of [src, dst, png, dst + '.part']) { try { fs.unlinkSync(f); } catch (e) {} }
  }
});

test('completed enhancement writes the video and preview artifacts', async () => {
  const srcName = 'zz_enhance_test_src2.mp4';
  const src = path.join(PROJECT_VIDEO_DIR, srcName);
  const dst = path.join(PROJECT_VIDEO_DIR, 'zz_enhance_test_src2_1080p60.mp4');
  const png = dst.replace(/\.mp4$/, '.png');
  for (const f of [src, dst, png]) { try { fs.unlinkSync(f); } catch (e) {} }
  fs.writeFileSync(src, Buffer.alloc(4096));

  try {
    const started = startEnhanceJob(srcName);
    assert.ok(started.jobId);
    const job = await waitFor(started.jobId, ['completed', 'error']);
    assert.equal(job.status, 'completed', `expected completion, got: ${job.message}`);
    assert.ok(fs.existsSync(dst), 'enhanced video should exist');
    assert.ok(fs.statSync(dst).size > 1024, 'enhanced video should be non-trivial');
    assert.ok(fs.existsSync(png), 'preview png should exist');
    assert.ok(!fs.existsSync(dst + '.part'), '.part must be renamed away');
  } finally {
    for (const f of [src, dst, png]) { try { fs.unlinkSync(f); } catch (e) {} }
  }
});
