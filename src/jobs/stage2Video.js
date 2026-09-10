const fs = require("fs");
const path = require("path");
const { COMFY_OUTPUT_DIR, COMFY_TEMP_OUTPUT_DIR, COMFY_REMOTE, COMFY_URL, PROJECT_VIDEO_DIR, WORKFLOWS_DIR, randomSeed } = require("../paths");
const { conformImageToCanvas } = require("../images/conform");
const { requireNodes } = require("../comfy/nodes");
const { getFrameInterpModel } = require("../comfy/interp");
const { submitComfyWorkflowWithProgress } = require("../comfy/client");
const { uploadToComfyInput, downloadFromComfy, comfyViewExists } = require("../../services/comfyFiles");
const { H3_ACTIONS } = require("../prompt-catalog/h3Actions");

// STAGE 2: MiniMax H3 10-Second Extension (~180s)
// Renders the two 5s segments from the staged first frame and exports the final video.
async function runStage2(task, taskId, canvas, stillResult, { finalSeg1Prompt, finalSeg2Prompt, autoPrompts, stagedH3Name, dstStagedH3Path, signal }) {
      if (signal && signal.aborted) throw new Error('任务已被用户取消');
      task.progress = 45;
      const enhance = !!task.enhance;
      const stageTag = enhance ? '阶段二·超清增强' : '阶段二';
      const seg1ActionName = (H3_ACTIONS[autoPrompts.actions?.seg1] || {}).name || '迎面走姿';
      const seg2ActionName = (H3_ACTIONS[autoPrompts.actions?.seg2] || {}).name || '定点造型';
      const segActionNames = `${seg1ActionName} → ${seg2ActionName}`;
      task.message = `[${stageTag}] 正在加载 MiniMax H3 视频模型，分镜动作：${segActionNames}...`;

      // Stage still image into ComfyUI temp input for MiniMax H3 (conforming dimensions if necessary)
      const h3WfPath = path.join(WORKFLOWS_DIR, enhance ? 'fashion_streetwear_10s_extend_hd.json' : 'fashion_streetwear_10s_extend.json');
      let stagedImageRef = `online_temp/${stagedH3Name}`;
      await conformImageToCanvas(stillResult.destPath, dstStagedH3Path, canvas.width, canvas.height);
      if (COMFY_REMOTE) {
        const up = await uploadToComfyInput(dstStagedH3Path, { comfyUrl: COMFY_URL });
        stagedImageRef = `online_temp/${up.name}`;
      }

      const h3Wf = JSON.parse(fs.readFileSync(h3WfPath, 'utf-8'));

      // ── 超清增强分支 (task.enhance) ──
      // HD 模板按 javawock7618 参考实践接线：两段采样器的 denoised_output 先经
      // LTXVSeparateAVLatent 拆分（H3 采样器输出的是 NestedTensor 音视频联合潜空间，
      // 直接送 Upscaler 会崩溃），视频分量经 MinimaxH3LatentUpscaler3D (scale 1.5,
      // align 32) 潜空间放大后与音频分量 LTXVConcatAVLatent 拼回，再 VAEDecode 输出
      // 1080p 级帧 (102/103)。基础分辨率解码 (70) 保留，专供分镜二 guide/extend 条
      // 件与帧数/音频裁剪数学。
      // RIFE 插帧分支 (110/111) 仅在远端装有插帧模型时启用 (24fps → 48fps)；
      // 未安装时删除该分支并回退 1080p/24fps，同时告知用户。
      let requiredNodes = ['1', '40', '41', '80', '81', '84'];
      let segLabel = '阶段二';
      let useInterp = false;
      let interpModelName = null;
      // 插帧默认关闭：javawock7618 原仓库全部成品工作流均为 24fps 输出、不含任何
      // RIFE/FrameInterpolate 节点。实测 RIFE 在 H3 turbo 采样的 24fps 内容上会
      // 产生"慢动作/漂移感"（时长不变但运动被平滑稀释），故仅在显式
      // ENHANCE_INTERP=1 时启用。需要 60fps 交付可用历史卡片的 FFmpeg 后制增强。
      const interpOptIn = process.env.ENHANCE_INTERP === '1';
      if (enhance) {
        requiredNodes = [...requiredNodes, '100', '101', '102', '103', '104', '105', '106', '107'];
        if (interpOptIn) {
          interpModelName = await getFrameInterpModel({ signal });
          // 模板同时缺 110/111 时视为不可插帧（requireNodes 尚未执行，先防御避免
          // "Cannot set properties of undefined" 掩盖真实缺节点错误）
          if (interpModelName && h3Wf['110'] && h3Wf['111']) {
            useInterp = true;
            requiredNodes.push('110', '111');
            segLabel = '阶段二·超清增强 1080p·48fps';
          } else {
            segLabel = '阶段二·超清增强 1080p';
            task.message = '[阶段二·超清增强] ENHANCE_INTERP=1 但远端 ComfyUI 未安装 RIFE 插帧模型，本次输出 1080p/24fps...';
          }
        } else {
          segLabel = '阶段二·超清增强 1080p';
        }
      }

      // NOTE(1080p Latent Upscaler): 修复预留说明——
      // 白名单为 fail-fast 守卫，ID 必须已存在于 workflow JSON 中，否则提交
      // 工作流会立刻抛错。Upscaler 节点 ID 已规划为 '100'/'101'（HD 模板）。
      requireNodes(h3Wf, 'MiniMax H3', requiredNodes);

      // Interp branch patching only after requireNodes validated the template
      if (useInterp) {
        h3Wf['110'].inputs.model_name = interpModelName;
        h3Wf['80'].inputs.images = ['111', 0];
        h3Wf['80'].inputs.frame_rate = 48;
      } else if (enhance) {
        delete h3Wf['110'];
        delete h3Wf['111'];
        h3Wf['80'].inputs.images = ['89', 2];
        h3Wf['80'].inputs.frame_rate = 24;
      }
      h3Wf['1']['inputs']['image'] = stagedImageRef;

      // ⚠️ 1080p Latent Upscaler 接入约束（严禁改动此逻辑的数值语义）：
      // Node 40 / 81 是 MiniMaxH3ImageToVideo，其 width/height 应保持与 Stage 1
      // 相同的 canvas 尺寸（采样分辨率由 Node 2 ResolutionSelector 的 0.86MP 决定）。
      // 接入 Latent Upscaler 后，放大只发生在 Upscaler 节点的潜空间（VAEDecode 之前），
      // 这里严禁直接写入 1080p 原生宽高，否则会导致 OOM。
      h3Wf['40']['inputs']['width'] = canvas.width;
      h3Wf['40']['inputs']['height'] = canvas.height;
      h3Wf['81']['inputs']['width'] = canvas.width;
      h3Wf['81']['inputs']['height'] = canvas.height;

      h3Wf['41']['inputs']['noise_seed'] = randomSeed();
      h3Wf['84']['inputs']['noise_seed'] = randomSeed();

      h3Wf['40']['inputs']['prompt'] = finalSeg1Prompt;
      h3Wf['81']['inputs']['prompt'] = finalSeg2Prompt;

      const videoPrefix = `online_temp/outfit_${task.scene.id}_10s_${taskId}${enhance ? '_hd' : ''}`;
      h3Wf['80']['inputs']['filename_prefix'] = videoPrefix;

      // Delete redundant Node 96 (debug video combine) so ComfyUI doesn't waste time encoding a duplicate 5s video
      // (the HD template removes it at the template level; this is a no-op there)
      delete h3Wf['96'];

      // Real-time progress tracking through WebSocket node events
      const h3Res = await submitComfyWorkflowWithProgress(h3Wf, (ev) => {
        if (ev.type === 'sampling') {
          // Node 53 is segment 1 (8 steps); Node 86 is segment 2 (8 steps)
          if (ev.node === '53') {
            task.progress = Math.min(68, Math.round(45 + (ev.value / ev.max) * 23));
            task.message = `[${segLabel}] 分镜一渲染中：${seg1ActionName} (采样 ${ev.value}/${ev.max})...`;
          } else if (ev.node === '86') {
            task.progress = Math.min(92, Math.round(70 + (ev.value / ev.max) * 22));
            task.message = `[${segLabel}] 分镜二渲染中：${seg2ActionName} (采样 ${ev.value}/${ev.max})...`;
          }
        } else if (ev.type === 'node_change') {
          // 超清增强时 100/101（潜空间放大，耗时大头）与 111（RIFE 插帧）
          // 执行期间也要有真实的进度反馈，不能卡在采样完成文案上
          if (enhance && (ev.node === '100' || ev.node === '104' || ev.node === '106')) {
            task.progress = Math.max(task.progress, 68);
            task.message = `[${segLabel}] 分镜一潜空间放大中 (3D Latent Upscale 1.5x)...`;
          } else if (enhance && (ev.node === '101' || ev.node === '105' || ev.node === '107')) {
            task.progress = Math.max(task.progress, 92);
            task.message = `[${segLabel}] 分镜二潜空间放大中 (3D Latent Upscale 1.5x)...`;
          } else if (enhance && ev.node === '111') {
            task.progress = 95;
            task.message = `[${segLabel}] RIFE 高帧率插帧中 (24fps → 48fps)...`;
          } else if (ev.node === '89' || ev.node === '80') {
            task.progress = 95;
            task.message = `[${segLabel}] 分镜拼接与混音导出中...`;
          }
        }
      }, { signal, timeoutMs: enhance ? 60 * 60 * 1000 : undefined });

      // Retrieve final video from ComfyUI temp output
      let finalVideoFilename = null;
      let finalVideoSubfolder = '';
      if (h3Res.outputs && h3Res.outputs['80']) {
        const vhsOut = h3Res.outputs['80'];
        const vList = vhsOut.gifs || vhsOut.videos || [];
        if (vList.length > 0 && vList[0].filename) {
          finalVideoFilename = vList[0].filename;
          finalVideoSubfolder = vList[0].subfolder || '';
        }
      }

      // Fallback when history did not report the output file (VHS may finalize
      // the mp4 slightly after the prompt completes). Local mode scans the
      // ComfyUI output dir; remote mode polls /view for the expected names.
      if (!finalVideoFilename) {
        const searchPrefix = `outfit_${task.scene.id}_10s_${taskId}${enhance ? '_hd' : ''}`;
        for (let retry = 0; retry < 50; retry++) {
          if (signal && signal.aborted) throw new Error('任务已被用户取消');
          if (COMFY_REMOTE) {
            const candidates = [
              `${searchPrefix}-audio.mp4`,
              `${searchPrefix}_00001-audio.mp4`,
              `${searchPrefix}.mp4`,
              `${searchPrefix}_00001.mp4`
            ].map(f => ({ filename: f, subfolder: 'online_temp', type: 'output' }));
            for (const cand of candidates) {
              if (await comfyViewExists(cand, COMFY_URL)) {
                finalVideoFilename = cand.filename;
                finalVideoSubfolder = 'online_temp';
                break;
              }
            }
          } else if (fs.existsSync(COMFY_TEMP_OUTPUT_DIR)) {
            const outFiles = fs.readdirSync(COMFY_TEMP_OUTPUT_DIR).filter(f => f.startsWith(searchPrefix));
            const audioMp4 = outFiles.find(f => f.endsWith('-audio.mp4'));
            const plainMp4 = outFiles.find(f => f.endsWith('.mp4'));
            if (audioMp4 || plainMp4) {
              finalVideoFilename = audioMp4 || plainMp4;
              finalVideoSubfolder = 'online_temp';
              break;
            }
          }
          if (finalVideoFilename) break;
          await new Promise(r => setTimeout(r, 600));
          if (signal && signal.aborted) throw new Error('任务已被用户取消');
        }
      }

      if (!finalVideoFilename) {
        throw new Error('MiniMax H3 视频文件生成超时或未正常保存。');
      }

      // Move / copy video and preview thumbnail to PROJECT_VIDEO_DIR (project storage)
      const dstVideoPath = path.join(PROJECT_VIDEO_DIR, finalVideoFilename);
      const previewName = finalVideoFilename.replace(/-audio\.mp4$|\.mp4$/, '.png');
      if (COMFY_REMOTE) {
        const srcRef = { filename: finalVideoFilename, subfolder: finalVideoSubfolder || 'online_temp', type: 'output' };
        await downloadFromComfy(srcRef, dstVideoPath, COMFY_URL);
        // Preview thumbnail is optional — tolerate its absence
        try {
          await downloadFromComfy({ ...srcRef, filename: previewName }, path.join(PROJECT_VIDEO_DIR, previewName), COMFY_URL);
        } catch (e) {}
      } else {
        const srcVideoPath = path.join(COMFY_OUTPUT_DIR, finalVideoSubfolder, finalVideoFilename);
        fs.copyFileSync(srcVideoPath, dstVideoPath);
        const srcPreviewPath = path.join(COMFY_OUTPUT_DIR, finalVideoSubfolder, previewName);
        if (fs.existsSync(srcPreviewPath)) {
          fs.copyFileSync(srcPreviewPath, path.join(PROJECT_VIDEO_DIR, previewName));
        }
      }

      if (!fs.existsSync(dstVideoPath) || fs.statSync(dstVideoPath).size < 1024) {
        try { if (fs.existsSync(dstVideoPath)) fs.unlinkSync(dstVideoPath); } catch (e) {}
        throw new Error('MiniMax H3 视频文件生成失败或已损坏。');
      }
      const previewFullPath = path.join(PROJECT_VIDEO_DIR, previewName);
      if (fs.existsSync(previewFullPath) && fs.statSync(previewFullPath).size < 512) {
        try { fs.unlinkSync(previewFullPath); } catch (e) {}
      }

      task.videoUrl = `/outputs/videos/${finalVideoFilename}`;
      task.status = 'completed';
      task.progress = 100;
      task.message = enhance ? '展示视频生成完成（1080p 超清增强）。' : '展示视频生成完成。';
}

module.exports = { runStage2 };
