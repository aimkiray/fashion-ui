const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const { parseSseChunk } = require('./sse');
const { getRawConfig } = require('../config');
const { runPythonScript } = require('../../src/images/pythonBin');

// Appended to every generation/edit prompt (constraint layer, per the official
// image-prompting guide: state exclusions and preservation explicitly). Kept
// size-agnostic - orientation is controlled by the size parameter, not words.
const OPENAI_IMAGE_OUTPUT_REQUIREMENTS =
  'Output requirements: photorealistic result, preserve the exact clothing design, silhouette, fabric drape, and colors from the reference garment as faithfully as possible, with realistic human anatomy and grounded posture. Full body visible including footwear. Composition: keep clear headroom — at least 12% of the frame height of empty space above the hair — and keep the entire figure inside the frame with margin below the feet, so nothing is ever clipped. Model must face forward toward the camera in a front or flattering three-quarter front view with full face and front of the outfit clearly visible; strictly no back views, never back turned to camera, no facing away from camera. No text, no watermarks, no logos.';

// Image generation through budget relays can legitimately take several minutes
// (queued cheap channels + quality:high). 3 min was too tight and caused
// guaranteed timeouts; 10 min per attempt leaves room for slow upstreams.
const IMAGE_REQUEST_TIMEOUT_MS = 600000;

// Real streaming relays start emitting SSE partials within the first minute.
// If no response headers arrive within this window the upstream is hanging —
// abandon streaming fast and degrade to non-stream instead of dead-waiting.
const STREAM_TTFB_TIMEOUT_MS = 120000;

// Silence watchdog for an open SSE stream: some gateways accept the upgrade
// instantly but the upstream never emits a single event. If no bytes arrive
// for this long, cancel the stream and fall back to non-stream.
// (env override GPT2_STREAM_SILENCE_MS exists for deterministic tests)
const STREAM_SILENCE_TIMEOUT_MS = Number(process.env.GPT2_STREAM_SILENCE_MS) || 180000;

// Transient upstream conditions worth retrying: rate limit + gateway blips.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Human-friendly message for gateway/origin failures common with relays.
function httpErrorMessage(status, detail) {
  if (status === 524 || status === 504) {
    return `上游通道无响应 (HTTP ${status} 网关超时)：中转站背后的生成通道当前不可用或过载，请稍后重试，或在「⚙️ 配置 API」中更换 API 线路${detail ? ` [${detail}]` : ''}`;
  }
  return detail || `OpenAI API 请求失败 (${status})`;
}

