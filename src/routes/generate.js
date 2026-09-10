const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { randomUUID: uuidv4 } = require("crypto");
const { tasks, batchJobs, taskAbortControllers, cancelTask, cancelBatchJob } = require("../store/tasks");
const { enqueueJob } = require("../queue/fifo");
const { runGenerationJob } = require("../jobs/runGenerationJob");
const { noteGenerationActivity } = require("../comfy/idleRelease");
const { SCENES } = require("../prompt-catalog/scenes");
const { MODEL_STYLES } = require("../prompt-catalog/modelStyles");
const { MODEL_AGES } = require("../prompt-catalog/modelAges");
const { HAIRSTYLES } = require("../prompt-catalog/hairstyles");
const { FACE_SHAPES } = require("../prompt-catalog/faceShapes");
const { normTaskAction } = require("../prompt-catalog/h3Actions");
const { resolveActions, resolveBatchActions } = require("../prompts/computeTaskPrompts");
const { PROJECT_INPUT_DIR, PROJECT_IMAGE_DIR } = require("../paths");
router.post('/api/generate', async (req, res) => {
  const {
    image,
    model_image = null,
    scene_image = null,
    scene = 'street',
    custom_scene = '',
    gender = 'female',
    model_style = 'classic',
    model_style_prompt = '',
    custom_prompt = '',
    aspect_ratio = '3:4',
    mode = 'video',
    still_engine = 'gpt_image_2',
    krea_prompt = null,
    seg1_prompt = null,
    seg2_prompt = null,
    action1 = 'random',
    action2 = 'random',
    hair_style = 'natural',
    face_shape = 'oval',
    model_age = 'adult',
    enhance = false,
    composition = 'auto',
    existing_still = null
  } = req.body;

  // Whitelist: unknown aspect ratios fall back to 3:4 (keeps the exact-canvas
  // image request and the Stage-2 video canvas in agreement).
  if (!['3:4', '9:16', '1:1'].includes(aspect_ratio)) aspect_ratio = '3:4';

  // Strict boolean: client may send "false" as a string
  const enhanceEnabled = enhance === true || enhance === 'true';

  // Optional: skip Stage 1 and reuse an existing still photo for video generation
  let sanitizedExistingStill = null;
  if (existing_still) {
    sanitizedExistingStill = path.basename(String(existing_still));
    if (!/\.(png|jpe?g|webp)$/i.test(sanitizedExistingStill)) {
      return res.status(400).json({ error: `不支持的定妆照格式: ${sanitizedExistingStill}` });
    }
    if (!fs.existsSync(path.join(PROJECT_IMAGE_DIR, sanitizedExistingStill))) {
      return res.status(400).json({ error: `找不到指定的定妆照: ${sanitizedExistingStill}` });
    }
  }

  if (!image && !sanitizedExistingStill) {
    return res.status(400).json({ error: '缺少服装图片文件名' });
  }

  // Whitelist the model style and model age to known presets
  const modelStyleKey = MODEL_STYLES[model_style] ? model_style : 'classic';
  const modelAgeKey = MODEL_AGES[model_age] ? model_age : 'adult';

  // Prevent path traversal attacks
  const sanitizedImage = image ? path.basename(image) : null;
  if (sanitizedImage && !fs.existsSync(path.join(PROJECT_INPUT_DIR, sanitizedImage))) {
    return res.status(400).json({ error: `找不到指定的服装图片: ${sanitizedImage}` });
  }

  const sanitizedModelImage = model_image ? path.basename(String(model_image)) : null;
  const sanitizedSceneImage = scene_image ? path.basename(String(scene_image)) : null;

  const taskId = uuidv4();
  const sceneConfig = SCENES[scene] || SCENES.street;

  const isCustomScene = sceneConfig.id === 'custom';

  const { action1: resolvedAction1, action2: resolvedAction2 } = resolveActions(action1, action2, sceneConfig.id);

  const task = {
    id: taskId,
    status: 'queued',
    progress: 5,
    message: '任务已进入执行队列...',
    scene: sceneConfig,
    gender,
    model_style: modelStyleKey,
    model_style_prompt: typeof model_style_prompt === 'string' ? model_style_prompt.trim() : '',
    custom_scene: isCustomScene ? custom_scene : '',
    custom_prompt,
    still_engine: (still_engine === 'gpt_image_2' ? 'gpt_image_2' : 'krea2'),
    custom_krea_prompt: typeof krea_prompt === 'string' && krea_prompt.trim() ? krea_prompt.trim() : null,
    custom_seg1_prompt: typeof seg1_prompt === 'string' && seg1_prompt.trim() ? seg1_prompt.trim() : null,
    custom_seg2_prompt: typeof seg2_prompt === 'string' && seg2_prompt.trim() ? seg2_prompt.trim() : null,
    aspect_ratio,
    composition: ['auto', 'center', 'left', 'right'].includes(composition) ? composition : 'auto',
    image: sanitizedImage,
    model_image: sanitizedModelImage,
    scene_image: isCustomScene ? sanitizedSceneImage : null,
    action1: resolvedAction1,
    action2: resolvedAction2,
    hair_style: HAIRSTYLES[hair_style] ? hair_style : 'natural',
    face_shape: FACE_SHAPES[face_shape] ? face_shape : 'oval',
    model_age: modelAgeKey,
    existing_still: sanitizedExistingStill,
    mode,
    // 超清增强: 3D Latent Upscale 1080p + RIFE 插帧（远端装模型后生效）
    enhance: enhanceEnabled,
    stillImage: null,
    videoUrl: null,
    createdAt: new Date().toISOString(),
    error: null
  };
  const ac = new AbortController();
  taskAbortControllers.set(taskId, ac);
  tasks.set(taskId, task);
  noteGenerationActivity();

  // Enqueue job via global FIFO execution queue to prevent model thrashing
  enqueueJob(async () => {
    const t = tasks.get(taskId);
    if (!t || t.status === 'cancelled') {
      taskAbortControllers.delete(taskId);
      return;
    }
    try {
      await runGenerationJob(taskId, { signal: ac.signal });
    } catch (err) {
      if (t.status === 'cancelled' || ac.signal.aborted) return;
      console.error(`Task ${taskId} failed in global queue:`, err);
      if (t && t.status !== 'completed') {
        t.status = 'error';
        t.error = err.message;
        t.message = `生成失败: ${err.message}`;
      }
    } finally {
      taskAbortControllers.delete(taskId);
    }
  });

  res.json({ taskId });
});


