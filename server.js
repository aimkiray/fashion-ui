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
// Model style presets — vintage editorial presence with soft eye contact, natural skin, and relaxed posture
const MODEL_STYLES = {
  classic: {
    name: '高级名模',
    female: 'with poised vintage editorial elegance, serene composed expression, soft direct eye contact, naturally closed lips without tension, relaxed natural jawline, soft natural hair, and effortless upright lookbook posture',
    male: 'with sharp defined jawline, vintage editorial charisma, calm composed gaze, soft direct eye contact, naturally closed lips without tension, relaxed natural jawline, and upright natural posture'
  },
  sweet: {
    name: '甜美清新',
    female: 'with fresh-faced youthful purity, a gentle genuine warmth in the eyes, soft natural undone hair, tranquil poise, naturally closed lips without tension, relaxed natural jawline, and tender serene gaze',
    male: 'with clean youthful Korean lookbook charm, gentle refined features, relaxed natural poise, soft direct gaze, naturally closed lips without tension, and calm subtle warmth'
  },
  athletic: {
    name: '运动活力',
    female: 'with healthy athletic glow, tone-defined posture, calm focused eye contact, naturally closed lips without tension, relaxed natural jawline, soft natural hair, and confident grounded stance',
    male: 'with athletic toned build, sharp defined facial structure, calm focused gaze, soft direct eye contact, naturally closed lips without tension, and upright confident stance'
  },
  mature: {
    name: '成熟御姐',
    female: 'with sophisticated vintage poise, graceful mature facial structure, warm knowing soft eye contact, naturally closed lips without tension, relaxed natural jawline, soft natural hair, and commanding serene presence',
    male: 'with distinguished mature charisma, sharp masculine features, calm direct eye contact, naturally closed lips without tension, and commanding executive posture'
  },
  cool: {
    name: '中性酷感',
    female: 'with chic androgynous edge, cool understated attitude, sharp bone structure, naturally closed lips without tension, relaxed natural jawline, soft direct glance, and effortless lookbook poise',
    male: 'with contemporary streetwear edge, cool understated attitude, sharp jawline, soft direct gaze, naturally closed lips without tension, and effortless confident posture'
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

// Realistic Anti-AI prompt tokens (neutralize plastic skin, mannequin look, artificial sheen, stiff pose, mirror floor, phantom trains)
const KREA_NEGATIVE_PROMPT_BASE = 'plastic skin, waxy skin, airbrushed, mannequin, 3d render, cgi, over-smoothed skin, doll, ceramic skin, beauty filter, oversaturated, wax figure, artificial sheen, illustration, cartoon, stiff pose, mannequin pose, rigid pose, a-pose, t-pose, mirror floor reflection, glossy mirror floor, floating feet, hovering feet, cape, train, dress train, gown train, long train, trailing fabric, trailing skirt, phantom cape, exaggerated bustle, floor-length train, hands in pockets, hands tucked into pockets, hands in pants pockets, hands in jacket pockets, hand in pocket, thumb in pocket, thumbs hooked in pockets, hands tucked in waistband, hand on hip, hands on waist, hidden fingers, hidden hands, hands behind back, missing hands, missing fingers, extra fingers, deformed hands, mutated hands, bad hands, fused fingers, open mouth, teeth, toothy smile, grinning, smiling with teeth, laughing, parted lips, creepy smile, exaggerated facial expression, grimace, cropped feet, cut off feet, cut off shoes, cut off legs, cropped legs, half body, torso only, close-up, cropped head, out of frame, blurry, low quality, distorted clothing, extra limbs, bad anatomy, deformed, duplicate person, watermark, text, signature';

const KREA_NEGATIVE_PROMPT_MODEL_ID = 'plastic skin, waxy skin, airbrushed, mannequin, 3d render, cgi, over-smoothed skin, doll, ceramic skin, beauty filter, oversaturated, wax figure, artificial sheen, illustration, cartoon, stiff pose, mannequin pose, rigid pose, a-pose, t-pose, mirror floor reflection, glossy mirror floor, floating feet, hovering feet, cape, train, dress train, gown train, long train, trailing fabric, trailing skirt, phantom cape, exaggerated bustle, floor-length train, hands in pockets, hands tucked into pockets, hands in pants pockets, hands in jacket pockets, hand in pocket, thumb in pocket, thumbs hooked in pockets, hands tucked in waistband, hand on hip, hands on waist, hidden fingers, hidden hands, hands behind back, missing hands, missing fingers, extra fingers, deformed hands, mutated hands, bad hands, fused fingers, face change, different face, unrecognizable face, distorted face, changed hairstyle, deformed facial features, bad face, open mouth, teeth, toothy smile, grinning, smiling with teeth, laughing, parted lips, creepy smile, exaggerated facial expression, cropped feet, cut off feet, cut off shoes, cut off legs, cropped legs, half body, torso only, out of frame, blurry, low quality, distorted clothing, extra limbs, bad anatomy, deformed, duplicate person, watermark, text, signature';

const SCENES = {
  street: {
    id: 'street',
    name: '阳光都市街拍',
    enName: 'Vintage Sunny Street Editorial',
    icon: 'buildings',
    description: '阳光洒落的复古都市街头，亲密POV眼神交流，自然光影与编辑感姿势',
    sceneEnvironment: 'on a sunlit vintage city sidewalk beside historic brick buildings with classic storefront awnings, clean summer daylight, soft neutral-to-warm tones',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish East Asian editorial model', 'handsome East Asian editorial model', customStylePrompt);
      const pro = isM ? 'he' : 'she';
      const pos = isM ? 'his' : 'her';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `Create a 9:16 photorealistic vintage street editorial portrait of a ${subj} standing full-length on a sunlit vintage city sidewalk beside historic brick buildings with classic storefront awnings, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus, with a soft intimate POV feeling. Front-facing direct eye contact with a gentle three-quarter head turn, gaze connecting naturally with the viewer. Relaxed editorial stance, subtle natural weight shift to one hip, shoulders soft and open, posture feeling relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body vintage editorial fashion lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on concrete sidewalk with realistic soft ground contact shadows beneath footwear. Serene composed expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Clean directional summer sunlight casting soft realistic ground shadows, neutral-to-warm daylight, ivory and cream clothing staying true to tone, muted brick and awning colors remaining faithful. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering on cheeks, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, f/2.8, subtle organic film grain, intimate POV with the viewer standing close${extra}`,
        seg1_prompt: `A vintage street editorial fashion video faithful to the reference image: the identical ${subj} wearing the exact outfit from the reference image. Steady eye-level gimbal tracking shot with intimate POV: ${pro} takes slow, measured runway strides forward toward the camera along a sunlit vintage city sidewalk (1 step per second), shoes maintaining firm traction with natural step-and-plant walking mechanics, zero sliding, arms swaying organically at sides with relaxed open hands. ${pro} maintains front-facing soft eye contact with a gentle three-quarter head turn, naturally closed lips without tension, and a calm composed expression. Natural fabric and leather drape swaying organically with each step. Clean directional summer daylight, authentic textile details, soft circular background bokeh, stable camera framing, viewer standing close as if in the same quiet moment. Small secondary props only if present${extra}.\n\nAudio: distant muffled vintage city ambience, crisp footsteps on sidewalk, subtle soft rustle of clothing fabric swaying as ${pro} walks.`,
        seg2_prompt: `Continuing seamlessly from the previous walk: the same ${subj} in the identical outfit slows ${pos} stride, executing a smooth grounded 45-degree exhibition turn to showcase the side silhouette, drape, and rear tailoring of the clothing, feet firmly planted with natural pivot mechanics, glancing back toward the lens with maintained eye contact and naturally closed lips without tension. Steady slow 35mm camera pan capturing leather grain, fabric stitching, garment folds, and clean hemlines. Constant natural sunlight, warm city background bokeh, stable facial features, stable anatomy, intimate POV${extra}.\n\nAudio: continuous vintage city ambient background, soft shoe pivot on pavement, quiet fabric flutter, gentle outdoor breeze.`
      };
    }
  },
  studio: {
    id: 'studio',
    name: '极简纯色影棚',
    enName: 'Vintage Studio Editorial',
    icon: 'camera',
    description: '温暖象牙色复古影棚，柔和窗光，突出眼神交流与姿态几何',
    sceneEnvironment: 'in a refined vintage studio with warm ivory cyclorama, tall north-facing window with soft diffused daylight, minimal retro brass accents, clean airy editorial atmosphere',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish East Asian editorial model', 'handsome East Asian editorial model', customStylePrompt);
      const pro = isM ? 'he' : 'she';
      const pos = isM ? 'his' : 'her';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `Create a 9:16 photorealistic vintage studio editorial portrait of a ${subj} standing full-length in a refined vintage studio with warm ivory cyclorama and tall north-facing window, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Slightly lowered chin with lifted eyes, a quiet intimate gaze toward the lens. Elegant upright posture, body turned a quarter away from camera, shoulders soft and open, waistline forming gentle lines, posture relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body vintage editorial catalogue lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on matte studio floor with realistic soft ground contact shadows beneath footwear. Serene composed editorial expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Soft diffused north-window daylight, clean neutral-to-warm color balance, ivory and cream clothing staying true to tone, warm ivory backdrop remaining faithful. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering on cheeks, natural catchlights in the eyes, tactile cloth texture and seam details. Props stay small and secondary if present. Shot on 50mm lens, subtle organic film grain, soft contact shadows, intimate POV with the viewer standing close${extra}`,
        seg1_prompt: `A vintage studio editorial fashion video faithful to the reference image: the identical ${subj} wearing the exact outfit from the reference image, situated in a refined vintage studio with warm ivory cyclorama. Smooth motorized camera dolly tracking backward at eye level with intimate POV: ${pro} takes slow, deliberate runway steps forward, shoes maintaining firm traction on the studio floor with natural step-and-plant walking mechanics, zero sliding, arms swaying organically at sides with relaxed open hands, with calm poise and naturally closed lips without tension. ${pro} keeps a slightly lowered chin with lifted eyes, quiet intimate gaze. Clean garment tailoring, natural cloth and leather physics, natural weave texture and subtle film grain, zero shadow pulsing. Soft diffused daylight with gentle shadow falloff${extra}.\n\nAudio: dead-quiet soundproof studio room tone, soft rhythmic footsteps on floor, subtle tactile rustle of garment cloth swaying.`,
        seg2_prompt: `Continuing seamlessly from the previous walk: the same ${subj} in the identical outfit smoothly slows ${pos} cadence and executes an elegant grounded 45-degree exhibition turn, feet firmly planted with natural pivot mechanics, allowing the camera to inspect the side silhouette, collar construction, and rear garment cut, pausing with serene poise and naturally closed lips without tension. ${pro} glances back toward the lens with lifted eyes and a calm intimate expression. Tripod steady framing, soft daylight with gentle shadow falloff, authentic vintage catalogue aesthetic, stable facial features, stable anatomy${extra}.\n\nAudio: quiet soundproof studio room tone, soft shoe pivot on floor, quiet whisper of moving garment fabric.`
      };
    }
  },
  office: {
    id: 'office',
    name: '摩天楼职场通勤',
    enName: 'Vintage Executive Editorial',
    icon: 'building',
    description: '中世纪现代风格玻璃大堂，晨光与黄铜细节，优雅职场编辑感',
    sceneEnvironment: 'in a mid-century modern glass lobby with warm walnut panels, brass railings, and pale honed stone floors, morning architectural sunlight filtering diagonally through high glass curtain walls',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'chic East Asian business woman', 'refined East Asian businessman', customStylePrompt);
      const pro = isM ? 'he' : 'she';
      const pos = isM ? 'his' : 'her';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `Create a 9:16 photorealistic vintage executive editorial portrait of a ${subj} standing full-length in a mid-century modern glass lobby with warm walnut panels, brass railings, and pale honed stone floors, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Calm three-quarter eye contact with confident professional warmth, head turned just enough to show elegant jawline. Composed executive stance, posture relaxed but intentional, shoulders soft and open, waistline visible beneath tailored garments, long legs forming clean lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body vintage executive lookbook photography, head-to-toe framed with complete shoes and feet firmly planted with realistic soft ground contact shadows beneath footwear and subtle diffuse ambient floor sheen. Naturally closed lips without tension, relaxed natural jawline, soft natural hair. Morning architectural sunlight filtering diagonally through high glass curtain walls, clean neutral-to-warm light, walnut and brass tones staying faithful, pale stone remaining true to tone. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile leather grain and fabric drape. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`,
        seg1_prompt: `A vintage executive lookbook video faithful to the reference image: the identical ${subj} wearing the exact outfit from the reference image walking forward through a spacious mid-century modern glass lobby. Smooth forward tracking shot at eye level with intimate POV: ${pro} walks with confident upright posture, shoes maintaining firm traction with natural step-and-plant walking mechanics, zero sliding, arms swaying organically at sides with relaxed open hands, and a calm composed expression with naturally closed lips without tension. ${pro} maintains calm three-quarter eye contact. Morning sunbeams filtering diagonally through high glass windows, casting clean soft architectural light across the pale stone floor. Crisp garment lines, natural fabric movement, neutral-to-warm color balance${extra}.\n\nAudio: spacious architectural lobby ambiance, subtle acoustic reverberation, crisp confident footsteps echoing gently on stone floor.`,
        seg2_prompt: `Continuing seamlessly from the previous walk: the same ${subj} in the identical outfit halts smoothly near a brass and walnut handrail overlooking the skyline, executing a grounded 45-degree turn with feet firmly planted to reveal the tailored silhouette, leather grain, back seam construction, and garment drape. ${pro} glances toward the lens with composed confident three-quarter eye contact and naturally closed lips without tension. Steady slow camera glide, constant natural morning illumination, stable facial features, stable anatomy, intimate POV${extra}.\n\nAudio: tranquil glass lobby atmosphere, soft shoe step, quiet fabric motion, distant muted indoor reverberation.`
      };
    }
  },
  boutique: {
    id: 'boutique',
    name: '高端艺术买手店',
    enName: 'Vintage Luxury Boutique',
    icon: 'storefront',
    description: '天鹅绒与黄铜打造的复古高端专柜，柔和暖光，突出女性气质与眼神光',
    sceneEnvironment: 'in an elegant old-world concept boutique with velvet drapery, aged brass fixtures, honed marble floors, and warm vintage recessed spotlights',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'elegant East Asian fashion model', 'confident refined East Asian male model', customStylePrompt);
      const pro = isM ? 'he' : 'she';
      const pos = isM ? 'his' : 'her';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `Create a 9:16 photorealistic vintage luxury boutique portrait of a ${subj} standing full-length in an elegant old-world concept boutique with velvet drapery, aged brass fixtures, and honed marble floors, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Soft upward playful gaze, eyes catching warm spotlight reflections and maintaining direct contact with the viewer. Graceful weight on one leg, torso softly angled, shoulders and waistline forming refined feminine lines, posture relaxed but intentional. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body vintage luxury retail lookbook photography, head-to-toe framed with complete shoes and feet firmly planted with realistic soft ground contact shadows beneath footwear and subtle diffuse floor sheen. Serene composed gaze, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Warm vintage recessed spotlights with soft falloff, clean neutral-to-warm color balance, velvet and brass tones staying faithful, marble remaining true to tone. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and leather grain. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`,
        seg1_prompt: `A vintage luxury retail lookbook video faithful to the reference image: the identical ${subj} wearing the exact outfit from the reference image in an elegant old-world boutique with velvet drapery and honed marble floors. Smooth camera glide tracking backward at eye level with intimate POV: ${pro} walks gracefully forward, shoes maintaining firm traction with natural step-and-plant walking mechanics, zero sliding, arms swaying organically at sides with relaxed open hands, a calm composed expression and naturally closed lips without tension. ${pro} keeps a soft upward playful gaze with eyes catching warm spotlight reflections. Warm vintage spotlights gently grazing fabric textures and clean seams. Fluid motion, perfectly locked anatomy, elegant posture${extra}.\n\nAudio: luxurious quiet boutique interior ambiance, subtle acoustic reverberation, crisp rhythmic footsteps clicking gently on honed marble floor, soft silky cloth rustle.`,
        seg2_prompt: `Continuing seamlessly from the previous walk: the same ${subj} in the identical outfit gently pauses beside an aged brass display plinth, executing a grounded 45-degree exhibition turn with feet firmly planted to showcase the garment silhouette, seam tailoring, and textile craftsmanship. Smooth slow camera pan highlighting the neckline, leather grain, fabric weave, and rear cut. ${pro} glances upward toward the lens with playful intimate eye contact and naturally closed lips without tension. Constant warm vintage spotlighting, creamy background bokeh, stable anatomy${extra}.\n\nAudio: warm boutique interior ambiance, gentle soft reverberation, soft shoe pivot on marble, quiet fabric glide.`
      };
    }
  },
  outdoor: {
    id: 'outdoor',
    name: '自然户外林荫',
    enName: 'Vintage Garden Editorial',
    icon: 'leaf',
    description: '洒满阳光的复古花园小径，柔和眼神与回眸，浪漫编辑感',
    sceneEnvironment: 'in a lush vintage botanical garden along a smooth stone paver pathway with blooming foliage and an ornate wrought-iron bench, soft dappled summer sunlight',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'natural East Asian fashion model', 'relaxed East Asian male model', customStylePrompt);
      const pro = isM ? 'he' : 'she';
      const pos = isM ? 'his' : 'her';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `Create a 9:16 photorealistic vintage garden editorial portrait of a ${subj} standing full-length in a lush vintage botanical garden along a smooth stone paver pathway with blooming foliage and an ornate wrought-iron bench, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Side glance over the shoulder with maintained eye contact, face angle varied and alive. Peaceful relaxed stance beside garden greenery, posture fluid and natural, shoulders soft and open, waistline visible, long legs forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body vintage lifestyle lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on stone pavers with realistic soft ground contact shadows beneath footwear. Serene gentle expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Natural outdoor summer daylight, soft dappled sunlight through tree canopies, clean neutral-to-warm color balance, green foliage staying true to tone, stone remaining faithful. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile cloth folds and texture. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`,
        seg1_prompt: `A vintage garden lifestyle fashion lookbook video faithful to the reference image: the identical ${subj} wearing the reference clothing walks forward along a sun-dappled stone path through a lush vintage botanical garden. Steady forward tracking gimbal camera with intimate POV: ${pro} walks at a relaxed natural cadence, shoes maintaining firm traction on the stone pavers with natural step-and-plant walking mechanics, zero sliding, arms swaying organically at sides with relaxed open hands, with a calm serene expression and naturally closed lips without tension. ${pro} glances back over ${pos} shoulder with maintained eye contact. Sunlight filtering through tree canopies creating gentle dappled patterns across the clothing. Natural cloth and leather physics swaying softly in the fresh outdoor breeze${extra}.\n\nAudio: gentle outdoor breeze rustling green tree leaves, peaceful distant birdsong, soft footsteps on stone pavers, subtle cloth rustle.`,
        seg2_prompt: `Continuing seamlessly from the previous walk: the same ${subj} in the identical outfit pauses beside blooming greenery, executing a grounded 45-degree turn with feet firmly planted to showcase the garment movement, leather grain, fabric drape, and seam tailoring. Serene gentle gaze over the shoulder with maintained eye contact, naturally closed lips without tension, natural directional sunlight filtered through tree canopies creating a soft rim light on ${pos} silhouette and garment edges. Steady camera pan, stable facial features, stable anatomy, intimate POV${extra}.\n\nAudio: continuous tranquil birdsong, gentle outdoor wind gust, soft stone step, crisp fabric flutter in the breeze.`
      };
    }
  },
  cafe: {
    id: 'cafe',
    name: '现代极简咖啡厅',
    enName: 'Vintage European Cafe',
    icon: 'coffee',
    description: '复古欧洲咖啡馆，弯木椅与蕾丝帘，慵懒而亲密的生活编辑感',
    sceneEnvironment: 'in a refined vintage European cafe with warm timber oak interiors, bentwood chairs, lace curtains, and sunlit floor-to-ceiling windows',
    buildPrompts: (gender = 'female', custom = '', _customScene = '', style = 'classic', customStylePrompt = '') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish East Asian young woman', 'stylish East Asian young man', customStylePrompt);
      const pro = isM ? 'he' : 'she';
      const pos = isM ? 'his' : 'her';
      const extra = custom ? `, ${custom}` : '';
      return {
        krea_prompt: `Create a 9:16 photorealistic vintage cafe lifestyle portrait of a ${subj} standing full-length in a refined vintage European cafe with warm timber oak interiors, bentwood chairs, lace curtains, and sunlit floor-to-ceiling windows, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Relaxed profile-based eye contact, chin softly lifted toward the lens, gaze warm and approachable. Casual editorial stance near the sunlit window, body language relaxed but intentional, shoulders soft and open, posture forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body vintage cozy editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on hardwood floor with realistic soft ground contact shadows beneath footwear. Relaxed serene expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Warm natural window light with soft interior fill, clean neutral-to-warm color balance, warm oak and cream tones staying faithful, lace curtains remaining delicate. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile knit and fabric weave. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`,
        seg1_prompt: `A vintage cafe lifestyle fashion lookbook video faithful to the reference image: the identical ${subj} wearing the exact outfit walks forward with natural poise in a refined vintage European cafe near sunlit floor-to-ceiling windows. Smooth eye-level gimbal tracking shot with intimate POV: ${pro} walks at a relaxed pace, shoes maintaining firm traction on the wood floor with natural step-and-plant walking mechanics, zero sliding, arms swaying organically at sides with relaxed open hands, a calm peaceful expression and naturally closed lips without tension. ${pro} keeps relaxed profile-based eye contact, chin softly lifted. Warm timber tones, soft ambient lighting, natural garment drape swaying gently, neutral-to-warm color balance${extra}.\n\nAudio: quiet ambient cafe murmur in the far background, distant gentle hiss of espresso machine steam, soft footsteps on hardwood timber floor, quiet fabric rustle.`,
        seg2_prompt: `Continuing seamlessly from the previous walk: the same ${subj} in the identical outfit pauses beside the sunlit window, executing a grounded 45-degree turn with feet firmly planted to reveal the garment silhouette, leather grain, back tailoring, and fabric weave. Smooth camera pan highlighting the collar line, pocket details, and cloth texture. Calm peaceful expression with relaxed profile-based eye contact, naturally closed lips without tension, warm daylight, soft progressive background falloff, stable anatomy${extra}.\n\nAudio: gentle cafe room tone, quiet atmospheric background murmur, soft shoe step on wood floor, subtle fabric rustle.`
      };
    }
  },
  custom: {
    id: 'custom',
    name: '自定义专属场景',
    enName: 'Custom Vintage Editorial Scene',
    icon: 'palette',
    description: '自由描述任意复古编辑感展示背景，保持眼神交流与真实皮肤质感',
    sceneEnvironment: 'in an aesthetic vintage editorial fashion lookbook background with warm natural daylight and refined retro atmosphere',
    buildPrompts: (gender = 'female', customPrompt = '', customScene = '', style = 'classic', customStylePrompt = '') => {
      const isM = gender === 'male';
      const subj = styledSubject(gender, style, 'stylish East Asian editorial model', 'handsome East Asian editorial model', customStylePrompt);
      const pro = isM ? 'he' : 'she';
      const pos = isM ? 'his' : 'her';
      const rawScene = (customScene && customScene.trim()) ? customScene.trim() : 'an authentic vintage editorial fashion lookbook background';
      const sceneDesc = /^(in|on|at|against|under|near|along)\s+/i.test(rawScene)
        ? rawScene
        : `in ${rawScene}`;
      const extra = customPrompt ? `, ${customPrompt}` : '';
      return {
        krea_prompt: `Create a 9:16 photorealistic vintage editorial portrait of a ${subj} standing full-length ${sceneDesc}, transfer the outfit, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${pro} is the clear visual focus with a soft intimate POV feeling. Soft direct eye contact with a warm genuine presence, face angle natural and alive. Elegant confident posture, body language relaxed but intentional, shoulders soft and open, waistline visible, posture forming gentle lines. Both arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers. Full body vintage editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on ground with realistic soft ground contact shadows beneath footwear. Serene composed expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Realistic natural lighting consistent with the environment, clean neutral-to-warm color balance, clothing and background colors remaining faithful without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain, intimate POV with the viewer standing close${extra}`,
        seg1_prompt: `A vintage editorial lookbook showcase video faithful to the reference image: the ${subj} wearing the identical outfit, situated ${sceneDesc}. Smooth steady gimbal tracking shot at eye level with intimate POV: ${pro} walks forward at a measured natural cadence, shoes maintaining firm traction on the ground with natural step-and-plant walking mechanics, zero sliding, arms swaying organically at sides with relaxed open hands, with calm confidence, soft direct eye contact, and naturally closed lips without tension toward the lens. Fabric drape, leather grain, and textile weave clearly visible, natural organic cloth physics. Realistic natural ambient lighting consistent with the environment, neutral-to-warm color balance${extra}.\n\nAudio: natural atmospheric ambiance matching the acoustic surroundings, subtle rhythmic footsteps, soft fabric rustle as ${pro} moves.`,
        seg2_prompt: `Continuing seamlessly from the previous shot: the same ${subj} in the identical outfit situated ${sceneDesc} slows ${pos} stride and executes a grounded 45-degree exhibition turn with feet firmly planted to showcase the silhouette, fabric flow, leather grain, and rear tailoring of the clothing, pausing naturally with a calm composed glance toward the lens, soft direct eye contact, naturally closed lips without tension, and serene poise. Steady smooth camera pan revealing fabric weave and flow. Harmonious natural lighting, natural textile details, stable facial features, stable anatomy, intimate POV${extra}.\n\nAudio: continuous atmospheric ambient background, gentle fabric movement sound, subtle environmental breeze.`
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
  .replace(/\b(8k resolution|8k|hyperrealistic|photorealistic|ultra sharp focus|ultra sharp|pristine|flawless|stunning|cinematic|glamorous|radiant|shimmering|over-sharpened)\b/gi, '')
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
    kreaPrompt = `Create a 9:16 photorealistic vintage editorial portrait. Transfer the clothing and outfit from the first reference image onto the ${modelGenderLabel} in the second reference image, strictly preserving their exact facial features, facial identity, eye shape, nose shape, and hairstyle, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${isM ? 'He' : 'She'} is the clear visual focus with a soft intimate POV feeling, standing ${sceneEnv}. Full body vintage editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on ground with realistic soft ground contact shadows beneath footwear, arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers, subtle natural weight shift. Soft direct eye contact with warm genuine presence, serene composed expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Realistic lighting consistent with the environment, clean neutral-to-warm color balance, clothing and background colors remaining faithful without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain${cleanCustom ? ', ' + cleanCustom : ''}`;
  } else if (scene_image) {
    const subj = styledSubject(gender, modelStyleKey, 'stylish female model', 'handsome male model', cleanCustomModelStyle);
    kreaPrompt = `Create a 9:16 photorealistic vintage editorial portrait of ${subj} standing full-length in the background environment from the first reference image, wearing the exact clothing and outfit from the second reference image, strictly preserving the exact garment length, cut, and silhouette from the reference image, crisp clean hemline strictly following the reference garment boundary, naturally complementing separated tops with clean tailored bottoms. ${isM ? 'He' : 'She'} is the clear visual focus with a soft intimate POV feeling. Soft direct eye contact with warm genuine presence, face angle natural and alive. Elegant confident posture, body language relaxed but intentional, shoulders soft and open, waistline visible, posture forming gentle lines. Full body vintage editorial lookbook photography, head-to-toe framed with complete shoes and feet firmly planted on ground with realistic soft ground contact shadows beneath footwear, arms resting naturally at sides with subtle organic elbow curvature, hands relaxed and fully visible with five natural fingers, subtle natural weight shift. Serene composed expression, naturally closed lips without tension, relaxed natural jawline, soft natural hair. Realistic illumination matched to the background environment, clean neutral-to-warm color balance, clothing and background colors remaining faithful without heavy yellow or orange filter. Authentic human skin texture with visible natural pores, fine skin lines, subtle peach fuzz, natural skin sheen, realistic subsurface scattering, natural catchlights in the eyes, tactile fabric weave and seam details. Props stay small and secondary if present. Shot on 35mm lens, subtle organic film grain${cleanCustom ? ', ' + cleanCustom : ''}`;
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
      custom_krea_prompt: typeof krea_prompt === 'string' && krea_prompt.trim() ? krea_prompt.trim() : null,
      custom_seg1_prompt: typeof seg1_prompt === 'string' && seg1_prompt.trim() ? seg1_prompt.trim() : null,
      custom_seg2_prompt: typeof seg2_prompt === 'string' && seg2_prompt.trim() ? seg2_prompt.trim() : null,
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
    // Guide the vision encoder to focus on identity, skin texture, and garment details
    // instead of generic background description. Empty falls back to the training default.
    if (kreaWf['9']) {
      kreaWf['9']['inputs']['system_prompt'] = 'Describe the reference image focusing on exact facial identity, natural skin texture with visible pores and fine lines, fabric weave, seam construction, garment silhouette, and realistic environmental lighting.';
    }
    if (kreaWf['4']) {
      kreaWf['4']['inputs']['strength_model'] = 0.92;
    }
    if (kreaWf['8']) {
      kreaWf['8']['inputs']['ref_boost'] = garmentRefBoost;
    }
    if (kreaWf['9']) {
      kreaWf['9']['inputs']['grounding_px'] = 1024;
    }
    if (kreaWf['10']) {
      kreaWf['10']['inputs']['prompt'] = KREA_NEGATIVE_PROMPT_BASE;
      kreaWf['10']['inputs']['grounding_px'] = 1024;
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
          kreaWf['10']['inputs']['prompt'] = KREA_NEGATIVE_PROMPT_MODEL_ID;
          kreaWf['10']['inputs']['grounding_px'] = 1024;
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
          kreaWf['10']['inputs']['prompt'] = KREA_NEGATIVE_PROMPT_BASE;
          kreaWf['10']['inputs']['grounding_px'] = 1024;
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
