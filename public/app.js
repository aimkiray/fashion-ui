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
  let userAudioMuted = false;

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

  // DOM Elements - Progress & Status
  const progressCard = document.getElementById('progressCard');
  const progressCardTitle = document.getElementById('progressCardTitle');
  const progressBar = document.getElementById('progressBar');
  const progressStatusMsg = document.getElementById('progressStatusMsg');
  const elapsedTimer = document.getElementById('elapsedTimer');

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

  const videoBox = document.getElementById('videoBox');
  const resultVideo = document.getElementById('resultVideo');
  const btnToggleAudio = document.getElementById('btnToggleAudio');
  const downloadVideoBtn = document.getElementById('downloadVideoBtn');

  const historyGrid = document.getElementById('historyGrid');
  const btnRefreshHistory = document.getElementById('btnRefreshHistory');
  const systemStatus = document.getElementById('systemStatus');
  const statusText = document.getElementById('statusText');

  const toastContainer = document.getElementById('toastContainer');
  const lightboxModal = document.getElementById('lightboxModal');
  const lightboxImg = document.getElementById('lightboxImg');
  const btnCloseLightbox = document.getElementById('btnCloseLightbox');

  const modelStylePromptInput = document.getElementById('modelStylePrompt');
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

  // Persistence & Storage Keys
  const STORAGE_KEY = 'fashion_ui_user_options_v2';
  const ACTIVE_TASK_KEY = 'fashion_ui_active_task';
  const ACTIVE_BATCH_KEY = 'fashion_ui_active_batch';
  const STYLE_PROMPTS_KEY = 'fashion_ui_style_prompts_v1';
  const IDB_NAME = 'fashion_ui_storage_v2';
  const STORE_GARMENT = 'uploaded_garment';
  const STORE_MODEL = 'uploaded_model';
  const STORE_SCENE = 'uploaded_scene';

  // Default Model Style Prompts
  const DEFAULT_STYLE_PROMPTS = {
    female: {
      classic: 'with poised editorial elegance, serene composed expression, mouth closed, closed lips, and relaxed upright posture',
      sweet: 'with fresh-faced youthful purity, serene gentle features, quiet tranquil poise, mouth closed, softly closed lips, calm tender gaze',
      athletic: 'with an athletic healthy glow, calm focused expression, mouth closed, closed lips, and upright confident posture',
      mature: 'with commanding graceful poise, sophisticated refined features, mouth closed, closed lips, and poised upright posture',
      cool: 'with a chic androgynous edge, cool understated attitude, mouth closed, closed lips, and upright lookbook posture'
    },
    male: {
      classic: 'with sharp jawline, editorial charisma, calm composed expression, mouth closed, closed lips, and upright natural posture',
      sweet: 'with clean youthful Korean-style charm, gentle refined features, relaxed natural poise, mouth closed, closed lips, calm subtle gaze',
      athletic: 'with an athletic toned build, sharp defined features, calm focused expression, mouth closed, closed lips, and upright confident posture',
      mature: 'with distinguished executive poise, mature handsome features, mouth closed, closed lips, and upright commanding posture',
      cool: 'with a modern streetwear edge, cool understated attitude, mouth closed, closed lips, and upright confident posture'
    }
  };

  function loadStoredStylePrompts() {
    try {
      const raw = localStorage.getItem(STYLE_PROMPTS_KEY);
      return raw ? JSON.parse(raw) : {};
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
      updateModelStylePromptUI();
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
      const genMode = document.querySelector('input[name="genMode"]:checked')?.value || 'video';
      const customScene = customSceneText ? customSceneText.value : '';
      const customPrompt = customPromptInput ? customPromptInput.value : '';

      const options = {
        selectedScene: selectedScene || 'street',
        customSceneText: customScene,
        gender,
        modelStyle,
        aspectRatio,
        genMode,
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
    if (opts.genMode) {
      const el = document.querySelector(`input[name="genMode"][value="${opts.genMode}"]`);
      if (el) el.checked = true;
    }

    // 6. Custom prompt
    if (customPromptInput && typeof opts.customPrompt === 'string') {
      customPromptInput.value = opts.customPrompt;
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
    const batchHintEl = document.querySelector('.batch-hint');
    const batchScenes = getBatchScenesFor(selectedScene);
    const sceneNames = batchScenes.map(id => BATCH_SCENE_LABELS[id] || id);
    const scenesText = `【${sceneNames.join('、')}】`;
    const genMode = document.querySelector('input[name="genMode"]:checked')?.value || 'video';
    const isStillOnly = genMode === 'still_only';
    const modeText = isStillOnly ? '定妆照' : '视频';

    if (batchHintEl) {
      batchHintEl.textContent = `批量生成：系统自动选取${scenesText}排队生成 3 套场景${modeText}，方便高效出片`;
    }
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
  }

  // 2. Load Scenes
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
      saveUserOptions();
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
    },
    onFileClear: () => {
      uploadedModelFile = null;
      showToast('已清除模特参考图，将按下方配置生成模特。');
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
    },
    onFileClear: () => {
      uploadedSceneFile = null;
      showToast('已清除场景背景参考图。');
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
  document.querySelectorAll('.quick-tag').forEach(tag => {
    tag.addEventListener('click', (e) => {
      e.preventDefault();
      const insertText = tag.dataset.insert;
      if (!customPromptInput) return;
      const cur = customPromptInput.value.trim();
      if (!cur) {
        customPromptInput.value = insertText;
      } else if (cur.includes(insertText)) {
        showToast(`已包含此要求: ${insertText}`);
      } else {
        customPromptInput.value = cur + '\n' + insertText;
      }
      customPromptInput.focus();
      saveUserOptions();
    });
  });

  // Auto-save listeners for options and inputs
  document.querySelectorAll('input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.name === 'gender' || radio.name === 'modelStyle') {
        updateModelStylePromptUI();
      }
      saveUserOptions();
      updateBatchHint();
    });
  });
  if (modelStylePromptInput) {
    modelStylePromptInput.addEventListener('input', () => {
      const gender = document.querySelector('input[name="gender"]:checked')?.value || 'female';
      const modelStyle = document.querySelector('input[name="modelStyle"]:checked')?.value || 'classic';
      setEffectiveStylePrompt(gender, modelStyle, modelStylePromptInput.value);
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
    });
  }
  if (customPromptInput) {
    customPromptInput.addEventListener('input', saveUserOptions);
  }
  if (customSceneText) {
    customSceneText.addEventListener('input', saveUserOptions);
  }

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

  // 4. Single Generate Execution
  btnGenerate.addEventListener('click', async () => {
    try {
      let finalImageFilename = selectedImage;

      // Validate that an image is provided
      if (!uploadedFile && !finalImageFilename) {
        showToast('请先上传服装图片或选择上方预设样例。', true);
        return;
      }

      setButtonsDisabled(true);

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
          mode: genMode
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
      try {
        sessionStorage.setItem(ACTIVE_TASK_KEY, JSON.stringify({
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

  // 5. Batch Generate Execution (3 commercial styles: street + studio + boutique)
  if (btnGenerateBatch) {
    btnGenerateBatch.addEventListener('click', async () => {
      try {
        let finalImageFilename = selectedImage;

        if (!uploadedFile && !finalImageFilename) {
          showToast('请先上传服装图片或选择上方预设样例。', true);
          return;
        }

        setButtonsDisabled(true);

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

        const genRes = await fetch('/api/generate-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: finalImageFilename,
            model_image: finalModelFilename,
            scene_image: finalSceneFilename,
            scenes: batchScenes,
            gender,
            model_style: modelStyle,
            model_style_prompt: modelStylePrompt,
            custom_prompt: customPrompt,
            custom_scene: customScene,
            aspect_ratio: aspectRatio,
            mode: genMode
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
          sessionStorage.setItem(ACTIVE_BATCH_KEY, JSON.stringify({
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
        videoBox.style.display = 'none';
        delete resultVideo.dataset.currentSrc;
      }
    } else {
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

  function startBatchPolling(batchId) {
    if (batchPollTimeout) clearTimeout(batchPollTimeout);
    isBatchPolling = true;
    let pollFailures = 0;

    async function poll() {
      if (!isBatchPolling) return;
      try {
        const res = await fetch(`/api/batch/${batchId}`);
        if (res.status === 404) {
          stopBatchPolling('批量任务记录已失效，请重新发起。');
          return;
        }
        if (res.ok) {
          pollFailures = 0;
          const batch = await res.json();
          currentBatchData = batch;
          const totalTasks = batch.totalTasks || 3;
          const currentIdx = batch.currentTaskIndex;
          const subTasks = batch.tasks || [];

          let completedCount = 0;
          subTasks.forEach((t, i) => {
            const tabBtn = batchTabs && batchTabs.children ? batchTabs.children[i] : null;
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

          const runningTask = subTasks[currentIdx] || subTasks[subTasks.length - 1];
          const taskProgress = (runningTask && runningTask.progress) || 0;
          const overallProgress = Math.min(100, Math.round(((completedCount * 100) + taskProgress) / totalTasks));
          progressBar.style.width = `${Math.max(8, overallProgress)}%`;

          const sceneName = (runningTask && runningTask.scene && runningTask.scene.name) || `场景 ${currentIdx + 1}`;
          const currentMsg = (runningTask && runningTask.message) || '处理中...';
          progressStatusMsg.textContent = `[${Math.min(totalTasks, currentIdx + 1)}/${totalTasks} ${sceneName}] ${currentMsg}`;

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

          if (batch.status === 'completed' || batch.status === 'error' || completedCount >= totalTasks) {
            isBatchPolling = false;
            stopTimer();
            setButtonsDisabled(false);
            try { sessionStorage.removeItem(ACTIVE_BATCH_KEY); } catch (e) {}
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
        stopBatchPolling('与服务器通信连续失败，已停止批量任务追踪。');
        return;
      }

      if (isBatchPolling) {
        batchPollTimeout = setTimeout(poll, 1300);
      }
    }

    poll();
  }

  function stopBatchPolling(msg) {
    isBatchPolling = false;
    if (batchPollTimeout) clearTimeout(batchPollTimeout);
    stopTimer();
    setButtonsDisabled(false);
    try { sessionStorage.removeItem(ACTIVE_BATCH_KEY); } catch (e) {}
    showToast(msg, true);
    loadHistory();
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
      try { sessionStorage.removeItem(ACTIVE_TASK_KEY); } catch (e) {}
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
          pollFailures = 0;
          const task = await res.json();
          progressBar.style.width = `${task.progress}%`;
          progressStatusMsg.textContent = task.message;
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
            try { sessionStorage.removeItem(ACTIVE_TASK_KEY); } catch (e) {}
            showToast('生成完成，成片已就绪。');
            showResults(task);
            loadHistory();
            return;
          } else if (task.status === 'error') {
            isPollingActive = false;
            stopTimer();
            setButtonsDisabled(false);
            try { sessionStorage.removeItem(ACTIVE_TASK_KEY); } catch (e) {}
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
  async function loadHistory() {
    try {
      const res = await fetch('/api/history');
      const items = await res.json();
      historyGrid.innerHTML = '';

      if (items.length === 0) {
        historyGrid.innerHTML = '<p style="color: var(--text-muted); font-size: 12px;">暂无历史生成记录</p>';
        return;
      }

      items.forEach(item => {
        const isVideo = item.type === 'video';
        const card = document.createElement('div');
        card.className = 'history-card';
        card.innerHTML = `
          ${item.previewUrl ? `<img class="history-thumb" src="${escapeHtml(item.previewUrl)}" alt="${escapeHtml(item.filename)}">` : `<div class="history-thumb history-thumb-empty"><i class="ph ph-film-strip"></i></div>`}
          <button class="history-delete" type="button" title="删除此记录"><i class="ph ph-trash"></i></button>
          <div class="history-meta">
            <div class="history-name" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</div>
            <div class="history-size">
              <span class="history-badge ${isVideo ? 'badge-video' : 'badge-image'}">${isVideo ? '10s 视频' : '定妆照'}</span>
              <span>${escapeHtml(item.size)}</span>
            </div>
          </div>
        `;
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
              historyGrid.innerHTML = '<p style="color: var(--text-muted); font-size: 12px;">暂无历史生成记录</p>';
            }
          } catch (e) {
            cardEl.classList.remove('history-deleting');
            showToast(e.message || '删除失败');
          }
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
          } else {
            // Still image item
            videoBox.style.display = 'none';
            resultStillImg.src = item.url;
            downloadStillBtn.href = item.url;
            downloadStillBtn.download = item.filename;
          }
          showToast(`已加载历史作品: ${item.filename}`);
        });
        historyGrid.appendChild(card);
      });
    } catch (e) {
      console.error('Failed to load history:', e);
    }
  }

  // Resume in-flight task tracking if page was refreshed during generation
  async function checkActiveTaskOnLoad() {
    // 1. Check Batch Task
    try {
      const rawBatch = sessionStorage.getItem(ACTIVE_BATCH_KEY);
      if (rawBatch) {
        const { batchId, startTime: savedStartTime } = JSON.parse(rawBatch);
        if (batchId) {
          const bRes = await fetch(`/api/batch/${batchId}`);
          if (bRes.ok) {
            const batch = await bRes.json();
            if (batch.status === 'queued' || batch.status === 'running') {
              activeBatchId = batchId;
              setButtonsDisabled(true);
              progressCard.style.display = 'block';
              if (progressCardTitle) progressCardTitle.textContent = '⚡ 批量 3 套场景生成进度';
              const scenes = batch.tasks && batch.tasks.length > 0
                ? batch.tasks.map(t => (t.scene && t.scene.id) || 'street')
                : ['street', 'studio', 'boutique'];
              const taskIds = batch.tasks ? batch.tasks.map(t => t.id) : [];
              initBatchUI(scenes, taskIds);

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
            }
          }
          sessionStorage.removeItem(ACTIVE_BATCH_KEY);
        }
      }
    } catch (e) {
      console.warn('Failed to resume active batch on load:', e);
    }

    // 2. Check Single Task
    try {
      const raw = sessionStorage.getItem(ACTIVE_TASK_KEY);
      if (!raw) return;
      const { taskId, startTime: savedStartTime } = JSON.parse(raw);
      if (!taskId) return;

      const res = await fetch(`/api/progress/${taskId}`);
      if (res.status === 404) {
        sessionStorage.removeItem(ACTIVE_TASK_KEY);
        return;
      }
      const task = await res.json();
      if (task.status === 'queued' || task.status === 'running') {
        currentTaskId = taskId;
        setButtonsDisabled(true);
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
        sessionStorage.removeItem(ACTIVE_TASK_KEY);
        if (task.status === 'completed') {
          showResults(task);
        }
      }
    } catch (e) {
      console.warn('Failed to resume active task on load:', e);
    }
  }

  btnRefreshHistory.addEventListener('click', loadHistory);

  // App Initialization Sequence: restore options -> sync styles -> load scene cards -> check in-flight tasks -> load history
  (async () => {
    await restoreUserOptions();
    await syncModelStylesFromServer();
    updateModelStylePromptUI();
    await loadScenes();
    await checkActiveTaskOnLoad();
    loadHistory();
  })();
});
