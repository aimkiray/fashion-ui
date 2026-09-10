const fs = require('fs');
const path = require('path');
const { parseSseChunk } = require('./sse');
const { getRawConfig } = require('../config');

const OPENAI_IMAGE_OUTPUT_REQUIREMENTS =
  'Output requirements: portrait orientation, preserve the exact clothing design, silhouette, fabric drape, and colors from the reference garment as faithfully as possible, with realistic human anatomy and grounded posture.';

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
async function fetchStreamWithTtfbCap(endpoint, options) {
  const ac = new AbortController();
  const ttfbTimer = setTimeout(() => ac.abort(), STREAM_TTFB_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, { ...options, signal: ac.signal });
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

// Map aspect ratio to sizes the upstream actually supports. gpt-image-2 only
// accepts 1024x1024 / 1024x1536 / 1536x1024 — verified empirically: the relay
// silently coerces anything else (864x1536, 1024x1360) to 1024x1536. The
// selected aspect ratio is restored afterwards by crop_to_aspect.py.
function mapAspectRatioToSize(aspectRatio) {
  switch (aspectRatio) {
    case '1:1':
      return '1024x1024';
    case '9:16':
    case '3:4':
    default:
      return '1024x1536'; // official portrait (2:3) — closest superset of both
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
            throw new Error(msg);
          } else {
            const candidate = extractImageFromPayload(payload);
            if (candidate && !payload.partial) {
              finalBase64 = candidate;
            }
          }
        } catch (err) {
          if (err.message && (err.message.includes('OpenAI stream error') || err.message.includes('API'))) throw err;
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
async function fetchWithRetry(requestFactory, { attempts = 3, backoffMs = [2000, 5000], label = 'GPT Image 2' } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      const wait = backoffMs[Math.min(attempt - 2, backoffMs.length - 1)] || 2000;
      console.warn(`[${label}] 第 ${attempt}/${attempts} 次尝试，等待 ${wait}ms 后重试...`);
      await sleep(wait);
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
  projectInputDir,
  projectImageDir,
  onProgress
}) {
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

  // Prepare input images with strict reference ordering:
  // 1. If scene_image is present, the prompt specifies:
  //    "background environment from the first reference image, wearing the exact clothing and outfit from the second reference image"
  //    -> Image 1: Scene image, Image 2: Garment image
  // 2. If model_image is present, the prompt specifies:
  //    "Transfer the clothing and outfit from the first reference image onto the model in the second reference image"
  //    -> Image 1: Garment image, Image 2: Model image
  // 3. Otherwise:
  //    -> Image 1: Garment image
  const images = [];
  const garmentPath = path.join(projectInputDir, task.image);

  if (task.scene_image) {
    const scenePath = path.join(projectInputDir, task.scene_image);
    if (fs.existsSync(scenePath)) {
      images.push({ image_url: fileToDataUrl(scenePath) });
    }
    images.push({ image_url: fileToDataUrl(garmentPath) });
  } else if (task.model_image) {
    images.push({ image_url: fileToDataUrl(garmentPath) });
    const modelPath = path.join(projectInputDir, task.model_image);
    if (fs.existsSync(modelPath)) {
      images.push({ image_url: fileToDataUrl(modelPath) });
    }
  } else {
    images.push({ image_url: fileToDataUrl(garmentPath) });
  }

  const imageSize = mapAspectRatioToSize(task.aspect_ratio);
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
  const requestNonStream = async () => fetchWithRetry(() => fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(nonStreamBody),
    signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS)
  }), { attempts: 3, backoffMs: [2000, 5000] });

  let response = null;
  let usedStream = false;
  let nonStreamFailed = false;
  let nonStreamErrMsg = '';

  // 1) NON-STREAM FIRST: the current relay accepts stream requests but never
  //    delivers image data on them, while non-stream returns the image in
  //    seconds. Stream is kept only as a fallback for stream-only channels.
  try {
    response = await requestNonStream();
  } catch (netErr) {
    nonStreamFailed = true;
    nonStreamErrMsg = netErr.message;
    console.warn(`[GPT Image 2] 非流式请求失败 (${netErr.message})，降级为流式请求...`);
  }

  // 2) Non-stream explicitly rejected with 400/422 (some channels only
  //    accept streaming) → one stream fallback attempt.
  if (response && !response.ok && (response.status === 400 || response.status === 422)) {
    try { nonStreamErrMsg = (await response.json())?.error?.message || ''; } catch (e) {}
    console.warn(`[GPT Image 2] 非流式请求返回 HTTP ${response.status} (${nonStreamErrMsg})，降级为流式请求...`);
    nonStreamFailed = true;
  }

  if (nonStreamFailed) {
    try {
      response = await fetchWithRetry(() => fetchStreamWithTtfbCap(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      }), { attempts: 1 });
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

  // If base64Output is an HTTP URL, download it
  if (base64Output.startsWith('http://') || base64Output.startsWith('https://')) {
    if (typeof onProgress === 'function') {
      onProgress(35, '[GPT Image 2] 正在下载成片图像...');
    }
    const imgRes = await fetch(base64Output, { signal: AbortSignal.timeout(30000) });
    if (!imgRes.ok) throw new Error(`成片图像下载失败 (HTTP ${imgRes.status})`);
    const arrayBuffer = await imgRes.arrayBuffer();
    base64Output = Buffer.from(arrayBuffer).toString('base64');
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

  // Restore the exact selected aspect ratio: the upstream coerced the size to
  // its official set (e.g. portrait -> 1024x1536), so center-crop back to the
  // user's choice. No upscale — only pixels are removed, never invented.
  const ratioParts = String(task.aspect_ratio || '3:4').split(':');
  const ratioW = parseInt(ratioParts[0], 10);
  const ratioH = parseInt(ratioParts[1], 10);
  if (ratioW > 0 && ratioH > 0) {
    try {
      require('child_process').execFileSync(
        process.platform === 'win32' ? 'python' : 'python3',
        [path.join(__dirname, '..', '..', 'crop_to_aspect.py'), destPath, destPath, String(ratioW), String(ratioH)],
        { timeout: 10000 }
      );
    } catch (cropErr) {
      console.warn('[GPT Image 2] 按所选比例裁剪失败，保留上游原始尺寸:', cropErr.message);
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
