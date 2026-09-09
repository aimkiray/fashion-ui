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
// Model style presets — an attitude/look modifier appended to every scene's
// subject base, tuned specifically for female and male subjects.
const MODEL_STYLES = {
  classic: {
    name: '高级名模',
    female: 'with poised editorial elegance, serene composed expression, mouth closed, closed lips, and relaxed upright posture',
    male: 'with sharp jawline, editorial charisma, calm composed expression, mouth closed, closed lips, and upright natural posture'
  },
  sweet: {
    name: '甜美清新',
    female: 'with fresh-faced youthful purity, serene gentle features, quiet tranquil poise, mouth closed, softly closed lips, calm tender gaze',
    male: 'with clean youthful Korean-style charm, gentle refined features, relaxed natural poise, mouth closed, closed lips, calm subtle gaze'
  },
  athletic: {
    name: '运动活力',
    female: 'with an athletic healthy glow, calm focused expression, mouth closed, closed lips, and upright confident posture',
    male: 'with an athletic toned build, sharp defined features, calm focused expression, mouth closed, closed lips, and upright confident posture'
  },
  mature: {
    name: '成熟御姐',
    female: 'with commanding graceful poise, sophisticated refined features, mouth closed, closed lips, and poised upright posture',
    male: 'with distinguished executive poise, mature handsome features, mouth closed, closed lips, and upright commanding posture'
  },
  cool: {
    name: '中性酷感',
    female: 'with a chic androgynous edge, cool understated attitude, mouth closed, closed lips, and upright lookbook posture',
    male: 'with a modern streetwear edge, cool understated attitude, mouth closed, closed lips, and upright confident posture'
  }
};

// Scene-specific subject base + gender-aware style modifier.
function styledSubject(gender, style, femaleBase, maleBase) {
  const isM = gender === 'male';
  const s = MODEL_STYLES[style] || MODEL_STYLES.classic;
  const modifier = isM ? s.male : s.female;
  return `${isM ? maleBase : femaleBase} ${modifier}`;
}

// Realistic Anti-AI prompt tokens (neutralize plastic skin, mannequin look, and artificial sheen)
const KREA_NEGATIVE_PROMPT_BASE = 'plastic skin, waxy skin, airbrushed, mannequin, 3d render, cgi, over-smoothed skin, doll, ceramic skin, beauty filter, oversaturated, wax figure, artificial sheen, illustration, cartoon, hands in pockets, hands tucked into pockets, hands in pants pockets, hands in jacket pockets, hand in pocket, thumb in pocket, thumbs hooked in pockets, hands tucked in waistband, hand on hip, hands on waist, hidden fingers, hidden hands, hands behind back, missing hands, missing fingers, extra fingers, deformed hands, mutated hands, bad hands, fused fingers, open mouth, teeth, toothy smile, grinning, smiling with teeth, laughing, parted lips, creepy smile, exaggerated facial expression, grimace, cropped feet, cut off feet, cut off shoes, cut off legs, cropped legs, half body, torso only, close-up, cropped head, out of frame, blurry, low quality, distorted clothing, extra limbs, bad anatomy, deformed, duplicate person, watermark, text, signature';

const KREA_NEGATIVE_PROMPT_MODEL_ID = 'plastic skin, waxy skin, airbrushed, mannequin, 3d render, cgi, over-smoothed skin, doll, ceramic skin, beauty filter, oversaturated, wax figure, artificial sheen, illustration, cartoon, hands in pockets, hands tucked into pockets, hands in pants pockets, hands in jacket pockets, hand in pocket, thumb in pocket, thumbs hooked in pockets, hands tucked in waistband, hand on hip, hands on waist, hidden fingers, hidden hands, hands behind back, missing hands, missing fingers, extra fingers, deformed hands, mutated hands, bad hands, fused fingers, face change, different face, unrecognizable face, distorted face, changed hairstyle, deformed facial features, bad face, open mouth, teeth, toothy smile, grinning, smiling with teeth, laughing, parted lips, creepy smile, exaggerated facial expression, cropped feet, cut off feet, cut off shoes, cut off legs, cropped legs, half body, torso only, out of frame, blurry, low quality, distorted clothing, extra limbs, bad anatomy, deformed, duplicate person, watermark, text, signature';

