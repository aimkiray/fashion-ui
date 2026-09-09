const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { randomUUID: uuidv4 } = require('crypto');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const COMFY_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const COMFY_WS_URL = COMFY_URL.replace(/^http/, 'ws');

// Backend ComfyUI Paths (for execution only)
const COMFY_DIR = path.resolve(process.env.COMFY_DIR || 'D:/Comfy/ComfyUI');
const COMFY_INPUT_DIR = path.join(COMFY_DIR, 'input');
const COMFY_OUTPUT_DIR = path.join(COMFY_DIR, 'output');
const LOCAL_WORKFLOWS_DIR = path.join(__dirname, 'workflows');
const WORKFLOWS_DIR = fs.existsSync(LOCAL_WORKFLOWS_DIR) ? LOCAL_WORKFLOWS_DIR : path.join(COMFY_DIR, 'user', 'workflows');

// Dedicated temporary folder inside ComfyUI to keep root input/output clean and separate
const COMFY_TEMP_INPUT_DIR = path.join(COMFY_INPUT_DIR, 'online_temp');
const COMFY_TEMP_OUTPUT_DIR = path.join(COMFY_OUTPUT_DIR, 'online_temp');

// Dedicated Project Storage Directories (Isolated inside this project directory!)
const PROJECT_DIR = __dirname;
const STORAGE_DIR = path.join(PROJECT_DIR, 'storage');
const PROJECT_INPUT_DIR = path.join(STORAGE_DIR, 'inputs');
const PROJECT_OUTPUT_DIR = path.join(STORAGE_DIR, 'outputs');
const PROJECT_VIDEO_DIR = path.join(PROJECT_OUTPUT_DIR, 'videos');
const PROJECT_IMAGE_DIR = path.join(PROJECT_OUTPUT_DIR, 'images');

// Ensure all isolated and temporary directories exist
[
  COMFY_TEMP_INPUT_DIR,
  COMFY_TEMP_OUTPUT_DIR,
  STORAGE_DIR,
  PROJECT_INPUT_DIR,
  PROJECT_OUTPUT_DIR,
  PROJECT_VIDEO_DIR,
  PROJECT_IMAGE_DIR
].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Single source of truth for the generation canvas shared by both stages.
// Stage 1 (EmptySD3LatentImage) and Stage 2 (MiniMax H3 latent) must produce the
// exact same width/height, otherwise MiniMaxH3ImageToVideo stretches the staged
// first frame to fill the latent canvas and distorts the model.
// Values mirror the workflow's ResolutionSelector output for 0.86 megapixels / multiple 32.
const ASPECT_CANVAS = {
  '3:4':  { width: 832,  height: 1088 },
  '9:16': { width: 704,  height: 1280 },
  '1:1':  { width: 960,  height: 960  }
};

// Fresh noise per task so re-running the same outfit+scene yields a new
// model/result instead of replaying the fixed seeds baked into the templates.
const randomSeed = () => Math.floor(Math.random() * 4294967296);

// Detect white-background flat-lay / mannequin product shots. These force the
// diffusion model to inherit the flat studio reflections and plastic mannequin
// texture if ref_boost is too high; loosen it automatically for those inputs.
function detectFlatlayScoreSync(imagePath) {
  const scriptPath = path.join(__dirname, 'detect_flatlay.py');
  if (!fs.existsSync(scriptPath) || !fs.existsSync(imagePath)) return { flatlay_score: 0 };
  try {
    const result = require('child_process').execFileSync(
      process.platform === 'win32' ? 'python' : 'python3',
      [scriptPath, imagePath],
      { encoding: 'utf-8', timeout: 3000, maxBuffer: 1 * 1024 * 1024 }
    );
    const parsed = JSON.parse(result.trim().split(/\r?\n/).pop());
    return typeof parsed.flatlay_score === 'number' ? parsed : { flatlay_score: 0 };
  } catch (err) {
    console.warn('Flat-lay detection skipped:', err.message);
    return { flatlay_score: 0 };
  }
}

// Fail fast with a clear error if the workflow templates drift from the node
// ids this server patches, instead of a cryptic TypeError mid-generation.
function requireNodes(wf, label, ids) {
  const missing = ids.filter(id => !wf || !wf[id] || !wf[id].inputs);
  if (missing.length) {
    throw new Error(`${label} workflow 模板与服务端不匹配，缺少节点: ${missing.join(', ')}`);
  }
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Static endpoints now point exclusively to the project's own storage!
app.use('/inputs', express.static(PROJECT_INPUT_DIR));
app.use('/outputs', express.static(PROJECT_OUTPUT_DIR));

// Configure multer for file uploads -> saves exclusively into PROJECT_INPUT_DIR
const fileFilter = (req, file, cb) => {
  const allowedExts = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('只支持上传 PNG, JPG, JPEG, WEBP, BMP 图片格式'));
  }
};
// Disambiguates same-name uploads that land in the same millisecond
let uploadSeq = 0;
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PROJECT_INPUT_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const prefix = req.query.type ? path.basename(String(req.query.type)) : 'upload';
    cb(null, `${prefix}_${Date.now()}_${(uploadSeq++).toString(36)}_${base}${ext}`);
  }
});
const upload = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024 } });

// Extension checks alone accept renamed non-images; verify magic bytes instead.
const IMAGE_MAGICS = [
  [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], // PNG
  [0xFF, 0xD8, 0xFF],                                 // JPEG
  [0x42, 0x4D]                                        // BMP
];
function looksLikeImage(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(12);
    const n = fs.readSync(fd, buf, 0, 12, 0);
    const head = buf.subarray(0, n);
    if (IMAGE_MAGICS.some(m => m.every((b, i) => head[i] === b))) return true;
    return n >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
  } finally {
    fs.closeSync(fd);
  }
}

// Scene Presets
// Model style presets — editorial presence with composed expression, natural skin and hair,
// gaze/face angle kept scene-specific to avoid conflicts (scenes own the eye-contact wording).
const MODEL_STYLES = {
  classic: {
    name: '高级名模',
    female: 'with poised editorial elegance, serene composed expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair, and effortless upright lookbook posture',
    male: 'with sharp defined jawline, editorial charisma, calm composed expression, naturally closed lips without tension, relaxed natural jawline, and upright natural posture'
  },
  sweet: {
    name: '甜美清新',
    female: 'with fresh-faced youthful purity, gentle genuine warmth in the eyes, soft natural undone hair, tranquil poise, naturally closed lips without tension, and a tender serene presence',
    male: 'with clean youthful Korean-style charm, gentle refined features, relaxed natural poise, naturally closed lips without tension, and calm subtle warmth'
  },
  athletic: {
    name: '运动活力',
    female: 'with a healthy athletic glow, tone-defined posture, calm focused expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair, and a confident grounded stance',
    male: 'with an athletic toned build, sharp defined facial structure, calm composed expression, naturally closed lips without tension, and an upright confident stance'
  },
  mature: {
    name: '成熟御姐',
    female: 'with sophisticated graceful poise, refined mature facial structure, warm knowing presence, naturally closed lips without tension, relaxed natural jawline, soft natural hair, and commanding serene posture',
    male: 'with distinguished mature charisma, sharp masculine features, calm composed expression, naturally closed lips without tension, and commanding executive posture'
  },
  cool: {
    name: '中性酷感',
    female: 'with chic androgynous edge, cool understated attitude, sharp bone structure, naturally closed lips without tension, relaxed natural jawline, and effortless lookbook poise',
    male: 'with contemporary streetwear edge, cool understated attitude, sharp jawline, naturally closed lips without tension, and effortless confident posture'
  }
};

// Scene-specific subject base + gender-aware style modifier.
function styledSubject(gender, style, femaleBase, maleBase, customStylePrompt = null) {
  const isM = gender === 'male';
  const base = isM ? maleBase : femaleBase;
  if (customStylePrompt && typeof customStylePrompt === 'string' && customStylePrompt.trim()) {
    const trimmed = customStylePrompt.trim();
    if (trimmed.startsWith(',') || trimmed.startsWith('with ')) {
      return `${base} ${trimmed}`;
    }
    return `${base}, ${trimmed}`;
  }
  const s = MODEL_STYLES[style] || MODEL_STYLES.classic;
  const modifier = isM ? s.male : s.female;
  return `${base} ${modifier}`;
}

