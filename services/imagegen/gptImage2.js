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
          } else if (eventType === 'image_edit.completed') {
            if (payload.b64_json) {
              finalBase64 = payload.b64_json;
            }
          } else if (eventType === 'error' || parsed.eventName === 'error') {
            const msg = payload.message || 'OpenAI stream error';
            throw new Error(msg);
          }
        } catch (err) {
          if (err.message && err.message.includes('OpenAI stream error')) throw err;
          // Ignore JSON parse error on non-json SSE lines
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
        if (payload.b64_json) finalBase64 = payload.b64_json;
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
  const endpoint = `${baseUrl.replace(/\/$/, '')}/images/edits`;

  const headers = {
    'Authorization': `Bearer ${config.openaiApiKey}`,
    'Content-Type': 'application/json'
  };
  if (config.openaiOrgId) headers['OpenAI-Organization'] = config.openaiOrgId;
  if (config.openaiProjectId) headers['OpenAI-Project'] = config.openaiProjectId;

  // Prepare input images (Garment is primary; Model or Scene can be secondary reference)
  const images = [];
  const garmentPath = path.join(projectInputDir, task.image);
  images.push({ image_url: fileToDataUrl(garmentPath) });

  if (task.model_image) {
    const modelPath = path.join(projectInputDir, task.model_image);
    if (fs.existsSync(modelPath)) {
      images.push({ image_url: fileToDataUrl(modelPath) });
    }
  } else if (task.scene_image) {
    const scenePath = path.join(projectInputDir, task.scene_image);
    if (fs.existsSync(scenePath)) {
      images.push({ image_url: fileToDataUrl(scenePath) });
    }
  }

  const imageSize = mapAspectRatioToSize(task.aspect_ratio);
  const fullPrompt = `${prompt.trim()}\n\n${OPENAI_IMAGE_OUTPUT_REQUIREMENTS}`;

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

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });

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

  if (contentType.includes('text/event-stream') && response.body) {
    base64Output = await relayOpenAiStream(response.body, onProgress);
  } else {
    // Non-streaming JSON response fallback
    const payload = await response.json();
    if (payload.data && payload.data[0] && payload.data[0].b64_json) {
      base64Output = payload.data[0].b64_json;
    } else if (payload.data && payload.data[0] && payload.data[0].url) {
      // If URL is returned instead of b64
      const imgRes = await fetch(payload.data[0].url);
      const arrayBuffer = await imgRes.arrayBuffer();
      base64Output = Buffer.from(arrayBuffer).toString('base64');
    }
  }

  if (!base64Output) {
    throw new Error('GPT Image 2 未返回有效图像数据。');
  }

  // Save generated image to PROJECT_IMAGE_DIR
  const savedFilename = `gpt2_${task.scene.id || 'scene'}_${taskId}.png`;
  const destPath = path.join(projectImageDir, savedFilename);
  fs.writeFileSync(destPath, Buffer.from(base64Output, 'base64'));

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