const SCENES = {
  street: {
    id: 'street',
    name: '阳光都市街拍',
    enName: 'Sunny Streetwear Chic',
    icon: 'buildings',
    description: '阳光洒落的都市街头，自然光影景深，充满潮流时尚感',
    sceneEnvironment: 'on a sunlit city street sidewalk with historic brownstone buildings, natural directional sunlight casting soft ground shadows',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish female model', 'handsome male model');
      const pro = isM ? 'he' : 'she';
      const pos = isM ? 'his' : 'her';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length on a sunlit city street sidewalk with historic brownstone buildings, transfer the outfit, full body editorial fashion lookbook photography, head-to-toe framed with complete shoes and feet in view, both arms straight down relaxed naturally at sides, both hands open and fully visible with natural five fingers clearly shown on each hand, serene composed expression, closed lips, natural directional sunlight casting soft realistic ground shadows, authentic human skin texture with visible micro pores, natural skin sheen, fine skin lines, realistic subsurface scattering, tactile fabric weave and seam details, shot on 35mm lens, subtle film grain${extra}`,
        seg1_prompt: `A commercial lookbook fashion video faithful to the reference image: the identical ${subj} wearing the exact outfit from the reference image. Steady gimbal tracking shot at eye level: ${pro} takes slow, measured runway strides forward toward the camera along a sunlit urban asphalt sidewalk (1 step per second), both arms swaying naturally at sides with relaxed open hands. Calm composed lookbook expression with closed lips, subtle relaxed facial features. Natural fabric and leather drape and garment movement swaying organically with each step. Constant directional daylight, sharp textile details, soft circular background bokeh, stable camera framing${extra}.\n\nAudio: distant muffled city traffic hum, crisp footsteps on asphalt sidewalk, subtle soft rustle of clothing fabric swaying as ${pro} walks.`,
        seg2_prompt: `Continuing seamlessly from the previous walk: the same ${subj} in the identical outfit slows ${pos} stride, executing a smooth 45-degree exhibition turn to showcase the side silhouette, drape, and rear tailoring of the clothing, glancing casually toward the lens with a calm serene expression and closed lips. Steady slow 35mm camera pan capturing leather grain, fabric stitching, garment folds, and clean hemlines. Constant natural sunlight, warm city background bokeh, stable facial features, stable anatomy${extra}.\n\nAudio: continuous city ambient background, soft shoe pivot on pavement, quiet fabric flutter, gentle outdoor breeze.`
      };
    }
  },
  studio: {
    id: 'studio',
    name: '极简纯色影棚',
    enName: 'Minimalist Lookbook Studio',
    icon: 'camera',
    description: '纯色摄影棚无影墙，高端柔光箱打光，聚焦面料剪裁与版型结构',
    sceneEnvironment: 'in a clean minimalist studio against a neutral grey cyclorama backdrop, diffuse softbox studio lighting',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish female model', 'handsome male model');
      const pro = isM ? 'he' : 'she';
      const pos = isM ? 'his' : 'her';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a professional ${subj} standing full-length in a clean minimalist studio against a neutral grey cyclorama backdrop, transfer the outfit, full body commercial catalogue lookbook photography, head-to-toe framed with complete shoes and feet in view, both arms straight down relaxed naturally at sides, both hands open and fully visible with natural five fingers clearly shown on each hand, serene composed editorial expression, closed lips, diffuse softbox studio lighting, authentic human skin texture with visible micro pores, natural skin sheen, realistic subsurface scattering on cheeks, tactile cloth texture and seam details, shot on 50mm lens, subtle organic grain, soft ground contact shadow${extra}`,
        seg1_prompt: `A commercial lookbook fashion video faithful to the reference image: the identical ${subj} wearing the exact outfit from the reference image, situated against a pristine neutral grey cyclorama studio backdrop. Smooth motorized camera dolly tracking backward at eye level: ${pro} takes slow, deliberate runway steps forward, both arms swaying naturally at sides with relaxed open hands, with calm poise and closed lips. Sharp garment tailoring, natural cloth and leather physics, ultra-high definition weave and grain, zero shadow pulsing. Uniform dual softbox high-key commercial illumination${extra}.\n\nAudio: dead-quiet soundproof studio room tone, soft rhythmic footsteps on floor, subtle tactile rustle of garment cloth swaying.`,
        seg2_prompt: `Continuing seamlessly from the previous walk: the same ${subj} in the identical outfit smoothly slows ${pos} cadence and executes an elegant 45-degree exhibition turn, allowing the camera to inspect the side silhouette, collar construction, and rear garment cut, pausing with serene poise and closed lips. Tripod steady framing, soft high-key commercial studio lighting, pristine catalogue aesthetic, stable facial features, stable anatomy${extra}.\n\nAudio: quiet soundproof studio room tone, soft shoe pivot on floor, quiet whisper of moving garment fabric.`
      };
    }
  },
  office: {
    id: 'office',
    name: '摩天楼职场通勤',
    enName: 'Executive Urban Commuter',
    icon: 'building',
    description: '现代玻璃幕墙大厦大堂，晨光透射，干练优雅的商务名媛/精英穿搭',
    sceneEnvironment: 'in the grand entrance lobby of a modern glass corporate skyscraper, polished granite floors, morning architectural sunlight filtering through high glass curtain walls',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'chic business professional woman', 'professional businessman');
      const pro = isM ? 'he' : 'she';
      const pos = isM ? 'his' : 'her';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in the grand entrance lobby of a modern glass corporate skyscraper, polished granite floors, transfer the outfit, full body executive lookbook photography, head-to-toe framed with complete shoes and feet in view, both arms straight down relaxed naturally at sides, both hands open and fully visible with natural five fingers clearly shown on each hand, composed executive poise, closed lips, morning architectural sunlight filtering through high glass curtain walls, authentic human skin texture with visible micro pores, natural skin sheen, realistic subsurface scattering, tactile leather grain and fabric drape, shot on 35mm lens, subtle film grain${extra}`,
        seg1_prompt: `A commercial career lookbook video faithful to the reference image: the identical ${subj} wearing the exact outfit from the reference image walking forward through the spacious lobby of a glass corporate skyscraper. Smooth forward tracking shot at eye level: ${pro} walks with confident upright posture, both arms swaying naturally at sides with relaxed open hands, and a calm composed expression with closed lips. Morning sunbeams filtering diagonally through high glass windows, casting clean architectural reflections on the polished floor. Crisp garment lines, natural fabric movement${extra}.\n\nAudio: spacious architectural glass lobby ambiance, subtle acoustic reverberation, crisp confident footsteps echoing gently on polished floor.`,
        seg2_prompt: `Continuing seamlessly from the previous walk: the same ${subj} in the identical outfit halts smoothly near a glass architectural handrail overlooking the skyline, turning 45 degrees to reveal the tailored silhouette, leather grain, back seam construction, and garment drape. ${pro} glances toward the lens with a composed confident expression and closed lips. Steady slow camera glide, constant natural morning illumination, stable facial features, stable anatomy${extra}.\n\nAudio: tranquil glass lobby atmosphere, soft shoe step, quiet fabric motion, distant muted indoor reverberation.`
      };
    }
  },
  boutique: {
    id: 'boutique',
    name: '高端艺术买手店',
    enName: 'Luxury Concept Boutique',
    icon: 'storefront',
    description: '奢华大理石与柔光射灯的高端专柜，极具高级感与面料奢华质感',
    sceneEnvironment: 'in a luxury designer concept boutique with polished Italian marble floors and minimalist brass fixtures, warm 3200K architectural recessed spotlights',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'glamorous female fashion model', 'handsome sophisticated male model');
      const pro = isM ? 'he' : 'she';
      const pos = isM ? 'his' : 'her';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in a luxury designer concept boutique with polished Italian marble floors and minimalist brass fixtures, transfer the outfit, full body luxury retail lookbook photography, head-to-toe framed with complete shoes and feet in view, both arms straight down relaxed naturally at sides, both hands open and fully visible with natural five fingers clearly shown on each hand, serene glamorous gaze, closed lips, warm 3200K architectural recessed spotlights with soft falloff, authentic human skin texture with visible micro pores, natural skin sheen, realistic subsurface scattering, tactile fabric weave and leather grain, shot on 35mm lens, subtle film grain${extra}`,
        seg1_prompt: `A luxury retail commercial lookbook video faithful to the reference image: the identical ${subj} wearing the exact outfit from the reference image in a lavish warm-toned concept boutique with polished Italian marble floors. Smooth camera glide tracking backward at eye level: ${pro} walks gracefully forward with both arms swaying naturally at sides with relaxed open hands, a calm composed expression and closed lips. Warm 3200K architectural spotlights shimmering across fabric textures and clean seams. Fluid motion, perfectly locked anatomy, elegant posture${extra}.\n\nAudio: luxurious quiet boutique interior ambiance, subtle acoustic reverberation, crisp rhythmic footsteps clicking gently on polished marble floor, soft silky cloth rustle.`,
        seg2_prompt: `Continuing seamlessly from the previous walk: the same ${subj} in the identical outfit gently pauses beside an architectural display plinth, turning 45 degrees to showcase the garment silhouette, seam tailoring, and textile craftsmanship. Smooth slow camera pan highlighting the neckline, leather grain, fabric weave, and rear cut. Composed poised lookbook expression, closed lips, constant warm 3200K architectural spotlighting, creamy background bokeh, stable anatomy${extra}.\n\nAudio: warm boutique interior ambiance, gentle soft reverberation, soft shoe pivot on marble, quiet fabric glide.`
      };
    }
  },
  outdoor: {
    id: 'outdoor',
    name: '自然户外林荫',
    enName: 'Nature Sunlight & Garden',
    icon: 'leaf',
    description: '绿意盎然的公园石板路与林荫微风，适合碎花裙、风衣及度假休闲款',
    sceneEnvironment: 'in a lush sun-dappled botanical garden along a smooth stone paver pathway, blooming foliage, natural outdoor daylight, dappled sunbeam highlights',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'radiant female fashion model', 'athletic handsome male model');
      const pro = isM ? 'he' : 'she';
      const pos = isM ? 'his' : 'her';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in a lush sun-dappled botanical garden along a smooth stone paver pathway, blooming foliage, transfer the outfit, full body lifestyle lookbook photography, head-to-toe framed with complete shoes and feet in view, both arms straight down relaxed naturally at sides, both hands open and fully visible with natural five fingers clearly shown on each hand, peaceful serene expression, closed lips, natural outdoor daylight, soft dappled sunlight, authentic human skin texture with visible micro pores, natural skin sheen, realistic subsurface scattering, tactile cloth folds and texture, shot on 35mm lens, subtle film grain${extra}`,
        seg1_prompt: `An outdoor lifestyle fashion lookbook video faithful to the reference image: the identical ${subj} wearing the reference clothing walks forward along a sun-dappled stone path through a lush green park. Steady forward tracking gimbal camera: ${pro} walks at a relaxed natural cadence, both arms swaying naturally at sides with relaxed open hands, with a calm serene expression and closed lips. Sunlight filtering through tree canopies creating gentle dappled patterns across the clothing. Natural cloth and leather physics swaying softly in the fresh outdoor breeze${extra}.\n\nAudio: gentle outdoor breeze rustling green tree leaves, peaceful distant birdsong, soft footsteps on stone pavers, subtle cloth rustle.`,
        seg2_prompt: `Continuing seamlessly from the previous walk: the same ${subj} in the identical outfit pauses beside blooming greenery, turning smoothly 45 degrees to showcase the garment movement, leather grain, fabric drape, and seam tailoring. Serene gentle gaze, closed lips, natural directional sunlight filtered through tree canopies creating a soft rim light on ${pos} silhouette and garment edges. Steady camera pan, stable facial features, stable anatomy${extra}.\n\nAudio: continuous tranquil birdsong, gentle outdoor wind gust, soft stone step, crisp fabric flutter in the breeze.`
      };
    }
  },
  cafe: {
    id: 'cafe',
    name: '现代极简咖啡厅',
    enName: 'Lifestyle Nordic Cafe',
    icon: 'coffee',
    description: '落地窗暖调咖啡馆，慵懒生活气息，适合针织衫、卫衣与日常日常穿搭',
    sceneEnvironment: 'in a cozy Nordic-aesthetic cafe with warm timber oak interiors and large floor-to-ceiling sunlit windows, warm natural daylight and soft interior fill',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish young woman', 'stylish young man');
      const pro = isM ? 'he' : 'she';
      const pos = isM ? 'his' : 'her';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in a cozy Nordic-aesthetic cafe with warm timber oak interiors and large floor-to-ceiling sunlit windows, transfer the outfit, full body cozy editorial lookbook photography, head-to-toe framed with complete shoes and feet in view, both arms straight down relaxed naturally at sides, both hands open and fully visible with natural five fingers clearly shown on each hand, relaxed serene expression, closed lips, warm natural window light with soft interior fill, authentic human skin texture with visible micro pores, natural skin sheen, realistic subsurface scattering, tactile knit and fabric weave, shot on 35mm lens, subtle film grain${extra}`,
        seg1_prompt: `A cozy lifestyle fashion lookbook video faithful to the reference image: the identical ${subj} wearing the exact outfit walks forward with natural poise in an aesthetic Nordic-style cafe near sunlit floor-to-ceiling windows. Smooth eye-level gimbal tracking shot: ${pro} walks at a relaxed pace with both arms swaying naturally at sides with relaxed open hands, a calm peaceful expression and closed lips. Warm timber tones, soft ambient lighting, natural garment drape swaying gently${extra}.\n\nAudio: quiet ambient cafe murmur in the far background, distant gentle hiss of espresso machine steam, soft footsteps on hardwood timber floor, quiet fabric rustle.`,
        seg2_prompt: `Continuing seamlessly from the previous walk: the same ${subj} in the identical outfit pauses beside the sunlit window, turning 45 degrees to reveal the garment silhouette, leather grain, back tailoring, and fabric weave. Smooth camera pan highlighting the collar line, pocket details, and cloth texture. Calm peaceful expression, closed lips, warm daylight, soft shallow depth of field, stable anatomy${extra}.\n\nAudio: gentle cafe room tone, quiet atmospheric background murmur, soft shoe step on wood floor, subtle fabric rustle.`
      };
    }
  },
  custom: {
    id: 'custom',
    name: '自定义专属场景',
    enName: 'Custom Dream Scene',
    icon: 'palette',
    description: '自由描述任意个性化展示背景（海滩落日、雪山木屋、赛博霓虹、古风江南等）',
    sceneEnvironment: 'in an aesthetic commercial fashion lookbook background, natural commercial lighting',
    buildPrompts: (gender = 'female', customPrompt = '', customScene = '', style = 'classic') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish female model', 'handsome male model');
      const pro = isM ? 'he' : 'she';
      const pos = isM ? 'his' : 'her';
      const sceneDesc = (customScene && customScene.trim()) ? customScene.trim() : 'a stunning aesthetic commercial fashion lookbook background';
      const extra = customPrompt ? `, ${customPrompt}` : '';
      return {
        krea_prompt: `a ${subj} standing full-length in ${sceneDesc}, transfer the outfit, full body editorial lookbook photography, head-to-toe framed with complete shoes and feet in view, both arms straight down relaxed naturally at sides, both hands open and fully visible with natural five fingers clearly shown on each hand, serene composed expression, closed lips, elegant confident posture, realistic lighting consistent with the environment, authentic human skin texture with visible micro pores, natural skin sheen, realistic subsurface scattering, tactile fabric weave, shot on 35mm lens, subtle film grain, soft contact shadows${extra}`,
        seg1_prompt: `A commercial lookbook fashion showcase video faithful to the reference image: the ${subj} wearing the identical outfit, situated in ${sceneDesc}. Smooth steady gimbal tracking shot at eye level: ${pro} walks forward at a measured natural cadence, both arms swaying naturally at sides with relaxed open hands, with calm confidence and closed lips toward the lens. Fabric drape, leather grain, and textile weave clearly visible, natural organic cloth physics. Cinematic ambient lighting consistent with the environment${extra}.\n\nAudio: natural atmospheric ambiance matching the acoustic surroundings, subtle rhythmic footsteps, soft fabric rustle as ${pro} moves.`,
        seg2_prompt: `Continuing seamlessly from the previous shot: the same ${subj} in the identical outfit situated in ${sceneDesc} slows ${pos} stride and turns 45 degrees to showcase the silhouette, fabric flow, leather grain, and rear tailoring of the clothing, pausing naturally with a calm composed glance toward the lens, closed lips and serene poise. Steady smooth camera pan revealing fabric weave and flow. Harmonious lighting, ultra sharp details, stable facial features, stable anatomy${extra}.\n\nAudio: continuous atmospheric ambient background, gentle fabric movement sound, subtle environmental breeze.`
      };
    }
  }
};

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
    custom_prompt = '',
    aspect_ratio = '3:4',
    mode = 'video'
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
    custom_scene: isCustomScene ? custom_scene : '',
    custom_prompt,
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
    gender = 'female',
    model_style = 'classic',
    custom_prompt = '',
    custom_scene = '',
    aspect_ratio = '3:4',
    mode = 'video'
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
      custom_scene: scKey === 'custom' ? custom_scene : '',
      custom_prompt,
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

  // Format multiline textbox input: strip list bullets at line starts only
  // (keep hyphens inside words like "t-shirt"), collapse lines, block audio injection
  const stripTextboxNoise = (raw) => (raw || '')
    .replace(/^[•·*\-]\s*/gm, '')
    .replace(/\baudio\s*:/gi, '')
    .replace(/露齿笑|露牙笑|露齿|大笑|狂笑|张嘴笑/g, '闭唇从容神采')
    .replace(/\b(toothy smile|open mouth|grinning|laughing|showing teeth)\b/gi, 'closed lips, serene expression')
    .replace(/\r\n|\r|\n/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/[,，\s]+[,，]/g, ', ')
    .replace(/^[,，\s]+|[,，\s]+$/g, '')
    .trim();

  const cleanCustom = stripTextboxNoise(task.custom_prompt);
  const cleanCustomScene = stripTextboxNoise(task.custom_scene);

  const prompts = task.scene.buildPrompts(task.gender, cleanCustom, cleanCustomScene, task.model_style || 'classic');

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

    const kreaWf = JSON.parse(fs.readFileSync(kreaWfPath, 'utf-8'));
    requireNodes(kreaWf, 'Krea-2', ['5', '7', '9', '11', '13']);
    kreaWf['5']['inputs']['image'] = `online_temp/${tempInputFile}`;
    kreaWf['9']['inputs']['prompt'] = prompts.krea_prompt;
    if (kreaWf['4']) {
      kreaWf['4']['inputs']['strength_model'] = 0.92;
    }
    if (kreaWf['8']) {
      kreaWf['8']['inputs']['ref_boost'] = 0.96;
    }
    if (kreaWf['9']) {
      kreaWf['9']['inputs']['grounding_px'] = 1024;
    }
    if (kreaWf['10']) {
      kreaWf['10']['inputs']['prompt'] = KREA_NEGATIVE_PROMPT_BASE;
      kreaWf['10']['inputs']['grounding_px'] = 1024;
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
        kreaWf['8']['inputs']['ref_boost'] = 1.0; // second ref = model identity
        kreaWf['8']['inputs']['ref_boost_a'] = 0.96; // first ref = clothing outfit

        kreaWf['9']['inputs']['image_b'] = ['20', 0];
        if (kreaWf['10']) {
          kreaWf['10']['inputs']['image_b'] = ['20', 0];
          kreaWf['10']['inputs']['prompt'] = KREA_NEGATIVE_PROMPT_MODEL_ID;
          kreaWf['10']['inputs']['grounding_px'] = 1024;
        }

        const sceneEnv = (task.scene.id === 'custom' && cleanCustomScene)
          ? `in ${cleanCustomScene}, realistic lighting consistent with the environment`
          : (task.scene.sceneEnvironment || 'in an aesthetic fashion lookbook background, natural commercial lighting');
        const modelGenderLabel = task.gender === 'male' ? 'male model' : 'female model';
        kreaWf['9']['inputs']['prompt'] = `transfer the clothing and outfit from the first reference image onto the ${modelGenderLabel} in the second reference image, strictly preserving their exact facial features, facial identity, eye shape, nose shape, and hairstyle, full body editorial lookbook photography, head-to-toe framed with complete shoes and feet in view, both arms straight down relaxed naturally at sides, both hands open and fully visible with natural five fingers clearly shown on each hand, standing ${sceneEnv}, serene composed expression, closed lips, authentic human skin texture with visible micro pores, natural skin sheen, realistic subsurface scattering, tactile fabric weave and seam details, shot on 35mm lens, subtle film grain, soft contact shadows${cleanCustom ? ', ' + cleanCustom : ''}`;
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
        kreaWf['8']['inputs']['ref_boost'] = 0.96; // second ref = garment
        kreaWf['8']['inputs']['ref_boost_a'] = 1.0; // first ref = scene

        kreaWf['9']['inputs']['image_b'] = ['20', 0];
        if (kreaWf['10']) {
          kreaWf['10']['inputs']['image_b'] = ['20', 0];
          kreaWf['10']['inputs']['prompt'] = KREA_NEGATIVE_PROMPT_BASE;
          kreaWf['10']['inputs']['grounding_px'] = 1024;
        }

        const subj = styledSubject(task.gender, task.model_style || 'classic', 'stylish female model', 'handsome male model');
        kreaWf['9']['inputs']['prompt'] = `a ${subj} standing full-length in the background environment from the first reference image, wearing the exact clothing and outfit from the second reference image, full body editorial lookbook photography, head-to-toe framed with complete shoes and feet in view, both arms straight down relaxed naturally at sides, both hands open and fully visible with natural five fingers clearly shown on each hand, serene composed expression, closed lips, realistic illumination matched to the background environment, authentic human skin texture with visible micro pores, natural skin sheen, realistic subsurface scattering, tactile fabric weave, shot on 35mm lens, subtle film grain, soft contact shadows${cleanCustom ? ', ' + cleanCustom : ''}`;
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

    h3Wf['40']['inputs']['prompt'] = prompts.seg1_prompt;
    h3Wf['81']['inputs']['prompt'] = prompts.seg2_prompt;

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
