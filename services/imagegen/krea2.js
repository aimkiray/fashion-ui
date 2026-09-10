const fs = require('fs');
const path = require('path');
const { uploadToComfyInput, downloadFromComfy } = require('./../comfyFiles');

function nextNodeId(wf) {
  const ids = Object.keys(wf).map(Number).filter(n => !isNaN(n) && n > 0);
  return String(Math.max(0, ...ids) + 1);
}

/**
 * Generate Still Reference Image using local ComfyUI Krea-2 workflow
 */
async function generateKrea2({
  task,
  taskId,
  prompt,
  signal,
  projectInputDir,
  projectImageDir,
  comfyTempInputDir,
  comfyOutputDir,
  comfyRemote,
  comfyUrl,
  workflowsDir,
  aspectCanvas,
  randomSeed,
  detectFlatlayScore,
  requireNodes,
  submitComfyWorkflow,
  onProgress
}) {
  if (signal && signal.aborted) throw new Error('任务已被用户取消');

  const kreaWfPath = path.join(workflowsDir, 'krea2_outfit_transfer.json');
  if (!fs.existsSync(kreaWfPath)) {
    throw new Error('找不到 Krea-2 工作流模板文件 krea2_outfit_transfer.json');
  }

  const tempInputFile = `temp_in_${taskId}_${path.basename(task.image)}`;
  const srcInputPath = path.join(projectInputDir, task.image);
  const dstTempInputPath = path.join(comfyTempInputDir, tempInputFile);
  // Remote mode stages via the ComfyUI HTTP API; the workflow reference is
  // the same `online_temp/<name>` form in both modes.
  let stagedInputRef = `online_temp/${tempInputFile}`;

  if (!fs.existsSync(srcInputPath)) {
    throw new Error(`找不到上传的原始服装图片: ${task.image}`);
  }
  if (comfyRemote) {
    const up = await uploadToComfyInput(srcInputPath, { comfyUrl });
    stagedInputRef = `online_temp/${up.name}`;
  } else {
    fs.copyFileSync(srcInputPath, dstTempInputPath);
  }

  let dstTempModelPath = null;
  let dstTempScenePath = null;
  const tempModelFile = task.model_image ? `temp_model_${taskId}_${path.basename(task.model_image)}` : null;
  const tempSceneFile = task.scene_image ? `temp_scene_${taskId}_${path.basename(task.scene_image)}` : null;

  try {
    const garmentAnalysis = await detectFlatlayScore(srcInputPath);
    const isFlatlay = garmentAnalysis.flatlay_score >= 0.65;
    const garmentRefBoost = isFlatlay ? 0.94 : 0.96;
    if (garmentAnalysis.flatlay_score > 0) {
      console.log(`[krea2] garment flat-lay score ${garmentAnalysis.flatlay_score}, ref_boost=${garmentRefBoost}`);
    }

    const kreaWf = JSON.parse(fs.readFileSync(kreaWfPath, 'utf-8'));
    requireNodes(kreaWf, 'Krea-2', ['3', '5', '7', '8', '9', '11', '13']);
    kreaWf['5']['inputs']['image'] = stagedInputRef;
    kreaWf['9']['inputs']['prompt'] = prompt;

    if (kreaWf['9']) {
      kreaWf['9']['inputs']['system_prompt'] = task.model_image
        ? 'Describe the first reference image focusing on garment silhouette, fabric weave, and seam construction; describe the second reference image focusing on exact facial identity, hairstyle, and natural skin texture with visible pores and fine lines.'
        : task.scene_image
          ? 'Describe the first reference image focusing on the environmental setting, realistic lighting, and spatial relationships; describe the second reference image focusing on garment silhouette, fabric weave, and seam construction.'
          : 'Describe the reference image focusing on garment silhouette, fabric weave, seam construction, garment boundaries, and realistic fabric texture.';
    }
    if (kreaWf['4']) {
      kreaWf['4']['inputs']['strength_model'] = 0.92;
    }
    if (kreaWf['8']) {
      kreaWf['8']['inputs']['ref_boost'] = garmentRefBoost;
    }
    if (kreaWf['9']) {
      kreaWf['9']['inputs']['grounding_px'] = 768;
    }
    if (kreaWf['10']) {
      kreaWf['10']['inputs']['prompt'] = '';
      kreaWf['10']['inputs']['grounding_px'] = 768;
    }
    if (kreaWf['11']) {
      kreaWf['11']['inputs']['steps'] = 10;
      kreaWf['11']['inputs']['sampler_name'] = 'dpmpp_2m';
      kreaWf['11']['inputs']['scheduler'] = 'sgm_uniform';
    }

    // Film grain injection
    const grainCandidate = Object.entries(kreaWf).find(([, n]) => n && n.class_type === 'ImageAddNoise');
    let grainId = grainCandidate ? grainCandidate[0] : null;
    if (!grainId) {
      const decodeId = Object.entries(kreaWf).find(([, n]) => n && n.class_type === 'VAEDecode')?.[0];
      const saveEntry = Object.entries(kreaWf).find(([, n]) => n && n.class_type === 'SaveImage');
      if (decodeId && saveEntry) {
        grainId = nextNodeId(kreaWf);
        kreaWf[grainId] = {
          class_type: 'ImageAddNoise',
          inputs: { image: [decodeId, 0], seed: randomSeed(), strength: 0.02 }
        };
        saveEntry[1].inputs.images = [grainId, 0];
      }
    }
    if (grainId && kreaWf[grainId]) {
      kreaWf[grainId].inputs.seed = randomSeed();
      kreaWf[grainId].inputs.strength = 0.02;
    }

    // Dynamic Model Identity Injection (Dual Reference)
    if (task.model_image) {
      const srcModelPath = path.join(projectInputDir, task.model_image);
      if (fs.existsSync(srcModelPath)) {
        if (comfyRemote) {
          const up = await uploadToComfyInput(srcModelPath, { comfyUrl });
          kreaWf['20'] = {
            class_type: 'LoadImage',
            inputs: { image: `online_temp/${up.name}` }
          };
        } else {
          dstTempModelPath = path.join(comfyTempInputDir, tempModelFile);
          fs.copyFileSync(srcModelPath, dstTempModelPath);
          kreaWf['20'] = {
            class_type: 'LoadImage',
            inputs: { image: `online_temp/${tempModelFile}` }
          };
        }
        kreaWf['21'] = {
          class_type: 'VAEEncode',
          inputs: { pixels: ['20', 0], vae: ['3', 0] }
        };

        kreaWf['8']['inputs']['source_latent_b'] = ['21', 0];
        kreaWf['8']['inputs']['source_image_b'] = ['20', 0];
        kreaWf['8']['inputs']['ref_boost'] = 1.0;
        kreaWf['8']['inputs']['ref_boost_a'] = garmentRefBoost;

        kreaWf['9']['inputs']['image_b'] = ['20', 0];
        if (kreaWf['10']) {
          kreaWf['10']['inputs']['image_b'] = ['20', 0];
        }
        kreaWf['9']['inputs']['prompt'] = prompt;
      }
    } else if (task.scene_image) {
      const srcScenePath = path.join(projectInputDir, task.scene_image);
      if (fs.existsSync(srcScenePath)) {
        if (comfyRemote) {
          const up = await uploadToComfyInput(srcScenePath, { comfyUrl });
          kreaWf['5']['inputs']['image'] = `online_temp/${up.name}`;
        } else {
          dstTempScenePath = path.join(comfyTempInputDir, tempSceneFile);
          fs.copyFileSync(srcScenePath, dstTempScenePath);
          kreaWf['5']['inputs']['image'] = `online_temp/${tempSceneFile}`;
        }
        kreaWf['20'] = {
          class_type: 'LoadImage',
          inputs: { image: stagedInputRef }
        };
        kreaWf['21'] = {
          class_type: 'VAEEncode',
          inputs: { pixels: ['20', 0], vae: ['3', 0] }
        };
        kreaWf['8']['inputs']['source_latent_b'] = ['21', 0];
        kreaWf['8']['inputs']['source_image_b'] = ['20', 0];
        kreaWf['8']['inputs']['ref_boost'] = garmentRefBoost;
        kreaWf['8']['inputs']['ref_boost_a'] = 1.0;

        kreaWf['9']['inputs']['image_b'] = ['20', 0];
        if (kreaWf['10']) {
          kreaWf['10']['inputs']['image_b'] = ['20', 0];
        }
        kreaWf['9']['inputs']['prompt'] = prompt;
      }
    }
    kreaWf['11']['inputs']['seed'] = randomSeed();

    const canvas = aspectCanvas[task.aspect_ratio] || aspectCanvas['3:4'];
    kreaWf['7']['inputs']['width'] = canvas.width;
    kreaWf['7']['inputs']['height'] = canvas.height;

    const kreaPrefix = `online_temp/krea_${task.scene.id || 'scene'}_${taskId}`;
    kreaWf['13']['inputs']['filename_prefix'] = kreaPrefix;

    const kreaRes = await submitComfyWorkflow(kreaWf, (ev) => {
      if (ev.type === 'sampling' && typeof onProgress === 'function') {
        const progressVal = Math.min(38, Math.round(10 + (ev.value / ev.max) * 28));
        onProgress(progressVal, `[阶段一] 试衣照渲染中 (${ev.value}/${ev.max} 步)...`);
      }
    });

    const kreaOutImgs = kreaRes.outputs && kreaRes.outputs['13'] && kreaRes.outputs['13'].images;
    if (!kreaOutImgs || kreaOutImgs.length === 0) {
      throw new Error('Krea-2 试衣生成失败，未产生有效图片输出。');
    }

    const stillRawFilename = kreaOutImgs[0].filename;
    const stillSubfolder = kreaOutImgs[0].subfolder || '';
    const savedStillName = `krea_${task.scene.id || 'scene'}_${taskId}.png`;
    const destStillPath = path.join(projectImageDir, savedStillName);
    if (comfyRemote) {
      await downloadFromComfy({ filename: stillRawFilename, subfolder: stillSubfolder, type: 'output' }, destStillPath, comfyUrl);
    } else {
      const srcStillPath = path.join(comfyOutputDir, stillSubfolder, stillRawFilename);
      fs.copyFileSync(srcStillPath, destStillPath);
      try {
        if (fs.existsSync(srcStillPath)) fs.unlinkSync(srcStillPath);
      } catch (e) {}
    }

    if (!fs.existsSync(destStillPath) || fs.statSync(destStillPath).size < 512) {
      try { if (fs.existsSync(destStillPath)) fs.unlinkSync(destStillPath); } catch (e) {}
      throw new Error('Krea-2 试衣生成失败，导出的图像文件无效或损坏。');
    }

    if (typeof onProgress === 'function') {
      onProgress(40, '阶段一完成，定妆照已生成。');
    }

    return {
      filename: savedStillName,
      destPath: destStillPath,
      webUrl: `/outputs/images/${savedStillName}`
    };
  } finally {
    // Clean up temporary files. In remote mode the staged files live inside
    // the ComfyUI installation on another machine and ComfyUI has no delete
    // API — they are left there (online_temp) instead of being unlinked.
    if (!comfyRemote) {
      try {
        if (fs.existsSync(dstTempInputPath)) fs.unlinkSync(dstTempInputPath);
        if (dstTempModelPath && fs.existsSync(dstTempModelPath)) fs.unlinkSync(dstTempModelPath);
        if (dstTempScenePath && fs.existsSync(dstTempScenePath)) fs.unlinkSync(dstTempScenePath);
      } catch (e) {}
    }
  }
}

module.exports = {
  generateKrea2
};