function isTimeoutErr(err) {
  return !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

// Stream attempt: cap time-to-first-byte so a hanging upstream fails within
// STREAM_TTFB_TIMEOUT_MS; once headers arrive, arm the full total-time budget.
async function fetchStreamWithTtfbCap(endpoint, options = {}) {
  const ac = new AbortController();
  const ttfbTimer = setTimeout(() => ac.abort(), STREAM_TTFB_TIMEOUT_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([ac.signal, options.signal])
    : ac.signal;
  try {
    const response = await fetch(endpoint, { ...options, signal: combinedSignal });
    clearTimeout(ttfbTimer);
    // Headers arrived; SSE activity or the final image should follow. Keep a
    // generous total cap for slow-but-alive upstreams.
    setTimeout(() => ac.abort(), IMAGE_REQUEST_TIMEOUT_MS);
    return response;
  } finally {
    clearTimeout(ttfbTimer);
  }
}

// Convert local file to base64 Data URL
function fileToDataUrl(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Reference image not found: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  let mime = 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
  else if (ext === '.webp') mime = 'image/webp';
  else if (ext === '.bmp') mime = 'image/bmp';
  
  const b64 = fs.readFileSync(filePath).toString('base64');
  return `data:${mime};base64,${b64}`;
}

// Request the EXACT video-canvas size from the upstream (e.g. 3:4 -> 832x1088,
// 9:16 -> 704x1280, 1:1 -> 960x960). gpt-image-2 accepts arbitrary pixel sizes,
// and the returned image may be off by a few pixels — fit_to_canvas.py then
// trims the excess (head-protecting) and Lanczos-resizes to the exact canvas,
// so no content-bearing crop is ever needed.
function mapAspectRatioToSize(aspectRatio, aspectCanvas) {
  const canvas = (aspectCanvas && (aspectCanvas[aspectRatio] || aspectCanvas['3:4'])) || null;
  if (canvas && canvas.width > 0 && canvas.height > 0) {
    return `${canvas.width}x${canvas.height}`;
  }
  switch (aspectRatio) {
    case '1:1':
      return '1024x1024';
    case '9:16':
    case '3:4':
    default:
      return '1024x1536'; // fallback if canvas table is unavailable
  }
}

// Extract base64 or URL from any supported OpenAI image payload shape
function extractImageFromPayload(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (payload.b64_json) return payload.b64_json;
  if (payload.image) return payload.image;
  if (Array.isArray(payload.data) && payload.data[0]) {
    return payload.data[0].b64_json || payload.data[0].url || payload.data[0].image || null;
  }
  if (payload.url) return payload.url;
  return null;
}

// Read one SSE chunk with a silence watchdog: if no bytes arrive within
// STREAM_SILENCE_TIMEOUT_MS, cancel the stream so the pending read settles
// (with a grace fallback in case cancel() does not settle it).
function readChunkWithWatchdog(stream, reader) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let grace = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(silence);
      if (grace) clearTimeout(grace);
      fn(arg);
    };
    const silence = setTimeout(() => {
      console.warn('[GPT Image 2] 流式通道静默超时（无任何数据），中止流式读取...');
      // reader.cancel() settles the pending read with {done:true} per spec;
      // the 5s grace fallback below guarantees the watchdog always resolves.
      try {
        const c = reader.cancel('silence timeout');
        if (c && typeof c.catch === 'function') c.catch(() => {});
      } catch (e) {}
      grace = setTimeout(() => finish(resolve, { done: true, value: undefined }), 5000);
    }, STREAM_SILENCE_TIMEOUT_MS);
    reader.read().then(
      (res) => finish(resolve, res),
      (err) => finish(reject, err)
    );
  });
}

async function relayOpenAiStream(stream, onProgress) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalBase64 = null;
  let partialCount = 0;

  while (true) {
    const { done, value } = await readChunkWithWatchdog(stream, reader);
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r/g, '');

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const parsed = parseSseChunk(chunk);
      if (parsed && parsed.data !== '[DONE]') {
        try {
          const payload = JSON.parse(parsed.data);
          const eventType = payload.type || parsed.eventName;

          if (eventType === 'image_edit.partial_image') {
            partialCount++;
            const progressVal = Math.min(38, 15 + partialCount * 10);
            if (typeof onProgress === 'function') {
              onProgress(progressVal, `[GPT Image 2] 渲染流式预览中 (阶段 ${partialCount})...`);
            }
          } else if (eventType === 'image_edit.completed' || eventType === 'image.completed' || eventType === 'completed') {
            const candidate = extractImageFromPayload(payload);
            if (candidate) finalBase64 = candidate;
          } else if (eventType === 'error' || parsed.eventName === 'error') {
            const msg = payload.message || payload.error?.message || 'OpenAI stream error';
            const streamErr = new Error(msg);
            streamErr.isUpstreamStreamError = true;
            throw streamErr;
          } else {
            const candidate = extractImageFromPayload(payload);
            if (candidate && !payload.partial) {
              finalBase64 = candidate;
            }
          }
        } catch (err) {
          if (err.isUpstreamStreamError) throw err;
          // Ignore non-fatal JSON parse error on non-json SSE lines
        }
      }

      boundary = buffer.indexOf('\n\n');
    }
  }

  buffer += decoder.decode();
  const remaining = buffer.trim();
  if (remaining) {
    const parsed = parseSseChunk(remaining);
    if (parsed && parsed.data !== '[DONE]') {
      try {
        const payload = JSON.parse(parsed.data);
        const candidate = extractImageFromPayload(payload);
        if (candidate) finalBase64 = candidate;
      } catch (e) {}
    }
  }

  return finalBase64;
}

/**
 * fetch with retry for transient failures (429/5xx/network errors/timeouts).
 * Returns the raw Response for 2xx and non-retryable 4xx so the caller can
 * decide how to degrade; throws the last error once all attempts are spent.
 */
