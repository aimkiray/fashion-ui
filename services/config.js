const fs = require('fs');
const path = require('path');

function getConfigFile() {
  return process.env.CONFIG_FILE || path.join(__dirname, '..', 'config.json');
}
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

let persistedConfig = {};

function loadPersistedConfig() {
  const configFile = getConfigFile();
  try {
    if (fs.existsSync(configFile)) {
      persistedConfig = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      if (typeof persistedConfig.openaiApiKey === 'string' && persistedConfig.openaiApiKey.trim()) {
        process.env.OPENAI_API_KEY = persistedConfig.openaiApiKey.trim();
      }
      if (typeof persistedConfig.openaiBaseUrl === 'string' && persistedConfig.openaiBaseUrl.trim()) {
        process.env.OPENAI_BASE_URL = persistedConfig.openaiBaseUrl.trim();
      }
      if (typeof persistedConfig.openaiImageModel === 'string' && persistedConfig.openaiImageModel.trim()) {
        process.env.OPENAI_IMAGE_MODEL = persistedConfig.openaiImageModel.trim();
      }
      if (typeof persistedConfig.openaiImageQuality === 'string' && persistedConfig.openaiImageQuality.trim()) {
        process.env.OPENAI_IMAGE_QUALITY = persistedConfig.openaiImageQuality.trim();
      }
    } else {
      persistedConfig = {};
    }
  } catch (e) {
    console.warn('config.json parse error:', e);
    persistedConfig = {};
  }
}

loadEnvFile();
loadPersistedConfig();

function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return 'https://api.openai.com/v1';
  let clean = url.trim().replace(/\/+$/, '');
  if (!clean) return 'https://api.openai.com/v1';
  // Security guard: ensure URL uses http:// or https:// protocol
  if (!/^https?:\/\//i.test(clean)) {
    clean = `https://${clean}`;
  }
  if (!clean.endsWith('/v1')) {
    clean = `${clean}/v1`;
  }
  return clean;
}

function getRawConfig() {
  const fileKey = (typeof persistedConfig.openaiApiKey === 'string') ? persistedConfig.openaiApiKey.trim() : '';
  const envKey = (process.env.OPENAI_API_KEY || '').trim();
  const apiKey = fileKey || envKey;

  const fileBase = (typeof persistedConfig.openaiBaseUrl === 'string') ? persistedConfig.openaiBaseUrl.trim() : '';
  const envBase = (process.env.OPENAI_BASE_URL || '').trim();
  const baseUrl = fileBase || envBase;

  const fileOrg = (typeof persistedConfig.openaiOrgId === 'string') ? persistedConfig.openaiOrgId.trim() : '';
  const envOrg = (process.env.OPENAI_ORG_ID || '').trim();
  const orgId = fileOrg || envOrg;

  const fileProject = (typeof persistedConfig.openaiProjectId === 'string') ? persistedConfig.openaiProjectId.trim() : '';
  const envProject = (process.env.OPENAI_PROJECT_ID || '').trim();
  const projectId = fileProject || envProject;

  const fileModel = (typeof persistedConfig.openaiImageModel === 'string') ? persistedConfig.openaiImageModel.trim() : '';
  const envModel = (process.env.OPENAI_IMAGE_MODEL || '').trim();
  const imageModel = fileModel || envModel || 'gpt-image-2';

  const fileQuality = (typeof persistedConfig.openaiImageQuality === 'string') ? persistedConfig.openaiImageQuality.trim() : '';
  const envQuality = (process.env.OPENAI_IMAGE_QUALITY || '').trim();
  const imageQuality = fileQuality || envQuality || 'high';

  return {
    openaiApiKey: apiKey,
    openaiBaseUrl: normalizeBaseUrl(baseUrl),
    openaiOrgId: orgId,
    openaiProjectId: projectId,
    openaiImageModel: imageModel,
    openaiImageQuality: imageQuality
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
  if (typeof newConfig.openaiApiKey === 'string') {
    persistedConfig.openaiApiKey = newConfig.openaiApiKey.trim();
    process.env.OPENAI_API_KEY = persistedConfig.openaiApiKey;
  }
  if (typeof newConfig.openaiBaseUrl === 'string') {
    persistedConfig.openaiBaseUrl = normalizeBaseUrl(newConfig.openaiBaseUrl);
    process.env.OPENAI_BASE_URL = persistedConfig.openaiBaseUrl;
  }
  if (typeof newConfig.openaiImageModel === 'string' && newConfig.openaiImageModel.trim()) {
    persistedConfig.openaiImageModel = newConfig.openaiImageModel.trim();
    // Keep env in sync — .env pins OPENAI_IMAGE_MODEL at boot and env wins
    // in getRawConfig, so sync process.env as well
    process.env.OPENAI_IMAGE_MODEL = persistedConfig.openaiImageModel;
  }
  if (typeof newConfig.openaiImageQuality === 'string' && newConfig.openaiImageQuality.trim()) {
    persistedConfig.openaiImageQuality = newConfig.openaiImageQuality.trim();
    // Keep env in sync — .env pins OPENAI_IMAGE_QUALITY at boot and env wins
    // in getRawConfig, so without this the UI quality change is silently ignored.
    process.env.OPENAI_IMAGE_QUALITY = persistedConfig.openaiImageQuality;
  }

  const configFile = getConfigFile();
  try {
    fs.writeFileSync(configFile, JSON.stringify(persistedConfig, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save config file:', e);
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
  loadEnv: loadEnvFile,
  loadPersistedConfig,
  reloadConfig: () => {
    loadEnvFile();
    loadPersistedConfig();
  },
  getRawConfig,
  getSafeConfig,
  saveConfig,
  testOpenAiConnection
};