// ---- H3 视频提示词骨架与场景配置 ----
// 从生活感样例提炼的结构规律（非逐字套用）：
//   身份锁定 → 秒级时间轴节拍 → 表情纪律（顺序分解+允许真实不完美+禁止项）
//   → 真实人体动态（惯性/缓急）→ 服装与手部连续性 → 镜头纪律
//   → 画面质感 → 去AI味黑名单 → 最终效果 → 音频。
// 场景差异只写进 H3_SCENE_CFG，骨架统一维护。
const H3_SCENE_CFG = {
  street: {
    title: '阳光都市街拍',
    lock: '服装与鞋履细节、街边建筑背景、自然日光、构图、镜头焦段和整体摄影质感',
    shot: '街拍摄影师跟拍',
    seg1: {
      beats: `0.00－1.50秒
模特从首帧的站姿自然起步，沿洒满阳光的人行道迎面走向镜头。
起步自然：重心先微微前移，第一步不要突然迈大。
她保持放松从容的状态，肩背舒展，眼神柔和地看向镜头。

1.50－3.80秒
她以稳定的节奏继续向前走，每秒约一步。
不要匀速机械行走，步伐之间有非常轻微的自然节奏差。
双臂在身体两侧自然摆动，手臂摆动与步伐自然交替。
鞋底稳稳踩实地面，每一步都有真实的落地与推进。

3.80－5.00秒
她走到离镜头较近的位置，微微放慢脚步，保持与镜头的柔和对视，全身始终完整在画面中。
不是突然停住，也不是机械匀速，接近镜头时动作自然减速。`,
      eye: '与镜头保持自然对视，头部带一点轻松的四分之三角度，眼神明亮而柔和。',
      camera: '与模特视线等高的稳定后撤跟拍：镜头随模特同步平稳后撤，保持全身构图完整。\n不要推镜，不要拉镜，不要摇镜，不要环绕，不要突然变焦。\n焦点稳定在模特的脸部和服装上，背景呈现真实柔和的街景虚化。\n不要焦点乱跳。',
      recap: '她迎面自然走来，步伐真实有惯性，眼神与镜头自然交流，服装与街景与首帧完全一致，像真实街拍摄影师随手记录的一段生活瞬间。',
      audio: '远处隐约的城市街道环境音，清晰有节奏的脚步声，衣物面料随步伐的轻微摆动声。'
    },
    seg2: {
      beats: `0.00－1.50秒
承接上一镜的行走，模特自然放慢脚步，平稳停下，双脚稳稳落地踩实。
停步不是急刹车，而是像真实走秀结束那样带着惯性缓缓收住。

1.50－3.20秒
她以重心脚为轴，自然连贯地完成一个约45度的转身。
转身时肩膀、腰部、腿部协同运动，重心转移真实，不要像机器人一样只旋转上半身。

3.20－5.00秒
转身后她稳定站定，展示服装的侧面与背面剪裁、面料垂感与缝线细节，随后自然回头看镜头，与镜头保持从容对视。`,
      eye: '转身站定后回头看镜头，眼神自然先有注视，再带出一点柔和的笑意，不要突然切换表情。',
      camera: '稳定的慢速横移：镜头以平稳慢速的横移拍摄转身过程，突出面料、缝线与剪裁细节。\n不要突然运镜，不要变焦，不要环绕。\n焦点始终稳定在模特身上。',
      recap: '她平稳停步、自然完成45度转身，服装细节清晰稳定，随后回头与镜头从容对视，整个动作一气呵成、真实自然。',
      audio: '连续的城市街道环境音，鞋底在人行道上的轻轻转身摩擦声，衣物随转身的轻微摆动声。'
    }
  },
  studio: {
    title: '极简纯色影棚',
    lock: '服装与鞋履细节、纯色无影墙背景、柔光箱光线、构图、镜头焦段和整体摄影质感',
    shot: '影棚摄影师掌机记录',
    seg1: {
      beats: `0.00－1.50秒
模特从首帧的站姿自然起步，在影棚地面上迎面走向镜头。
起步自然：重心先微微前移，第一步不要突然迈大。
她保持放松从容的状态，肩背舒展，下颌微微收低，眼神柔和地抬起看向镜头。

1.50－3.80秒
她以稳定的节奏继续向前走，每秒约一步，步幅从容优雅。
不要匀速机械行走，步伐之间有非常轻微的自然节奏差。
双臂在身体两侧自然摆动，手臂摆动与步伐自然交替。

3.80－5.00秒
她走到离镜头较近的位置，微微放慢脚步，保持安静亲切的对视，全身始终完整在画面中。
接近镜头时动作自然减速，不要突然停住。`,
      eye: '下颌微微收低，眼神轻轻抬起与镜头对视，安静、亲切、有张力。',
      camera: '与模特视线等高的稳定后撤跟拍：镜头平稳后撤，保持全身构图完整。\n不要推镜，不要拉镜，不要摇镜，不要突然变焦。\n焦点稳定在模特的脸部和服装上，无影墙背景保持干净一致的柔光。',
      recap: '她在纯色影棚中迎面自然走来，步伐真实有惯性，安静亲切的眼神与镜头交流，服装与影棚背景与首帧完全一致。',
      audio: '安静的影棚房间底噪，轻柔有节奏的脚步声，衣料随步伐的细微摩擦声。'
    },
    seg2: {
      beats: `0.00－1.50秒
承接上一镜的行走，模特自然放慢脚步，平稳停下，双脚稳稳落地。
停步带着真实惯性，缓缓收住。

1.50－3.20秒
她以重心脚为轴，自然连贯地完成一个约45度的转身，展示服装的侧面剪裁、领口结构与背面做工。
转身时肩、腰、腿协同运动，重心转移真实。

3.20－5.00秒
转身后她稳定站定，展示面料垂感与缝线细节，随后抬眼回看镜头，保持安静从容的对视。`,
      eye: '转身站定后抬眼回看镜头，眼神安静从容，先有注视，再带一点柔和笑意。',
      camera: '稳定的慢速横移：平稳慢速横移拍摄转身过程，突出面料、缝线与剪裁细节。\n不要突然运镜，不要变焦。\n焦点始终稳定在模特身上。',
      recap: '她平稳停步、自然转身展示服装侧面与背面细节，随后抬眼与镜头从容对视，整个动作一气呵成。',
      audio: '安静的影棚房间底噪，鞋底轻轻的转身摩擦声，衣料随转身的细微摆动声。'
    }
  },
  office: {
    title: '摩天楼职场通勤',
    lock: '服装与鞋履细节、现代玻璃幕墙大堂背景、晨光、构图、镜头焦段和整体摄影质感',
    shot: '写字楼大堂内的跟拍',
    seg1: {
      beats: `0.00－1.50秒
模特从首帧的站姿自然起步，在大堂光洁的石面地面上迎面走向镜头。
起步自然：重心先微微前移，第一步不要突然迈大。
她保持干练从容的状态，肩背舒展，眼神以三分之二角度与镜头自然交流。

1.50－3.80秒
她以稳定的节奏继续向前走，每秒约一步，步幅干练利落。
不要匀速机械行走，步伐之间有非常轻微的自然节奏差。
双臂在身体两侧自然摆动，与步伐自然交替。

3.80－5.00秒
她走到离镜头较近的位置，微微放慢脚步，保持从容对视，全身始终完整在画面中。
接近镜头时动作自然减速，不要突然停住。`,
      eye: '以三分之二角度与镜头自然对视，眼神从容、自信、有职业感。',
      camera: '与模特视线等高的稳定后撤跟拍：镜头平稳后撤，保持全身构图完整。\n不要推镜，不要拉镜，不要摇镜，不要突然变焦。\n焦点稳定在模特的脸部和服装上，玻璃幕墙晨光背景保持一致。',
      recap: '她在晨光大堂中迎面自然走来，步伐真实有惯性，从容自信的眼神与镜头交流，服装与大堂背景与首帧完全一致。',
      audio: '开阔的大堂空间环境音，轻微的声学混响，石面地面上清晰有节奏的脚步声。'
    },
    seg2: {
      beats: `0.00－1.50秒
承接上一镜的行走，模特自然放慢脚步，平稳停下，双脚稳稳落地。
停步带着真实惯性，缓缓收住。

1.50－3.20秒
她以重心脚为轴，自然连贯地完成一个约45度的转身，展示套装的侧面剪裁、面料垂感与背面做工。
转身时肩、腰、腿协同运动，重心转移真实。

3.20－5.00秒
转身后她稳定站定，展示服装细节，随后以三分之二角度回看镜头，保持从容自信的对视。`,
      eye: '转身站定后以三分之二角度回看镜头，眼神从容自信，先有注视，再带一点柔和暖意。',
      camera: '稳定的慢速横移：平稳慢速横移拍摄转身过程，突出套装面料与剪裁细节。\n不要突然运镜，不要变焦。\n焦点始终稳定在模特身上。',
      recap: '她平稳停步、自然转身展示套装细节，随后回看镜头从容对视，整个动作干练流畅、真实自然。',
      audio: '安静通透的大堂氛围音，鞋底轻轻的转身摩擦声，衣物随转身的轻微摆动声。'
    }
  },
  boutique: {
    title: '高端艺术买手店',
    lock: '服装与鞋履细节、大理石与黄铜买手店背景、暖色射灯光线、构图、镜头焦段和整体摄影质感',
    shot: '买手店内的跟拍',
    seg1: {
      beats: `0.00－1.50秒
模特从首帧的站姿自然起步，在大理石地面上迎面走向镜头。
起步自然：重心先微微前移，第一步不要突然迈大。
她保持优雅从容的状态，肩背舒展，眼神微微上扬看向镜头。

1.50－3.80秒
她以稳定的节奏继续向前走，每秒约一步，步幅优雅轻盈。
不要匀速机械行走，步伐之间有非常轻微的自然节奏差。
双臂在身体两侧自然摆动，与步伐自然交替。

3.80－5.00秒
她走到离镜头较近的位置，微微放慢脚步，保持柔和的对视，全身始终完整在画面中。
接近镜头时动作自然减速，不要突然停住。`,
      eye: '眼神微微上扬，接住暖色射灯的反光，与镜头保持柔和明亮的对视。',
      camera: '与模特视线等高的稳定后撤跟拍：镜头平稳后撤，保持全身构图完整。\n不要推镜，不要拉镜，不要摇镜，不要突然变焦。\n焦点稳定在模特的脸部和服装上，射灯暖光在面料上的反光保持一致。',
      recap: '她在买手店暖光中迎面自然走来，步伐真实有惯性，柔和明亮的眼神与镜头交流，服装与店铺背景与首帧完全一致。',
      audio: '安静的精品店室内环境音，轻微的声学混响，鞋跟在大理石地面上清晰轻快的节奏声。'
    },
    seg2: {
      beats: `0.00－1.50秒
承接上一镜的行走，模特自然放慢脚步，平稳停下，双脚稳稳落地。
停步带着真实惯性，缓缓收住。

1.50－3.20秒
她以重心脚为轴，自然连贯地完成一个约45度的转身，展示服装的侧面剪裁、面料质感与背面做工。
转身时肩、腰、腿协同运动，重心转移真实。

3.20－5.00秒
转身后她稳定站定，展示面料与缝线细节，随后眼神微微上扬回看镜头，保持柔和明亮的对视。`,
      eye: '转身站定后回看镜头，眼神微微上扬接住射灯反光，柔和明亮，先有注视，再带一点轻盈笑意。',
      camera: '稳定的慢速横移：平稳慢速横移拍摄转身过程，突出面料质感与剪裁细节。\n不要突然运镜，不要变焦。\n焦点始终稳定在模特身上。',
      recap: '她平稳停步、自然转身展示服装细节，随后上扬眼神与镜头柔和对视，整个动作优雅流畅。',
      audio: '安静的精品店室内氛围音，鞋跟在大理石上的轻轻转身声，衣料随转身的细微摆动声。'
    }
  },
  outdoor: {
    title: '自然户外林荫',
    lock: '服装与鞋履细节、花园石板路背景、树荫光斑、构图、镜头焦段和整体摄影质感',
    shot: '花园里的跟拍',
    seg1: {
      beats: `0.00－1.50秒
模特从首帧的站姿自然起步，沿着石板小径迎面走向镜头。
起步自然：重心先微微前移，第一步不要突然迈大。
她保持松弛自然的状态，肩背舒展，行走中自然回头看镜头。

1.50－3.80秒
她以放松的节奏继续向前走，每秒约一步，步态轻盈自然。
不要匀速机械行走，步伐之间有非常轻微的自然节奏差。
双臂在身体两侧自然摆动，微风吹动发丝和衣摆，动作与环境真实呼应。

3.80－5.00秒
她走到离镜头较近的位置，微微放慢脚步，保持回眸式的柔和对视，全身始终完整在画面中。
接近镜头时动作自然减速，不要突然停住。`,
      eye: '行走中自然回眸看镜头，眼神柔和明亮，像在花园里被熟悉的人轻轻叫住。',
      camera: '与模特视线等高的稳定后撤跟拍：镜头平稳后撤，保持全身构图完整。\n不要推镜，不要拉镜，不要摇镜，不要突然变焦。\n焦点稳定在模特的脸部和服装上，树荫光斑自然流动但不抢焦点。',
      recap: '她沿石板小径迎面自然走来，步伐轻盈真实，回眸眼神柔和明亮，服装与花园背景与首帧完全一致。',
      audio: '户外微风拂过树叶的沙沙声，远处隐约的鸟鸣，石板路上轻快的脚步声，衣物随微风的轻微摆动声。'
    },
    seg2: {
      beats: `0.00－1.50秒
承接上一镜的行走，模特自然放慢脚步，在盛开花草旁平稳停下，双脚稳稳落地。
停步带着真实惯性，缓缓收住。

1.50－3.20秒
她以重心脚为轴，自然连贯地完成一个约45度的转身，展示服装的侧面剪裁、面料垂感与背面做工。
转身时肩、腰、腿协同运动，重心转移真实。

3.20－5.00秒
转身后她稳定站定，展示面料与剪裁细节，随后自然回眸看镜头，保持柔和明亮的对视。`,
      eye: '转身站定后回眸看镜头，眼神柔和明亮，先有注视，再带一点自然笑意。',
      camera: '稳定的慢速横移：平稳慢速横移拍摄转身过程，突出面料、缝线与剪裁细节。\n不要突然运镜，不要变焦。\n焦点始终稳定在模特身上。',
      recap: '她在花草旁平稳停步、自然转身展示服装细节，随后回眸与镜头柔和对视，整个动作松弛自然。',
      audio: '连续的花园鸟鸣与风声，石板上的轻轻转身声，衣物随微风与转身的轻微摆动声。'
    }
  },
  cafe: {
    title: '现代极简咖啡厅',
    lock: '服装与鞋履细节、咖啡馆木质背景与落地窗、自然暖光、构图、镜头焦段和整体摄影质感',
    shot: '咖啡馆里的跟拍',
    seg1: {
      beats: `0.00－1.50秒
模特从首帧的站姿自然起步，在木地板上迎面走向镜头。
起步自然：重心先微微前移，第一步不要突然迈大。
她保持慵懒放松的状态，肩背舒展，下颌微微抬起、头部四分之三转向镜头。

1.50－3.80秒
她以放松的节奏继续向前走，每秒约一步，步态松弛自然。
不要匀速机械行走，步伐之间有非常轻微的自然节奏差。
双臂在身体两侧自然摆动，与步伐自然交替。

3.80－5.00秒
她走到离镜头较近的位置，微微放慢脚步，保持温暖亲近的对视，全身始终完整在画面中。
接近镜头时动作自然减速，不要突然停住。`,
      eye: '下颌微微抬起，头部四分之三转向镜头，眼神温暖、亲近、有生活感。',
      camera: '与模特视线等高的稳定后撤跟拍：镜头平稳后撤，保持全身构图完整。\n不要推镜，不要拉镜，不要摇镜，不要突然变焦。\n焦点稳定在模特的脸部和服装上，落地窗暖光保持一致。',
      recap: '她在咖啡馆暖光中迎面自然走来，步伐松弛真实，温暖的眼神与镜头交流，服装与咖啡馆背景与首帧完全一致。',
      audio: '咖啡馆远处轻微的人声底噪，隐约的咖啡机蒸汽声，木地板上轻柔的脚步声。'
    },
    seg2: {
      beats: `0.00－1.50秒
承接上一镜的行走，模特自然放慢脚步，在落地窗边平稳停下，双脚稳稳落地。
停步带着真实惯性，缓缓收住。

1.50－3.20秒
她以重心脚为轴，自然连贯地完成一个约45度的转身，展示服装的侧面剪裁、针织面料质感与背面做工。
转身时肩、腰、腿协同运动，重心转移真实。

3.20－5.00秒
转身后她稳定站定，展示面料与缝线细节，随后下颌微抬回看镜头，保持温暖亲近的对视。`,
      eye: '转身站定后回看镜头，下颌微微抬起，眼神温暖亲近，先有注视，再带一点自然笑意。',
      camera: '稳定的慢速横移：平稳慢速横移拍摄转身过程，突出针织面料与剪裁细节。\n不要突然运镜，不要变焦。\n焦点始终稳定在模特身上。',
      recap: '她在窗边平稳停步、自然转身展示服装细节，随后回看镜头温暖对视，整个动作松弛自然。',
      audio: '咖啡馆安静的房间氛围音，木地板上的轻轻转身声，衣物随转身的细微摆动声。'
    }
  },
  custom: {
    title: '自定义专属场景',
    lock: '服装与鞋履细节、背景环境与光线氛围、构图、镜头焦段和整体摄影质感',
    shot: '生活场景跟拍',
    seg1: {
      beats: `0.00－1.50秒
模特从首帧的站姿自然起步，在首帧场景中迎面走向镜头。
起步自然：重心先微微前移，第一步不要突然迈大。
她保持放松从容的状态，肩背舒展，眼神柔和地看向镜头。

1.50－3.80秒
她以稳定的节奏继续向前走，每秒约一步。
不要匀速机械行走，步伐之间有非常轻微的自然节奏差。
双臂在身体两侧自然摆动，动作与首帧场景环境真实呼应。

3.80－5.00秒
她走到离镜头较近的位置，微微放慢脚步，保持自然柔和的对视，全身始终完整在画面中。
接近镜头时动作自然减速，不要突然停住。`,
      eye: '与镜头自然对视，眼神温暖真实、放松而有生气。',
      camera: '与模特视线等高的稳定后撤跟拍：镜头平稳后撤，保持全身构图完整。\n不要推镜，不要拉镜，不要摇镜，不要突然变焦。\n焦点稳定在模特的脸部和服装上，场景光线保持与首帧一致。',
      recap: '她迎面自然走来，步伐真实有惯性，眼神与镜头自然交流，服装与场景与首帧完全一致。',
      audio: '与场景匹配的真实环境底噪，有节奏的脚步声，衣物随步伐的轻微摩擦声。'
    },
    seg2: {
      beats: `0.00－1.50秒
承接上一镜的行走，模特自然放慢脚步，平稳停下，双脚稳稳落地。
停步带着真实惯性，缓缓收住。

1.50－3.20秒
她以重心脚为轴，自然连贯地完成一个约45度的转身，展示服装的侧面剪裁、面料垂感与背面做工。
转身时肩、腰、腿协同运动，重心转移真实。

3.20－5.00秒
转身后她稳定站定，展示面料与剪裁细节，随后自然回看镜头，保持从容的对视。`,
      eye: '转身站定后回看镜头，眼神从容真实，先有注视，再带一点自然笑意。',
      camera: '稳定的慢速横移：平稳慢速横移拍摄转身过程，突出面料、缝线与剪裁细节。\n不要突然运镜，不要变焦。\n焦点始终稳定在模特身上。',
      recap: '她平稳停步、自然转身展示服装细节，随后回看镜头从容对视，整个动作一气呵成。',
      audio: '与场景匹配的连续环境音，轻轻的转身脚步声，衣物随转身的轻微摆动声。'
    }
  }
};

