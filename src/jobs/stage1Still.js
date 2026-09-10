const fs = require("fs");
const path = require("path");
const { generateReferenceImage } = require("../../services/imagegen");
const { ASPECT_CANVAS, PROJECT_INPUT_DIR, PROJECT_IMAGE_DIR, COMFY_TEMP_INPUT_DIR,
  COMFY_OUTPUT_DIR, COMFY_REMOTE, COMFY_URL, WORKFLOWS_DIR, randomSeed } = require("../paths");
const { readImageDims, nearestCanvasKey } = require("../images/canvas");
const { detectFlatlayScore } = require("../images/flatlay");
const { requireNodes } = require("../comfy/nodes");
const { submitComfyWorkflowWithProgress } = require("../comfy/client");
const { MODEL_STYLES } = require("../prompt-catalog/modelStyles");
const { MODEL_AGES } = require("../prompt-catalog/modelAges");
const { HAIRSTYLES } = require("../prompt-catalog/hairstyles");
const { FACE_SHAPES } = require("../prompt-catalog/faceShapes");

// STAGE 1: Reference Still Image Generation (~20s)
// Supports Krea-2 (ComfyUI) or GPT Image 2 (OpenAI), or reuses an existing still.
// Returns { stillResult, canvas, stillOnly } — canvas may be re-derived from the still.
async function runStage1(task, taskId, finalKreaPrompt, sceneDisplayName, { signal } = {}) {
  if (signal && signal.aborted) throw new Error('任务已被用户取消');
  let canvas = ASPECT_CANVAS[task.aspect_ratio] || ASPECT_CANVAS['3:4'];
  task.status = 'running';

  let stillResult;
  if (task.existing_still) {
    // Skip Stage 1 entirely: the user picked an existing still photo.
    const stillAbsPath = path.join(PROJECT_IMAGE_DIR, task.existing_still);
    if (!fs.existsSync(stillAbsPath)) {
      throw new Error(`找不到指定的定妆照: ${task.existing_still}`);
    }
    // Derive the video canvas from the still's real aspect ratio so the
    // H3 workflow matches the image instead of the UI's stale selection.
    const dims = readImageDims(stillAbsPath);
    const derivedKey = dims ? nearestCanvasKey(dims.w, dims.h) : null;
    if (derivedKey && ASPECT_CANVAS[derivedKey]) {
      canvas = ASPECT_CANVAS[derivedKey];
    }
    task.stillImage = `/outputs/images/${task.existing_still}`;
    stillResult = { destPath: stillAbsPath, webUrl: task.stillImage, filename: task.existing_still };
    task.progress = 38;
    task.message = `使用现有定妆照，跳过阶段一，按 ${canvas.width}x${canvas.height} 画布进入视频阶段...`;
  } else {
    task.progress = 10;
    const engineLabel = task.still_engine === 'gpt_image_2' ? 'GPT Image 2' : 'Krea-2';
    const modelTag = task.model_image && task.scene_image
      ? ' · 指定模特主角 + 场景参考'
      : task.model_image
        ? ' · 指定模特主角'
        : ` · ${(MODEL_STYLES[task.model_style] || MODEL_STYLES.classic).name} · ${(MODEL_AGES[task.model_age] || MODEL_AGES.adult || MODEL_AGES.prime).name} · ${(HAIRSTYLES[task.hair_style] || HAIRSTYLES.natural).name} · ${(FACE_SHAPES[task.face_shape] || FACE_SHAPES.oval).name}`;
    task.message = `[阶段一] 正在生成模特试衣定妆照 (${sceneDisplayName}${modelTag} · ${engineLabel})...`;

    stillResult = await generateReferenceImage({
      engine: task.still_engine || 'krea2',
      task,
      taskId,
      prompt: finalKreaPrompt,
      signal,
      onProgress: (progress, message) => {
        task.progress = progress;
        task.message = message;
      },
      context: {
        projectInputDir: PROJECT_INPUT_DIR,
        projectImageDir: PROJECT_IMAGE_DIR,
        comfyTempInputDir: COMFY_TEMP_INPUT_DIR,
        comfyOutputDir: COMFY_OUTPUT_DIR,
        comfyRemote: COMFY_REMOTE,
        comfyUrl: COMFY_URL,
        workflowsDir: WORKFLOWS_DIR,
        aspectCanvas: ASPECT_CANVAS,
        randomSeed,
        detectFlatlayScore,
        requireNodes,
        submitComfyWorkflow: (wf, onProgress) => submitComfyWorkflowWithProgress(wf, onProgress, { signal })
      }
    });

    task.stillImage = stillResult.webUrl;
  }
  task.progress = 40;
  // existing_still 已在 38% 阶段给出"进入视频阶段"的详细说明，避免重复文案
  if (!task.existing_still) task.message = '阶段一完成，定妆照已生成。';

  // Stage 1 only mode early exit
  if (task.mode === 'still_only') {
    task.status = 'completed';
    task.progress = 100;
    task.message = '试衣定妆照生成完成。';
    return { stillResult, canvas, stillOnly: true };
  }

  return { stillResult, canvas };
}

module.exports = { runStage1 };