const fs = require('fs');
const path = require('path');
const os = require('os');
const { tasks } = require('../store/tasks');
const { noteGenerationActivity } = require('../comfy/idleRelease');
const {
  COMFY_TEMP_INPUT_DIR, COMFY_TEMP_OUTPUT_DIR, COMFY_OUTPUT_DIR,
  COMFY_REMOTE, WORKFLOWS_DIR
} = require('../paths');
const { computeTaskPrompts } = require('../prompts/computeTaskPrompts');
const { stripTextboxNoise } = require('../prompts/textbox');
const { runStage1 } = require('./stage1Still');
const { runStage2 } = require('./stage2Video');

// Main async generation execution: prompt computation → Stage 1 (still) → Stage 2 (video).
async function runGenerationJob(taskId, { signal } = {}) {
  const task = tasks.get(taskId);
  if (!task) return;
  if (task.status === 'cancelled' || (signal && signal.aborted)) {
    task.status = 'cancelled';
    task.message = '任务已被用户取消';
    return;
  }

  const kreaWfPath = path.join(WORKFLOWS_DIR, 'krea2_outfit_transfer.json');
  const h3WfPath = path.join(WORKFLOWS_DIR, 'fashion_streetwear_10s_extend.json');

  if (task.still_engine !== 'gpt_image_2' && !fs.existsSync(kreaWfPath)) {
    throw new Error('Required Krea-2 workflow JSON template not found on server.');
  }
  if (task.mode !== 'still_only' && !fs.existsSync(h3WfPath)) {
    throw new Error('Required MiniMax H3 workflow JSON template not found on server.');
  }
  const h3HdWfPath = path.join(WORKFLOWS_DIR, 'fashion_streetwear_10s_extend_hd.json');
  if (task.enhance && task.mode !== 'still_only' && !fs.existsSync(h3HdWfPath)) {
    throw new Error('超清增强工作流模板缺失: fashion_streetwear_10s_extend_hd.json');
  }

  const cleanCustomScene = stripTextboxNoise(task.custom_scene);
  const autoPrompts = computeTaskPrompts({
    scene: task.scene.id,
    gender: task.gender,
    model_style: task.model_style,
    model_style_prompt: task.model_style_prompt,
    custom_scene: task.custom_scene,
    custom_prompt: task.custom_prompt,
    model_image: task.model_image,
    scene_image: task.scene_image,
    action1: task.action1,
    action2: task.action2,
    hair_style: task.hair_style,
    face_shape: task.face_shape,
    model_age: task.model_age
  });

  const finalKreaPrompt = (task.custom_krea_prompt && task.custom_krea_prompt.trim()) || autoPrompts.krea_prompt;
  const finalSeg1Prompt = (task.custom_seg1_prompt && task.custom_seg1_prompt.trim()) || autoPrompts.seg1_prompt;
  const finalSeg2Prompt = (task.custom_seg2_prompt && task.custom_seg2_prompt.trim()) || autoPrompts.seg2_prompt;

  const sceneDisplayName = task.scene.id === 'custom'
    ? (cleanCustomScene ? `自定义场景: ${cleanCustomScene.slice(0, 16)}` : '自定义专属场景')
    : task.scene.name;

  // File paths to track for reliable cleanup. Remote mode: conform to a local
  // temp file first, then upload it to the remote ComfyUI input tree.
  const stagedH3Name = `staged_${taskId}.png`;
  const dstStagedH3Path = COMFY_REMOTE
    ? path.join(os.tmpdir(), `fashion_${stagedH3Name}`)
    : path.join(COMFY_TEMP_INPUT_DIR, stagedH3Name);

  try {
    // STAGE 1: reference still image (Krea-2 / GPT Image 2 / reused still photo)
    const { stillResult, canvas, stillOnly } = await runStage1(task, taskId, finalKreaPrompt, sceneDisplayName, { signal });

    // Stage 1 only mode early exit
    if (stillOnly) {
      // 超清增强只作用于视频生成——定妆照模式下明确告知，避免静默失效
      if (task.enhance) {
        task.message = '定妆照生成完成。（超清增强仅对 10 秒视频生成生效，本次未应用）';
      }
      return;
    }

    if (task.status === 'cancelled' || (signal && signal.aborted)) {
      task.status = 'cancelled';
      task.message = '任务已被用户取消';
      return;
    }

    // STAGE 2: MiniMax H3 10-second extension
    await runStage2(task, taskId, canvas, stillResult, {
      finalSeg1Prompt,
      finalSeg2Prompt,
      autoPrompts,
      stagedH3Name,
      dstStagedH3Path,
      signal
    });
  } catch (err) {
    if (task.status === 'cancelled' || (signal && signal.aborted)) {
      task.status = 'cancelled';
      task.message = '任务已被用户取消';
      return;
    }
    throw err;
  } finally {
    // Start the idle timer only after the final ComfyUI workflow has settled.
    noteGenerationActivity();

    // Thorough cleanup: Ensure NO temporary files are left behind inside ComfyUI directories.
    // Note: only dstStagedH3Path is a real variable — the taskId-scan below covers
    // every other file this task produced in the temp/output directories.
    try {
      if (dstStagedH3Path && fs.existsSync(dstStagedH3Path)) fs.unlinkSync(dstStagedH3Path);
      // Scan temp dir AND output root — all files this task produced carry the taskId.
      // Remote mode: the files live on the ComfyUI host and there is no delete API.
      if (!COMFY_REMOTE) {
        for (const outDir of [COMFY_TEMP_OUTPUT_DIR, COMFY_OUTPUT_DIR]) {
          if (!fs.existsSync(outDir)) continue;
          const remaining = fs.readdirSync(outDir).filter(f => f.includes(taskId));
          for (const f of remaining) {
            try {
              fs.unlinkSync(path.join(outDir, f));
            } catch(e) {}
          }
        }
      }
    } catch(e) {
      console.warn('Temp cleanup warning:', e.message);
    }
  }
}

module.exports = { runGenerationJob };