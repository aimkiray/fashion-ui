document.addEventListener('DOMContentLoaded', () => {
  // State
  let selectedImage = null;
  let uploadedFile = null;
  let uploadedModelFile = null;
  let uploadedSceneFile = null;
  let selectedScene = 'street';
  let currentTaskId = null;
  let activeBatchId = null;
  let currentBatchData = null;
  let selectedBatchIndex = 0;
  let pollTimeout = null;
  let batchPollTimeout = null;
  let isPollingActive = false;
  let isBatchPolling = false;
  let userClickedBatchTab = false;
  let timerInterval = null;
  let startTime = null;
  let dragCounter = 0;
  let userAudioMuted = true; // 默认静音：浏览器自动播放策略也要求 muted 才能自启
  let isPromptsCustomModified = false;
  let inspectorDebounceTimer = null;
  let cachedAutoPrompts = { krea_prompt: '', seg1_prompt: '', seg2_prompt: '' };

  // DOM Elements - Garment Upload
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const dropzonePrompt = document.getElementById('dropzonePrompt');
  const dropzonePreview = document.getElementById('dropzonePreview');
  const previewImg = document.getElementById('previewImg');
  const btnRemoveImage = document.getElementById('btnRemoveImage');
  const presetButtons = document.querySelectorAll('.preset-btn');

  // DOM Elements - Model Reference (Optional)
  const modelDropzone = document.getElementById('modelDropzone');
  const modelFileInput = document.getElementById('modelFileInput');
  const modelDropzonePrompt = document.getElementById('modelDropzonePrompt');
  const modelDropzonePreview = document.getElementById('modelDropzonePreview');
  const modelPreviewImg = document.getElementById('modelPreviewImg');
  const btnRemoveModelImage = document.getElementById('btnRemoveModelImage');

  // DOM Elements - Scene Reference (Optional)
  const sceneDropzone = document.getElementById('sceneDropzone');
  const sceneFileInput = document.getElementById('sceneFileInput');
  const sceneDropzonePrompt = document.getElementById('sceneDropzonePrompt');
  const sceneDropzonePreview = document.getElementById('sceneDropzonePreview');
  const scenePreviewImg = document.getElementById('scenePreviewImg');
  const btnRemoveSceneImage = document.getElementById('btnRemoveSceneImage');

  // DOM Elements - Scene & Prompt Configuration
  const sceneGrid = document.getElementById('sceneGrid');
  const customSceneWrapper = document.getElementById('customSceneWrapper');
  const customSceneText = document.getElementById('customSceneText');
  const customPromptInput = document.getElementById('customPrompt');
  const btnGenerate = document.getElementById('btnGenerate');
  const btnGenerateBatch = document.getElementById('btnGenerateBatch');

  // DOM Elements - Prompt Inspector & Fine-Tuning
  const promptInspectorDetails = document.getElementById('promptInspectorDetails');
  const inspectorBadge = document.getElementById('inspectorBadge');
  const btnResetPrompts = document.getElementById('btnResetPrompts');
  const inspectorKreaPrompt = document.getElementById('inspectorKreaPrompt');
  const inspectorSeg1Prompt = document.getElementById('inspectorSeg1Prompt');
  const inspectorSeg2Prompt = document.getElementById('inspectorSeg2Prompt');
  const badgeKreaPrompt = document.getElementById('badgeKreaPrompt');
  const badgeSeg1Prompt = document.getElementById('badgeSeg1Prompt');
  const badgeSeg2Prompt = document.getElementById('badgeSeg2Prompt');

  // DOM Elements - Progress & Status
  const progressCard = document.getElementById('progressCard');
  const progressCardTitle = document.getElementById('progressCardTitle');
  const progressBar = document.getElementById('progressBar');
  const progressStatusMsg = document.getElementById('progressStatusMsg');
  const elapsedTimer = document.getElementById('elapsedTimer');
  const btnCancelTask = document.getElementById('btnCancelTask');

  // DOM Elements - Batch Navigation
  const batchNavBar = document.getElementById('batchNavBar');
  const batchTabs = document.getElementById('batchTabs');
  const batchTitleText = document.getElementById('batchTitleText');
  const batchProgressPill = document.getElementById('batchProgressPill');
  const btnDownloadAllBatch = document.getElementById('btnDownloadAllBatch');

  // DOM Elements - Showcase & Output
  const showcaseEmpty = document.getElementById('showcaseEmpty');
  const showcaseContent = document.getElementById('showcaseContent');
  const resultStillImg = document.getElementById('resultStillImg');
  const stillFrameWrapper = document.getElementById('stillFrameWrapper');
  const downloadStillBtn = document.getElementById('downloadStillBtn');
  const btnZoomStill = document.getElementById('btnZoomStill');
  const btnStillToVideo = document.getElementById('btnStillToVideo');

  const videoBox = document.getElementById('videoBox');
  const resultVideo = document.getElementById('resultVideo');
  const btnToggleAudio = document.getElementById('btnToggleAudio');
  const downloadVideoBtn = document.getElementById('downloadVideoBtn');

  // Result frames follow the media's true aspect ratio — a fixed 3/4 frame
  // with object-fit: cover crops anything that is not exactly 3:4.
  if (resultStillImg) {
    resultStillImg.addEventListener('load', () => {
      const frame = resultStillImg.closest('.image-frame');
      if (frame && resultStillImg.naturalWidth && resultStillImg.naturalHeight) {
        frame.style.aspectRatio = `${resultStillImg.naturalWidth} / ${resultStillImg.naturalHeight}`;
      }
    });
  }
  if (resultVideo) {
    resultVideo.addEventListener('loadedmetadata', () => {
      const frame = resultVideo.closest('.video-frame');
      if (frame && resultVideo.videoWidth && resultVideo.videoHeight) {
        frame.style.aspectRatio = `${resultVideo.videoWidth} / ${resultVideo.videoHeight}`;
      }
    });
  }

  const historyGrid = document.getElementById('historyGrid');
  const btnRefreshHistory = document.getElementById('btnRefreshHistory');
  const systemStatus = document.getElementById('systemStatus');
  const statusText = document.getElementById('statusText');

  const toastContainer = document.getElementById('toastContainer');
  const lightboxModal = document.getElementById('lightboxModal');
  const lightboxImg = document.getElementById('lightboxImg');
  const btnCloseLightbox = document.getElementById('btnCloseLightbox');

  // API Config Modal Elements
  const btnOpenApiConfig = document.getElementById('btnOpenApiConfig');
  const btnCloseApiConfig = document.getElementById('btnCloseApiConfig');
  const apiConfigModal = document.getElementById('apiConfigModal');
  const cfgApiKey = document.getElementById('cfgApiKey');
  const btnToggleApiKey = document.getElementById('btnToggleApiKey');
  const cfgApiKeyStatus = document.getElementById('cfgApiKeyStatus');
  const cfgBaseUrl = document.getElementById('cfgBaseUrl');
  const cfgModel = document.getElementById('cfgModel');
  const cfgQuality = document.getElementById('cfgQuality');
  const cfgTestResult = document.getElementById('cfgTestResult');
  const btnTestApiConnection = document.getElementById('btnTestApiConnection');
  const btnSaveApiConfig = document.getElementById('btnSaveApiConfig');
  const btnClearApiKey = document.getElementById('btnClearApiKey');
  const inspectorStage1Title = document.getElementById('inspectorStage1Title');

  const modelStylePromptInput = document.getElementById('modelStylePrompt');
const seg1ActionSelect = document.getElementById('seg1Action');
const seg2ActionSelect = document.getElementById('seg2Action');
const DEFAULT_ACTIONS = { seg1: 'random', seg2: 'random' };
  const btnResetStylePrompt = document.getElementById('btnResetStylePrompt');

  // Helper: HTML entity escaping
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Toast notification helper
  function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = `toast ${isError ? 'error' : ''}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ==========================================
  // OpenAI / GPT Image 2 API Config Modal Logic
  // ==========================================
  let serverConfig = null;

  async function fetchServerConfig() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        serverConfig = await res.json();
        updateApiConfigModalFields();
      }
    } catch (e) {
      console.warn('Failed to fetch config:', e);
    }
  }

  function updateApiConfigModalFields() {
    if (!serverConfig) return;
    if (cfgApiKeyStatus) {
      if (serverConfig.hasApiKey) {
        cfgApiKeyStatus.textContent = `已配置 API Key: ${serverConfig.apiKeyMasked}`;
        cfgApiKeyStatus.style.color = '#2ed573';
      } else {
        cfgApiKeyStatus.textContent = '尚未配置 API Key (必填)';
        cfgApiKeyStatus.style.color = 'var(--text-muted)';
      }
    }
    if (cfgBaseUrl && serverConfig.openaiBaseUrl) {
      cfgBaseUrl.value = serverConfig.openaiBaseUrl;
    }
    if (cfgModel && serverConfig.openaiImageModel) {
      cfgModel.value = serverConfig.openaiImageModel;
    }
    if (cfgQuality && serverConfig.openaiImageQuality) {
      cfgQuality.value = serverConfig.openaiImageQuality;
    }
  }

  function openApiConfigModal() {
    if (!apiConfigModal) return;
    apiConfigModal.style.display = 'flex';
    if (cfgTestResult) {
      cfgTestResult.style.display = 'none';
      cfgTestResult.className = 'test-result-box';
    }
    fetchServerConfig();
  }

  function closeApiConfigModal() {
    if (!apiConfigModal) return;
    apiConfigModal.style.display = 'none';
  }

  if (btnOpenApiConfig) btnOpenApiConfig.addEventListener('click', openApiConfigModal);
  if (btnCloseApiConfig) btnCloseApiConfig.addEventListener('click', closeApiConfigModal);
  if (apiConfigModal) {
    apiConfigModal.addEventListener('click', (e) => {
      if (e.target === apiConfigModal) closeApiConfigModal();
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (apiConfigModal && apiConfigModal.style.display === 'flex') {
        closeApiConfigModal();
      }
      if (lightboxModal && lightboxModal.style.display === 'flex') {
        lightboxModal.style.display = 'none';
      }
    }
  });

  if (btnToggleApiKey) {
    btnToggleApiKey.addEventListener('click', () => {
      if (!cfgApiKey) return;
      const isPwd = cfgApiKey.type === 'password';
      cfgApiKey.type = isPwd ? 'text' : 'password';
      btnToggleApiKey.innerHTML = isPwd ? '<i class="ph ph-eye-slash"></i>' : '<i class="ph ph-eye"></i>';
    });
  }

  if (btnTestApiConnection) {
    btnTestApiConnection.addEventListener('click', async () => {
      const apiKey = cfgApiKey ? cfgApiKey.value.trim() : '';
      const baseUrl = cfgBaseUrl ? cfgBaseUrl.value.trim() : '';
      btnTestApiConnection.disabled = true;
      btnTestApiConnection.innerHTML = '<i class="ph ph-spinner ph-spin"></i> 测试中...';
      if (cfgTestResult) {
        cfgTestResult.style.display = 'block';
        cfgTestResult.className = 'test-result-box info';
        cfgTestResult.textContent = '正在连接 OpenAI 接口...';
      }
      try {
        const res = await fetch('/api/config/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, baseUrl })
        });
        const data = await res.json();
        if (cfgTestResult) {
          cfgTestResult.className = `test-result-box ${data.ok ? 'success' : 'error'}`;
          cfgTestResult.textContent = data.message || (data.ok ? '连接成功！' : '连接失败');
        }
      } catch (err) {
        if (cfgTestResult) {
          cfgTestResult.className = 'test-result-box error';
          cfgTestResult.textContent = `网络错误: ${err.message}`;
        }
      } finally {
        btnTestApiConnection.disabled = false;
        btnTestApiConnection.innerHTML = '<i class="ph ph-plugs"></i> 测试连接';
      }
    });
  }

  if (btnSaveApiConfig) {
    btnSaveApiConfig.addEventListener('click', async () => {
      const apiKey = cfgApiKey ? cfgApiKey.value.trim() : '';
      const baseUrl = cfgBaseUrl ? cfgBaseUrl.value.trim() : '';
      const model = cfgModel ? cfgModel.value.trim() : 'gpt-image-2';
      const quality = cfgQuality ? cfgQuality.value : 'high';

      btnSaveApiConfig.disabled = true;
      btnSaveApiConfig.innerHTML = '<i class="ph ph-spinner ph-spin"></i> 保存中...';

      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            openaiApiKey: apiKey || undefined,
            openaiBaseUrl: baseUrl || undefined,
            openaiImageModel: model,
            openaiImageQuality: quality
          })
        });
        const data = await res.json();
        if (data.success && data.config) {
          serverConfig = data.config;
          if (cfgApiKey) cfgApiKey.value = '';
          updateApiConfigModalFields();
          showToast('OpenAI API 配置已保存成功！');
          closeApiConfigModal();
        } else {
          showToast('保存失败: ' + (data.error || '未知错误'), true);
        }
      } catch (err) {
        showToast('保存失败: ' + err.message, true);
      } finally {
        btnSaveApiConfig.disabled = false;
        btnSaveApiConfig.innerHTML = '<i class="ph ph-check"></i> 保存配置';
      }
    });
  }

  if (btnClearApiKey) {
    btnClearApiKey.addEventListener('click', async () => {
      if (!window.confirm('确定要清空服务端保存的 API Key 吗？\n（若 .env 中配置了环境变量，将自动安全回退至环境变量）')) return;
      btnClearApiKey.disabled = true;
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ openaiApiKey: '' })
        });
        const data = await res.json();
        if (data.success && data.config) {
          serverConfig = data.config;
          if (cfgApiKey) cfgApiKey.value = '';
          updateApiConfigModalFields();
          showToast('API Key 已清空（若有 .env 将自动回退）');
        } else {
          showToast('清空失败: ' + (data.error || '未知错误'), true);
        }
      } catch (err) {
        showToast('清空失败: ' + err.message, true);
      } finally {
        btnClearApiKey.disabled = false;
      }
    });
  }

  // Persistence & Storage Keys
  const STORAGE_KEY = 'fashion_ui_user_options_v2';
  const ACTIVE_TASK_KEY = 'fashion_ui_active_task';
  const ACTIVE_BATCH_KEY = 'fashion_ui_active_batch';
  const STYLE_PROMPTS_KEY = 'fashion_ui_style_prompts_v3';
  const IDB_NAME = 'fashion_ui_storage_v2';
  const STORE_GARMENT = 'uploaded_garment';
  const STORE_MODEL = 'uploaded_model';
  const STORE_SCENE = 'uploaded_scene';

  // Default Model Style Prompts
  const DEFAULT_STYLE_PROMPTS = {
    female: {
      classic: 'with sculpted high-fashion supermodel presence, poised regal bearing, composed magnetic gaze, naturally closed lips without tension, and effortless commanding runway posture',
      sweet: 'with sweet youthful charm, bright sparkling eyes full of gentle warmth, dewy fresh skin, naturally closed lips with a faint serene tenderness, and graceful airy posture',
      athletic: 'with healthy athletic vitality, sun-kissed glowing skin and toned posture, bright focused determined eyes, naturally closed lips with composed confidence, and grounded energetic stance',
      mature: 'with commanding mature elegance, knowing confident warmth in the eyes, luminous smooth skin, naturally closed lips with serene authority, and statuesque poised posture',
      cool: 'with chic androgynous edge, sharp minimal attitude, cool detached yet engaged gaze, naturally closed lips without tension, and effortless nonchalant posture',
      youthful: 'with lively youthful energy, bright sparkling eyes radiating cheerful vitality, fresh glowing skin, naturally closed lips with a bright cheerful spirit, and light springy posture',
      intellectual: 'with gentle intellectual grace, serene thoughtful eyes carrying quiet depth, soft minimal styling, clean natural makeup look, naturally closed lips with calm composure, and understated elegant posture',
      french: 'with effortless Parisian chic, relaxed romantic air, naturally glowing minimal makeup, warm subtle gaze, naturally closed lips with serene charm, and breezy nonchalant elegance in posture',
      retro: 'with 1990s Hong Kong cinematic glamour, luminous warm skin, magnetic star-quality gaze, naturally closed lips with poised mystique, and iconic timeless posture',
      petite: 'with petite adorable charm, small slim frame and fine-boned delicate figure, big bright expressive eyes, smooth dewy skin, naturally closed lips with playful cuteness, and cute perky posture',
    },
    male: {
      classic: 'with high-fashion supermodel charisma, composed magnetic gaze, naturally closed lips without tension, and commanding runway posture',
      sweet: 'with clean boyish charm, soft warm eye expression, fresh dewy skin, naturally closed lips without tension, and light approachable posture',
      athletic: 'with athletic vigor, toned build and sun-kissed skin, sharp focused gaze, naturally closed lips without tension, and upright powerful stance',
      mature: 'with distinguished executive presence, calm assured gaze, naturally closed lips without tension, and commanding confident posture',
      cool: 'with contemporary streetwear edge, understated cool attitude, naturally closed lips without tension, and relaxed confident posture',
      youthful: 'with sunny youthful energy, bright lively eyes and fresh open expression, glowing healthy skin, naturally closed lips without tension, and light energetic posture',
      intellectual: 'with refined scholarly warmth, calm thoughtful gaze and gentle steady presence, clean minimal styling, naturally closed lips without tension, and composed graceful posture',
      french: 'with relaxed Parisian elegance, easygoing romantic air, warm understated gaze, naturally closed lips without tension, and breezy confident posture',
      retro: 'with 1990s Hong Kong cinematic charisma, luminous warm skin, magnetic film-star gaze, naturally closed lips without tension, and iconic screen-presence posture',
      petite: 'with cute boyish charm, small lean frame, bright lively eyes, fresh clear skin, naturally closed lips without tension, and playful relaxed posture',
    }
  };

  function loadStoredStylePrompts() {
    try {
      const raw = localStorage.getItem(STYLE_PROMPTS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveStoredStylePrompts(data) {
    try {
      localStorage.setItem(STYLE_PROMPTS_KEY, JSON.stringify(data));
    } catch (e) {}
  }

  function getStylePromptKey(gender, style) {
    const g = gender === 'male' ? 'male' : 'female';
    const s = style || 'classic';
    return `${g}_${s}`;
  }

  function getEffectiveStylePrompt(gender, style) {
    const g = gender === 'male' ? 'male' : 'female';
    const s = style || 'classic';
    const stored = loadStoredStylePrompts();
    const key = getStylePromptKey(g, s);
    if (typeof stored[key] === 'string' && stored[key].trim() !== '') {
      return stored[key];
    }
    return DEFAULT_STYLE_PROMPTS[g]?.[s] || DEFAULT_STYLE_PROMPTS.female.classic;
  }

  function setEffectiveStylePrompt(gender, style, promptVal) {
    const g = gender === 'male' ? 'male' : 'female';
    const s = style || 'classic';
    const stored = loadStoredStylePrompts();
    const key = getStylePromptKey(g, s);
    stored[key] = promptVal;
    saveStoredStylePrompts(stored);
  }

  function resetEffectiveStylePrompt(gender, style) {
    const g = gender === 'male' ? 'male' : 'female';
    const s = style || 'classic';
    const stored = loadStoredStylePrompts();
    const key = getStylePromptKey(g, s);
    delete stored[key];
    saveStoredStylePrompts(stored);
    return DEFAULT_STYLE_PROMPTS[g]?.[s] || DEFAULT_STYLE_PROMPTS.female.classic;
  }

  function updateModelStylePromptUI() {
    if (!modelStylePromptInput) return;
    const gender = document.querySelector('input[name="gender"]:checked')?.value || 'female';
    const modelStyle = document.querySelector('input[name="modelStyle"]:checked')?.value || 'classic';
    modelStylePromptInput.value = getEffectiveStylePrompt(gender, modelStyle);
  }

  async function syncModelStylesFromServer() {
    try {
      const res = await fetch('/api/model-styles');
      if (!res.ok) return;
      const data = await res.json();
      for (const [key, val] of Object.entries(data)) {
        if (val.female) DEFAULT_STYLE_PROMPTS.female[key] = val.female;
        if (val.male) DEFAULT_STYLE_PROMPTS.male[key] = val.male;
      }
      if (document.activeElement !== modelStylePromptInput) {
        updateModelStylePromptUI();
      }
    } catch (e) {}
  }

  // IndexedDB Helper with support for Garment, Model reference, and Scene reference
  function openStorageDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_GARMENT)) {
          db.createObjectStore(STORE_GARMENT);
        }
        if (!db.objectStoreNames.contains(STORE_MODEL)) {
          db.createObjectStore(STORE_MODEL);
        }
        if (!db.objectStoreNames.contains(STORE_SCENE)) {
          db.createObjectStore(STORE_SCENE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function cacheStorageFile(storeName, dataUrl, filename, mimeType) {
    try {
      const db = await openStorageDB();
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put({ data: dataUrl, name: filename, type: mimeType }, 'current_upload');
    } catch (e) {
      console.warn(`Failed to cache ${storeName}:`, e);
    }
  }

  async function getCachedStorageFile(storeName) {
    try {
      const db = await openStorageDB();
      return new Promise((resolve) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get('current_upload');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async function clearCachedStorageFile(storeName) {
    try {
      const db = await openStorageDB();
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete('current_upload');
    } catch (e) {}
  }

  async function dataUrlToFile(dataUrl, filename, mimeType) {
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      return new File([blob], filename || 'uploaded_image.png', {
        type: mimeType || blob.type || 'image/png'
      });
    } catch {
      const parts = dataUrl.split(',');
      const mime = parts[0].match(/:(.*?);/)?.[1] || mimeType || 'image/png';
      const bstr = atob(parts[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      return new File([u8arr], filename || 'uploaded_image.png', { type: mime });
    }
  }

  function saveUserOptions() {
    try {
      const gender = document.querySelector('input[name="gender"]:checked')?.value || 'female';
      const modelStyle = document.querySelector('input[name="modelStyle"]:checked')?.value || 'classic';
      const aspectRatio = document.querySelector('input[name="aspectRatio"]:checked')?.value || '3:4';
      const stillEngine = document.querySelector('input[name="stillEngine"]:checked')?.value || 'gpt_image_2';
      const genMode = document.querySelector('input[name="genMode"]:checked')?.value || 'video';
      const compositionMode = document.querySelector('input[name="compositionMode"]:checked')?.value || 'auto';
      const enhanceMode = document.querySelector('input[name="enhanceMode"]:checked')?.value || 'off';
      // These used to be closure variables; after the refactor they live only in
      // the DOM. Referencing the old names here threw a ReferenceError that the
      // try/catch swallowed — silently breaking ALL option persistence.
      const seg1Action = seg1ActionSelect ? seg1ActionSelect.value : DEFAULT_ACTIONS.seg1;
      const seg2Action = seg2ActionSelect ? seg2ActionSelect.value : DEFAULT_ACTIONS.seg2;
      const hairStyle = document.querySelector('input[name="hairStyle"]:checked')?.value || 'natural';
      const faceShape = document.querySelector('input[name="faceShape"]:checked')?.value || 'oval';
      const modelAge = document.querySelector('input[name="modelAge"]:checked')?.value || 'adult';
      const customScene = customSceneText ? customSceneText.value : '';
      const customPrompt = customPromptInput ? customPromptInput.value : '';

      const options = {
        selectedScene: selectedScene || 'street',
        customSceneText: customScene,
        gender,
        modelStyle,
        aspectRatio,
        stillEngine,
        genMode,
        compositionMode,
        enhanceMode,
        seg1Action,
        seg2Action,
        hairStyle,
        faceShape,
        modelAge,
        customPrompt,
        imageSource: uploadedFile ? 'upload' : (selectedImage ? 'preset' : null),
        selectedPresetImg: selectedImage || null,
        hasModelImage: !!uploadedModelFile,
        hasSceneImage: !!uploadedSceneFile
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
    } catch (e) {
      console.warn('Failed to save options to localStorage:', e);
    }
  }

  async function restoreUserOptions() {
    let opts = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('fashion_ui_user_options_v1');
      if (raw) {
        opts = JSON.parse(raw);
        // If migrating from v1 where test_outfit.png was automatically saved by default, clear it
        if (!localStorage.getItem(STORAGE_KEY) && opts && opts.selectedPresetImg === 'test_outfit.png' && opts.imageSource === 'preset') {
          opts.selectedPresetImg = null;
          opts.imageSource = null;
        }
      }
    } catch (e) {
      console.warn('Failed to parse saved options:', e);
    }

    // 1. Restore Model Reference if cached
    try {
      const cachedModel = await getCachedStorageFile(STORE_MODEL);
      if (cachedModel && cachedModel.data) {
        if (modelPreviewImg && modelDropzonePrompt && modelDropzonePreview) {
          modelPreviewImg.src = cachedModel.data;
          modelDropzonePrompt.style.display = 'none';
          modelDropzonePreview.style.display = 'flex';
        }
        uploadedModelFile = await dataUrlToFile(cachedModel.data, cachedModel.name, cachedModel.type);
      }
    } catch (e) {
      console.warn('Failed to restore model reference:', e);
    }

    // 2. Restore Scene Reference if cached
    try {
      const cachedScene = await getCachedStorageFile(STORE_SCENE);
      if (cachedScene && cachedScene.data) {
        if (scenePreviewImg && sceneDropzonePrompt && sceneDropzonePreview) {
          scenePreviewImg.src = cachedScene.data;
          sceneDropzonePrompt.style.display = 'none';
          sceneDropzonePreview.style.display = 'flex';
        }
        uploadedSceneFile = await dataUrlToFile(cachedScene.data, cachedScene.name, cachedScene.type);
      }
    } catch (e) {
      console.warn('Failed to restore scene reference:', e);
    }

    if (!opts) {
      selectedImage = null;
      uploadedFile = null;
      dropzonePrompt.style.display = 'block';
      dropzonePreview.style.display = 'none';
      presetButtons.forEach(b => b.classList.remove('active'));
      return;
    }

    // 3. Scene variable & custom wrapper state
    if (opts.selectedScene) {
      selectedScene = opts.selectedScene;
      if (customSceneWrapper) {
        customSceneWrapper.style.display = selectedScene === 'custom' ? 'block' : 'none';
      }
    }

    // 4. Custom scene description
    if (customSceneText && typeof opts.customSceneText === 'string') {
      customSceneText.value = opts.customSceneText;
    }

    // 5. Radios: gender, modelStyle, aspectRatio, genMode
    if (opts.gender) {
      const el = document.querySelector(`input[name="gender"][value="${opts.gender}"]`);
      if (el) el.checked = true;
    }
    if (opts.modelStyle) {
      const el = document.querySelector(`input[name="modelStyle"][value="${opts.modelStyle}"]`);
      if (el) el.checked = true;
    }
    updateModelStylePromptUI();
    if (opts.aspectRatio) {
      const el = document.querySelector(`input[name="aspectRatio"][value="${opts.aspectRatio}"]`);
      if (el) el.checked = true;
    }
    if (opts.stillEngine) {
      const el = document.querySelector(`input[name="stillEngine"][value="${opts.stillEngine}"]`);
      if (el) el.checked = true;
      updateStillEngineUI();
    }
    if (opts.genMode) {
      const el = document.querySelector(`input[name="genMode"][value="${opts.genMode}"]`);
      if (el) el.checked = true;
    }
    if (opts.compositionMode) {
      const el = document.querySelector(`input[name="compositionMode"][value="${opts.compositionMode}"]`);
      if (el) el.checked = true;
    }
    if (opts.enhanceMode) {
      const el = document.querySelector(`input[name="enhanceMode"][value="${opts.enhanceMode}"]`);
      if (el) el.checked = true;
    }

    // 5.5 Video action selects (options are populated by syncActionsFromServer before restore)
    if (seg1ActionSelect && opts.seg1Action) seg1ActionSelect.value = opts.seg1Action;
    if (seg2ActionSelect && opts.seg2Action) seg2ActionSelect.value = opts.seg2Action;
    if (seg1ActionSelect && seg1ActionSelect.selectedIndex === -1) seg1ActionSelect.value = DEFAULT_ACTIONS.seg1;
    if (seg2ActionSelect && seg2ActionSelect.selectedIndex === -1) seg2ActionSelect.value = DEFAULT_ACTIONS.seg2;

    // 5.6 Hair, face shape & model age radios
    if (opts.hairStyle) {
      const el = document.querySelector('input[name="hairStyle"][value="' + opts.hairStyle + '"]');
      if (el) el.checked = true;
    }
    if (opts.faceShape) {
      const el = document.querySelector('input[name="faceShape"][value="' + opts.faceShape + '"]');
      if (el) el.checked = true;
    }
    if (opts.modelAge) {
      const ageVal = opts.modelAge === 'prime' ? 'adult' : (opts.modelAge === 'mature' ? 'middle_aged' : (opts.modelAge === 'silver' ? 'elderly' : opts.modelAge));
      const el = document.querySelector('input[name="modelAge"][value="' + ageVal + '"]');
      if (el) el.checked = true;
    }

    // 6. Custom prompt
    if (customPromptInput && typeof opts.customPrompt === 'string') {
      customPromptInput.value = opts.customPrompt;
      updateCustomPromptBadge();
    }

    // 7. Garment image
    if (opts.imageSource === 'upload') {
      try {
        const cached = await getCachedStorageFile(STORE_GARMENT);
        if (cached && cached.data) {
          previewImg.src = cached.data;
          dropzonePrompt.style.display = 'none';
          dropzonePreview.style.display = 'flex';
          presetButtons.forEach(b => b.classList.remove('active'));
          selectedImage = null;

          uploadedFile = await dataUrlToFile(cached.data, cached.name, cached.type);
          return;
        }
      } catch (e) {
        console.warn('Failed to restore uploaded garment:', e);
      }
    }

    if (opts.selectedPresetImg) {
      const presetBtn = document.querySelector(`.preset-btn[data-img="${opts.selectedPresetImg}"]`);
      if (presetBtn) {
        presetButtons.forEach(b => b.classList.remove('active'));
        presetBtn.classList.add('active');
        selectedImage = opts.selectedPresetImg;
        uploadedFile = null;
        previewImg.src = `/inputs/${selectedImage}?v=${Date.now()}`;
        dropzonePrompt.style.display = 'none';
        dropzonePreview.style.display = 'flex';
        return;
      }
    }

    // Default fallback: do not select any preset image
    uploadedFile = null;
    selectedImage = null;
    dropzonePreview.style.display = 'none';
    dropzonePrompt.style.display = 'block';
    presetButtons.forEach(b => b.classList.remove('active'));
  }

  // 1. System Health & Queue Check
  async function checkSystem() {
    try {
      const res = await fetch('/api/system');
      const data = await res.json();
      if (data.online) {
        const gpuName = (data.gpu || 'RTX 4090').replace(/^cuda:\d+\s*/i, '').trim();
        const queueCount = data.queue ? ((data.queue.running || 0) + (data.queue.pending || 0)) : 0;
        const queueHint = queueCount > 0 ? ` | 排队中: ${queueCount}` : '';
        statusText.textContent = `在线 (${gpuName} | 显存 ${data.vram_free_gb}/${data.vram_total_gb} GB${queueHint})`;
        systemStatus.style.background = 'rgba(92, 185, 135, 0.14)';
        systemStatus.style.color = '#8fd6ad';
      } else {
        statusText.textContent = `离线 - ComfyUI 服务异常`;
        systemStatus.style.background = 'rgba(217, 92, 92, 0.14)';
        systemStatus.style.color = '#eba7a7';
      }
    } catch {
      statusText.textContent = `无法连接本地服务器`;
      systemStatus.style.background = 'rgba(217, 92, 92, 0.14)';
      systemStatus.style.color = '#eba7a7';
    }
  }
  checkSystem();
  setInterval(checkSystem, 15000);

  // Batch Scene Mapping & Dynamic Selector Helpers
  const BATCH_SCENE_LABELS = {
    street: '都市街拍',
    studio: '纯色影棚',
    boutique: '艺术买手店',
    office: '职场通勤',
    outdoor: '户外林荫',
    cafe: '极简咖啡厅',
    custom: '自定义场景'
  };

  function getBatchScenesFor(selected) {
    const result = [selected || 'street'];
    if (result[0] !== 'studio') {
      result.push('studio');
    } else {
      result.push('street');
    }
    if (!result.includes('street')) {
      result.push('street');
    } else if (!result.includes('boutique')) {
      result.push('boutique');
    } else {
      result.push('office');
    }
    return result.slice(0, 3);
  }

  function updateBatchHint() {
    const batchScenes = getBatchScenesFor(selectedScene);
    const sceneNames = batchScenes.map(id => BATCH_SCENE_LABELS[id] || id);
    const scenesText = `【${sceneNames.join('、')}】`;
    const genMode = document.querySelector('input[name="genMode"]:checked')?.value || 'video';
    const isStillOnly = genMode === 'still_only';
    const modeText = isStillOnly ? '定妆照' : '视频';

    if (btnGenerateBatch) {
      btnGenerateBatch.title = `自动排队顺序生成${scenesText} 3 套${modeText}`;
      btnGenerateBatch.innerHTML = `<i class="ph ph-lightning"></i> 一键批量生成 3 套${isStillOnly ? '定妆照' : '场景视频'}`;
    }
    if (btnGenerate) {
      if (isStillOnly) {
        btnGenerate.innerHTML = '<i class="ph ph-camera"></i> 快速生成试衣定妆照';
      } else {
        btnGenerate.innerHTML = '<i class="ph ph-sparkle"></i> 生成单套场景视频';
      }
    }
    // 超清增强仅对视频生成生效：定妆照模式下禁用开关，避免"勾了但被静默忽略"
    const enhanceGroup = document.getElementById('enhanceModeGroup');
    if (enhanceGroup) enhanceGroup.classList.toggle('option-disabled', isStillOnly);
    document.querySelectorAll('input[name="enhanceMode"]').forEach(el => { el.disabled = isStillOnly; });
  }

  function updateStillEngineUI() {
    const stillEngine = document.querySelector('input[name="stillEngine"]:checked')?.value || 'gpt_image_2';
    const inspectorStage1Title = document.getElementById('inspectorStage1Title');
    if (inspectorStage1Title) {
      inspectorStage1Title.textContent = stillEngine === 'gpt_image_2'
        ? '阶段一：GPT Image 2 参考底图提示词'
        : '阶段一：Krea-2 试衣定妆照生图提示词';
    }
    // Progress-card pipeline step 2 must follow the selected still engine.
    const step2Text = document.getElementById('step2Text');
    if (step2Text) {
      step2Text.textContent = stillEngine === 'gpt_image_2'
        ? 'GPT Image 2 静态试衣定型（主角融合与服装上身）'
        : 'Krea-2 静态试衣定型（主角融合与服装上身）';
    }
  }

  // 2. Load Actions & Scenes
  const cachedActionsMap = { random: '随机' };
  function getActionDisplayName(id) {
    if (!id || id === 'random') return '随机';
    return cachedActionsMap[id] || id;
  }

  async function syncActionsFromServer() {
    if (!seg1ActionSelect || !seg2ActionSelect) return;
    try {
      const res = await fetch('/api/actions');
      const actions = await res.json();
      if (Array.isArray(actions)) {
        actions.forEach(a => { cachedActionsMap[a.id] = a.name; });
      }
      const prev = { seg1: seg1ActionSelect.value, seg2: seg2ActionSelect.value };
      for (const sel of [seg1ActionSelect, seg2ActionSelect]) {
        sel.innerHTML = '<option value="random">🎲 随机</option>' +
          actions.map(a => '<option value="' + a.id + '">' + a.name + '</option>').join('');
      }
      seg1ActionSelect.value = prev.seg1 || DEFAULT_ACTIONS.seg1;
      seg2ActionSelect.value = prev.seg2 || DEFAULT_ACTIONS.seg2;
      if (seg1ActionSelect.selectedIndex === -1) seg1ActionSelect.value = DEFAULT_ACTIONS.seg1;
      if (seg2ActionSelect.selectedIndex === -1) seg2ActionSelect.value = DEFAULT_ACTIONS.seg2;
    } catch (e) {
      console.warn('Failed to load actions:', e);
    }
  }

  async function loadScenes() {
    try {
      const res = await fetch('/api/scenes');
      const scenes = await res.json();
      sceneGrid.innerHTML = '';

      scenes.forEach((sc) => {
        const isCustom = sc.id === 'custom';
        const card = document.createElement('div');
        card.className = `scene-card ${sc.id === selectedScene ? 'selected' : ''} ${isCustom ? 'scene-card-custom' : ''}`;
        card.dataset.sceneId = sc.id;
        card.innerHTML = `
          <div class="scene-top">
            <span class="scene-icon"><i class="ph ph-${sc.icon}"></i></span>
            <span class="scene-name">${sc.name}</span>
          </div>
          <p class="scene-desc">${sc.description}</p>
        `;
        card.addEventListener('click', () => {
          const sceneChanged = (selectedScene !== sc.id);
          document.querySelectorAll('.scene-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          selectedScene = sc.id;

          // Toggle custom scene input box visibility
          if (selectedScene === 'custom') {
            if (customSceneWrapper) {
              customSceneWrapper.style.display = 'block';
              if (customSceneText) customSceneText.focus();
            }
          } else {
            if (customSceneWrapper) {
              customSceneWrapper.style.display = 'none';
            }
            // Clear any stale scene reference image when leaving custom mode
            if (uploadedSceneFile) {
              uploadedSceneFile = null;
              clearCachedStorageFile(STORE_SCENE);
              if (sceneDropzonePreview) sceneDropzonePreview.style.display = 'none';
              if (sceneDropzonePrompt) sceneDropzonePrompt.style.display = 'block';
              if (sceneFileInput) sceneFileInput.value = '';
            }
          }
          saveUserOptions();
          updateBatchHint();

          if (sceneChanged) {
            const diffs = getPromptInspectorDiffs();
            if (diffs.hasAnyDiff) {
              showToast(`已切换至【${sc.name}】，提示词已自动同步为新场景配置`);
            }
            refreshPromptInspector(true);
          } else {
            queueRefreshPromptInspector();
          }
        });
        sceneGrid.appendChild(card);
      });

      // Synchronize custom scene wrapper visibility with restored selectedScene
      if (selectedScene === 'custom' && customSceneWrapper) {
        customSceneWrapper.style.display = 'block';
      }
      updateBatchHint();
    } catch (err) {
      console.error('Failed to load scenes:', err);
    }
  }

  // Bind quick scene tags
  document.querySelectorAll('.quick-scene-tag').forEach(tag => {
    tag.addEventListener('click', (e) => {
      e.preventDefault();
      const sceneDesc = tag.dataset.scene;
      const tagLabel = tag.textContent.trim();
      if (customSceneText) {
        customSceneText.value = sceneDesc;
      }
      // Ensure custom scene card is selected
      const customCard = document.querySelector('.scene-card-custom');
      if (customCard && selectedScene !== 'custom') {
        customCard.click();
      } else {
        selectedScene = 'custom';
        if (customSceneWrapper) customSceneWrapper.style.display = 'block';
        if (customSceneText) customSceneText.focus();
        updateBatchHint();
      }
      showToast(`已应用场景灵感: ${tagLabel}`);
      saveUserOptions();
      queueRefreshPromptInspector();
    });
  });

  // 3. Upload, Preset & Clipboard Handling Helper
  function setupDropzone(opts) {
    const {
      dropzoneEl,
      fileInputEl,
      promptEl,
      previewEl,
      previewImgEl,
      removeBtnEl,
      storeName,
      onFileSet,
      onFileClear
    } = opts;

    if (!dropzoneEl || !fileInputEl) return null;
    let localDragCounter = 0;

    dropzoneEl.addEventListener('click', () => {
      fileInputEl.click();
    });

    dropzoneEl.addEventListener('dragenter', (e) => {
      e.preventDefault();
      localDragCounter++;
      dropzoneEl.classList.add('drag-over');
    });

    dropzoneEl.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    dropzoneEl.addEventListener('dragleave', (e) => {
      e.preventDefault();
      localDragCounter--;
      if (localDragCounter <= 0) {
        localDragCounter = 0;
        dropzoneEl.classList.remove('drag-over');
      }
    });

    dropzoneEl.addEventListener('drop', (e) => {
      e.preventDefault();
      localDragCounter = 0;
      dropzoneEl.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        processFile(e.dataTransfer.files[0]);
      }
    });

    fileInputEl.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        processFile(e.target.files[0]);
      }
    });

    if (removeBtnEl) {
      removeBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        previewEl.style.display = 'none';
        promptEl.style.display = 'block';
        previewImgEl.src = '';
        fileInputEl.value = '';
        if (storeName) clearCachedStorageFile(storeName);
        if (onFileClear) onFileClear();
        saveUserOptions();
      });
    }

    function processFile(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target.result;
        previewImgEl.src = dataUrl;
        promptEl.style.display = 'none';
        previewEl.style.display = 'flex';
        if (storeName) cacheStorageFile(storeName, dataUrl, file.name, file.type);
        if (onFileSet) onFileSet(file, dataUrl);
        saveUserOptions();
      };
      reader.readAsDataURL(file);
    }

    return { processFile };
  }

  // Bind Garment Dropzone
  const garmentDropzoneHelper = setupDropzone({
    dropzoneEl: dropzone,
    fileInputEl: fileInput,
    promptEl: dropzonePrompt,
    previewEl: dropzonePreview,
    previewImgEl: previewImg,
    removeBtnEl: btnRemoveImage,
    storeName: STORE_GARMENT,
    onFileSet: (file) => {
      uploadedFile = file;
      selectedImage = null;
      presetButtons.forEach(btn => btn.classList.remove('active'));
    },
    onFileClear: () => {
      uploadedFile = null;
      selectedImage = null;
      presetButtons.forEach(btn => btn.classList.remove('active'));
    }
  });

  // Bind Model Reference Dropzone
  const modelDropzoneHelper = setupDropzone({
    dropzoneEl: modelDropzone,
    fileInputEl: modelFileInput,
    promptEl: modelDropzonePrompt,
    previewEl: modelDropzonePreview,
    previewImgEl: modelPreviewImg,
    removeBtnEl: btnRemoveModelImage,
    storeName: STORE_MODEL,
    onFileSet: (file) => {
      uploadedModelFile = file;
      showToast('已上传模特主角参考图，将提取面容与发型融合。');
      queueRefreshPromptInspector();
    },
    onFileClear: () => {
      uploadedModelFile = null;
      showToast('已清除模特参考图，将按下方配置生成模特。');
      queueRefreshPromptInspector();
    }
  });

  // Bind Scene Reference Dropzone
  const sceneDropzoneHelper = setupDropzone({
    dropzoneEl: sceneDropzone,
    fileInputEl: sceneFileInput,
    promptEl: sceneDropzonePrompt,
    previewEl: sceneDropzonePreview,
    previewImgEl: scenePreviewImg,
    removeBtnEl: btnRemoveSceneImage,
    storeName: STORE_SCENE,
    onFileSet: (file) => {
      uploadedSceneFile = file;
      showToast('已上传场景背景参考图。');
      queueRefreshPromptInspector();
    },
    onFileClear: () => {
      uploadedSceneFile = null;
      showToast('已清除场景背景参考图。');
      queueRefreshPromptInspector();
    }
  });

  // Support Ctrl+V paste from clipboard
  window.addEventListener('paste', (e) => {
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) {
      return; // allow normal text pasting in textareas
    }
    if (e.clipboardData && e.clipboardData.items) {
      for (const item of e.clipboardData.items) {
        if (item.type.indexOf('image') !== -1) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            if (modelDropzone && modelDropzone.matches(':hover') && modelDropzoneHelper) {
              modelDropzoneHelper.processFile(file);
              showToast('已从剪贴板读取模特主角参考图。');
            } else if (sceneDropzone && sceneDropzone.matches(':hover') && sceneDropzoneHelper) {
              sceneDropzoneHelper.processFile(file);
              showToast('已从剪贴板读取场景背景参考图。');
            } else if (garmentDropzoneHelper) {
              garmentDropzoneHelper.processFile(file);
              showToast('已从剪贴板读取服装图片。');
            }
            break;
          }
        }
      }
    }
  });

  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const isAlreadyActive = btn.classList.contains('active');
      if (isAlreadyActive) {
        // Toggle off: deselect preset and return to empty dropzone
        btn.classList.remove('active');
        selectedImage = null;
        uploadedFile = null;
        fileInput.value = '';
        dropzonePreview.style.display = 'none';
        dropzonePrompt.style.display = 'block';
        previewImg.src = '';
        clearCachedStorageFile(STORE_GARMENT);
        saveUserOptions();
        return;
      }
      presetButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      uploadedFile = null;
      selectedImage = btn.dataset.img;
      fileInput.value = '';
      previewImg.src = `/inputs/${selectedImage}?v=${Date.now()}`;
      dropzonePrompt.style.display = 'none';
      dropzonePreview.style.display = 'flex';
      clearCachedStorageFile(STORE_GARMENT);
      saveUserOptions();
    });
  });

  // Quick prompt tag suggestions click handler
  function updateCustomPromptBadge() {
    const badge = document.getElementById('customPromptBadge');
    if (!badge || !customPromptInput) return;
    const hasText = customPromptInput.value.trim().length > 0;
    badge.style.display = hasText ? 'inline-block' : 'none';
  }

  document.querySelectorAll('.quick-tag').forEach(tag => {
    tag.addEventListener('click', (e) => {
      e.preventDefault();
      const insertText = tag.dataset.insert;
      const tagLabel = tag.textContent.trim();
      if (!customPromptInput) return;
      const details = document.getElementById('customPromptDetails');
      if (details && !details.open) {
        details.open = true;
      }
      const cur = customPromptInput.value.trim();
      if (!cur) {
        customPromptInput.value = insertText;
        showToast(`已添加: ${tagLabel}`);
      } else if (cur.includes(insertText)) {
        showToast(`已包含此要求: ${tagLabel}`);
      } else {
        customPromptInput.value = cur + ',\n' + insertText;
        showToast(`已添加: ${tagLabel}`);
      }
      customPromptInput.focus();
      updateCustomPromptBadge();
      saveUserOptions();
      queueRefreshPromptInspector();
    });
  });

  // Auto-save listeners for options and inputs
  document.querySelectorAll('input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.name === 'gender' || radio.name === 'modelStyle') {
        updateModelStylePromptUI();
      }
      if (radio.name === 'stillEngine') {
        updateStillEngineUI();
        const curEngine = document.querySelector('input[name="stillEngine"]:checked')?.value;
        if (curEngine === 'gpt_image_2' && serverConfig && !serverConfig.hasApiKey) {
          showToast('💡 提示：GPT Image 2 尚未配置 API Key，请点击「配置 API」设置。');
        }
      }
      saveUserOptions();
      updateBatchHint();
      queueRefreshPromptInspector();
    });
  });
  if (modelStylePromptInput) {
    modelStylePromptInput.addEventListener('input', () => {
      const gender = document.querySelector('input[name="gender"]:checked')?.value || 'female';
      const modelStyle = document.querySelector('input[name="modelStyle"]:checked')?.value || 'classic';
      setEffectiveStylePrompt(gender, modelStyle, modelStylePromptInput.value);
      queueRefreshPromptInspector();
    });
  }
  if (btnResetStylePrompt) {
    btnResetStylePrompt.addEventListener('click', (e) => {
      e.preventDefault();
      const gender = document.querySelector('input[name="gender"]:checked')?.value || 'female';
      const modelStyle = document.querySelector('input[name="modelStyle"]:checked')?.value || 'classic';
      const defaultVal = resetEffectiveStylePrompt(gender, modelStyle);
      if (modelStylePromptInput) {
        modelStylePromptInput.value = defaultVal;
      }
      showToast('已恢复当前风格默认提示词');
      queueRefreshPromptInspector();
    });
  }
  if (customPromptInput) {
    customPromptInput.addEventListener('input', () => {
      updateCustomPromptBadge();
      saveUserOptions();
      queueRefreshPromptInspector();
    });
  }
  if (customSceneText) {
    customSceneText.addEventListener('input', () => {
      saveUserOptions();
      queueRefreshPromptInspector();
    });
  }

  // -------------------------------------------------------------
  // Prompt Inspector & Fine-Tuning Controller
  // -------------------------------------------------------------
  function normalizePromptText(val) {
    if (!val) return '';
    return val.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  }

  function getPromptInspectorDiffs() {
    const kreaVal = inspectorKreaPrompt ? inspectorKreaPrompt.value : '';
    const seg1Val = inspectorSeg1Prompt ? inspectorSeg1Prompt.value : '';
    const seg2Val = inspectorSeg2Prompt ? inspectorSeg2Prompt.value : '';

    const normKrea = normalizePromptText(kreaVal);
    const normSeg1 = normalizePromptText(seg1Val);
    const normSeg2 = normalizePromptText(seg2Val);

    const normAutoKrea = normalizePromptText(cachedAutoPrompts.krea_prompt);
    const normAutoSeg1 = normalizePromptText(cachedAutoPrompts.seg1_prompt);
    const normAutoSeg2 = normalizePromptText(cachedAutoPrompts.seg2_prompt);

    const kreaDiff = Boolean(normAutoKrea && normKrea !== normAutoKrea);
    const seg1Diff = Boolean(normAutoSeg1 && normSeg1 !== normAutoSeg1);
    const seg2Diff = Boolean(normAutoSeg2 && normSeg2 !== normAutoSeg2);

    return {
      kreaDiff,
      seg1Diff,
      seg2Diff,
      hasAnyDiff: kreaDiff || seg1Diff || seg2Diff,
      kreaVal,
      seg1Val,
      seg2Val
    };
  }

  function getSceneName(sceneId) {
    const card = document.querySelector(`.scene-card[data-scene-id="${sceneId}"] .scene-name`);
    if (card && card.textContent.trim()) {
      return card.textContent.trim();
    }
    const map = {
      street: '都市街拍',
      studio: '纯色影棚',
      office: '职场通勤',
      boutique: '艺术买手店',
      forest: '户外林荫',
      cafe: '极简咖啡厅',
      custom: '自定义场景'
    };
    return map[sceneId] || sceneId;
  }

  async function refreshPromptInspector(force = false) {
    if (!inspectorKreaPrompt || !inspectorSeg1Prompt || !inspectorSeg2Prompt) return;

    try {
      const gender = document.querySelector('input[name="gender"]:checked')?.value || 'female';
      const modelStyle = document.querySelector('input[name="modelStyle"]:checked')?.value || 'classic';
      const modelStylePrompt = modelStylePromptInput ? modelStylePromptInput.value.trim() : '';
      const customPrompt = customPromptInput ? customPromptInput.value.trim() : '';
      const customScene = customSceneText ? customSceneText.value.trim() : '';
      const hasModelImg = Boolean(uploadedModelFile);
      const hasSceneImg = Boolean(uploadedSceneFile && selectedScene === 'custom');

      const res = await fetch('/api/preview-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene: selectedScene,
          gender,
          model_style: modelStyle,
          model_style_prompt: modelStylePrompt,
          custom_scene: selectedScene === 'custom' ? customScene : '',
          action1: seg1ActionSelect ? seg1ActionSelect.value : DEFAULT_ACTIONS.seg1,
          action2: seg2ActionSelect ? seg2ActionSelect.value : DEFAULT_ACTIONS.seg2,
          hair_style: document.querySelector('input[name="hairStyle"]:checked')?.value || 'natural',
          face_shape: document.querySelector('input[name="faceShape"]:checked')?.value || 'oval',
          model_age: document.querySelector('input[name="modelAge"]:checked')?.value || 'adult',
          composition: document.querySelector('input[name="compositionMode"]:checked')?.value || 'auto',
          custom_prompt: customPrompt,
          model_image: hasModelImg ? 'placeholder_model.png' : null,
          scene_image: hasSceneImg ? 'placeholder_scene.png' : null
        })
      });

      if (!res.ok) return;
      const data = await res.json();

      const { kreaDiff, seg1Diff, seg2Diff } = getPromptInspectorDiffs();

      // Only update fields that the user hasn't explicitly customized, or if force is true
      if (!kreaDiff || force) {
        inspectorKreaPrompt.value = data.krea_prompt || '';
      }
      if (!seg1Diff || force) {
        inspectorSeg1Prompt.value = data.seg1_prompt || '';
      }
      if (!seg2Diff || force) {
        inspectorSeg2Prompt.value = data.seg2_prompt || '';
      }

      cachedAutoPrompts = {
        krea_prompt: data.krea_prompt || '',
        seg1_prompt: data.seg1_prompt || '',
        seg2_prompt: data.seg2_prompt || ''
      };

      if (force) {
        isPromptsCustomModified = false;
      }
      updatePromptInspectorBadges();
      resizeAllInspectorTextareas();
    } catch (err) {
      console.warn('Failed to preview prompts:', err);
    }
  }

  function adjustTextareaHeight(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    if (textarea.scrollHeight > 0) {
      textarea.style.height = `${Math.max(textarea.scrollHeight + 4, 60)}px`;
    }
  }

  function resizeAllInspectorTextareas() {
    if (!promptInspectorDetails || !promptInspectorDetails.open) return;
    const runResize = () => {
      adjustTextareaHeight(inspectorKreaPrompt);
      adjustTextareaHeight(inspectorSeg1Prompt);
      adjustTextareaHeight(inspectorSeg2Prompt);
    };
    requestAnimationFrame(runResize);
    setTimeout(runResize, 50);
  }

  function queueRefreshPromptInspector() {
    if (inspectorDebounceTimer) clearTimeout(inspectorDebounceTimer);
    inspectorDebounceTimer = setTimeout(() => {
      refreshPromptInspector(false);
    }, 200);
  }

  function updatePromptInspectorBadges() {
    const { kreaDiff, seg1Diff, seg2Diff, hasAnyDiff } = getPromptInspectorDiffs();
    isPromptsCustomModified = hasAnyDiff;

    if (inspectorBadge) {
      if (hasAnyDiff) {
        inspectorBadge.textContent = '已微调';
        inspectorBadge.classList.add('modified');
      } else {
        inspectorBadge.textContent = '自动同步';
        inspectorBadge.classList.remove('modified');
      }
    }

    if (badgeKreaPrompt) {
      badgeKreaPrompt.textContent = kreaDiff ? '已微调' : '自动';
      badgeKreaPrompt.classList.toggle('modified', kreaDiff);
    }
    if (badgeSeg1Prompt) {
      badgeSeg1Prompt.textContent = seg1Diff ? '已微调' : '自动';
      badgeSeg1Prompt.classList.toggle('modified', seg1Diff);
    }
    if (badgeSeg2Prompt) {
      badgeSeg2Prompt.textContent = seg2Diff ? '已微调' : '自动';
      badgeSeg2Prompt.classList.toggle('modified', seg2Diff);
    }

    if (inspectorKreaPrompt) inspectorKreaPrompt.classList.toggle('modified', kreaDiff);
    if (inspectorSeg1Prompt) inspectorSeg1Prompt.classList.toggle('modified', seg1Diff);
    if (inspectorSeg2Prompt) inspectorSeg2Prompt.classList.toggle('modified', seg2Diff);
  }

  if (inspectorKreaPrompt) {
    inspectorKreaPrompt.addEventListener('input', () => {
      adjustTextareaHeight(inspectorKreaPrompt);
      updatePromptInspectorBadges();
    });
  }
  if (inspectorSeg1Prompt) {
    inspectorSeg1Prompt.addEventListener('input', () => {
      adjustTextareaHeight(inspectorSeg1Prompt);
      updatePromptInspectorBadges();
    });
  }
  if (inspectorSeg2Prompt) {
    inspectorSeg2Prompt.addEventListener('input', () => {
      adjustTextareaHeight(inspectorSeg2Prompt);
      updatePromptInspectorBadges();
    });
  }

  if (btnResetPrompts) {
    btnResetPrompts.addEventListener('click', (e) => {
      e.preventDefault();
      refreshPromptInspector(true);
      showToast('已恢复底层提示词自动同步');
    });
  }

  if (promptInspectorDetails) {
    promptInspectorDetails.addEventListener('toggle', () => {
      if (promptInspectorDetails.open) {
        resizeAllInspectorTextareas();
        if (!inspectorKreaPrompt.value || !inspectorSeg1Prompt.value) {
          refreshPromptInspector(false);
        }
      }
    });
  }

  window.addEventListener('resize', () => {
    if (promptInspectorDetails && promptInspectorDetails.open) {
      resizeAllInspectorTextareas();
    }
  });

  function setButtonsDisabled(disabled) {
    if (btnGenerate) btnGenerate.disabled = disabled;
    if (btnGenerateBatch) btnGenerateBatch.disabled = disabled;
  }

  async function uploadImageFile(file, type = 'garment') {
    const formData = new FormData();
    formData.append('image', file);
    const upRes = await fetch(`/api/upload?type=${encodeURIComponent(type)}`, {
      method: 'POST',
      body: formData
    });
    const upData = await upRes.json();
    if (!upRes.ok) throw new Error(upData.error || `上传${type}失败`);
    return upData.filename;
  }

  function scrollToProgress() {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior = reduceMotion ? 'auto' : 'smooth';
    if (window.matchMedia('(max-width: 1100px)').matches) {
      progressCard.scrollIntoView({ behavior, block: 'start' });
    } else {
      window.scrollTo({ top: 0, behavior });
    }
  }

  // Helper: Stop active video/audio playback when starting generation or switching views
  function stopActiveVideoPlayback() {
    if (resultVideo) {
      try {
        resultVideo.pause();
        resultVideo.currentTime = 0;
      } catch (e) {}
      delete resultVideo.dataset.currentSrc;
    }
    document.querySelectorAll('video, audio').forEach(media => {
      try {
        media.pause();
        media.currentTime = 0;
      } catch (e) {}
    });
  }

  // 4. Single Generate Execution
  btnGenerate.addEventListener('click', async () => {
    try {
      let finalImageFilename = selectedImage;

      // Validate that an image is provided
      if (!uploadedFile && !finalImageFilename) {
        showToast('请先上传服装图片或选择上方预设样例。', true);
        return;
      }

      const stillEngine = document.querySelector('input[name="stillEngine"]:checked')?.value || 'gpt_image_2';
      if (stillEngine === 'gpt_image_2') {
        if (!serverConfig) {
          await fetchServerConfig();
        }
        if (!serverConfig || !serverConfig.hasApiKey) {
          showToast('请先配置 OpenAI API Key 才能使用 GPT Image 2 引擎。', true);
          openApiConfigModal();
          return;
        }
      }

      setButtonsDisabled(true);
      stopActiveVideoPlayback();

      // Hide batch nav bar when starting single task
      if (batchNavBar) batchNavBar.style.display = 'none';

      const genMode = document.querySelector('input[name="genMode"]:checked')?.value || 'video';
      const isStillOnly = genMode === 'still_only';

      // Reset showcase view for the new run
      showcaseEmpty.style.display = 'block';
      showcaseContent.style.display = 'none';
      const emptyH3 = showcaseEmpty.querySelector('h3');
      const emptyP = showcaseEmpty.querySelector('p');
      if (emptyH3) emptyH3.textContent = isStillOnly ? '试衣定妆照生成中...' : '展示视频生成中...';
      if (emptyP) emptyP.textContent = isStillOnly ? '正在为您极速合成高保真试衣定妆照，成片将在此展示' : '正在为您合成服装展示定妆照与动态视频，成片将在此展示';

      progressCard.style.display = 'block';
      if (progressCardTitle) progressCardTitle.textContent = isStillOnly ? '试衣定妆照生成进度' : '单套场景生成进度';
      progressBar.style.width = '5%';
      progressStatusMsg.textContent = '准备生成资源...';

      // 1. Upload Garment if newly uploaded
      if (uploadedFile) {
        progressStatusMsg.textContent = '正在上传服装图片...';
        finalImageFilename = await uploadImageFile(uploadedFile, 'garment');
      }

      // 2. Upload Model Reference if provided
      let finalModelFilename = null;
      if (uploadedModelFile) {
        progressStatusMsg.textContent = '正在上传模特主角参考图...';
        finalModelFilename = await uploadImageFile(uploadedModelFile, 'model');
      }

      // 3. Upload Scene Reference if provided and custom scene is active
      let finalSceneFilename = null;
      if (selectedScene === 'custom' && uploadedSceneFile) {
        progressStatusMsg.textContent = '正在上传场景背景参考图...';
        finalSceneFilename = await uploadImageFile(uploadedSceneFile, 'scene_ref');
      }

      const gender = document.querySelector('input[name="gender"]:checked')?.value || 'female';
      const modelStyle = document.querySelector('input[name="modelStyle"]:checked')?.value || 'classic';
      const modelStylePrompt = modelStylePromptInput ? modelStylePromptInput.value.trim() : '';
      const aspectRatio = document.querySelector('input[name="aspectRatio"]:checked')?.value || '3:4';
      const customPrompt = customPromptInput ? customPromptInput.value.trim() : '';
      const customScene = customSceneText ? customSceneText.value.trim() : '';

      if (selectedScene === 'custom' && !customScene && !finalSceneFilename) {
        showToast('已选择自定义场景，但还未填写描述或上传背景图，将按通用时尚背景处理。');
      }

      if (finalModelFilename && finalSceneFilename && selectedScene === 'custom') {
        showToast('💡 同时上传了模特与场景参考图，系统将优先锁定模特主角面孔。');
      }

      // Start Task
      progressBar.style.width = '8%';
      progressStatusMsg.textContent = '任务已提交，正在排队...';
      startTimer();
      scrollToProgress();

      const { kreaDiff, seg1Diff, seg2Diff } = getPromptInspectorDiffs();

      const genRes = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: finalImageFilename,
          model_image: finalModelFilename,
          scene_image: selectedScene === 'custom' ? finalSceneFilename : null,
          scene: selectedScene,
          custom_scene: selectedScene === 'custom' ? customScene : '',
          gender,
          model_style: modelStyle,
          model_style_prompt: modelStylePrompt,
          custom_prompt: customPrompt,
          aspect_ratio: aspectRatio,
          mode: genMode,
          still_engine: stillEngine,
          krea_prompt: kreaDiff ? inspectorKreaPrompt.value.trim() : null,
          seg1_prompt: seg1Diff ? inspectorSeg1Prompt.value.trim() : null,
          seg2_prompt: seg2Diff ? inspectorSeg2Prompt.value.trim() : null,
          action1: seg1ActionSelect ? seg1ActionSelect.value : DEFAULT_ACTIONS.seg1,
          action2: seg2ActionSelect ? seg2ActionSelect.value : DEFAULT_ACTIONS.seg2,
          hair_style: document.querySelector('input[name="hairStyle"]:checked')?.value || 'natural',
          face_shape: document.querySelector('input[name="faceShape"]:checked')?.value || 'oval',
          model_age: document.querySelector('input[name="modelAge"]:checked')?.value || 'adult',
          composition: document.querySelector('input[name="compositionMode"]:checked')?.value || 'auto',
          enhance: genMode !== 'still_only' && document.querySelector('input[name="enhanceMode"]:checked')?.value === 'on',
        })
      });
      let genData;
      try {
        genData = await genRes.json();
      } catch (jsonErr) {
        throw new Error(`服务器响应异常 (${genRes.status})`);
      }
      if (!genRes.ok) throw new Error(genData.error || '启动生成任务失败');

      currentTaskId = genData.taskId;
      // Restore the engine label on step 2 (a previous existing-still run may
      // have relabeled it to 载入现有定妆照).
      if (typeof updateStillEngineUI === 'function') updateStillEngineUI();
      try {
        localStorage.setItem(ACTIVE_TASK_KEY, JSON.stringify({
          taskId: currentTaskId,
          startTime: startTime || Date.now()
        }));
      } catch (e) {}
      startPolling(currentTaskId);
    } catch (err) {
      showToast('发生错误: ' + err.message, true);
      setButtonsDisabled(false);
      stopTimer();
    }
  });

  // Generate a 10s video directly from an existing still photo (skips Stage 1).
  // Scene / action / model options follow the current panel settings; the video
  // canvas is derived server-side from the still's real aspect ratio.
  async function generateVideoFromExistingStill(filename) {
    if (!filename) return;
    const enhanceOn = document.querySelector('input[name="enhanceMode"]:checked')?.value === 'on';
    if (!window.confirm(`使用定妆照「${filename}」直接生成 10 秒展示视频?\n将跳过阶段一，场景与动作按当前面板设置执行。\n超清增强: ${enhanceOn ? '开启（1080p·高帧率，耗时增加）' : '关闭（快速预览）'}`)) return;
    try {
      setButtonsDisabled(true);
      stopActiveVideoPlayback();
      if (batchNavBar) batchNavBar.style.display = 'none';

      const gender = document.querySelector('input[name="gender"]:checked')?.value || 'female';
      const modelStyle = document.querySelector('input[name="modelStyle"]:checked')?.value || 'classic';
      const modelStylePrompt = modelStylePromptInput ? modelStylePromptInput.value.trim() : '';
      const aspectRatio = document.querySelector('input[name="aspectRatio"]:checked')?.value || '3:4';
      const customPrompt = customPromptInput ? customPromptInput.value.trim() : '';
      const customScene = customSceneText ? customSceneText.value.trim() : '';
      const sceneValue = (typeof selectedScene !== 'undefined' && selectedScene) ? selectedScene : 'street';

      // Reset showcase view
      showcaseEmpty.style.display = 'block';
      showcaseContent.style.display = 'none';
      const emptyH3 = showcaseEmpty.querySelector('h3');
      const emptyP = showcaseEmpty.querySelector('p');
      if (emptyH3) emptyH3.textContent = '展示视频生成中...';
      if (emptyP) emptyP.textContent = '正在基于现有定妆照合成动态展示视频';

      progressCard.style.display = 'block';
      if (progressCardTitle) progressCardTitle.textContent = '现有定妆照 → 视频生成进度';
      progressBar.style.width = '38%';
      progressStatusMsg.textContent = '任务已提交，正在排队...';
      startTimer();
      scrollToProgress();

      const { seg1Diff, seg2Diff } = getPromptInspectorDiffs();

      const genRes = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: selectedImage || null,
          model_image: null,
          scene_image: null,
          scene: sceneValue,
          custom_scene: sceneValue === 'custom' ? customScene : '',
          gender,
          model_style: modelStyle,
          model_style_prompt: modelStylePrompt,
          custom_prompt: customPrompt,
          aspect_ratio: aspectRatio,
          mode: 'video',
          still_engine: 'gpt_image_2',
          existing_still: filename,
          krea_prompt: null,
          seg1_prompt: seg1Diff ? inspectorSeg1Prompt.value.trim() : null,
          seg2_prompt: seg2Diff ? inspectorSeg2Prompt.value.trim() : null,
          action1: seg1ActionSelect ? seg1ActionSelect.value : DEFAULT_ACTIONS.seg1,
          action2: seg2ActionSelect ? seg2ActionSelect.value : DEFAULT_ACTIONS.seg2,
          hair_style: document.querySelector('input[name="hairStyle"]:checked')?.value || 'natural',
          face_shape: document.querySelector('input[name="faceShape"]:checked')?.value || 'oval',
          model_age: document.querySelector('input[name="modelAge"]:checked')?.value || 'adult',
          composition: document.querySelector('input[name="compositionMode"]:checked')?.value || 'auto',
          enhance: document.querySelector('input[name="enhanceMode"]:checked')?.value === 'on'
        })
      });
      let genData;
      try {
        genData = await genRes.json();
      } catch (jsonErr) {
        throw new Error(`服务器响应异常 (${genRes.status})`);
      }
      if (!genRes.ok) throw new Error(genData.error || '启动生成任务失败');

      currentTaskId = genData.taskId;
      // Stage 1 is skipped for existing stills — relabel the step so the
      // progress list does not claim an engine ran when it did not.
      const step2TextEl = document.getElementById('step2Text');
      if (step2TextEl) step2TextEl.textContent = '载入现有定妆照';
      try {
        localStorage.setItem(ACTIVE_TASK_KEY, JSON.stringify({
          taskId: currentTaskId,
          startTime: startTime || Date.now()
        }));
      } catch (e) {}
      startPolling(currentTaskId);
    } catch (err) {
      showToast('发生错误: ' + err.message, true);
      setButtonsDisabled(false);
      stopTimer();
    }
  }

  if (btnStillToVideo) {
    btnStillToVideo.addEventListener('click', () => {
      const filename = btnStillToVideo.dataset.filename || (resultStillImg.getAttribute('src') || '').split('/').pop();
      if (filename) generateVideoFromExistingStill(filename);
    });
  }

  // 5. Batch Generate Execution (3 commercial styles: street + studio + boutique)
  if (btnGenerateBatch) {
    btnGenerateBatch.addEventListener('click', async () => {
      try {
        let finalImageFilename = selectedImage;

        if (!uploadedFile && !finalImageFilename) {
          showToast('请先上传服装图片或选择上方预设样例。', true);
          return;
        }

        const stillEngine = document.querySelector('input[name="stillEngine"]:checked')?.value || 'gpt_image_2';
        if (stillEngine === 'gpt_image_2') {
          if (!serverConfig) {
            await fetchServerConfig();
          }
          if (!serverConfig || !serverConfig.hasApiKey) {
            showToast('请先配置 OpenAI API Key 才能使用 GPT Image 2 引擎。', true);
            openApiConfigModal();
            return;
          }
        }

        setButtonsDisabled(true);
        stopActiveVideoPlayback();

        const batchScenes = getBatchScenesFor(selectedScene);
        const batchSceneNames = batchScenes.map(id => BATCH_SCENE_LABELS[id] || id).join('、');

        const genMode = document.querySelector('input[name="genMode"]:checked')?.value || 'video';
        const isStillOnly = genMode === 'still_only';

        // Reset showcase view for batch execution
        showcaseEmpty.style.display = 'block';
        showcaseContent.style.display = 'none';
        const emptyH3 = showcaseEmpty.querySelector('h3');
        const emptyP = showcaseEmpty.querySelector('p');
        if (emptyH3) emptyH3.textContent = isStillOnly ? '⚡ 批量 3 套场景定妆照生成中...' : '⚡ 批量 3 套场景视频生成中...';
        if (emptyP) emptyP.textContent = `系统正在安全顺序排队合成【${batchSceneNames}】3套${isStillOnly ? '定妆照' : '成片视频'}，渲染就绪后可在上方标签页切换查看`;

        progressCard.style.display = 'block';
        if (progressCardTitle) progressCardTitle.textContent = isStillOnly ? '⚡ 批量 3 套场景定妆照生成进度' : '⚡ 批量 3 套场景生成进度';
        progressBar.style.width = '5%';
        progressStatusMsg.textContent = '正在准备批量生成资源...';

        if (uploadedFile) {
          progressStatusMsg.textContent = '正在上传服装图片...';
          finalImageFilename = await uploadImageFile(uploadedFile, 'garment');
        }

        let finalModelFilename = null;
        if (uploadedModelFile) {
          progressStatusMsg.textContent = '正在上传模特主角参考图...';
          finalModelFilename = await uploadImageFile(uploadedModelFile, 'model');
        }

        let finalSceneFilename = null;
        if (uploadedSceneFile && batchScenes.includes('custom')) {
          progressStatusMsg.textContent = '正在上传场景背景参考图...';
          finalSceneFilename = await uploadImageFile(uploadedSceneFile, 'scene_ref');
        } else if (uploadedSceneFile) {
          showToast('💡 批量模式下自动选取多套预设场景，已忽略单场景背景参考图。');
        }

        const gender = document.querySelector('input[name="gender"]:checked')?.value || 'female';
        const modelStyle = document.querySelector('input[name="modelStyle"]:checked')?.value || 'classic';
        const modelStylePrompt = modelStylePromptInput ? modelStylePromptInput.value.trim() : '';
        const aspectRatio = document.querySelector('input[name="aspectRatio"]:checked')?.value || '3:4';
        const customPrompt = customPromptInput ? customPromptInput.value.trim() : '';
        const customScene = customSceneText ? customSceneText.value.trim() : '';

        progressBar.style.width = '8%';
        progressStatusMsg.textContent = `批量任务已提交，系统按安全队列顺序合成【${batchSceneNames}】3段成片...`;
        startTimer();
        scrollToProgress();

        const { kreaDiff, seg1Diff, seg2Diff, hasAnyDiff } = getPromptInspectorDiffs();
        if (hasAnyDiff) {
          const scName = getSceneName(selectedScene);
          showToast(`批量生成提示：已微调提示词将专用于【${scName}】，其他场景保持各自专属设计。`);
        }

        const genRes = await fetch('/api/generate-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: finalImageFilename,
            model_image: finalModelFilename,
            scene_image: finalSceneFilename,
            scenes: batchScenes,
            scene: selectedScene,
            gender,
            model_style: modelStyle,
            model_style_prompt: modelStylePrompt,
            custom_prompt: customPrompt,
            custom_scene: customScene,
            aspect_ratio: aspectRatio,
            mode: genMode,
            still_engine: stillEngine,
            krea_prompt: kreaDiff ? inspectorKreaPrompt.value.trim() : null,
            seg1_prompt: seg1Diff ? inspectorSeg1Prompt.value.trim() : null,
            seg2_prompt: seg2Diff ? inspectorSeg2Prompt.value.trim() : null,
            action1: seg1ActionSelect ? seg1ActionSelect.value : DEFAULT_ACTIONS.seg1,
            action2: seg2ActionSelect ? seg2ActionSelect.value : DEFAULT_ACTIONS.seg2,
            hair_style: document.querySelector('input[name="hairStyle"]:checked')?.value || 'natural',
            face_shape: document.querySelector('input[name="faceShape"]:checked')?.value || 'oval',
            model_age: document.querySelector('input[name="modelAge"]:checked')?.value || 'adult',
            composition: document.querySelector('input[name="compositionMode"]:checked')?.value || 'auto',
            enhance: genMode !== 'still_only' && document.querySelector('input[name="enhanceMode"]:checked')?.value === 'on',
          })
        });
        let batchResp;
        try {
          batchResp = await genRes.json();
        } catch (jsonErr) {
          throw new Error(`服务器响应异常 (${genRes.status})`);
        }
        if (!genRes.ok) throw new Error(batchResp.error || '启动批量任务失败');

        activeBatchId = batchResp.batchId;
        try {
          localStorage.setItem(ACTIVE_BATCH_KEY, JSON.stringify({
            batchId: activeBatchId,
            startTime: startTime || Date.now()
          }));
        } catch (e) {}

        selectedBatchIndex = 0;
        initBatchUI(batchScenes, batchResp.taskIds);
        startBatchPolling(activeBatchId);
      } catch (err) {
        showToast('批量生成失败: ' + err.message, true);
        setButtonsDisabled(false);
        stopTimer();
      }
    });
  }

  function initBatchUI(scenes, taskIds) {
    if (!batchNavBar || !batchTabs) return;
    batchNavBar.style.display = 'block';
    batchTabs.innerHTML = '';
    batchProgressPill.textContent = `已完成 0/${scenes.length}`;
    userClickedBatchTab = false;

    scenes.forEach((scId, idx) => {
      const btn = document.createElement('button');
      btn.className = `batch-tab-btn ${idx === selectedBatchIndex ? 'active' : ''}`;
      btn.dataset.index = idx;
      btn.dataset.sceneId = scId;
      btn.innerHTML = `
        <i class="ph ph-circle tab-status-icon"></i>
        <span>场景${idx + 1}: ${BATCH_SCENE_LABELS[scId] || scId}</span>
      `;
      btn.addEventListener('click', () => {
        selectedBatchIndex = idx;
        userClickedBatchTab = true;
        document.querySelectorAll('.batch-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (currentBatchData && currentBatchData.tasks && currentBatchData.tasks[idx]) {
          showBatchTaskResult(currentBatchData.tasks[idx]);
        }
      });
      batchTabs.appendChild(btn);
    });
  }

  function showBatchTaskResult(task) {
    if (!task) return;
    const sceneId = (task.scene && task.scene.id) || 'scene';
    const sceneName = (task.scene && task.scene.name) || '当前场景';

    if (task.stillImage || task.videoUrl) {
      showcaseEmpty.style.display = 'none';
      showcaseContent.style.display = 'block';

      if (task.stillImage) {
        if (resultStillImg.dataset.currentSrc !== task.stillImage) {
          resultStillImg.dataset.currentSrc = task.stillImage;
          resultStillImg.src = task.stillImage;
        }
        downloadStillBtn.href = task.stillImage;
        downloadStillBtn.download = `fashion_still_${sceneId}.png`;
      }
      if (task.videoUrl && task.mode === 'video') {
        videoBox.style.display = 'block';
        if (resultVideo.dataset.currentSrc !== task.videoUrl) {
          resultVideo.dataset.currentSrc = task.videoUrl;
          resultVideo.src = task.videoUrl;
          resultVideo.muted = userAudioMuted;
          resultVideo.play().catch(() => {
            resultVideo.muted = true;
            resultVideo.play();
          });
        }
        downloadVideoBtn.href = task.videoUrl;
        downloadVideoBtn.download = `fashion_video_10s_${sceneId}.mp4`;
      } else if (!task.videoUrl) {
        stopActiveVideoPlayback();
        videoBox.style.display = 'none';
      }
    } else {
      stopActiveVideoPlayback();
      showcaseContent.style.display = 'none';
      showcaseEmpty.style.display = 'block';
      delete resultStillImg.dataset.currentSrc;
      delete resultVideo.dataset.currentSrc;
      const emptyH3 = showcaseEmpty.querySelector('h3');
      const emptyP = showcaseEmpty.querySelector('p');
      if (emptyH3) emptyH3.textContent = `【${sceneName}】正在排队渲染中`;
      if (emptyP) emptyP.textContent = task.message || '系统正在按顺序排队执行，稍候渲染就绪后将在此展示...';
    }
  }

  function updateBatchTabsState(batch) {
    if (!batch) return 0;
    const totalTasks = batch.totalTasks || 3;
    const subTasks = batch.tasks || [];
    let completedCount = 0;
    subTasks.forEach((t, i) => {
      const tabBtn = batchTabs && batchTabs.children ? batchTabs.children[i] : null;
      if (tabBtn && t.action1 && t.action2) {
        const a1Name = getActionDisplayName(t.action1);
        const a2Name = getActionDisplayName(t.action2);
        tabBtn.title = `场景${i + 1}（动作：${a1Name} → ${a2Name}）`;
        if (!tabBtn.querySelector('.tab-action-pill')) {
          const pill = document.createElement('span');
          pill.className = 'tab-action-pill';
          pill.textContent = `${a1Name} → ${a2Name}`;
          tabBtn.appendChild(pill);
        }
      }
      if (t.status === 'completed') {
        completedCount++;
        if (tabBtn) {
          tabBtn.className = `batch-tab-btn ${i === selectedBatchIndex ? 'active' : ''} done`;
          const icon = tabBtn.querySelector('.tab-status-icon');
          if (icon) icon.className = 'ph ph-check-circle tab-status-icon';
        }
      } else if (t.status === 'running') {
        if (tabBtn) {
          tabBtn.className = `batch-tab-btn ${i === selectedBatchIndex ? 'active' : ''} running`;
          const icon = tabBtn.querySelector('.tab-status-icon');
          if (icon) icon.className = 'ph ph-spinner tab-status-icon';
        }
      } else if (t.status === 'error') {
        if (tabBtn) {
          tabBtn.className = `batch-tab-btn ${i === selectedBatchIndex ? 'active' : ''} error`;
          const icon = tabBtn.querySelector('.tab-status-icon');
          if (icon) icon.className = 'ph ph-x-circle tab-status-icon';
        }
      }
    });

    if (batchProgressPill) {
      batchProgressPill.textContent = `已完成 ${completedCount}/${totalTasks}`;
    }
    return completedCount;
  }

  function startBatchPolling(batchId) {
    if (batchPollTimeout) clearTimeout(batchPollTimeout);
    isBatchPolling = true;
    let pollFailures = 0;

    async function poll() {
      if (!isBatchPolling) return;
      try {
        const res = await fetch(`/api/batch/${batchId}`);
        if (res.status === 404) {
          stopBatchPolling('批量任务记录已失效，请重新发起。', true);
          return;
        }
        if (res.ok) {
          if (!isBatchPolling) return;
          pollFailures = 0;
          const batch = await res.json();
          currentBatchData = batch;
          const totalTasks = batch.totalTasks || 3;
          const currentIdx = batch.currentTaskIndex;
          const subTasks = batch.tasks || [];

          const completedCount = updateBatchTabsState(batch);

          const runningTask = subTasks[currentIdx] || subTasks[subTasks.length - 1];
          const taskProgress = (runningTask && runningTask.progress) || 0;
          const overallProgress = Math.min(100, Math.round(((completedCount * 100) + taskProgress) / totalTasks));
          progressBar.style.width = `${Math.max(8, overallProgress)}%`;

          const sceneName = (runningTask && runningTask.scene && runningTask.scene.name) || `场景 ${currentIdx + 1}`;
          const currentMsg = (runningTask && runningTask.message) || '处理中...';
          const act1 = runningTask && runningTask.action1 ? getActionDisplayName(runningTask.action1) : '';
          const act2 = runningTask && runningTask.action2 ? getActionDisplayName(runningTask.action2) : '';
          const actHint = (act1 && act2) ? ` · ${act1} → ${act2}` : '';
          progressStatusMsg.textContent = `[${Math.min(totalTasks, currentIdx + 1)}/${totalTasks} ${sceneName}${actHint}] ${currentMsg}`;

          if (runningTask) {
            updateStepsUI(runningTask.progress, runningTask.mode);
          }

          // Progressive reveal: if current viewed tab has new output or user manually selected it, refresh view
          const viewedTask = subTasks[selectedBatchIndex];
          if (viewedTask) {
            if (viewedTask.stillImage || viewedTask.videoUrl) {
              showBatchTaskResult(viewedTask);
            } else if (userClickedBatchTab) {
              showBatchTaskResult(viewedTask);
            }
          }
          if (!userClickedBatchTab && runningTask && (runningTask.stillImage || runningTask.videoUrl)) {
            if (selectedBatchIndex !== currentIdx) {
              selectedBatchIndex = currentIdx;
              if (batchTabs) {
                Array.from(batchTabs.children).forEach((b, i) => {
                  b.classList.toggle('active', i === selectedBatchIndex);
                });
              }
              showBatchTaskResult(runningTask);
            }
          }

          if (batch.status === 'cancelled') {
            isBatchPolling = false;
            stopTimer();
            setButtonsDisabled(false);
            try { localStorage.removeItem(ACTIVE_BATCH_KEY); } catch (e) {}
            showToast('批量任务已取消');
            progressStatusMsg.textContent = '批量任务已取消';
            loadHistory();
            return;
          }

          if (batch.status === 'completed' || batch.status === 'error' || completedCount >= totalTasks) {
            isBatchPolling = false;
            stopTimer();
            setButtonsDisabled(false);
            try { localStorage.removeItem(ACTIVE_BATCH_KEY); } catch (e) {}
            if (completedCount === totalTasks) {
              showToast('⚡ 批量 3 套场景展示成片已全部生成就绪！');
            } else if (completedCount > 0) {
              showToast(`⚠️ 批量任务部分完成 (${completedCount}/${totalTasks})，部分场景生成失败。`, true);
            } else {
              showToast('⚠️ 批量任务全部失败，请检查后重试。', true);
            }
            loadHistory();
            return;
          }
        } else {
          pollFailures++;
        }
      } catch (err) {
        console.error('Batch polling error:', err);
        pollFailures++;
      }

      if (pollFailures >= 5) {
        stopBatchPolling('与服务器通信连续失败，已停止批量任务追踪。', true);
        return;
      }

      if (isBatchPolling) {
        batchPollTimeout = setTimeout(poll, 1300);
      }
    }

    poll();
  }

  function stopBatchPolling(msg, isError = false) {
    isBatchPolling = false;
    if (batchPollTimeout) clearTimeout(batchPollTimeout);
    stopTimer();
    setButtonsDisabled(false);
    try { localStorage.removeItem(ACTIVE_BATCH_KEY); } catch (e) {}
    showToast(msg, isError);
    loadHistory();
  }

  // Cancel task button handler
  if (btnCancelTask) {
    btnCancelTask.addEventListener('click', async () => {
      if (!isPollingActive && !isBatchPolling) {
        showToast('当前没有进行中的生成任务');
        return;
      }
      if (!window.confirm('确定要中断并取消当前的生成任务吗？')) return;

      btnCancelTask.disabled = true;
      try {
        if (isBatchPolling && activeBatchId) {
          const res = await fetch(`/api/batch/${activeBatchId}/cancel`, { method: 'POST' });
          const data = await res.json();
          if (res.ok) {
            stopBatchPolling('批量任务已成功取消');
          } else {
            showToast(data.error || '取消批量任务失败', true);
          }
        } else if (currentTaskId) {
          const res = await fetch(`/api/tasks/${currentTaskId}/cancel`, { method: 'POST' });
          const data = await res.json();
          if (res.ok) {
            if (pollTimeout) clearTimeout(pollTimeout);
            isPollingActive = false;
            stopTimer();
            setButtonsDisabled(false);
            try { localStorage.removeItem(ACTIVE_TASK_KEY); } catch (e) {}
            progressStatusMsg.textContent = '任务已取消';
            showToast('任务已成功取消');
            loadHistory();
          } else {
            showToast(data.error || '取消任务失败', true);
          }
        }
      } catch (err) {
        showToast('取消请求异常: ' + err.message, true);
      } finally {
        btnCancelTask.disabled = false;
      }
    });
  }

  // Batch download all button
  if (btnDownloadAllBatch) {
    btnDownloadAllBatch.addEventListener('click', () => {
      if (!currentBatchData || !currentBatchData.tasks) {
        showToast('暂无批量任务成片可供下载。', true);
        return;
      }
      const finishedTasks = currentBatchData.tasks.filter(t => t.videoUrl || t.stillImage);
      if (finishedTasks.length === 0) {
        showToast('成片仍在生成中，请等待生成完成后下载。', true);
        return;
      }
      const hasVideos = finishedTasks.some(t => t.videoUrl);
      const allVideos = finishedTasks.every(t => t.videoUrl);
      const label = hasVideos ? (allVideos ? '成片视频' : '成片文件') : '定妆照';
      showToast(`正在批量下载全部 ${finishedTasks.length} 个${label}...`);
      finishedTasks.forEach((t, i) => {
        setTimeout(() => {
          const a = document.createElement('a');
          const sceneId = (t.scene && t.scene.id) || 'scene';
          if (t.videoUrl) {
            a.href = t.videoUrl;
            a.download = `fashion_10s_${sceneId}_${i + 1}.mp4`;
          } else {
            a.href = t.stillImage;
            a.download = `fashion_still_${sceneId}_${i + 1}.png`;
          }
          document.body.appendChild(a);
          a.click();
          a.remove();
        }, i * 450);
      });
    });
  }

  function startTimer() {
    startTime = Date.now();
    elapsedTimer.textContent = '00:00';
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      const m = String(Math.floor(sec / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      elapsedTimer.textContent = `${m}:${s}`;
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
  }

  function updateStepsUI(progress, mode = 'video') {
    if (mode === 'still_only') {
      const step1 = document.getElementById('step1');
      const step2 = document.getElementById('step2');
      const step3 = document.getElementById('step3');
      const step4 = document.getElementById('step4');
      const step5 = document.getElementById('step5');

      if (progress >= 10) step1.className = 'step-item done';
      else step1.className = 'step-item active';

      if (progress >= 100) step2.className = 'step-item done';
      else if (progress >= 10) step2.className = 'step-item active';
      else step2.className = 'step-item';

      [step3, step4, step5].forEach(el => {
        if (el) el.className = 'step-item skipped';
      });
      return;
    }

    const steps = [
      { id: 'step1', threshold: 10 },
      { id: 'step2', threshold: 40 },
      { id: 'step3', threshold: 68 },
      { id: 'step4', threshold: 88 },
      { id: 'step5', threshold: 96 }
    ];

    steps.forEach((st, idx) => {
      const el = document.getElementById(st.id);
      if (!el) return;
      if (progress >= st.threshold) {
        el.className = 'step-item done';
      } else if (idx === 0 || progress >= steps[idx - 1].threshold) {
        el.className = 'step-item active';
      } else {
        el.className = 'step-item';
      }
    });
  }

  // Polling with recursive setTimeout to avoid overlapping requests
  function startPolling(taskId) {
    if (pollTimeout) clearTimeout(pollTimeout);
    isPollingActive = true;
    let pollFailures = 0;

    function stopPolling(message) {
      isPollingActive = false;
      if (pollTimeout) clearTimeout(pollTimeout);
      stopTimer();
      setButtonsDisabled(false);
      try { localStorage.removeItem(ACTIVE_TASK_KEY); } catch (e) {}
      showToast(message, true);
      // Task record is gone, but finished artifacts may already be in storage
      loadHistory();
    }

    async function poll() {
      if (!isPollingActive) return;
      try {
        const res = await fetch(`/api/progress/${taskId}`);
        if (res.status === 404) {
          // Task record gone (server restart / cleanup) — retrying is pointless
          stopPolling('任务记录已失效（服务可能已重启），请重新发起生成。');
          return;
        }
        if (res.ok) {
          if (!isPollingActive) return;
          pollFailures = 0;
          const task = await res.json();
          progressBar.style.width = `${task.progress}%`;
          const act1 = task.action1 ? getActionDisplayName(task.action1) : '';
          const act2 = task.action2 ? getActionDisplayName(task.action2) : '';
          const actHint = (act1 && act2 && task.mode === 'video') ? ` (${act1} → ${act2})` : '';
          progressStatusMsg.textContent = `${task.message}${actHint}`;
          updateStepsUI(task.progress, task.mode);

          // Progressive reveal: show Stage 1 still photo as soon as it is rendered
          if (task.stillImage && showcaseEmpty.style.display !== 'none') {
            showcaseEmpty.style.display = 'none';
            showcaseContent.style.display = 'block';
            resultStillImg.src = task.stillImage;
            downloadStillBtn.href = task.stillImage;
            downloadStillBtn.download = `fashion_still_${(task.scene && task.scene.id) || 'scene'}.png`;
            videoBox.style.display = 'none';
          }

          if (task.status === 'completed') {
            isPollingActive = false;
            stopTimer();
            setButtonsDisabled(false);
            try { localStorage.removeItem(ACTIVE_TASK_KEY); } catch (e) {}
            showToast('生成完成，成片已就绪。');
            showResults(task);
            loadHistory();
            return;
          } else if (task.status === 'cancelled') {
            isPollingActive = false;
            stopTimer();
            setButtonsDisabled(false);
            try { localStorage.removeItem(ACTIVE_TASK_KEY); } catch (e) {}
            showToast('任务已取消');
            progressStatusMsg.textContent = '任务已取消';
            loadHistory();
            return;
          } else if (task.status === 'error') {
            isPollingActive = false;
            stopTimer();
            setButtonsDisabled(false);
            try { localStorage.removeItem(ACTIVE_TASK_KEY); } catch (e) {}
            showToast('生成失败: ' + (task.error || task.message), true);
            return;
          }
        } else {
          pollFailures++;
        }
      } catch (err) {
        console.error('Polling error:', err);
        pollFailures++;
      }

      if (pollFailures >= 5) {
        stopPolling('与服务器通信连续失败，已停止任务追踪。');
        return;
      }

      if (isPollingActive) {
        pollTimeout = setTimeout(poll, 1200);
      }
    }
    poll();
  }

  function showResults(task) {
    showcaseEmpty.style.display = 'none';
    showcaseContent.style.display = 'block';
    const sceneId = (task.scene && task.scene.id) || 'custom';

    if (task.stillImage) {
      resultStillImg.src = task.stillImage;
      downloadStillBtn.href = task.stillImage;
      downloadStillBtn.download = `fashion_still_${sceneId}.png`;
    }

    if (task.videoUrl && task.mode === 'video') {
      videoBox.style.display = 'block';
      resultVideo.src = task.videoUrl;
      resultVideo.muted = userAudioMuted;
      resultVideo.play().catch(() => {
        resultVideo.muted = true;
        resultVideo.play();
      });
      downloadVideoBtn.href = task.videoUrl;
      downloadVideoBtn.download = `fashion_video_10s_${sceneId}.mp4`;
    } else {
      videoBox.style.display = 'none';
    }

    // Offer "generate video from this still" whenever a still is shown without a video
    if (btnStillToVideo) {
      const showStillToVideo = Boolean(task.stillImage && !task.videoUrl);
      btnStillToVideo.style.display = showStillToVideo ? 'inline-flex' : 'none';
      if (showStillToVideo) {
        btnStillToVideo.dataset.filename = task.stillImage.split('/').pop();
      }
    }
  }

  // Audio Toggle & Sync
  function syncAudioButtonState() {
    if (!resultVideo) return;
    if (resultVideo.muted) {
      btnToggleAudio.innerHTML = '<i class="ph ph-speaker-slash"></i> 开启声音';
    } else {
      btnToggleAudio.innerHTML = '<i class="ph ph-speaker-high"></i> 静音';
    }
  }
  resultVideo.addEventListener('volumechange', syncAudioButtonState);

  btnToggleAudio.addEventListener('click', () => {
    if (resultVideo.muted) {
      resultVideo.muted = false;
      userAudioMuted = false;
      showToast('原声已开启');
    } else {
      resultVideo.muted = true;
      userAudioMuted = true;
      showToast('已静音');
    }
    syncAudioButtonState();
  });

  // Lightbox Zoom
  function openLightbox(src) {
    lightboxImg.src = src;
    lightboxModal.style.display = 'flex';
  }

  btnZoomStill.addEventListener('click', () => {
    if (resultStillImg.src) openLightbox(resultStillImg.src);
  });
  stillFrameWrapper.addEventListener('click', () => {
    if (resultStillImg.src) openLightbox(resultStillImg.src);
  });
  btnCloseLightbox.addEventListener('click', () => {
    lightboxModal.style.display = 'none';
  });
  lightboxModal.addEventListener('click', (e) => {
    if (e.target === lightboxModal) lightboxModal.style.display = 'none';
  });

  // 5. Load History (Supports both Videos and Stage 1 Still Photos)
  // 小红书式瀑布流: grid rows are 2px units; each card spans enough rows to fit
  // its natural height + 12px spacing, so variable-ratio thumbs pack tightly.
  let masonryRaf = 0;
  function layoutHistoryMasonry() {
    const cards = Array.from(historyGrid.querySelectorAll('.history-card'));
    if (!cards.length) return;
    // Batch all reads before any writes: interleaving offsetHeight reads with
    // gridRowEnd writes would force a sync reflow per card (layout thrashing).
    // Heights are span-independent (align-items: start, fixed column width).
    const spans = cards.map(card => Math.max(1, Math.ceil((card.offsetHeight + 12) / 2)));
    cards.forEach((card, i) => {
      card.style.gridRowEnd = `span ${spans[i]}`;
    });
  }
  function scheduleHistoryMasonry() {
    if (masonryRaf) cancelAnimationFrame(masonryRaf);
    masonryRaf = requestAnimationFrame(() => {
      masonryRaf = 0;
      layoutHistoryMasonry();
    });
  }
  window.addEventListener('resize', scheduleHistoryMasonry);

  // ── 历史卡片「超清增强」: 对已生成的 720p·24fps 视频后制升级 (FFmpeg 60fps 插帧 + Lanczos 1.5x) ──
  const ENHANCED_RE = /_1080p60\.mp4$/i;
  const ENHANCE_POLL_INTERVAL = 1500;
  const ENHANCE_POLL_DEADLINE = 30 * 60 * 1000; // 服务端挂死/重启后不再无限轮询
  const ENHANCE_MAX_NETWORK_ERRORS = 5;         // 瞬时网络抖动有限重试，避免误放行第二个 job

  async function runCardEnhance(filename, btn) {
    // busy 态再次点击 = 请求取消（1~5 分钟的任务需要中止入口）
    if (btn.dataset.busy === '1') {
      const jobId = btn.dataset.jobId;
      if (!jobId || btn.dataset.cancelAsked === '1') return;
      if (!window.confirm('正在增强中，要取消这个超清增强任务吗？')) return;
      btn.dataset.cancelAsked = '1';
      try {
        await fetch(`/api/enhance/${jobId}/cancel`, { method: 'POST' });
      } catch (e) {
        showToast(e.message || '取消请求失败', true);
        btn.dataset.cancelAsked = '';
      }
      return;
    }
    if (!window.confirm(`对「${filename}」执行超清增强?\n将生成 1080p·60fps 交付版本（原图保留），处理约需 1~5 分钟。`)) return;
    btn.dataset.busy = '1';
    const originalHtml = btn.innerHTML;
    try {
      const res = await fetch('/api/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || '启动增强失败');
      btn.dataset.jobId = body.jobId;
      showToast(body.resumed ? '该视频已在增强中，已接续进度显示' : '超清增强任务已启动');

      let networkErrors = 0;
      const startedAt = Date.now();
      const poll = async () => {
        if (Date.now() - startedAt > ENHANCE_POLL_DEADLINE) {
          if (btn.isConnected) { btn.innerHTML = originalHtml; btn.dataset.busy = ''; btn.dataset.jobId = ''; }
          showToast('增强任务超时未完成，请稍后在历史中查看或重新发起', true);
          return;
        }
        try {
          const jRes = await fetch(`/api/enhance/${body.jobId}`);
          const job = await jRes.json();
          if (!jRes.ok) {
            // 404 = 服务端 job 丢失（内存 Map，服务重启即失），重试无意义
            throw new Error(jRes.status === 404
              ? '增强任务已丢失（服务可能重启过），请重新发起'
              : (job.error || '查询增强进度失败'));
          }
          networkErrors = 0;
          if (btn.isConnected) {
            btn.innerHTML = `<i class="ph ph-circle-notch spin"></i> ${job.progress || 0}%`;
          }
          if (job.status === 'completed') {
            showToast(`超清增强完成: ${job.output}`);
            // 仅当按钮仍挂在当前 DOM 上（未因刷新/重建失效）才刷新列表，
            // 避免旧 poller 与新 poller 重复触发 loadHistory 与提示
            if (btn.isConnected) loadHistory();
            return;
          }
          if (job.status === 'error') throw new Error(job.message || '增强失败');
          if (job.status === 'cancelled') {
            if (btn.isConnected) { btn.innerHTML = originalHtml; btn.dataset.busy = ''; btn.dataset.cancelAsked = ''; btn.dataset.jobId = ''; }
            showToast('超清增强已取消');
            return;
          }
          setTimeout(poll, ENHANCE_POLL_INTERVAL);
        } catch (e) {
          networkErrors++;
          // 网络抖动：有限重试，服务端 ffmpeg 仍在跑，直接放弃会让用户重复发起
          if (networkErrors < ENHANCE_MAX_NETWORK_ERRORS && !/丢失|重新发起/.test(e.message || '')) {
            setTimeout(poll, ENHANCE_POLL_INTERVAL * 2);
            return;
          }
          if (btn.isConnected) { btn.innerHTML = originalHtml; btn.dataset.busy = ''; btn.dataset.cancelAsked = ''; btn.dataset.jobId = ''; }
          showToast(e.message || '增强失败', true);
        }
      };
      poll();
    } catch (e) {
      btn.dataset.busy = '';
      showToast(e.message || '增强失败', true);
    }
  }

  async function loadHistory() {
    try {
      const res = await fetch('/api/history');
      const items = await res.json();
      historyGrid.innerHTML = '';

      if (items.length === 0) {
        // Inline 'auto' (not '') — '' would fall back to the CSS 2px unit and
        // collapse the empty-state paragraph.
        historyGrid.style.gridAutoRows = 'auto';
        historyGrid.innerHTML = '<p style="color: var(--text-muted); font-size: 12px;">暂无历史生成记录</p>';
        return;
      }

      items.forEach(item => {
        const isVideo = item.type === 'video';
        const isEnhanced = isVideo && ENHANCED_RE.test(item.filename);
        const card = document.createElement('div');
        card.className = 'history-card';
        // With known dimensions, reserve the thumb box via aspect-ratio before
        // the image loads — the masonry spans are correct on the first pass.
        const thumbDims = (Number.isFinite(parseInt(item.width, 10)) && Number.isFinite(parseInt(item.height, 10)) && item.width > 0 && item.height > 0)
          ? ` style="aspect-ratio: ${parseInt(item.width, 10)} / ${parseInt(item.height, 10)};"`
          : '';
        card.innerHTML = `
          ${item.previewUrl ? `<img class="history-thumb" src="${escapeHtml(item.previewUrl)}" alt="${escapeHtml(item.filename)}"${thumbDims} loading="lazy" decoding="async">` : `<div class="history-thumb history-thumb-empty"><i class="ph ${isVideo ? 'ph-film-strip' : 'ph-image'}"></i></div>`}
          <button class="history-delete" type="button" title="删除此记录"><i class="ph ph-trash"></i></button>
          ${isEnhanced ? '<div class="history-hd-badge" title="1080p · 60fps 超清增强版"><i class="ph ph-gem"></i> 1080p60</div>' : ''}
          <div class="history-meta">
            <div class="history-name" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</div>
            <div class="history-size">
              <span class="history-badge ${isVideo ? 'badge-video' : 'badge-image'}">${isEnhanced ? '1080p·60fps 超清' : (isVideo ? '10s 视频' : '定妆照')}</span>
              <span>${escapeHtml(item.size)}</span>
            </div>
            ${!isVideo ? `<button class="history-video-btn" type="button" title="用此定妆照直接生成 10 秒视频"><i class="ph ph-video-camera"></i> 生成视频</button>` : ''}
            ${isVideo && !isEnhanced ? `<button class="history-enhance-btn" type="button" title="后制增强为 1080p·60fps 交付版（FFmpeg 插帧 + Lanczos 放大）"><i class="ph ph-gem"></i> 超清增强</button>` : ''}
          </div>
        `;
        const thumbImg = card.querySelector('img.history-thumb');
        if (thumbImg) {
          thumbImg.addEventListener('error', () => {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'history-thumb history-thumb-empty';
            emptyDiv.innerHTML = `<i class="ph ${isVideo ? 'ph-film-strip' : 'ph-image'}"></i>`;
            thumbImg.replaceWith(emptyDiv);
            scheduleHistoryMasonry();
          }, { once: true });
        }
        card.querySelector('.history-delete').addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const cardEl = ev.currentTarget.closest('.history-card');
          if (!window.confirm(`确定删除「${item.filename}」吗?删除后不可恢复。`)) return;
          cardEl.classList.add('history-deleting');
          try {
            const res = await fetch(`/api/history/${item.type}/${encodeURIComponent(item.filename)}`, { method: 'DELETE' });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || '删除失败');
            cardEl.remove();
            showToast('已删除');
            if (!historyGrid.querySelector('.history-card')) {
              historyGrid.style.gridAutoRows = 'auto';
              historyGrid.innerHTML = '<p style="color: var(--text-muted); font-size: 12px;">暂无历史生成记录</p>';
            }
          } catch (e) {
            cardEl.classList.remove('history-deleting');
            showToast(e.message || '删除失败');
          }
        });
        const videoBtn = card.querySelector('.history-video-btn');
        if (videoBtn) videoBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          generateVideoFromExistingStill(item.filename);
        });
        const enhanceBtn = card.querySelector('.history-enhance-btn');
        if (enhanceBtn) enhanceBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          runCardEnhance(item.filename, enhanceBtn);
        });
        card.addEventListener('click', () => {
          showcaseEmpty.style.display = 'none';
          showcaseContent.style.display = 'block';
          if (batchNavBar) batchNavBar.style.display = 'none';

          if (isVideo) {
            videoBox.style.display = 'block';
            resultVideo.src = item.url;
            resultVideo.muted = userAudioMuted;
            resultVideo.play().catch(() => {
              // Browser blocked autoplay with sound — fall back to muted autoplay
              resultVideo.muted = true;
              resultVideo.play();
            });
            downloadVideoBtn.href = item.url;
            downloadVideoBtn.download = item.filename;
            if (item.previewUrl) {
              resultStillImg.src = item.previewUrl;
              downloadStillBtn.href = item.previewUrl;
              downloadStillBtn.download = item.previewUrl.split('/').pop();
            }
            if (btnStillToVideo) btnStillToVideo.style.display = 'none';
          } else {
            // Still image item
            stopActiveVideoPlayback();
            videoBox.style.display = 'none';
            resultStillImg.src = item.url;
            downloadStillBtn.href = item.url;
            downloadStillBtn.download = item.filename;
            if (btnStillToVideo) {
              btnStillToVideo.style.display = 'inline-flex';
              btnStillToVideo.dataset.filename = item.filename;
            }
          }
          showToast(`已加载历史作品: ${item.filename}`);
        });
        historyGrid.appendChild(card);
      });

      // Relayout as thumbnails finish loading — only needed for thumbs without
      // server-provided dimensions (those already reserve their box, so their
      // spans are final and loading them is layout-neutral).
      historyGrid.querySelectorAll('img.history-thumb').forEach(img => {
        if (img.style.aspectRatio) return;
        if (img.complete && img.naturalHeight > 0) return;
        img.addEventListener('load', scheduleHistoryMasonry, { once: true });
        img.addEventListener('error', scheduleHistoryMasonry, { once: true });
      });
      scheduleHistoryMasonry();
    } catch (e) {
      console.error('Failed to load history:', e);
    }
  }

  // Resume in-flight task tracking or restore results if page was closed/refreshed during generation
  async function checkActiveTaskOnLoad() {
    // 1. Check Batch Task
    try {
      const rawBatch = localStorage.getItem(ACTIVE_BATCH_KEY) || sessionStorage.getItem(ACTIVE_BATCH_KEY);
      if (rawBatch) {
        const { batchId, startTime: savedStartTime } = JSON.parse(rawBatch);
        if (batchId) {
          const bRes = await fetch(`/api/batch/${batchId}`);
          if (bRes.ok) {
            const batch = await bRes.json();
            const scenes = batch.tasks && batch.tasks.length > 0
              ? batch.tasks.map(t => (t.scene && t.scene.id) || 'street')
              : ['street', 'studio', 'boutique'];
            const taskIds = batch.tasks ? batch.tasks.map(t => t.id) : [];

            if (batch.status === 'queued' || batch.status === 'running') {
              activeBatchId = batchId;
              setButtonsDisabled(true);
              stopActiveVideoPlayback();
              progressCard.style.display = 'block';
              if (progressCardTitle) progressCardTitle.textContent = '⚡ 批量 3 套场景生成进度';
              initBatchUI(scenes, taskIds);
              updateBatchTabsState(batch);

              startTime = savedStartTime || Date.now();
              elapsedTimer.textContent = '00:00';
              clearInterval(timerInterval);
              timerInterval = setInterval(() => {
                const sec = Math.floor((Date.now() - startTime) / 1000);
                const m = String(Math.floor(sec / 60)).padStart(2, '0');
                const s = String(sec % 60).padStart(2, '0');
                elapsedTimer.textContent = `${m}:${s}`;
              }, 1000);

              startBatchPolling(batchId);
              return;
            } else if (batch.status === 'completed') {
              try { localStorage.removeItem(ACTIVE_BATCH_KEY); sessionStorage.removeItem(ACTIVE_BATCH_KEY); } catch (e) {}
              currentBatchData = batch;
              selectedBatchIndex = 0;
              initBatchUI(scenes, taskIds);
              updateBatchTabsState(batch);
              if (batch.tasks && batch.tasks.length > 0) {
                showBatchTaskResult(batch.tasks[0]);
              }
              showToast('⚡ 批量 3 套场景展示成片已全部生成就绪！');
              return;
            }
          }
          try { localStorage.removeItem(ACTIVE_BATCH_KEY); sessionStorage.removeItem(ACTIVE_BATCH_KEY); } catch (e) {}
        }
      }
    } catch (e) {
      console.warn('Failed to resume active batch on load:', e);
    }

    // 2. Check Single Task
    try {
      const raw = localStorage.getItem(ACTIVE_TASK_KEY) || sessionStorage.getItem(ACTIVE_TASK_KEY);
      if (!raw) return;
      const { taskId, startTime: savedStartTime } = JSON.parse(raw);
      if (!taskId) return;

      const res = await fetch(`/api/progress/${taskId}`);
      if (res.status === 404) {
        try { localStorage.removeItem(ACTIVE_TASK_KEY); sessionStorage.removeItem(ACTIVE_TASK_KEY); } catch (e) {}
        return;
      }
      const task = await res.json();
      if (task.status === 'queued' || task.status === 'running') {
        currentTaskId = taskId;
        setButtonsDisabled(true);
        stopActiveVideoPlayback();
        progressCard.style.display = 'block';
        if (progressCardTitle) progressCardTitle.textContent = '单套场景生成进度';
        progressBar.style.width = `${task.progress}%`;
        progressStatusMsg.textContent = task.message;
        updateStepsUI(task.progress, task.mode);

        if (task.stillImage && showcaseEmpty.style.display !== 'none') {
          showcaseEmpty.style.display = 'none';
          showcaseContent.style.display = 'block';
          resultStillImg.src = task.stillImage;
          downloadStillBtn.href = task.stillImage;
          downloadStillBtn.download = `fashion_still_${(task.scene && task.scene.id) || 'scene'}.png`;
          videoBox.style.display = 'none';
        }

        startTime = savedStartTime || Date.now();
        elapsedTimer.textContent = '00:00';
        clearInterval(timerInterval);
        timerInterval = setInterval(() => {
          const sec = Math.floor((Date.now() - startTime) / 1000);
          const m = String(Math.floor(sec / 60)).padStart(2, '0');
          const s = String(sec % 60).padStart(2, '0');
          elapsedTimer.textContent = `${m}:${s}`;
        }, 1000);

        startPolling(taskId);
      } else {
        try { localStorage.removeItem(ACTIVE_TASK_KEY); sessionStorage.removeItem(ACTIVE_TASK_KEY); } catch (e) {}
        if (task.status === 'completed') {
          showResults(task);
          showToast('生成完成，成片已就绪。');
        }
      }
    } catch (e) {
      console.warn('Failed to resume active task on load:', e);
    }
  }

  btnRefreshHistory.addEventListener('click', loadHistory);

  // App Initialization Sequence: sync actions -> restore options -> sync styles -> load scene cards -> check in-flight tasks -> load history
  (async () => {
    if (seg1ActionSelect) seg1ActionSelect.addEventListener('change', () => { saveUserOptions(); queueRefreshPromptInspector(); });
    if (seg2ActionSelect) seg2ActionSelect.addEventListener('change', () => { saveUserOptions(); queueRefreshPromptInspector(); });
    await fetchServerConfig();
    await syncActionsFromServer();
    await restoreUserOptions();
    await syncModelStylesFromServer();
    updateModelStylePromptUI();
    updateStillEngineUI();
    // 同步恢复后的派生 UI：genMode→超清增强禁用态、批量按钮文案等
    updateBatchHint();
    await loadScenes();
    await checkActiveTaskOnLoad();
    loadHistory();
    await refreshPromptInspector(true);
  })();
});
