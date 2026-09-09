const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { randomUUID: uuidv4 } = require('crypto');
const os = require('os');
const { getSafeConfig, saveConfig, testOpenAiConnection } = require('./services/config');
const { generateReferenceImage } = require('./services/imagegen');

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
// Model style presets — 9 differentiated signatures (bone structure / skin / hair /
// gaze quality / posture). Gaze DIRECTION and face angle stay scene-specific;
// modifiers only carry gaze quality, never where the model looks.
const MODEL_STYLES = {
  classic: {
    name: '高级名模',
    female: 'with sculpted high-fashion supermodel presence, poised regal bearing, composed magnetic gaze, naturally closed lips without tension, and effortless commanding runway posture',
    male: 'with high-fashion supermodel charisma, composed magnetic gaze, naturally closed lips without tension, and commanding runway posture'
  },
  sweet: {
    name: '甜美清新',
    female: 'with sweet youthful charm, bright sparkling eyes full of gentle warmth, dewy fresh skin, naturally closed lips with a faint serene tenderness, and graceful airy posture',
    male: 'with clean boyish charm, soft warm eye expression, fresh dewy skin, naturally closed lips without tension, and light approachable posture'
  },
  athletic: {
    name: '运动活力',
    female: 'with healthy athletic vitality, sun-kissed glowing skin and toned posture, bright focused determined eyes, naturally closed lips with composed confidence, and grounded energetic stance',
    male: 'with athletic vigor, toned build and sun-kissed skin, sharp focused gaze, naturally closed lips without tension, and upright powerful stance'
  },
  mature: {
    name: '成熟御姐',
    female: 'with commanding mature elegance, knowing confident warmth in the eyes, luminous smooth skin, naturally closed lips with serene authority, and statuesque poised posture',
    male: 'with distinguished executive presence, calm assured gaze, naturally closed lips without tension, and commanding confident posture'
  },
  cool: {
    name: '中性酷感',
    female: 'with chic androgynous edge, sharp minimal attitude, cool detached yet engaged gaze, naturally closed lips without tension, and effortless nonchalant posture',
    male: 'with contemporary streetwear edge, understated cool attitude, naturally closed lips without tension, and relaxed confident posture'
  },
  youthful: {
    name: '元气阳光',
    female: 'with lively youthful energy, bright sparkling eyes radiating cheerful vitality, fresh glowing skin, naturally closed lips with a bright cheerful spirit, and light springy posture',
    male: 'with sunny youthful energy, bright lively eyes and fresh open expression, glowing healthy skin, naturally closed lips without tension, and light energetic posture'
  },
  intellectual: {
    name: '温柔知性',
    female: 'with gentle intellectual grace, serene thoughtful eyes carrying quiet depth, soft minimal styling, clean natural makeup look, naturally closed lips with calm composure, and understated elegant posture',
    male: 'with refined scholarly warmth, calm thoughtful gaze and gentle steady presence, clean minimal styling, naturally closed lips without tension, and composed graceful posture'
  },
  french: {
    name: '法式浪漫',
    female: 'with effortless Parisian chic, relaxed romantic air, naturally glowing minimal makeup, warm subtle gaze, naturally closed lips with serene charm, and breezy nonchalant elegance in posture',
    male: 'with relaxed Parisian elegance, easygoing romantic air, warm understated gaze, naturally closed lips without tension, and breezy confident posture'
  },
  retro: {
    name: '复古港风',
    female: 'with 1990s Hong Kong cinematic glamour, luminous warm skin, magnetic star-quality gaze, naturally closed lips with poised mystique, and iconic timeless posture',
    male: 'with 1990s Hong Kong cinematic charisma, luminous warm skin, magnetic film-star gaze, naturally closed lips without tension, and iconic screen-presence posture'
  },
  petite: {
    name: '小巧可爱',
    female: 'with petite adorable charm, small slim frame and fine-boned delicate figure, big bright expressive eyes, smooth dewy skin, naturally closed lips with playful cuteness, and cute perky posture',
    male: 'with cute boyish charm, small lean frame, bright lively eyes, fresh clear skin, naturally closed lips without tension, and playful relaxed posture'
  }
};

