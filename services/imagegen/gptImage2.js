const fs = require('fs');
const path = require('path');
const { parseSseChunk } = require('./sse');
const { getRawConfig } = require('../config');

const OPENAI_IMAGE_OUTPUT_REQUIREMENTS =
  'Output requirements: portrait orientation, preserve the exact clothing design, silhouette, fabric drape, and colors from the reference garment as faithfully as possible, with realistic human anatomy and grounded posture.';

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

// Map aspect ratio to dimensions supported by gpt-image-2 (divisible by 16)
function mapAspectRatioToSize(aspectRatio) {
  switch (aspectRatio) {
    case '9:16':
      return '864x1536';
    case '1:1':
      return '1024x1024';
    case '3:4':
    default:
      return '1024x1360';
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

async function relayOpenAiStream(stream, onProgress) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalBase64 = null;
  let partialCount = 0;

  while (true) {
    const { done, value } = await reader.read();
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

  const requestBody = {
    model: config.openaiImageModel || 'gpt-image-2',
    prompt: fullPrompt,
    images: images,
    size: imageSize,
    quality: config.openaiImageQuality || 'high',
    output_format: 'png',
    stream: true,
    partial_images: 2
  };

  let response;
  let usedStream = true;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(180000)
    });
  } catch (netErr) {
    throw new Error(`无法连接到 OpenAI 图像服务: ${netErr.message}`);
  }

  // If streaming request fails with 400 or 422 (common with non-streaming reverse proxies), retry with stream: false
  if (!response.ok && (response.status === 400 || response.status === 422)) {
    let errPayload = null;
    try { errPayload = await response.clone().json(); } catch (e) {}
    const errMsg = errPayload?.error?.message || '';

    console.warn(`[GPT Image 2] 流式请求返回 HTTP ${response.status} (${errMsg})，尝试降级为非流式直接请求...`);
    usedStream = false;
    const nonStreamBody = {
      model: config.openaiImageModel || 'gpt-image-2',
      prompt: fullPrompt,
      images: images,
      size: imageSize,
      quality: config.openaiImageQuality || 'high',
      output_format: 'png'
    };
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(nonStreamBody),
        signal: AbortSignal.timeout(180000)
      });
    } catch (retryErr) {
      throw new Error(`OpenAI 图像非流式重试失败: ${retryErr.message}`);
    }
  }

  if (!response.ok) {
    let message = `OpenAI API 请求失败 (${response.status})`;
    try {
      const payload = await response.json();
      if (payload.error && payload.error.message) {
        message = payload.error.message;
      }
    } catch (e) {}
    throw new Error(message);
  }

  let base64Output = null;
  const contentType = response.headers.get('content-type') || '';

  if (usedStream && contentType.includes('text/event-stream') && response.body) {
    try {
      base64Output = await relayOpenAiStream(response.body, onProgress);
    } catch (streamErr) {
      console.warn('[GPT Image 2] 流式解析中断:', streamErr.message);
    }
  }

  // If streaming didn't produce base64Output (or if response wasn't event-stream)
  if (!base64Output) {
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