// 按【最高优先级】→【5秒核心动作】→【表情与眼神】→【真实人体动态】
// →【服装与手部】→【镜头】→【画面质感】→【严格去除AI味】→【最终效果】→【音频】
// 组装场景视频提示词；她/他在此处按性别替换。
function h3SegPrompt(sceneId, seg, isM, extra = '') {
  const cfg = H3_SCENE_CFG[sceneId] || H3_SCENE_CFG.custom;
  const s = cfg['seg' + seg];
  const pro = isM ? '他' : '她';
  const segTitle = seg === 1 ? '分镜一·迎面走姿' : '分镜二·45°转体展示';
  const body = seg === 1
    ? '身体重心随步伐自然前移；\n每一步都有真实的落地与惯性；'
    : '停步时身体带着惯性缓缓收住；\n转身时重心转移自然连贯；';
  const hand = seg === 1
    ? '双臂在身体两侧自然摆动，双手放松、手指自然张开，全程可见；'
    : '双臂自然垂于身体两侧，双手放松、全程可见；';
  const beats = s.beats.split('她').join(pro);
  const eye = s.eye.split('她').join(pro);
  const camera = s.camera.split('她').join(pro);
  const recap = s.recap.split('她').join(pro);
  let p = `生成一段5秒、真人写实、自然生活感时尚短视频，适用于 Minimax H3 首帧续写。${cfg.title}·${segTitle}。

【最高优先级】
严格保持首帧画面中模特的人脸、五官、发型、妆容、肤色、身材比例、${cfg.lock}不变。
不要换脸，不要改变人物造型，不要改变服装款式与配色，不要改变场景。
整段视频必须像真实${cfg.shot}记录下的一段生活瞬间：
自然、松弛、有编辑感、有生命感。
不要刻意表演，不要短视频模板感，严格去掉AI味。

━━━━━━━━━━━━━━━━━━
【5秒核心动作】
${beats}

━━━━━━━━━━━━━━━━━━
【表情与眼神｜必须执行】
眼神变化遵循真实顺序：
与镜头对视时，眼神先有细微的亮意，
→ 面部肌肉保持放松，
→ 形成从容、安静、亲切的神态。
${eye}
允许自然眨眼1次左右，
允许非常细微的眼球移动和呼吸感。
这些真实的不完美要保留。

禁止：
假表情、
僵硬脸、
突然咧嘴、
过度露齿、
空洞眼神、
夸张眯眼、
标准网红笑。
模特全程自然闭唇、嘴角放松，不要张嘴，不要露齿笑。

━━━━━━━━━━━━━━━━━━
【真实人体动态】
整个5秒不能像一张静态图片在动。
保留非常轻微的真实人体运动：
自然呼吸；
肩颈细微起伏；
${body}
眼睛有真实注视变化；
允许自然眨眼；
几缕碎发有极轻微晃动。
所有动作必须有真实惯性和缓急变化。
不要匀速，不要突然启动，不要突然停止，不要机械。

━━━━━━━━━━━━━━━━━━
【服装与手部】
服装全程保持首帧中的款式、配色、剪裁与缝线细节。
不要改变服装款式与细节，衣摆、袖口、缝线全程稳定。
面料随动作有符合物理规律的自然摆动和惯性。
禁止：服装变形、纹理跳动、凭空出现的拖尾或裙摆、衣服颜色变化。
手部必须真实：
五指正常，
没有多指，
没有粘连，
没有穿模，
手腕自然。
${hand}

━━━━━━━━━━━━━━━━━━
【镜头】
${camera}

━━━━━━━━━━━━━━━━━━
【画面质感】
保持首帧真实自然的光线与色调。
皮肤保留真实皮肤纹理：
细微毛孔，
真实肤质，
柔和面部高光，
眼睛真实反光，
真实发丝边缘。
不要过度磨皮，不要塑料皮肤，不要蜡像脸，不要过度锐化，不要假白，不要HDR感过重。

━━━━━━━━━━━━━━━━━━
【严格去除AI味】
禁止出现：
换脸，
脸型变化，
发型变化，
五官漂移，
牙齿闪烁，
嘴巴变形，
头发融化，
手指畸形，
滑步，
脚步漂浮，
服装凭空变化，
背景物体闪烁，
焦点乱跳，
突然运镜，
机械匀速动作，
商业广告式表演，
明显AI生成痕迹。

━━━━━━━━━━━━━━━━━━
【最终效果】
${recap}

━━━━━━━━━━━━━━━━━━
【音频】
${s.audio}`;
  if (extra) p += `\n\n━━━━━━━━━━━━━━━━━━\n【补充要求】\n${extra}`;
  return p;
}