// 发型库：与模特风格、场景解耦的独立维度；男女各一条英文描述。
const HAIRSTYLES = {
  natural: { name: '长发披肩', female: 'soft natural long hair falling loosely over the shoulders', male: 'neat natural short hair' },
  wavy: { name: '大波浪', female: 'long loose wavy hair with soft natural movement', male: 'short wavy textured hair' },
  ponytail: { name: '高马尾', female: 'a high sleek ponytail', male: 'clean short hair swept back' },
  bob: { name: '齐脖波波头', female: 'a fluffy chin-length bob', male: 'clean cropped short hair' },
  bun: { name: '低盘发', female: 'a neat low bun updo', male: 'closely cropped short hair' },
  pixie: { name: '利落短发', female: 'a sharp cropped pixie cut', male: 'a clean buzz-cut short hairstyle' }
};

// 脸型库：独立维度，男女各一条。
const FACE_SHAPES = {
  oval: { name: '鹅蛋脸', female: 'a soft balanced oval face', male: 'a balanced oval face' },
  vline: { name: '小V脸', female: 'a slim tapered V-line face with a delicate chin', male: 'a sharp tapered V-line face' },
  round: { name: '圆润脸', female: 'a soft rounded face with full cheeks', male: 'a softly rounded boyish face' },
  square: { name: '立体方脸', female: 'a defined square-jaw face with clean bone structure', male: 'a chiseled square-jaw face' },
  heart: { name: '心形脸', female: 'a heart-shaped face with a wide forehead and delicate pointed chin', male: 'a heart-shaped face with a tapered chin' },
  long: { name: '清瘦长脸', female: 'a slender elongated face with high cheekbones', male: 'a lean long face with defined cheekbones' }
};

// Scene-specific subject base + gender-aware style modifier + independent hair/face dims.
function styledSubject(gender, style, femaleBase, maleBase, customStylePrompt = null, hairKey = 'natural', faceKey = 'oval') {
  const isM = gender === 'male';
  const base = isM ? maleBase : femaleBase;
  const g = isM ? 'male' : 'female';
  const face = (FACE_SHAPES[faceKey] || FACE_SHAPES.oval)[g];
  const hair = (HAIRSTYLES[hairKey] || HAIRSTYLES.natural)[g];
  if (customStylePrompt && typeof customStylePrompt === 'string' && customStylePrompt.trim()) {
    const trimmed = customStylePrompt.trim();
    const head = trimmed.startsWith(',') || trimmed.startsWith('with ') ? base + ' ' + trimmed : base + ', ' + trimmed;
    return head + ', ' + face + ', and ' + hair;
  }
  const s = MODEL_STYLES[style] || MODEL_STYLES.classic;
  const modifier = isM ? s.male : s.female;
  const modBody = modifier.startsWith('with ') ? modifier.slice(5) : modifier;
  return base + ' with ' + face + ', ' + modBody + ', and ' + hair;
}

// ---- H3 视频提示词骨架、场景氛围与动作库 ----
// 结构规律（从生活感样例提炼）：身份锁定 → 秒级时间轴节拍 → 表情纪律 →
// 真实人体动态 → 服装与手部 → 镜头纪律 → 画面质感 → 去AI味黑名单 →
// 最终效果 → 音频。
// 场景（H3_SCENE_CFG）决定环境氛围与锁定清单；动作（H3_ACTIONS）决定编排节拍、
// 视线、镜头与动作音效。每条动作=一段5秒编排，均为状态中立写法，
// 分镜一/分镜二可自由组合；'random' 每次生成随机抽取，避免千篇一律。
const H3_SCENE_CFG = {
  street: {
    title: '阳光都市街拍',
    lock: '服装与鞋履细节、街边建筑背景、自然日光、构图、镜头焦段和整体摄影质感',
    shot: '街拍摄影师跟拍',
    ambience: '远处隐约的城市街道环境音'
  },
  studio: {
    title: '极简纯色影棚',
    lock: '服装与鞋履细节、纯色无影墙背景、柔光箱光线、构图、镜头焦段和整体摄影质感',
    shot: '影棚摄影师掌机记录',
    ambience: '安静的影棚房间底噪'
  },
  office: {
    title: '摩天楼职场通勤',
    lock: '服装与鞋履细节、现代玻璃幕墙大堂背景、晨光、构图、镜头焦段和整体摄影质感',
    shot: '写字楼大堂内的跟拍',
    ambience: '开阔的大堂空间环境音，轻微的声学混响'
  },
  boutique: {
    title: '高端艺术买手店',
    lock: '服装与鞋履细节、大理石与黄铜买手店背景、暖色射灯光线、构图、镜头焦段和整体摄影质感',
    shot: '买手店内的跟拍',
    ambience: '安静的精品店室内环境音，轻微的声学混响'
  },
  outdoor: {
    title: '自然户外林荫',
    lock: '服装与鞋履细节、公园林荫石板路背景、树影与自然光、构图、镜头焦段和整体摄影质感',
    shot: '公园林荫里的跟拍',
    ambience: '户外微风拂过树叶的沙沙声，远处隐约的鸟鸣'
  },
  cafe: {
    title: '现代极简咖啡厅',
    lock: '服装与鞋履细节、咖啡馆木质背景与落地窗、自然暖光、构图、镜头焦段和整体摄影质感',
    shot: '咖啡馆里的跟拍',
    ambience: '咖啡馆远处轻微的人声底噪，隐约的咖啡机蒸汽声'
  },
  custom: {
    title: '自定义专属场景',
    lock: '服装与鞋履细节、背景环境与光线氛围、构图、镜头焦段和整体摄影质感',
    shot: '生活场景跟拍',
    ambience: '与场景匹配的真实环境底噪'
  }
};