async function fetchWithRetry(requestFactory, { attempts = 3, backoffMs = [2000, 5000], label = 'GPT Image 2', signal } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal && signal.aborted) {
      throw new Error('任务已被用户取消');
    }
    if (attempt > 1) {
      const wait = backoffMs[Math.min(attempt - 2, backoffMs.length - 1)] || 2000;
      console.warn(`[${label}] 第 ${attempt}/${attempts} 次尝试，等待 ${wait}ms 后重试...`);
      await sleep(wait);
      if (signal && signal.aborted) {
        throw new Error('任务已被用户取消');
      }
    }
    try {
      const response = await requestFactory();
      if (!RETRYABLE_STATUS.has(response.status)) {
        return response;
      }
      let detail = '';
      try {
        detail = (await response.json())?.error?.message || '';
      } catch (e) {}
      console.warn(`[${label}] 可重试的 HTTP ${response.status}${detail ? ` (${detail})` : ''}`);
      lastErr = new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    } catch (err) {
      if (signal && signal.aborted) {
        throw new Error('任务已被用户取消');
      }
      console.warn(`[${label}] 请求失败: ${err.message}`);
      lastErr = err;
      // A hung upstream will hang again on retry — timeout means stop retrying.
      if (isTimeoutErr(err)) break;
    }
  }
  throw lastErr || new Error(`${label} 请求失败`);
}

/**
 * Generate Still Reference Image using OpenAI gpt-image-2
 * Follows the implementation pattern in openai/openai-imagegen-demo
 */