const SCENES = {
  street: {
    id: 'street',
    name: '阳光都市街拍',
    enName: 'Sunny Streetwear Chic',
    icon: 'buildings',
    description: '阳光洒落的都市街头，自然光影景深，亲密POV眼神交流与潮流编辑感姿势',
    sceneEnvironment: 'on a sunlit city street sidewalk with historic brownstone buildings, natural directional sunlight casting soft ground shadows',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish East Asian editorial model', 'handsome East Asian editorial model', customStylePrompt);
      const pro = isM ? 'he' : 'she';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length on a sunlit city street sidewalk with historic brownstone buildings, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus, with a soft intimate POV feeling. Direct eye contact with the viewer, head in a gentle three-quarter turn, gaze connecting naturally. Relaxed editorial stance, subtle natural weight shift to one hip, shoulders soft and open, waistline and long legs forming gentle lines, posture relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body editorial fashion lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the concrete sidewalk with realistic soft ground contact shadows beneath footwear. Serene composed expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Clean directional summer sunlight casting soft realistic ground shadows, neutral-to-warm daylight, ivory and cream clothing staying true to tone, brick and pavement colors remaining faithful, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering on cheeks, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, f/2.8, subtle organic film grain, intimate POV with the viewer standing close${extra}`,
        seg1_prompt: h3SegPrompt('street', 1, isM, custom),
        seg2_prompt: h3SegPrompt('street', 2, isM, custom)
      };
    }
  },
  studio: {
    id: 'studio',
    name: '极简纯色影棚',
    enName: 'Minimalist Lookbook Studio',
    icon: 'camera',
    description: '纯色摄影棚无影墙，高端柔光箱打光，突出眼神交流与姿态几何',
    sceneEnvironment: 'in a clean minimalist studio against a neutral grey cyclorama backdrop, diffuse softbox studio lighting',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'professional East Asian editorial model', 'handsome East Asian editorial model', customStylePrompt);
      const pro = isM ? 'he' : 'she';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in a clean minimalist studio against a neutral grey cyclorama backdrop, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Slightly lowered chin with eyes lifted toward the lens, a quiet intimate gaze. Elegant upright posture, body turned a quarter away from camera, shoulders soft and open, waistline forming gentle lines, posture relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body editorial catalogue lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the matte studio floor with realistic soft ground contact shadows beneath footwear. Serene composed editorial expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Diffuse softbox studio lighting with soft shadow falloff, clean neutral-to-warm color balance, ivory and cream clothing staying true to tone, grey backdrop remaining faithful, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering on cheeks, natural catchlights in the eyes, tactile cloth texture and seam details. Props stay small and secondary if present. Shot on 50mm lens, subtle organic film grain, soft contact shadows, intimate POV with the viewer standing close${extra}`,
        seg1_prompt: h3SegPrompt('studio', 1, isM, custom),
        seg2_prompt: h3SegPrompt('studio', 2, isM, custom)
      };
    }
  },
  office: {
    id: 'office',
    name: '摩天楼职场通勤',
    enName: 'Executive Urban Commuter',
    icon: 'building',
    description: '现代玻璃幕墙大厦大堂，晨光透射，干练优雅的商务编辑感',
    sceneEnvironment: 'in the grand entrance lobby of a modern glass corporate skyscraper, polished granite floors, morning architectural sunlight filtering through high glass curtain walls',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'chic East Asian business woman', 'refined East Asian businessman', customStylePrompt);
      const pro = isM ? 'he' : 'she';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in the grand entrance lobby of a modern glass corporate skyscraper with polished granite floors, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Calm three-quarter eye contact with confident professional warmth, head turned just enough to show the jawline. Composed executive stance, posture relaxed but intentional, shoulders soft and open, waistline visible beneath tailored garments, long legs forming clean lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body executive lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the polished granite floor with realistic soft ground contact shadows beneath footwear and subtle diffuse ambient floor sheen. Naturally closed lips without tension, relaxed natural jawline, soft natural hair. Morning architectural sunlight filtering diagonally through high glass curtain walls, clean neutral-to-warm light, granite and glass tones staying faithful, clothing colors remaining true to tone, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile leather grain and fabric drape. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`,
        seg1_prompt: h3SegPrompt('office', 1, isM, custom),
        seg2_prompt: h3SegPrompt('office', 2, isM, custom)
      };
    }
  },
  boutique: {
    id: 'boutique',
    name: '高端艺术买手店',
    enName: 'Luxury Concept Boutique',
    icon: 'storefront',
    description: '奢华大理石与柔光射灯的高端专柜，突出女性气质与眼神光',
    sceneEnvironment: 'in a luxury designer concept boutique with polished Italian marble floors and minimalist brass fixtures, warm 3200K architectural recessed spotlights',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'elegant East Asian fashion model', 'confident refined East Asian male model', customStylePrompt);
      const pro = isM ? 'he' : 'she';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in a luxury designer concept boutique with polished Italian marble floors and minimalist brass fixtures, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Soft upward gaze catching warm spotlight reflections, composed direct eye contact with the viewer. Graceful weight on one leg, torso softly angled, shoulders and waistline forming refined elegant lines, posture relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body luxury retail lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the polished marble floor with realistic soft ground contact shadows beneath footwear and subtle diffuse floor sheen. Serene composed expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Warm 3200K architectural recessed spotlights with soft falloff, clean neutral-to-warm color balance, marble and brass tones staying faithful, clothing colors remaining true to tone, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and leather grain. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`,
        seg1_prompt: h3SegPrompt('boutique', 1, isM, custom),
        seg2_prompt: h3SegPrompt('boutique', 2, isM, custom)
      };
    }
  },
  outdoor: {
    id: 'outdoor',
    name: '自然户外林荫',
    enName: 'Nature Sunlight & Garden',
    icon: 'leaf',
    description: '绿意盎然的公园石板路与林荫微风，柔和眼神回眸与浪漫编辑感',
    sceneEnvironment: 'in a lush sun-dappled botanical garden along a smooth stone paver pathway, blooming foliage, natural outdoor daylight, dappled sunbeam highlights',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'natural East Asian fashion model', 'relaxed East Asian male model', customStylePrompt);
      const pro = isM ? 'he' : 'she';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in a lush sun-dappled botanical garden along a smooth stone paver pathway with blooming foliage, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. A side glance over the shoulder with maintained eye contact, face angle varied and alive. Peaceful relaxed stance beside garden greenery, posture fluid and natural, shoulders soft and open, waistline visible, long legs forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body lifestyle lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the stone pavers with realistic soft ground contact shadows beneath footwear. Serene gentle expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Natural outdoor daylight, soft dappled sunbeam highlights through tree canopies, clean neutral-to-warm color balance, green foliage staying true to tone, stone colors remaining faithful, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile cloth folds and texture. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`,
        seg1_prompt: h3SegPrompt('outdoor', 1, isM, custom),
        seg2_prompt: h3SegPrompt('outdoor', 2, isM, custom)
      };
    }
  },
  cafe: {
    id: 'cafe',
    name: '现代极简咖啡厅',
    enName: 'Lifestyle Nordic Cafe',
    icon: 'coffee',
    description: '落地窗暖调咖啡馆，慵懒而亲密的生活编辑感',
    sceneEnvironment: 'in a cozy Nordic-aesthetic cafe with warm timber oak interiors and large floor-to-ceiling sunlit windows, warm natural daylight and soft interior fill',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish East Asian young woman', 'stylish East Asian young man', customStylePrompt);
      const pro = isM ? 'he' : 'she';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in a cozy Nordic-aesthetic cafe with warm timber oak interiors and large floor-to-ceiling sunlit windows, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Chin softly lifted, head turned three-quarters toward the lens, warm approachable eye contact. Casual editorial stance near the sunlit window, body language relaxed but intentional, shoulders soft and open, posture forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body cozy editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the hardwood floor with realistic soft ground contact shadows beneath footwear. Relaxed serene expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Warm natural window light with soft interior fill, clean neutral-to-warm color balance, warm oak and cream tones staying faithful, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile knit and fabric weave. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`,
        seg1_prompt: h3SegPrompt('cafe', 1, isM, custom),
        seg2_prompt: h3SegPrompt('cafe', 2, isM, custom)
      };
    }
  },
  custom: {
    id: 'custom',
    name: '自定义专属场景',
    enName: 'Custom Dream Scene',
    icon: 'palette',
    description: '自由描述任意个性化展示背景（海滩落日、雪山木屋、赛博霓虹、古风江南等），保持眼神交流与真实皮肤质感',
    sceneEnvironment: 'in an aesthetic commercial fashion lookbook background, natural commercial lighting',
    buildPrompts: (gender = 'female', customPrompt = '', customScene = '', style = 'classic', customStylePrompt = '') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish East Asian editorial model', 'handsome East Asian editorial model', customStylePrompt);
      const pro = isM ? 'he' : 'she';
      const rawScene = (customScene && customScene.trim()) ? customScene.trim() : 'an aesthetic commercial fashion lookbook background';
      const sceneDesc = /^(in|on|at|against|under|near|along)\s+/i.test(rawScene)
        ? rawScene
        : `in ${rawScene}`;
      const extra = customPrompt ? `, ${customPrompt}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length ${sceneDesc}, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Soft direct eye contact with a warm genuine presence, face angle natural and alive. Elegant confident posture, body language relaxed but intentional, shoulders soft and open, waistline visible, posture forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on ground with realistic soft ground contact shadows beneath footwear. Serene composed expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Realistic natural lighting consistent with the environment, clean neutral-to-warm color balance, clothing and background colors remaining faithful without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`,
        seg1_prompt: h3SegPrompt('custom', 1, isM, customPrompt),
        seg2_prompt: h3SegPrompt('custom', 2, isM, customPrompt)
      };
    }
  }
};