router.post('/api/generate-batch', async (req, res) => {
  const {
    image,
    model_image = null,
    scene_image = null,
    scenes = ['street', 'studio', 'boutique'],
    scene = 'street',
    gender = 'female',
    model_style = 'classic',
    model_style_prompt = '',
    custom_prompt = '',
    custom_scene = '',
    aspect_ratio = '3:4',
    mode = 'video',
    still_engine = 'gpt_image_2',
    krea_prompt = null,
    seg1_prompt = null,
    seg2_prompt = null,
    action1 = 'random',
    action2 = 'random',
    hair_style = 'natural',
    face_shape = 'oval',
    model_age = 'adult',
    enhance = false,
    composition = 'auto'
  } = req.body;

  // Whitelist: unknown aspect ratios fall back to 3:4.
  if (!['3:4', '9:16', '1:1'].includes(aspect_ratio)) aspect_ratio = '3:4';

  // Strict boolean: client may send "false" as a string
  const enhanceEnabled = enhance === true || enhance === 'true';
  const compositionMode = ['auto', 'center', 'left', 'right'].includes(composition) ? composition : 'auto';

  if (!image) {
    return res.status(400).json({ error: '缺少服装图片文件名' });
  }

  const sanitizedImage = path.basename(image);
  if (!fs.existsSync(path.join(PROJECT_INPUT_DIR, sanitizedImage))) {
    return res.status(400).json({ error: `找不到指定的服装图片: ${sanitizedImage}` });
  }

  const sanitizedModelImage = model_image ? path.basename(String(model_image)) : null;
  const sanitizedSceneImage = scene_image ? path.basename(String(scene_image)) : null;
  const modelStyleKey = MODEL_STYLES[model_style] ? model_style : 'classic';
  const modelAgeKey = MODEL_AGES[model_age] ? model_age : 'adult';

  const batchId = uuidv4();
  const selectedScenes = Array.isArray(scenes) && scenes.length > 0 ? scenes.slice(0, 5) : ['street', 'studio', 'boutique'];
  const taskIds = [];
  const batchActions = resolveBatchActions(selectedScenes, action1, action2);

  for (let i = 0; i < selectedScenes.length; i++) {
    const scKey = selectedScenes[i];
    const scConfig = SCENES[scKey] || SCENES.street;
    const isTargetScene = (scKey === scene);
    const tid = uuidv4();
    const { action1: resolvedAction1, action2: resolvedAction2 } = batchActions[i];
    const task = {
      id: tid,
      batchId,
      status: 'queued',
      progress: 0,
      message: `排队等待生成 (${scConfig.name})...`,
      scene: scConfig,
      gender,
      model_style: modelStyleKey,
      model_style_prompt: typeof model_style_prompt === 'string' ? model_style_prompt.trim() : '',
      custom_scene: scKey === 'custom' ? custom_scene : '',
      custom_prompt,
      still_engine: (still_engine === 'gpt_image_2' ? 'gpt_image_2' : 'krea2'),
      custom_krea_prompt: isTargetScene && typeof krea_prompt === 'string' && krea_prompt.trim() ? krea_prompt.trim() : null,
      custom_seg1_prompt: isTargetScene && typeof seg1_prompt === 'string' && seg1_prompt.trim() ? seg1_prompt.trim() : null,
      custom_seg2_prompt: isTargetScene && typeof seg2_prompt === 'string' && seg2_prompt.trim() ? seg2_prompt.trim() : null,
      aspect_ratio,
      image: sanitizedImage,
      model_image: sanitizedModelImage,
      scene_image: scKey === 'custom' ? sanitizedSceneImage : null,
      action1: resolvedAction1,
      action2: resolvedAction2,
      hair_style: HAIRSTYLES[hair_style] ? hair_style : 'natural',
      face_shape: FACE_SHAPES[face_shape] ? face_shape : 'oval',
      model_age: modelAgeKey,
      mode,
      // 超清增强: 3D Latent Upscale 1080p + RIFE 插帧（远端装模型后生效）
      enhance: enhanceEnabled,
      composition: compositionMode,
      stillImage: null,
      videoUrl: null,
      createdAt: new Date().toISOString(),
      error: null
    };
    const ac = new AbortController();
    taskAbortControllers.set(tid, ac);
    tasks.set(tid, task);
    taskIds.push(tid);
  }

  const batchJob = {
    id: batchId,
    status: 'queued',
    taskIds,
    currentTaskIndex: 0,
    totalTasks: taskIds.length,
    createdAt: new Date().toISOString()
  };
  batchJobs.set(batchId, batchJob);
  noteGenerationActivity();

  // Enqueue entire batch as an atomic sequence in the global queue
  enqueueJob(async () => {
    if (batchJob.status === 'cancelled') return;
    batchJob.status = 'running';
    try {
      for (let i = 0; i < taskIds.length; i++) {
        if (batchJob.status === 'cancelled') break;
        batchJob.currentTaskIndex = i;
        const tid = taskIds[i];
        const t = tasks.get(tid);
        if (!t || t.status === 'cancelled') continue;
        const ac = taskAbortControllers.get(tid) || new AbortController();
        try {
          await runGenerationJob(tid, { signal: ac.signal });
        } catch (err) {
          if (t.status === 'cancelled' || ac.signal.aborted) continue;
          console.error(`Batch ${batchId} subtask ${tid} failed:`, err);
          if (t && t.status !== 'completed') {
            t.status = 'error';
            t.error = err.message;
            t.message = `生成失败: ${err.message}`;
          }
        } finally {
          taskAbortControllers.delete(tid);
        }
      }
    } finally {
      if (batchJob.status !== 'cancelled') {
        const anyCompleted = taskIds.some(tid => tasks.get(tid)?.status === 'completed');
        batchJob.status = anyCompleted ? 'completed' : 'error';
      }
    }
  });

  res.json({ batchId, taskIds });
});