// 动作库：每条动作 = 一段5秒编排。节拍为状态中立写法，可填进任意分镜。
const H3_ACTIONS = {
  walk: {
    id: 'walk',
    name: '迎面走姿',
    description: '模特迎面走向镜头，步伐自然有惯性，适合展示全身穿搭与整体气质',
    beats: `0.00－1.50秒
模特从当前站位自然起步，在首帧场景中迎面走向镜头。
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
    camera: '与模特视线等高的稳定后撤跟拍：镜头随模特同步平稳后撤，保持全身构图完整。\n不要推镜，不要拉镜，不要摇镜，不要环绕，不要突然变焦。\n焦点稳定在模特的脸部和服装上，背景虚化与首帧一致。',
    recap: '她迎面自然走来，步伐真实有惯性，眼神与镜头自然交流，服装与场景与首帧完全一致。',
    sound: '清晰有节奏的脚步声，衣物面料随步伐的轻微摆动声'
  },
  turn45: {
    id: 'turn45',
    name: '45°转体展示',
    description: '停步后45度转身展示服装侧面与背面细节，结尾回眸看镜头',
    beats: `0.00－1.50秒
模特自然放慢动作，平稳停下，双脚稳稳落地踩实。
停步不是急刹车，而是像真实走秀结束那样带着惯性缓缓收住。
她保持放松从容的状态，肩背舒展。

1.50－3.20秒
她以重心脚为轴，自然连贯地完成一个约45度的转身。
转身时肩膀、腰部、腿部协同运动，重心转移真实，不要像机器人一样只旋转上半身。

3.20－5.00秒
转身后她稳定站定，展示服装的侧面与背面剪裁、面料垂感与缝线细节，随后自然回头看镜头，与镜头保持从容对视。`,
    eye: '转身站定后回头看镜头，眼神自然先有注视，再带出一点柔和的笑意，不要突然切换表情。',
    camera: '稳定的慢速横移：镜头以平稳慢速的横移拍摄转身过程，突出面料、缝线与剪裁细节。\n不要突然运镜，不要变焦，不要环绕。\n焦点始终稳定在模特身上。',
    recap: '她平稳停步、自然完成45度转身，服装细节清晰稳定，随后回头与镜头从容对视。',
    sound: '鞋底轻轻的转身摩擦声，衣物随转身的轻微摆动声'
  },
  pose: {
    id: 'pose',
    name: '定点造型展示',
    description: '原地微动态造型，靠呼吸、重心转移与神态变化突出面料细节',
    beats: `0.00－1.50秒
模特保持当前站位，在原地自然呼吸，重心轻轻从一条腿换到另一条腿。
不要僵硬站立，也不要开始走动。
她保持放松从容的状态，肩背舒展，眼神柔和地看向镜头。

1.50－3.80秒
她保持原地，头部缓慢自然地微微偏向一侧，肩膀随之有细微的松弛变化。
身体像真实等待拍照间隙的人一样自然松弛，手指有非常轻微的自然屈伸。
动作幅度很小，全部是微动态，没有大幅度肢体动作。

3.80－5.00秒
她把重心稳稳放回双脚，姿态落定，保持与镜头柔和从容的对视。
不是突然定格，而是像呼吸一样自然收住。`,
    eye: '与镜头保持自然对视，眼神放松而有生气，允许非常细微的注视角度变化。',
    camera: '固定机位：机位固定不动，保持全身构图完整，靠模特的微动态让画面有生命感。\n不要推镜，不要拉镜，不要摇镜，不要变焦，不要环绕。\n焦点稳定在模特的脸部和服装上。',
    recap: '她原地站立，用真实的呼吸、重心转移和细微神态让画面有生命感，服装细节清晰稳定。',
    sound: '极轻微的衣物面料摩擦声'
  },
  turnshow: {
    id: 'turnshow',
    name: '原地转身展示',
    description: '原地缓慢转身，完整展示正、侧、背面服装细节，结尾回眸',
    beats: `0.00－1.50秒
模特保持当前站位，开始以重心脚为轴非常缓慢地原地转身，把身体朝向缓缓转向侧面。
转动速度均匀而缓慢，带着真实的重量转移，不要机械旋转。

1.50－3.80秒
她继续缓慢转身，逐步展示服装的侧面剪裁与背面做工，面料垂感随转身自然流动。
转身过程中肩膀、腰部、腿部协同运动，头部随转身自然移动。

3.80－5.00秒
她稳稳定住，随后自然回头看镜头，与镜头保持从容对视，服装细节全程清晰稳定。`,
    eye: '转身定住后回头看镜头，眼神自然先有注视，再带出一点柔和的笑意。',
    camera: '固定机位：机位固定不动，完整记录原地转身过程，保持全身构图完整。\n不要推镜，不要拉镜，不要变焦，不要环绕。\n焦点始终稳定在模特身上。',
    recap: '她在原地缓慢转身，完整展示服装的正面、侧面与背面细节，最后回头与镜头从容对视。',
    sound: '鞋底缓慢转动的轻微摩擦声，衣料随转身的自然摆动声'
  },
  sidestep: {
    id: 'sidestep',
    name: '侧向漫步',
    description: '侧向轻盈漫步后转身定住，适合展示侧面剪裁与动态面料',
    beats: `0.00－1.50秒
模特保持放松状态，开始以缓慢轻盈的横向步伐向画面一侧移动两三步。
起步自然：第一步小而轻，身体朝向保持侧对镜头。
她的肩背保持舒展，眼神自然扫向镜头。

1.50－3.80秒
她以从容的节奏继续横向移动，步幅小而稳，重心平顺过渡。
不要匀速机械移动，每一步都有真实的落地与惯性。
双臂在身体两侧自然摆动，摆动幅度比正常行走更小。

3.80－5.00秒
她停下横向移动，身体自然转向镜头，重心落定，保持柔和从容的对视。
停顿带着真实惯性，缓缓收住。`,
    eye: '横向移动中以侧对镜头的视线自然扫向镜头，停步后转为柔和从容的正面注视。',
    camera: '固定机位或极轻微的稳定横移：完整记录侧向移动，保持全身构图完整。\n不要推镜，不要拉镜，不要突然变焦，不要环绕。\n焦点始终稳定在模特身上。',
    recap: '她以轻盈的横向步伐从容移动，身体转向镜头定住，像真实抓拍的漫步瞬间。',
    sound: '轻缓的横向脚步声，衣物随步伐的轻微摆动声'
  }
};

const H3_ACTION_IDS = Object.keys(H3_ACTIONS);
// 保留 'random' 原样入库，具体动作在生成时解析
const normTaskAction = (a, fallback) => (a === 'random' || H3_ACTIONS[a]) ? a : fallback;

// 按【最高优先级】→【5秒核心动作】→【表情与眼神】→【真实人体动态】
// →【服装与手部】→【镜头】→【画面质感】→【严格去除AI味】→【最终效果】→【音频】
// 组装单个分镜提示词；她/他按性别替换；分镜二自动加承接句。
function h3SegPrompt(sceneId, actionId, seg, isM, extra = '') {
  const cfg = H3_SCENE_CFG[sceneId] || H3_SCENE_CFG.custom;
  const act = H3_ACTIONS[actionId] || H3_ACTIONS.walk;
  const pro = isM ? '他' : '她';
  const segTitle = seg === 1 ? '分镜一' : '分镜二';
  const opener = seg === 2 ? '承接上一镜的动作与站位，画面保持连续。\n\n' : '';
  const beats = opener + act.beats.split('她').join(pro);
  const eye = act.eye.split('她').join(pro);
  const camera = act.camera.split('她').join(pro);
  const recap = act.recap.split('她').join(pro);
  const audio = `${cfg.ambience}，${act.sound}。`;
  let p = `生成一段5秒、真人写实、自然生活感时尚短视频，适用于 Minimax H3 首帧续写。${cfg.title}·${segTitle}·${act.name}。

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
身体重心随动作自然转移；
每个动作都有真实的力度与幅度变化；
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
双手放松、全程自然可见，手指自然张开，不插兜、不握拳。

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
${audio}`;
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
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish East Asian female editorial model', 'stylish East Asian male editorial model', customStylePrompt, hairKey, faceKey);
      const pro = isM ? 'he' : 'she';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length on a sunlit city street sidewalk with historic brownstone buildings, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus, with a soft intimate POV feeling. Direct eye contact with the viewer, head in a gentle three-quarter turn, gaze connecting naturally. Relaxed editorial stance, subtle natural weight shift to one hip, shoulders soft and open, waistline and long legs forming gentle lines, posture relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body editorial fashion lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the concrete sidewalk with realistic soft ground contact shadows beneath footwear. Serene composed expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Clean directional summer sunlight casting soft realistic ground shadows, neutral-to-warm daylight, ivory and cream clothing staying true to tone, brick and pavement colors remaining faithful, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering on cheeks, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, f/2.8, subtle organic film grain, intimate POV with the viewer standing close${extra}`
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
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'professional East Asian female model', 'professional East Asian male model', customStylePrompt, hairKey, faceKey);
      const pro = isM ? 'he' : 'she';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in a clean minimalist studio against a neutral grey cyclorama backdrop, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Slightly lowered chin with eyes lifted toward the lens, a quiet intimate gaze. Elegant upright posture, body turned a quarter away from camera, shoulders soft and open, waistline forming gentle lines, posture relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body editorial catalogue lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the matte studio floor with realistic soft ground contact shadows beneath footwear. Serene composed editorial expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Diffuse softbox studio lighting with soft shadow falloff, clean neutral-to-warm color balance, ivory and cream clothing staying true to tone, grey backdrop remaining faithful, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering on cheeks, natural catchlights in the eyes, tactile cloth texture and seam details. Props stay small and secondary if present. Shot on 50mm lens, subtle organic film grain, soft contact shadows, intimate POV with the viewer standing close${extra}`
      };
    }
  },
  office: {
    id: 'office',
    name: '摩天楼职场通勤',
    enName: 'Executive Urban Commuter',
    icon: 'building',
    description: '现代玻璃幕墙大厦大堂，晨光透射，干练优雅的商务编辑感',
    sceneEnvironment: 'in the quiet morning lobby of a modern glass corporate skyscraper with a low reception counter and a few potted plants, polished granite floors with subtle realistic reflections, soft daylight through the tall glass curtain wall',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'chic East Asian businesswoman', 'chic East Asian businessman', customStylePrompt, hairKey, faceKey);
      const pro = isM ? 'he' : 'she';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in the quiet morning lobby of a modern glass corporate skyscraper with a low reception counter nearby and polished granite floors, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Calm three-quarter eye contact with confident professional warmth, head turned just enough to show the jawline. Composed executive stance, posture relaxed but intentional, shoulders soft and open, waistline visible beneath tailored garments, long legs forming clean lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body executive lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the polished granite floor with realistic soft ground contact shadows beneath footwear and subtle diffuse ambient floor sheen. Naturally closed lips without tension, relaxed natural jawline, soft natural hair. Soft diffuse morning daylight through the tall glass curtain wall, clean neutral-to-warm light, granite and glass tones staying faithful, clothing colors remaining true to tone, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile leather grain and fabric drape. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`
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
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'graceful East Asian female fashion model', 'graceful East Asian male fashion model', customStylePrompt, hairKey, faceKey);
      const pro = isM ? 'he' : 'she';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in a luxury designer concept boutique with polished Italian marble floors and minimalist brass fixtures, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Soft upward gaze catching warm spotlight reflections, composed direct eye contact with the viewer. Graceful weight on one leg, torso softly angled, shoulders and waistline forming refined elegant lines, posture relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body luxury retail lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the polished marble floor with realistic soft ground contact shadows beneath footwear and subtle diffuse floor sheen. Serene composed expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Warm 3200K architectural recessed spotlights with soft falloff, clean neutral-to-warm color balance, marble and brass tones staying faithful, clothing colors remaining true to tone, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and leather grain. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`
      };
    }
  },
  outdoor: {
    id: 'outdoor',
    name: '自然户外林荫',
    enName: 'Nature Sunlight & Garden',
    icon: 'leaf',
    description: '绿意盎然的公园石板路与林荫微风，柔和眼神回眸与浪漫编辑感',
    sceneEnvironment: 'on a quiet tree-lined park path with uneven weathered stone pavers, mature green trees and low hedges, scattered fallen leaves, soft diffused daylight through the leaves with gentle natural shadow patches',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'natural East Asian female model', 'natural East Asian male model', customStylePrompt, hairKey, faceKey);
      const pro = isM ? 'he' : 'she';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length on a quiet tree-lined park path with uneven weathered stone pavers, mature green foliage and low hedges, a few scattered fallen leaves on the ground, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. A side glance over the shoulder with maintained eye contact, face angle varied and alive. Peaceful relaxed stance beside natural park greenery, posture fluid and natural, shoulders soft and open, waistline visible, long legs forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body lifestyle lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the stone pavers with realistic soft ground contact shadows beneath footwear. Serene gentle expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Soft diffused outdoor daylight filtering through the tree canopy, gentle organic shadow patches on the path, clean neutral-to-warm color balance, green foliage staying true to tone without oversaturation, worn stone colors remaining faithful, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile cloth folds and texture. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`
      };
    }
  },
  cafe: {
    id: 'cafe',
    name: '现代极简咖啡厅',
    enName: 'Lifestyle Nordic Cafe',
    icon: 'coffee',
    description: '落地窗暖调咖啡馆，慵懒而亲密的生活编辑感',
    sceneEnvironment: 'in a cozy modern cafe with warm timber oak interiors, a few simple wooden tables and chairs, and large floor-to-ceiling windows, soft natural daylight through the windows',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish East Asian young woman', 'stylish East Asian young man', customStylePrompt, hairKey, faceKey);
      const pro = isM ? 'he' : 'she';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in a cozy modern cafe with warm timber oak interiors, a few simple wooden tables and chairs, and large floor-to-ceiling windows, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Chin softly lifted, head turned three-quarters toward the lens, warm approachable eye contact. Casual editorial stance near the window, body language relaxed but intentional, shoulders soft and open, posture forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body cozy editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on the hardwood floor with realistic soft ground contact shadows beneath footwear. Relaxed serene expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Warm natural window light with soft interior fill, clean neutral-to-warm color balance, warm oak and cream tones staying faithful, without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile knit and fabric weave. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`
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
    buildPrompts: (gender = 'female', customPrompt = '', customScene = '', style = 'classic', customStylePrompt = '', hairKey = 'natural', faceKey = 'oval') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish East Asian female editorial model', 'stylish East Asian male editorial model', customStylePrompt, hairKey, faceKey);
      const pro = isM ? 'he' : 'she';
      const rawScene = (customScene && customScene.trim()) ? customScene.trim() : 'an aesthetic commercial fashion lookbook background';
      const sceneDesc = /^(in|on|at|against|under|near|along)\s+/i.test(rawScene)
        ? rawScene
        : `in ${rawScene}`;
      const extra = customPrompt ? `, ${customPrompt}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length ${sceneDesc}, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Soft direct eye contact with a warm genuine presence, face angle natural and alive. Elegant confident posture, body language relaxed but intentional, shoulders soft and open, waistline visible, posture forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on ground with realistic soft ground contact shadows beneath footwear. Serene composed expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Realistic natural lighting consistent with the environment, clean neutral-to-warm color balance, clothing and background colors remaining faithful without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`
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
  scene_image = null,
  action1 = 'random',
  action2 = 'random',
  hair_style = 'natural',
  face_shape = 'oval'
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
    cleanCustomModelStyle,
    hair_style,
    face_shape
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
    const subj = styledSubject(gender, modelStyleKey, 'stylish female model', 'stylish male model', cleanCustomModelStyle, hair_style, face_shape);
    kreaPrompt = `Create an editorial lookbook portrait of a ${subj} standing full-length in the background environment from the first reference image, wearing the exact clothing and outfit from the second reference image, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${isM ? 'He' : 'She'} is the clear visual focus with a soft intimate POV feeling. Soft direct eye contact with warm genuine presence, face angle natural and alive. Elegant confident posture, body language relaxed but intentional, shoulders soft and open, waistline visible, posture forming gentle lines. Full body editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on ground with realistic soft ground contact shadows beneath footwear, arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers, subtle natural weight shift. Serene composed expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Realistic illumination matched to the background environment, clean neutral-to-warm color balance, clothing and background colors remaining faithful without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain${cleanCustom ? ', ' + cleanCustom : ''}`;
  }

  let a1 = normTaskAction(action1, 'random');
  let a2 = normTaskAction(action2, 'random');
  // 随机抽动作：双随机时避免两分镜抽到同一条，最大化组合多样性
  if (a1 === 'random') a1 = H3_ACTION_IDS[Math.floor(Math.random() * H3_ACTION_IDS.length)];
  if (a2 === 'random') {
    a2 = H3_ACTION_IDS[Math.floor(Math.random() * H3_ACTION_IDS.length)];
    if (a1 === a2 && H3_ACTION_IDS.length > 1) {
      a2 = H3_ACTION_IDS[(H3_ACTION_IDS.indexOf(a1) + 1) % H3_ACTION_IDS.length];
    }
  }

  return {
    krea_prompt: kreaPrompt,
    seg1_prompt: h3SegPrompt(sceneConfig.id, a1, 1, isM, cleanCustom),
    seg2_prompt: h3SegPrompt(sceneConfig.id, a2, 2, isM, cleanCustom),
    actions: { seg1: a1, seg2: a2 }
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

app.get('/api/actions', (_req, res) => {
  res.json(Object.values(H3_ACTIONS).map(a => ({ id: a.id, name: a.name, description: a.description })));
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

// Configuration Endpoints for Engines (OpenAI, Krea, etc.)
app.get('/api/config', (req, res) => {
  try {
    res.json(getSafeConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config', (req, res) => {
  try {
    const updated = saveConfig(req.body || {});
    res.json({ success: true, config: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config/test', async (req, res) => {
  try {
    const { apiKey, baseUrl } = req.body || {};
    const result = await testOpenAiConnection(apiKey, baseUrl);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
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
      scene_image = null,
      action1 = 'random',
      action2 = 'random',
      hair_style = 'natural',
      face_shape = 'oval'
    } = req.body || {};

    const prompts = computeTaskPrompts({
      scene,
      gender,
      model_style,
      model_style_prompt,
      custom_scene,
      custom_prompt,
      model_image,
      scene_image,
      action1,
      action2,
      hair_style,
      face_shape
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
    still_engine = 'krea2',
    krea_prompt = null,
    seg1_prompt = null,
    seg2_prompt = null,
    action1 = 'random',
    action2 = 'random',
    hair_style = 'natural',
    face_shape = 'oval'
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
    still_engine: (still_engine === 'gpt_image_2' ? 'gpt_image_2' : 'krea2'),
    custom_krea_prompt: typeof krea_prompt === 'string' && krea_prompt.trim() ? krea_prompt.trim() : null,
    custom_seg1_prompt: typeof seg1_prompt === 'string' && seg1_prompt.trim() ? seg1_prompt.trim() : null,
    custom_seg2_prompt: typeof seg2_prompt === 'string' && seg2_prompt.trim() ? seg2_prompt.trim() : null,
    aspect_ratio,
    image: sanitizedImage,
    model_image: sanitizedModelImage,
    scene_image: isCustomScene ? sanitizedSceneImage : null,
    action1: normTaskAction(action1, 'random'),
    action2: normTaskAction(action2, 'random'),
    hair_style: HAIRSTYLES[hair_style] ? hair_style : 'natural',
    face_shape: FACE_SHAPES[face_shape] ? face_shape : 'oval',
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
    still_engine = 'krea2',
    krea_prompt = null,
    seg1_prompt = null,
    seg2_prompt = null,
    action1 = 'random',
    action2 = 'random',
    hair_style = 'natural',
    face_shape = 'oval'
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
      still_engine: (still_engine === 'gpt_image_2' ? 'gpt_image_2' : 'krea2'),
      custom_krea_prompt: isTargetScene && typeof krea_prompt === 'string' && krea_prompt.trim() ? krea_prompt.trim() : null,
      custom_seg1_prompt: isTargetScene && typeof seg1_prompt === 'string' && seg1_prompt.trim() ? seg1_prompt.trim() : null,
      custom_seg2_prompt: isTargetScene && typeof seg2_prompt === 'string' && seg2_prompt.trim() ? seg2_prompt.trim() : null,
      aspect_ratio,
      image: sanitizedImage,
      model_image: sanitizedModelImage,
      scene_image: scKey === 'custom' ? sanitizedSceneImage : null,
      action1: normTaskAction(action1, 'random'),
      action2: normTaskAction(action2, 'random'),
      hair_style: HAIRSTYLES[hair_style] ? hair_style : 'natural',
      face_shape: FACE_SHAPES[face_shape] ? face_shape : 'oval',
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

  if (task.still_engine !== 'gpt_image_2' && !fs.existsSync(kreaWfPath)) {
    throw new Error('Required Krea-2 workflow JSON template not found on server.');
  }
  if (task.mode !== 'still_only' && !fs.existsSync(h3WfPath)) {
    throw new Error('Required MiniMax H3 workflow JSON template not found on server.');
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
    face_shape: task.face_shape
  });

  const finalKreaPrompt = (task.custom_krea_prompt && task.custom_krea_prompt.trim()) || autoPrompts.krea_prompt;
  const finalSeg1Prompt = (task.custom_seg1_prompt && task.custom_seg1_prompt.trim()) || autoPrompts.seg1_prompt;
  const finalSeg2Prompt = (task.custom_seg2_prompt && task.custom_seg2_prompt.trim()) || autoPrompts.seg2_prompt;

  const sceneDisplayName = task.scene.id === 'custom'
    ? (cleanCustomScene ? `自定义场景: ${cleanCustomScene.slice(0, 16)}` : '自定义专属场景')
    : task.scene.name;

  // File paths to track for reliable cleanup
  const stagedH3Name = `staged_${taskId}.png`;
  const dstStagedH3Path = path.join(COMFY_TEMP_INPUT_DIR, stagedH3Name);

  try {
    // -------------------------------------------------------------
    // STAGE 1: Reference Still Image Generation (~20s)
    // Supports Krea-2 (ComfyUI) or GPT Image 2 (OpenAI)
    // -------------------------------------------------------------
    task.status = 'running';
    task.progress = 10;
    const engineLabel = task.still_engine === 'gpt_image_2' ? 'GPT Image 2' : 'Krea-2';
    const modelTag = task.model_image ? ' · 指定模特主角' : ` · ${MODEL_STYLES[task.model_style].name}`;
    task.message = `[阶段一] 正在生成模特试衣定妆照 (${sceneDisplayName}${modelTag} · ${engineLabel})...`;

    const stillResult = await generateReferenceImage({
      engine: task.still_engine || 'krea2',
      task,
      taskId,
      prompt: finalKreaPrompt,
      onProgress: (progress, message) => {
        task.progress = progress;
        task.message = message;
      },
      context: {
        projectInputDir: PROJECT_INPUT_DIR,
        projectImageDir: PROJECT_IMAGE_DIR,
        comfyTempInputDir: COMFY_TEMP_INPUT_DIR,
        comfyOutputDir: COMFY_OUTPUT_DIR,
        workflowsDir: WORKFLOWS_DIR,
        aspectCanvas: ASPECT_CANVAS,
        randomSeed,
        detectFlatlayScoreSync,
        requireNodes,
        submitComfyWorkflow: submitComfyWorkflowWithProgress
      }
    });

    task.stillImage = stillResult.webUrl;
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
    const segActionNames = `${H3_ACTIONS[autoPrompts.actions.seg1].name} → ${H3_ACTIONS[autoPrompts.actions.seg2].name}`;
    task.message = `[阶段二] 正在加载视频生成模型（${segActionNames}）...`;

    // Stage still image into ComfyUI temp input for MiniMax H3
    fs.copyFileSync(stillResult.destPath, dstStagedH3Path);

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