// Format multiline textbox input: strip list bullets at line starts only
// (keep hyphens inside words like "t-shirt"), collapse lines, block audio injection
const stripTextboxNoise = (raw) => (raw || '')
  .replace(/^[•·*\-]\s*/gm, '')
  .replace(/\baudio\s*:/gi, '')
  .replace(/露齿笑|露牙笑|露齿|大笑|狂笑|张嘴笑/g, '闭唇从容神采')
  .replace(/\b(toothy smile|open mouth|grinning|laughing|showing teeth)\b/gi, 'closed lips, serene expression')
  .replace(/\b(8k resolution|8k|hyperrealistic|photorealistic|ultra sharp focus|ultra sharp|pristine|flawless|stunning|cinematic|glamorous|radiant|shimmering|over-sharpened|9:16|16:9|3:4|4:3|1:1)\b/gi, '')
  .replace(/\r\n|\r|\n/g, ', ')
  .replace(/\s+/g, ' ')
  .replace(/[,，\s]+[,，]/g, ', ')
  .replace(/^[,，\s]+|[,，\s]+$/g, '')
  .trim();

// Centralized authoritative prompt computation for preview and execution
function computeTaskPrompts({
  scene = 'street',
  gender = 'female',
  model_style = 'classic',
  model_style_prompt = '',
  custom_scene = '',
  custom_prompt = '',
  model_image = null,
  scene_image = null
} = {}) {
  const modelStyleKey = MODEL_STYLES[model_style] ? model_style : 'classic';
  const sceneConfig = SCENES[scene] || SCENES.street;
  const isM = gender === 'male';

  const cleanCustom = stripTextboxNoise(custom_prompt);
  const cleanCustomScene = stripTextboxNoise(custom_scene);
  const cleanCustomModelStyle = stripTextboxNoise(model_style_prompt);

  const prompts = sceneConfig.buildPrompts(
    gender,
    cleanCustom,
    cleanCustomScene,
    modelStyleKey,
    cleanCustomModelStyle
  );

  let kreaPrompt = prompts.krea_prompt;

  if (model_image) {
    const customEnvPreposition = /^(in|on|at|against|under|near|along)\s+/i.test(cleanCustomScene) ? '' : 'in ';
    const sceneEnv = (sceneConfig.id === 'custom' && cleanCustomScene)
      ? `${customEnvPreposition}${cleanCustomScene}, realistic lighting consistent with the environment`
      : (sceneConfig.sceneEnvironment || 'in an aesthetic fashion lookbook background, natural commercial lighting');
    const modelGenderLabel = isM ? 'male model' : 'female model';
    kreaPrompt = `Create an editorial lookbook portrait. Transfer the clothing and outfit from the first reference image onto the ${modelGenderLabel} in the second reference image, strictly preserving their exact facial features, facial identity, eye shape, nose shape, and hairstyle, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${isM ? 'He' : 'She'} is the clear visual focus with a soft intimate POV feeling, standing ${sceneEnv}. Full body editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on ground with realistic soft ground contact shadows beneath footwear, arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers, subtle natural weight shift. Soft direct eye contact with warm genuine presence, serene composed expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Realistic lighting consistent with the environment, clean neutral-to-warm color balance, clothing and background colors remaining faithful without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain${cleanCustom ? ', ' + cleanCustom : ''}`;
  } else if (scene_image) {
    const subj = styledSubject(gender, modelStyleKey, 'stylish female model', 'handsome male model', cleanCustomModelStyle);
    kreaPrompt = `Create an editorial lookbook portrait of a ${subj} standing full-length in the background environment from the first reference image, wearing the exact clothing and outfit from the second reference image, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${isM ? 'He' : 'She'} is the clear visual focus with a soft intimate POV feeling. Soft direct eye contact with warm genuine presence, face angle natural and alive. Elegant confident posture, body language relaxed but intentional, shoulders soft and open, waistline visible, posture forming gentle lines. Full body editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on ground with realistic soft ground contact shadows beneath footwear, arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers, subtle natural weight shift. Serene composed expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Realistic illumination matched to the background environment, clean neutral-to-warm color balance, clothing and background colors remaining faithful without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain${cleanCustom ? ', ' + cleanCustom : ''}`;
  }

  return {
    krea_prompt: kreaPrompt,
    seg1_prompt: prompts.seg1_prompt,
    seg2_prompt: prompts.seg2_prompt
  };
}

// Global task store with auto-cleanup (prevent memory leak)
const tasks = new Map();
const batchJobs = new Map();
const isActiveTask = (task) => task.status === 'queued' || task.status === 'running';

// Release models after 30 idle minutes. Set IDLE_RELEASE_MS=0 to disable.
const idleReleaseSetting = process.env.IDLE_RELEASE_MS;
const configuredIdleReleaseMs = idleReleaseSetting && idleReleaseSetting.trim() !== ''
  ? Number(idleReleaseSetting)
  : NaN;
const IDLE_RELEASE_MS = Number.isFinite(configuredIdleReleaseMs) && configuredIdleReleaseMs >= 0
  ? configuredIdleReleaseMs
  : 30 * 60 * 1000;
let lastGenerationActivityAt = 0;
let idleReleased = false;

function noteGenerationActivity() {
  lastGenerationActivityAt = Date.now();
  idleReleased = false;
}