router.post('/api/tasks/:taskId/cancel', (req, res) => {
  const { taskId } = req.params;
  const task = tasks.get(taskId);
  if (!task) return res.status(404).json({ error: '找不到指定任务' });
  const cancelled = cancelTask(taskId, req.body?.reason || '任务已被用户取消');
  if (!cancelled) {
    return res.status(400).json({ error: `任务状态为 ${task.status}，无法取消` });
  }
  res.json({ success: true, message: '任务已成功取消', taskId });
});

router.post('/api/batch/:batchId/cancel', (req, res) => {
  const { batchId } = req.params;
  const batch = batchJobs.get(batchId);
  if (!batch) return res.status(404).json({ error: '找不到指定批量任务' });
  const cancelled = cancelBatchJob(batchId, req.body?.reason || '批量任务已被用户取消');
  if (!cancelled) {
    return res.status(400).json({ error: `批量任务状态为 ${batch.status}，无法取消` });
  }
  res.json({ success: true, message: '批量任务已成功取消', batchId });
});

router.get('/api/batch/:batchId', (req, res) => {
  const batch = batchJobs.get(req.params.batchId);
  if (!batch) return res.status(404).json({ error: 'Batch job not found' });
  const subTasks = batch.taskIds.map(tid => tasks.get(tid)).filter(Boolean);
  res.json({
    id: batch.id,
    status: batch.status,
    currentTaskIndex: batch.currentTaskIndex,
    totalTasks: batch.totalTasks,
    tasks: subTasks
  });
});

router.get('/api/progress/:taskId', (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

module.exports = router;