async function generateGptImage2({
  task,
  taskId,
  prompt,
  signal,
  projectInputDir,
  projectImageDir,
  aspectCanvas,
  onProgress
}) {
  if (signal && signal.aborted) {
    throw new Error('任务已被用户取消');
  }

  const config = getRawConfig();
  if (!config.openaiApiKey) {
    throw new Error('未配置 OpenAI API Key。请在页面右上角点击「⚙️ 配置 API」或设置 OPENAI_API_KEY。');
  }

  const baseUrl = config.openaiBaseUrl || 'https://api.openai.com/v1';
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/images/edits`;

  const headers = {
    'Authorization': `Bearer ${config.openaiApiKey}`,
    'Content-Type': 'application/json'
  };
  if (config.openaiOrgId) headers['OpenAI-Organization'] = config.openaiOrgId;
  if (config.openaiProjectId) headers['OpenAI-Project'] = config.openaiProjectId;

  // Prepare input images. Precedence MUST mirror computeTaskPrompts (model_image
  // wins over scene_image) or the prompt's "first/second reference image" wording
  // will not match the images actually sent:
  // 1. model_image present -> prompt: "Transfer the clothing from the first
  //    reference image onto the model in the second reference image"
  //    -> Image 1: Garment, Image 2: Model (scene ref is dropped, its
  //    environment is described in text by the prompt builder)
  // 2. else scene_image present -> prompt: "background from the first reference
  //    image, wearing the exact clothing from the second reference image"
  //    -> Image 1: Scene, Image 2: Garment
  // 3. otherwise -> Image 1: Garment
  const images = [];
  const garmentPath = path.join(projectInputDir, task.image);

  const requireRef = (label, refPath) => {
    if (!fs.existsSync(refPath)) {
      // 静默丢图会让双图 prompt 落到单图语义上，生成结果完全错误——宁可明确失败
      throw new Error(`参考图文件缺失: ${label} (${refPath})`);
    }
    return { image_url: fileToDataUrl(refPath) };
  };

  if (task.model_image) {
    images.push(requireRef('服装图', garmentPath));
    images.push(requireRef('模特参考图', path.join(projectInputDir, task.model_image)));
  } else if (task.scene_image) {
    images.push(requireRef('场景参考图', path.join(projectInputDir, task.scene_image)));
    images.push(requireRef('服装图', garmentPath));
  } else {
    images.push({ image_url: fileToDataUrl(garmentPath) });
  }

  const imageSize = mapAspectRatioToSize(task.aspect_ratio, aspectCanvas);
  const trimmedPrompt = prompt.trim();
  const fullPrompt = trimmedPrompt.includes('Output requirements:')
    ? trimmedPrompt
    : `${trimmedPrompt}\n\n${OPENAI_IMAGE_OUTPUT_REQUIREMENTS}`;

  if (typeof onProgress === 'function') {
    onProgress(12, '[GPT Image 2] 正在向 OpenAI 发起图像生成请求...');
  }

  const baseBody = {
    model: config.openaiImageModel || 'gpt-image-2',
    prompt: fullPrompt,
    images: images,
    size: imageSize,
    quality: config.openaiImageQuality || 'high',
    output_format: 'png'
  };
  const requestBody = { ...baseBody, stream: true, partial_images: 2 };
  const nonStreamBody = { ...baseBody };

  // Non-stream request with retries (3 attempts: 2s, 5s backoff; a hung
  // upstream aborts after the timeout instead of burning all attempts).
  const requestNonStream = async (body = nonStreamBody) => {
    const timeoutSignal = AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS);
    const reqSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    return fetchWithRetry(() => fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: reqSignal
    }), { attempts: 3, backoffMs: [2000, 5000], signal });
  };

  let response = null;
  let usedStream = false;
  let nonStreamFailed = false;
  let nonStreamErrMsg = '';

  // 1) NON-STREAM FIRST: the current relay accepts stream requests but never
  //    delivers image data on them, while non-stream returns the image in
  //    seconds. Stream is kept only as a fallback for stream-only channels.
  try {
    response = await requestNonStream(nonStreamBody);
  } catch (netErr) {
    if (signal && signal.aborted) {
      throw new Error('任务已被用户取消');
    }
    nonStreamFailed = true;
    nonStreamErrMsg = netErr.message;
    console.warn(`[GPT Image 2] 非流式请求失败 (${netErr.message})，降级为流式请求...`);
  }

  // 2) Non-stream explicitly rejected with 400/422.
  if (response && !response.ok && (response.status === 400 || response.status === 422)) {
    try { nonStreamErrMsg = (await response.json())?.error?.message || ''; } catch (e) {}
    // 2a) 上游不接受自定义画布尺寸（背后可能是只认官方枚举的模型）→ 用官方
    //     尺寸重试一次；crop_to_canvas.py 的头部保护裁切（coerced 分支）负责
    //     把比例修正回目标画布，闭环不切头。
    if (response.status === 400 && /size/i.test(nonStreamErrMsg)) {
      const officialSize = imageSize === '1024x1024' ? '1024x1024' : '1024x1536';
      if (officialSize !== imageSize) {
        console.warn(`[GPT Image 2] 上游拒绝 size=${imageSize} (${nonStreamErrMsg})，回退官方尺寸 ${officialSize} 重试...`);
        try {
          response = await requestNonStream({ ...nonStreamBody, size: officialSize });
        } catch (retryErr) {
          if (signal && signal.aborted) throw new Error('任务已被用户取消');
          nonStreamFailed = true;
          nonStreamErrMsg = retryErr.message;
        }
      }
    }
    // 2b) 仍有 400/422（部分渠道只接受流式）→ 一次流式回退。
    if (response && !response.ok && (response.status === 400 || response.status === 422)) {
      // 重试产生的 400 也要消费掉 body，避免错误文案停留在首次请求的过期原因
      try { nonStreamErrMsg = (await response.json())?.error?.message || nonStreamErrMsg; } catch (e) {}
      console.warn(`[GPT Image 2] 非流式请求返回 HTTP ${response.status} (${nonStreamErrMsg})，降级为流式请求...`);
      nonStreamFailed = true;
    }
  }

  if (nonStreamFailed) {
    try {
      response = await fetchWithRetry(() => fetchStreamWithTtfbCap(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal
      }), { attempts: 1, signal });
      usedStream = true;
    } catch (streamErr) {
      if (response && !response.ok) {
        throw new Error(httpErrorMessage(response.status, nonStreamErrMsg));
      }
      throw new Error(`OpenAI 图像请求失败 (非流式与流式均不可用): ${streamErr.message}`);
    }
  }

  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.error?.message || '';
    } catch (e) {}
    throw new Error(httpErrorMessage(response.status, detail));
  }

  let base64Output = null;
  const contentType = response.headers.get('content-type') || '';

  if (usedStream && contentType.includes('text/event-stream') && response.body) {
    try {
      base64Output = await relayOpenAiStream(response.body, onProgress);
    } catch (streamErr) {
      console.warn('[GPT Image 2] 流式解析中断:', streamErr.message);
      // Upstream error events must surface, not fall through to the generic message
      if (streamErr.isUpstreamStreamError) throw streamErr;
    }
    if (!base64Output) {
      console.warn('[GPT Image 2] 流式兜底响应未包含图像数据。');
    }
  }

  // Non-stream path (default): parse the JSON body for the image.
  if (!base64Output && !usedStream) {
    try {
      const payload = await response.json();
      base64Output = extractImageFromPayload(payload);
    } catch (e) {}
  }

  if (!base64Output) {
    throw new Error('GPT Image 2 未返回有效图像数据。');
  }

  if (signal && signal.aborted) {
    throw new Error('任务已被用户取消');
  }

  // If base64Output is an HTTP URL, download it
  if (base64Output.startsWith('http://') || base64Output.startsWith('https://')) {
    if (typeof onProgress === 'function') {
      onProgress(35, '[GPT Image 2] 正在下载成片图像...');
    }
    const timeoutSignal = AbortSignal.timeout(30000);
    const imgSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const imgRes = await fetch(base64Output, { signal: imgSignal });
    if (!imgRes.ok) throw new Error(`成片图像下载失败 (HTTP ${imgRes.status})`);
    const arrayBuffer = await imgRes.arrayBuffer();
    base64Output = Buffer.from(arrayBuffer).toString('base64');
  }

  if (signal && signal.aborted) {
    throw new Error('任务已被用户取消');
  }

  // Cleanly strip data:image/...;base64, prefix if present to avoid corrupting image bytes
  base64Output = base64Output.replace(/^data:image\/[a-zA-Z+]+;base64,/, '').trim();

  const imageBuffer = Buffer.from(base64Output, 'base64');
  if (imageBuffer.length < 100) {
    throw new Error('GPT Image 2 返回的图像数据无效或已损坏。');
  }

  // Save generated image to PROJECT_IMAGE_DIR
  const savedFilename = `gpt2_${task.scene.id || 'scene'}_${taskId}.png`;
  const destPath = path.join(projectImageDir, savedFilename);
  fs.writeFileSync(destPath, imageBuffer);

  // Fit the returned image to the exact video canvas. The request already used
  // the canvas size, so in the normal case this is a no-op copy; a few-px
  // upstream drift is corrected by a head-protecting trim + Lanczos resize
  // (crop_to_canvas.py). If the relay still coerces the size to its official
  // set (e.g. portrait -> 1024x1536), the same script crops back to the canvas
  // aspect with a head-protecting bias and a warning is logged.
  const canvas = aspectCanvas[String(task.aspect_ratio || '3:4')] || aspectCanvas['3:4'];
  const targetW = canvas ? String(canvas.width) : null;
  const targetH = canvas ? String(canvas.height) : null;
  if (targetW && targetH) {
    try {
      const fitResult = await runPythonScript(
        path.join(__dirname, '..', '..', 'crop_to_canvas.py'),
        [destPath, destPath, targetW, targetH],
        { timeout: 15000 }
      );
      // 脚本在 coerced/过度放大时向 stderr 发关键告警，不能静默丢弃
      if (fitResult && fitResult.stderr && fitResult.stderr.trim()) {
        console.warn('[GPT Image 2] crop_to_canvas:', fitResult.stderr.trim());
      }
    } catch (fitErr) {
      console.warn('[GPT Image 2] 画布尺寸修正失败，保留上游原始尺寸:', fitErr.message);
    }
  }

  if (typeof onProgress === 'function') {
    onProgress(40, '[GPT Image 2] 定妆照已生成并保存。');
  }

  return {
    filename: savedFilename,
    destPath,
    webUrl: `/outputs/images/${savedFilename}`
  };
}

module.exports = {
  generateGptImage2,
  mapAspectRatioToSize
};