async function releaseComfyResourcesIfIdle() {
  if (IDLE_RELEASE_MS === 0 || !lastGenerationActivityAt || idleReleased) return;
  if ([...tasks.values()].some(isActiveTask)) return;
  if (Date.now() - lastGenerationActivityAt < IDLE_RELEASE_MS) return;

  try {
    const queueRes = await fetch(`${COMFY_URL}/queue`);
    if (!queueRes.ok) throw new Error(`queue check returned HTTP ${queueRes.status}`);
    const queue = await queueRes.json();
    const running = queue.queue_running ? queue.queue_running.length : 0;
    const pending = queue.queue_pending ? queue.queue_pending.length : 0;

    // A request may have started while /queue was being read.
    if (running || pending || [...tasks.values()].some(isActiveTask)) return;

    const freeRes = await fetch(`${COMFY_URL}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true })
    });
    if (!freeRes.ok) throw new Error(`resource release returned HTTP ${freeRes.status}`);

    idleReleased = true;
    const idleLabel = IDLE_RELEASE_MS < 60_000
      ? `${Math.round(IDLE_RELEASE_MS / 1000)} seconds`
      : `${Math.round(IDLE_RELEASE_MS / 60_000)} minutes`;
    console.log(`Requested ComfyUI resource release after ${idleLabel} idle.`);
  } catch (err) {
    console.warn('Idle ComfyUI resource release skipped:', err.message);
  }
}

setInterval(() => {
  const now = Date.now();
  const maxAge = 2 * 60 * 60 * 1000; // 2 hours
  for (const [id, task] of tasks.entries()) {
    if (isActiveTask(task)) continue; // never evict in-flight tasks
    const age = now - new Date(task.createdAt).getTime();
    if (age > maxAge) tasks.delete(id);
  }
  for (const [id, batch] of batchJobs.entries()) {
    const age = now - new Date(batch.createdAt).getTime();
    if (age > maxAge) batchJobs.delete(id);
  }
  if (tasks.size > 150) {
    const sorted = [...tasks.entries()]
      .filter(([, task]) => !isActiveTask(task))
      .sort((a, b) => new Date(a[1].createdAt) - new Date(b[1].createdAt));
    for (let i = 0; i < sorted.length - 50; i++) {
      tasks.delete(sorted[i][0]);
    }
  }
}, 10 * 60 * 1000);

setInterval(() => {
  void releaseComfyResourcesIfIdle();
}, 60 * 1000);

// Helper: ComfyUI HTTP Submission with Real-time WebSocket Progress
async function submitComfyWorkflowWithProgress(workflow, onProgress = () => {}) {
  const clientId = uuidv4();
  let ws = null;

  try {
    ws = new WebSocket(`${COMFY_WS_URL}/ws?clientId=${clientId}`);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'progress' && msg.data) {
          try {
            onProgress({ type: 'sampling', value: msg.data.value, max: msg.data.max, node: msg.data.node });
          } catch(err) {}
        } else if (msg.type === 'executing' && msg.data) {
          try {
            onProgress({ type: 'node_change', node: msg.data.node });
          } catch(err) {}
        }
      } catch (e) {}
    });
    ws.on('error', () => {});

    // Wait for WS connection to establish (up to 3s) so ComfyUI registers this
    // clientId before /prompt is called; otherwise progress events are dropped
    await new Promise((resolve) => {
      if (ws.readyState === WebSocket.OPEN) return resolve();
      const timer = setTimeout(resolve, 3000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch (e) {
    ws = null;
    console.warn('WebSocket connect failed, using HTTP polling fallback');
  }

  try {
    const res = await fetch(`${COMFY_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ComfyUI rejected prompt (${res.status}): ${text}`);
    }

    const { prompt_id } = await res.json();
    const startTime = Date.now();
    const timeoutMs = 30 * 60 * 1000;

    while (Date.now() - startTime < timeoutMs) {
      await new Promise(r => setTimeout(r, 1200));
      const histRes = await fetch(`${COMFY_URL}/history/${prompt_id}`);
      if (!histRes.ok) continue;

      const history = await histRes.json();
      if (history && history[prompt_id]) {
        const entry = history[prompt_id];
        const status = entry.status || {};
        if (status.completed || status.status_str === 'success') {
          return entry;
        }
        if (status.status_str === 'error') {
          throw new Error(`ComfyUI execution failed: ${JSON.stringify(entry.status)}`);
        }
      }
    }
    throw new Error('ComfyUI execution timed out after 30 minutes.');
  } finally {
    if (ws) {
      try { ws.close(); } catch(e) {}
    }
  }
}

// Routes
app.get('/api/system', async (req, res) => {
  try {
    const resp = await fetch(`${COMFY_URL}/system_stats`);
    const data = await resp.json();
    let queueInfo = { running: 0, pending: 0 };
    try {
      const qResp = await fetch(`${COMFY_URL}/queue`);
      const qData = await qResp.json();
      queueInfo = {
        running: qData.queue_running ? qData.queue_running.length : 0,
        pending: qData.queue_pending ? qData.queue_pending.length : 0
      };
    } catch(e) {}

    res.json({
      online: true,
      gpu: data.devices && data.devices[0] ? data.devices[0].name : 'Unknown',
      vram_free_gb: data.devices && data.devices[0] ? (data.devices[0].vram_free / 1024 / 1024 / 1024).toFixed(1) : 'N/A',
      vram_total_gb: data.devices && data.devices[0] ? (data.devices[0].vram_total / 1024 / 1024 / 1024).toFixed(1) : 'N/A',
      queue: queueInfo
    });
  } catch (err) {
    res.json({ online: false, error: err.message });
  }
});

app.get('/api/scenes', (req, res) => {
  const list = Object.values(SCENES).map(s => ({
    id: s.id,
    name: s.name,
    enName: s.enName,
    icon: s.icon,
    description: s.description
  }));
  res.json(list);
});

app.get('/api/model-styles', (req, res) => {
  res.json(MODEL_STYLES);
});

// Endpoint for frontend to preview authoritative underlying prompts for inspection and fine-tuning
app.post('/api/preview-prompts', (req, res) => {
  try {
    const {
      scene = 'street',
      gender = 'female',
      model_style = 'classic',
      model_style_prompt = '',
      custom_scene = '',
      custom_prompt = '',
      model_image = null,
      scene_image = null
    } = req.body || {};

    const prompts = computeTaskPrompts({
      scene,
      gender,
      model_style,
      model_style_prompt,
      custom_scene,
      custom_prompt,
      model_image,
      scene_image
    });

    res.json(prompts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: '请选择或上传服装图片' });
    if (!looksLikeImage(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch(e) {}
      return res.status(400).json({ error: '文件内容不是有效的 PNG/JPG/WEBP/BMP 图片' });
    }
    res.json({
      filename: req.file.filename,
      url: `/inputs/${req.file.filename}`,
      size: req.file.size
    });
  });
});

app.post('/api/generate', async (req, res) => {
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
    krea_prompt = null,
    seg1_prompt = null,
    seg2_prompt = null
  } = req.body;

  if (!image) {
    return res.status(400).json({ error: '缺少服装图片文件名' });
  }

  // Whitelist the model style to a known preset
  const modelStyleKey = MODEL_STYLES[model_style] ? model_style : 'classic';

  // Prevent path traversal attacks
  const sanitizedImage = path.basename(image);
  const srcInputPath = path.join(PROJECT_INPUT_DIR, sanitizedImage);
  if (!fs.existsSync(srcInputPath)) {
    return res.status(400).json({ error: `找不到指定的服装图片: ${sanitizedImage}` });
  }

  const sanitizedModelImage = model_image ? path.basename(String(model_image)) : null;
  const sanitizedSceneImage = scene_image ? path.basename(String(scene_image)) : null;

  const taskId = uuidv4();
  const sceneConfig = SCENES[scene] || SCENES.street;

  const isCustomScene = sceneConfig.id === 'custom';

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
    custom_krea_prompt: typeof krea_prompt === 'string' && krea_prompt.trim() ? krea_prompt.trim() : null,
    custom_seg1_prompt: typeof seg1_prompt === 'string' && seg1_prompt.trim() ? seg1_prompt.trim() : null,
    custom_seg2_prompt: typeof seg2_prompt === 'string' && seg2_prompt.trim() ? seg2_prompt.trim() : null,
    aspect_ratio,
    image: sanitizedImage,
    model_image: sanitizedModelImage,
    scene_image: isCustomScene ? sanitizedSceneImage : null,
    mode,
    stillImage: null,
    videoUrl: null,
    createdAt: new Date().toISOString(),
    error: null
  };
  tasks.set(taskId, task);
  noteGenerationActivity();

  // Enqueue job via global FIFO execution queue to prevent model thrashing
  enqueueJob(async () => {
    try {
      await runGenerationJob(taskId);
    } catch (err) {
      console.error(`Task ${taskId} failed in global queue:`, err);
      const t = tasks.get(taskId);
      if (t && t.status !== 'completed') {
        t.status = 'error';
        t.error = err.message;
        t.message = `生成失败: ${err.message}`;
      }
    }
  });

  res.json({ taskId });
});

// Global FIFO execution queue to guarantee strictly one generation unit runs at a time.
// Completely prevents GPU VRAM thrashing, race conditions, and model unload/reload cycles in ComfyUI.
let globalJobQueue = Promise.resolve();

function enqueueJob(runner) {
  const next = globalJobQueue.then(async () => {
    try {
      await runner();
    } catch (err) {
      console.error('Job execution failed in global queue:', err);
    }
  }).catch(fatalErr => {
    console.error('Fatal unhandled error in globalJobQueue runner:', fatalErr);
  });
  globalJobQueue = next;
  return next;
}

app.post('/api/generate-batch', async (req, res) => {
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
    krea_prompt = null,
    seg1_prompt = null,
    seg2_prompt = null
  } = req.body;

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

  const batchId = uuidv4();
  const selectedScenes = Array.isArray(scenes) && scenes.length > 0 ? scenes.slice(0, 5) : ['street', 'studio', 'boutique'];
  const taskIds = [];

  for (const scKey of selectedScenes) {
    const scConfig = SCENES[scKey] || SCENES.street;
    const isTargetScene = (scKey === scene);
    const tid = uuidv4();
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
      custom_krea_prompt: isTargetScene && typeof krea_prompt === 'string' && krea_prompt.trim() ? krea_prompt.trim() : null,
      custom_seg1_prompt: isTargetScene && typeof seg1_prompt === 'string' && seg1_prompt.trim() ? seg1_prompt.trim() : null,
      custom_seg2_prompt: isTargetScene && typeof seg2_prompt === 'string' && seg2_prompt.trim() ? seg2_prompt.trim() : null,
      aspect_ratio,
      image: sanitizedImage,
      model_image: sanitizedModelImage,
      scene_image: scKey === 'custom' ? sanitizedSceneImage : null,
      mode,
      stillImage: null,
      videoUrl: null,
      createdAt: new Date().toISOString(),
      error: null
    };
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

  // Enqueue entire batch as a single uninterruptible atomic sequence in the global queue
  enqueueJob(async () => {
    batchJob.status = 'running';
    for (let i = 0; i < taskIds.length; i++) {
      batchJob.currentTaskIndex = i;
      const tid = taskIds[i];
      try {
        await runGenerationJob(tid);
      } catch (err) {
        console.error(`Batch ${batchId} subtask ${tid} failed:`, err);
        const t = tasks.get(tid);
        if (t && t.status !== 'completed') {
          t.status = 'error';
          t.error = err.message;
          t.message = `生成失败: ${err.message}`;
        }
      }
    }
    const anyCompleted = taskIds.some(tid => tasks.get(tid)?.status === 'completed');
    batchJob.status = anyCompleted ? 'completed' : 'error';
  });

  res.json({ batchId, taskIds });
});

app.get('/api/batch/:batchId', (req, res) => {
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

app.get('/api/progress/:taskId', (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

app.get('/api/history', (req, res) => {
  try {
    const list = [];
    // 1. Scan Videos
    if (fs.existsSync(PROJECT_VIDEO_DIR)) {
      const files = fs.readdirSync(PROJECT_VIDEO_DIR);
      files.filter(f => f.endsWith('-audio.mp4') || (f.endsWith('.mp4') && !files.includes(f.replace('.mp4', '-audio.mp4')))).forEach(f => {
        const fullPath = path.join(PROJECT_VIDEO_DIR, f);
        const stat = fs.statSync(fullPath);
        const previewName = f.replace(/-audio\.mp4$|\.mp4$/, '.png');
        const hasPreview = fs.existsSync(path.join(PROJECT_VIDEO_DIR, previewName));
        list.push({
          type: 'video',
          filename: f,
          url: `/outputs/videos/${f}`,
          previewUrl: hasPreview ? `/outputs/videos/${previewName}` : null,
          size: (stat.size / 1024 / 1024).toFixed(2) + ' MB',
          createdAt: stat.mtime
        });
      });
    }

    // 2. Scan Still Photos (Stage 1 outputs)
    if (fs.existsSync(PROJECT_IMAGE_DIR)) {
      const imgFiles = fs.readdirSync(PROJECT_IMAGE_DIR);
      imgFiles.filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.webp')).forEach(f => {
        const fullPath = path.join(PROJECT_IMAGE_DIR, f);
        const stat = fs.statSync(fullPath);
        list.push({
          type: 'image',
          filename: f,
          url: `/outputs/images/${f}`,
          previewUrl: `/outputs/images/${f}`,
          size: (stat.size / 1024 / 1024).toFixed(2) + ' MB',
          createdAt: stat.mtime
        });
      });
    }

    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(list.slice(0, 40));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a history item by type + filename (files live in fixed output dirs,
// so the client only supplies an untrusted filename which we sanitize).
app.delete('/api/history/:type/:filename', (req, res) => {
  try {
    const baseDir = req.params.type === 'video' ? PROJECT_VIDEO_DIR : PROJECT_IMAGE_DIR;
    const requested = path.basename(String(req.params.filename));
    if (!requested || requested !== req.params.filename || requested.includes('\\') || requested.startsWith('.')) {
      return res.status(400).json({ error: '非法文件名' });
    }
    const targets = [];
    if (req.params.type === 'video') {
      // Listed videos are the playable file, which may be "<base>.mp4" or "<base>-audio.mp4".
      // Normalize to base name, then clean up all three artifacts: video, audio twin, preview png.
      const base = requested.replace(/-audio\.mp4$|\.mp4$/, '');
      if (base && base !== requested) {
        targets.push(base + '.mp4');
        targets.push(base + '-audio.mp4');
        targets.push(base + '.png');
      }
    } else if (req.params.type === 'image') {
      targets.push(requested);
    } else {
      return res.status(400).json({ error: '未知类型' });
    }
    let deleted = 0;
    for (const name of targets) {
      if (!name || !name.includes('.')) continue;
      const target = path.join(baseDir, name);
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        deleted++;
      }
    }
    if (deleted === 0) return res.status(404).json({ error: '文件不存在' });
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Main async generation execution
async function runGenerationJob(taskId) {
  const task = tasks.get(taskId);
  if (!task) return;

  const kreaWfPath = path.join(WORKFLOWS_DIR, 'krea2_outfit_transfer.json');
  const h3WfPath = path.join(WORKFLOWS_DIR, 'fashion_streetwear_10s_extend.json');

  if (!fs.existsSync(kreaWfPath) || !fs.existsSync(h3WfPath)) {
    throw new Error('Required workflow JSON templates not found on server.');
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
    scene_image: task.scene_image
  });

  const finalKreaPrompt = (task.custom_krea_prompt && task.custom_krea_prompt.trim()) || autoPrompts.krea_prompt;
  const finalSeg1Prompt = (task.custom_seg1_prompt && task.custom_seg1_prompt.trim()) || autoPrompts.seg1_prompt;
  const finalSeg2Prompt = (task.custom_seg2_prompt && task.custom_seg2_prompt.trim()) || autoPrompts.seg2_prompt;

  const sceneDisplayName = task.scene.id === 'custom'
    ? (cleanCustomScene ? `自定义场景: ${cleanCustomScene.slice(0, 16)}` : '自定义专属场景')
    : task.scene.name;

  // File paths to track for reliable cleanup
  const tempInputFile = `temp_in_${taskId}_${path.basename(task.image)}`;
  const srcInputPath = path.join(PROJECT_INPUT_DIR, task.image);
  const dstTempInputPath = path.join(COMFY_TEMP_INPUT_DIR, tempInputFile);
  const stagedH3Name = `staged_${taskId}.png`;
  const dstStagedH3Path = path.join(COMFY_TEMP_INPUT_DIR, stagedH3Name);

  let dstTempModelPath = null;
  let dstTempScenePath = null;
  const tempModelFile = task.model_image ? `temp_model_${taskId}_${path.basename(task.model_image)}` : null;
  const tempSceneFile = task.scene_image ? `temp_scene_${taskId}_${path.basename(task.scene_image)}` : null;

  try {
    // -------------------------------------------------------------
    // STAGE 1: Krea-2 Outfit Transfer (~20s)
    // -------------------------------------------------------------
    task.status = 'running';
    task.progress = 10;
    const modelTag = task.model_image ? ' · 指定模特主角' : ` · ${MODEL_STYLES[task.model_style].name}`;
    task.message = `[阶段一] 正在生成模特试衣定妆照 (${sceneDisplayName}${modelTag})...`;

    if (!fs.existsSync(srcInputPath)) {
      throw new Error(`找不到上传的原始服装图片: ${task.image}`);
    }
    fs.copyFileSync(srcInputPath, dstTempInputPath);

    // Detect if the uploaded garment image is a white-background flat-lay/mannequin.
    // High-score inputs push plastic studio look onto the model, so we loosen ref_boost.
    const garmentAnalysis = detectFlatlayScoreSync(srcInputPath);
    const isFlatlay = garmentAnalysis.flatlay_score >= 0.65;
    const garmentRefBoost = isFlatlay ? 0.94 : 0.96;
    if (garmentAnalysis.flatlay_score > 0) {
      console.log(`[krea2] garment flat-lay score ${garmentAnalysis.flatlay_score}, ref_boost=${garmentRefBoost}`);
    }

    const kreaWf = JSON.parse(fs.readFileSync(kreaWfPath, 'utf-8'));
    requireNodes(kreaWf, 'Krea-2', ['5', '7', '9', '11', '13']);
    kreaWf['5']['inputs']['image'] = `online_temp/${tempInputFile}`;
    kreaWf['9']['inputs']['prompt'] = finalKreaPrompt;
    // Steer the vision encoder toward identity/garment detail instead of the
    // training default's generic background caption. Path-aware: in the dual-ref
    // paths the first vision block is the scene/garment slot, the second is the subject slot.
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
    // 640-768px is the LoRA's in-distribution band (trained with 384-768 jitter)
    if (kreaWf['9']) {
      kreaWf['9']['inputs']['grounding_px'] = 768;
    }
    // Training-matched unconditional for the grounded negative: empty prompt +
    // same image (krea2edit author's recipe). At cfg=1.0 the sampler drops the
    // negative entirely (comfy cfg1 optimization), so a token list was dead weight.
    if (kreaWf['10']) {
      kreaWf['10']['inputs']['prompt'] = '';
      kreaWf['10']['inputs']['grounding_px'] = 768;
    }
    // Slightly raise step count for dpmpp_2m to get gentler gradients on skin/fabrics.
    if (kreaWf['11']) {
      kreaWf['11']['inputs']['steps'] = 10;
      kreaWf['11']['inputs']['sampler_name'] = 'dpmpp_2m';
      kreaWf['11']['inputs']['scheduler'] = 'sgm_uniform';
    }
    // Film grain: subtle 2% strength noise breaks AI pixel-perfect smoothness.
    // Insert the node dynamically if the workflow template does not yet contain it.
    function nextNodeId(wf) {
      const ids = Object.keys(wf).map(Number).filter(n => !isNaN(n) && n > 0);
      return String(Math.max(0, ...ids) + 1);
    }
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

    // -------------------------------------------------------------
    // Dynamic Model Identity Injection (Dual Reference)
    // -------------------------------------------------------------
    if (task.model_image) {
      const srcModelPath = path.join(PROJECT_INPUT_DIR, task.model_image);
      if (fs.existsSync(srcModelPath)) {
        dstTempModelPath = path.join(COMFY_TEMP_INPUT_DIR, tempModelFile);
        fs.copyFileSync(srcModelPath, dstTempModelPath);

        kreaWf['20'] = {
          class_type: 'LoadImage',
          inputs: { image: `online_temp/${tempModelFile}` }
        };
        kreaWf['21'] = {
          class_type: 'VAEEncode',
          inputs: { pixels: ['20', 0], vae: ['3', 0] }
        };

        kreaWf['8']['inputs']['source_latent_b'] = ['21', 0];
        kreaWf['8']['inputs']['source_image_b'] = ['20', 0];
        kreaWf['8']['inputs']['ref_boost'] = 1.0; // second ref = model identity (face must stay locked)
        kreaWf['8']['inputs']['ref_boost_a'] = garmentRefBoost; // first ref = clothing outfit

        kreaWf['9']['inputs']['image_b'] = ['20', 0];
        if (kreaWf['10']) {
          kreaWf['10']['inputs']['image_b'] = ['20', 0];
        }

        kreaWf['9']['inputs']['prompt'] = finalKreaPrompt;
      }
    } else if (task.scene_image) {
      const srcScenePath = path.join(PROJECT_INPUT_DIR, task.scene_image);
      if (fs.existsSync(srcScenePath)) {
        dstTempScenePath = path.join(COMFY_TEMP_INPUT_DIR, tempSceneFile);
        fs.copyFileSync(srcScenePath, dstTempScenePath);

        // Reference 1: Scene image (Node 5)
        // Reference 2: Garment image (Node 20)
        kreaWf['5']['inputs']['image'] = `online_temp/${tempSceneFile}`;
        kreaWf['20'] = {
          class_type: 'LoadImage',
          inputs: { image: `online_temp/${tempInputFile}` }
        };
        kreaWf['21'] = {
          class_type: 'VAEEncode',
          inputs: { pixels: ['20', 0], vae: ['3', 0] }
        };
        kreaWf['8']['inputs']['source_latent_b'] = ['21', 0];
        kreaWf['8']['inputs']['source_image_b'] = ['20', 0];
        kreaWf['8']['inputs']['ref_boost'] = garmentRefBoost; // second ref = garment (loosen for flat-lay)
        kreaWf['8']['inputs']['ref_boost_a'] = 1.0; // first ref = scene

        kreaWf['9']['inputs']['image_b'] = ['20', 0];
        if (kreaWf['10']) {
          kreaWf['10']['inputs']['image_b'] = ['20', 0];
        }

        kreaWf['9']['inputs']['prompt'] = finalKreaPrompt;
      }
    }
    kreaWf['11']['inputs']['seed'] = randomSeed();

    // Synchronize Stage 1 latent with the canvas shared across both stages
    // (must equal the Stage 2 latent size, or the first frame gets stretched)
    const canvas = ASPECT_CANVAS[task.aspect_ratio] || ASPECT_CANVAS['3:4'];
    kreaWf['7']['inputs']['width'] = canvas.width;
    kreaWf['7']['inputs']['height'] = canvas.height;

    const kreaPrefix = `online_temp/krea_${task.scene.id}_${taskId}`;
    kreaWf['13']['inputs']['filename_prefix'] = kreaPrefix;

    const kreaRes = await submitComfyWorkflowWithProgress(kreaWf, (ev) => {
      if (ev.type === 'sampling') {
        task.progress = Math.min(38, Math.round(10 + (ev.value / ev.max) * 28));
        task.message = `[阶段一] 试衣照渲染中 (${ev.value}/${ev.max} 步)...`;
      }
    });

    const kreaOutImgs = kreaRes.outputs && kreaRes.outputs['13'] && kreaRes.outputs['13'].images;
    if (!kreaOutImgs || kreaOutImgs.length === 0) {
      throw new Error('Krea-2 试衣生成失败，未产生有效图片输出。');
    }

    // Copy Stage 1 result into Project storage/outputs/images/
    // (trust the subfolder ComfyUI reports instead of hardcoding online_temp)
    const stillRawFilename = kreaOutImgs[0].filename;
    const stillSubfolder = kreaOutImgs[0].subfolder || '';
    const srcStillPath = path.join(COMFY_OUTPUT_DIR, stillSubfolder, stillRawFilename);
    const savedStillName = `krea_${task.scene.id}_${taskId}.png`;
    const destStillPath = path.join(PROJECT_IMAGE_DIR, savedStillName);
    fs.copyFileSync(srcStillPath, destStillPath);

    // Clean up Stage 1 image from ComfyUI output directory immediately
    try {
      if (fs.existsSync(srcStillPath)) fs.unlinkSync(srcStillPath);
    } catch(e) {}

    task.stillImage = `/outputs/images/${savedStillName}`;
    task.progress = 40;
    task.message = '阶段一完成，定妆照已生成。';

    // Stage 1 only mode early exit
    if (task.mode === 'still_only') {
      task.status = 'completed';
      task.progress = 100;
      task.message = '试衣定妆照生成完成。';
      return;
    }

    // -------------------------------------------------------------
    // STAGE 2: MiniMax H3 10-Second Extension (~180s)
    // -------------------------------------------------------------
    task.progress = 45;
    task.message = '[阶段二] 正在加载视频生成模型...';

    // Stage still image into ComfyUI temp input for MiniMax H3
    fs.copyFileSync(destStillPath, dstStagedH3Path);

    const h3Wf = JSON.parse(fs.readFileSync(h3WfPath, 'utf-8'));
    requireNodes(h3Wf, 'MiniMax H3', ['1', '40', '41', '80', '81', '84']);
    h3Wf['1']['inputs']['image'] = `online_temp/${stagedH3Name}`;

    // Overwrite the ResolutionSelector links with the same canvas used by Stage 1
    // so both segments and the staged first frame share identical dimensions
    h3Wf['40']['inputs']['width'] = canvas.width;
    h3Wf['40']['inputs']['height'] = canvas.height;
    h3Wf['81']['inputs']['width'] = canvas.width;
    h3Wf['81']['inputs']['height'] = canvas.height;

    h3Wf['41']['inputs']['noise_seed'] = randomSeed();
    h3Wf['84']['inputs']['noise_seed'] = randomSeed();

    h3Wf['40']['inputs']['prompt'] = finalSeg1Prompt;
    h3Wf['81']['inputs']['prompt'] = finalSeg2Prompt;

    const videoPrefix = `online_temp/outfit_${task.scene.id}_10s_${taskId}`;
    h3Wf['80']['inputs']['filename_prefix'] = videoPrefix;

    // Delete redundant Node 96 (debug video combine) so ComfyUI doesn't waste time encoding a duplicate 5s video
    delete h3Wf['96'];

    // Real-time progress tracking through WebSocket node events
    const h3Res = await submitComfyWorkflowWithProgress(h3Wf, (ev) => {
      if (ev.type === 'sampling') {
        // Node 53 is segment 1 (8 steps); Node 86 is segment 2 (8 steps)
        if (ev.node === '53') {
          task.progress = Math.min(68, Math.round(45 + (ev.value / ev.max) * 23));
          task.message = `[阶段二] 分镜一渲染中：迎面走姿 (采样 ${ev.value}/${ev.max})...`;
        } else if (ev.node === '86') {
          task.progress = Math.min(92, Math.round(70 + (ev.value / ev.max) * 22));
          task.message = `[阶段二] 分镜二渲染中：45°转体特写 (采样 ${ev.value}/${ev.max})...`;
        }
      } else if (ev.type === 'node_change') {
        if (ev.node === '89' || ev.node === '80') {
          task.progress = 95;
          task.message = '[阶段二] 分镜拼接与混音导出中...';
        }
      }
    });

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

    // Fallback retry loop in COMFY_TEMP_OUTPUT_DIR
    if (!finalVideoFilename) {
      const searchPrefix = `outfit_${task.scene.id}_10s_${taskId}`;
      for (let retry = 0; retry < 50; retry++) {
        if (fs.existsSync(COMFY_TEMP_OUTPUT_DIR)) {
          const outFiles = fs.readdirSync(COMFY_TEMP_OUTPUT_DIR).filter(f => f.startsWith(searchPrefix));
          const audioMp4 = outFiles.find(f => f.endsWith('-audio.mp4'));
          const plainMp4 = outFiles.find(f => f.endsWith('.mp4'));
          if (audioMp4 || plainMp4) {
            finalVideoFilename = audioMp4 || plainMp4;
            break;
          }
        }
        await new Promise(r => setTimeout(r, 600));
      }
    }

    if (!finalVideoFilename) {
      throw new Error('MiniMax H3 视频文件生成超时或未正常保存。');
    }

    // Move / copy video and preview thumbnail to PROJECT_VIDEO_DIR (project storage)
    const srcVideoPath = path.join(COMFY_OUTPUT_DIR, finalVideoSubfolder, finalVideoFilename);
    const dstVideoPath = path.join(PROJECT_VIDEO_DIR, finalVideoFilename);
    fs.copyFileSync(srcVideoPath, dstVideoPath);

    const previewName = finalVideoFilename.replace(/-audio\.mp4$|\.mp4$/, '.png');
    const srcPreviewPath = path.join(COMFY_OUTPUT_DIR, finalVideoSubfolder, previewName);
    if (fs.existsSync(srcPreviewPath)) {
      fs.copyFileSync(srcPreviewPath, path.join(PROJECT_VIDEO_DIR, previewName));
    }

    task.videoUrl = `/outputs/videos/${finalVideoFilename}`;
    task.status = 'completed';
    task.progress = 100;
    task.message = '展示视频生成完成。';
  } finally {
    // Start the idle timer only after the final ComfyUI workflow has settled.
    noteGenerationActivity();

    // Thorough cleanup: Ensure NO temporary files are left behind inside ComfyUI directories
    try {
      if (dstTempInputPath && fs.existsSync(dstTempInputPath)) fs.unlinkSync(dstTempInputPath);
      if (dstTempModelPath && fs.existsSync(dstTempModelPath)) fs.unlinkSync(dstTempModelPath);
      if (dstTempScenePath && fs.existsSync(dstTempScenePath)) fs.unlinkSync(dstTempScenePath);
      if (dstStagedH3Path && fs.existsSync(dstStagedH3Path)) fs.unlinkSync(dstStagedH3Path);
      // Scan temp dir AND output root — all files this task produced carry the taskId
      for (const outDir of [COMFY_TEMP_OUTPUT_DIR, COMFY_OUTPUT_DIR]) {
        if (!fs.existsSync(outDir)) continue;
        const remaining = fs.readdirSync(outDir).filter(f => f.includes(taskId));
        for (const f of remaining) {
          try {
            fs.unlinkSync(path.join(outDir, f));
          } catch(e) {}
        }
      }
    } catch(e) {
      console.warn('Temp cleanup warning:', e.message);
    }
  }
}

// Friendly JSON errors for malformed/oversized bodies
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: '请求体不是有效的 JSON' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体过大（上限 1MB）' });
  }
  res.status(500).json({ error: err && err.message ? err.message : '服务器内部错误' });
});

const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(`AI Fashion Studio Web UI is running at:`);
  console.log(`Local:   http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const net of nets) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`Network: http://${net.address}:${PORT}`);
        }
      }
    }
  }
  console.log(`ComfyUI: ${COMFY_URL}`);
  console.log(`=======================================================`);
});
