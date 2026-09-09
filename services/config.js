const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const ENV_FILE = path.join(__dirname, '..', '.env');

// Auto-load .env file if it exists
function loadEnvFile() {
  if (typeof process.loadEnvFile === 'function') {
    try {
      if (fs.existsSync(ENV_FILE)) {
        process.loadEnvFile(ENV_FILE);
      }
    } catch (e) {
      manualLoadEnv();
    }
  } else {
    manualLoadEnv();
  }
}

function manualLoadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  try {
    const lines = fs.readFileSync(ENV_FILE, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch (e) {}
}

loadEnvFile();

let persistedConfig = {};
try {
  if (fs.existsSync(CONFIG_FILE)) {
    persistedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  }
} catch (e) {
  persistedConfig = {};
}

function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return 'https://api.openai.com/v1';
  let clean = url.trim().replace(/\/+$/, '');
  if (!clean) return 'https://api.openai.com/v1';
  if (!clean.endsWith('/v1')) {
    clean = `${clean}/v1`;
  }
  return clean;
}

function getRawConfig() {
  return {
    openaiApiKey: (process.env.OPENAI_API_KEY || persistedConfig.openaiApiKey || '').trim(),
    openaiBaseUrl: normalizeBaseUrl(process.env.OPENAI_BASE_URL || persistedConfig.openaiBaseUrl),
    openaiOrgId: (process.env.OPENAI_ORG_ID || persistedConfig.openaiOrgId || '').trim(),
    openaiProjectId: (process.env.OPENAI_PROJECT_ID || persistedConfig.openaiProjectId || '').trim(),
    openaiImageModel: (process.env.OPENAI_IMAGE_MODEL || persistedConfig.openaiImageModel || 'gpt-image-2').trim(),
    openaiImageQuality: (process.env.OPENAI_IMAGE_QUALITY || persistedConfig.openaiImageQuality || 'high').trim()
  };
}

function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

function getSafeConfig() {
  const raw = getRawConfig();
  return {
    hasApiKey: !!raw.openaiApiKey,
    apiKeyMasked: maskApiKey(raw.openaiApiKey),
    openaiBaseUrl: raw.openaiBaseUrl,
    openaiImageModel: raw.openaiImageModel,
    openaiImageQuality: raw.openaiImageQuality,
    supportedEngines: [
      { id: 'krea2', name: 'Krea-2 (本地扩散)', ready: true, note: '无需 API Key，本地 GPU 渲染' },
      { id: 'gpt_image_2', name: 'GPT Image 2 (OpenAI)', ready: !!raw.openaiApiKey, note: raw.openaiApiKey ? '已配置 API Key' : '需配置 API Key' }
    ]
  };
}

function saveConfig(newConfig) {
  if (typeof newConfig.openaiApiKey === 'string' && newConfig.openaiApiKey.trim()) {
    persistedConfig.openaiApiKey = newConfig.openaiApiKey.trim();
    process.env.OPENAI_API_KEY = persistedConfig.openaiApiKey;
  }
  if (typeof newConfig.openaiBaseUrl === 'string') {
    persistedConfig.openaiBaseUrl = normalizeBaseUrl(newConfig.openaiBaseUrl);
    process.env.OPENAI_BASE_URL = persistedConfig.openaiBaseUrl;
  }
  if (typeof newConfig.openaiImageModel === 'string' && newConfig.openaiImageModel.trim()) {
    persistedConfig.openaiImageModel = newConfig.openaiImageModel.trim();
  }
  if (typeof newConfig.openaiImageQuality === 'string' && newConfig.openaiImageQuality.trim()) {
    persistedConfig.openaiImageQuality = newConfig.openaiImageQuality.trim();
  }

  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(persistedConfig, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save config.json:', e);
  }
  return getSafeConfig();
}

async function testOpenAiConnection(customApiKey, customBaseUrl) {
  const apiKey = (customApiKey && customApiKey.trim()) || getRawConfig().openaiApiKey || '';
  const baseUrl = normalizeBaseUrl(customBaseUrl || getRawConfig().openaiBaseUrl);

  if (!apiKey) {
    return { ok: false, message: '请先填写 OpenAI API Key' };
  }

  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (res.ok) {
      const data = await res.json();
      const models = data.data ? data.data.map(m => m.id) : [];
      const hasGptImage2 = models.some(m => m.includes('gpt-image-2') || m.includes('dall-e'));
      return {
        ok: true,
        message: `连接成功！端点响应正常${hasGptImage2 ? '，检测到图像模型' : ''}。`
      };
    } else {
      let errDetail = `HTTP ${res.status}`;
      try {
        const errJson = await res.json();
        if (errJson.error && errJson.error.message) {
          errDetail = errJson.error.message;
        }
      } catch (e) {}
      return { ok: false, message: `连接失败: ${errDetail}` };
    }
  } catch (err) {
    return { ok: false, message: `网络连接异常: ${err.message}` };
  }
}

module.exports = {
  getRawConfig,
  getSafeConfig,
  saveConfig,
  testOpenAiConnection
};
