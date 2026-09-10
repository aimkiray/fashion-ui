const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Backend ComfyUI Paths (for execution only)
const COMFY_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const COMFY_WS_URL = COMFY_URL.replace(/^http/, 'ws');
// COMFY_REMOTE=1: this app runs on a different machine than ComfyUI — stage
// workflow inputs and fetch outputs through the ComfyUI HTTP API
// (/upload/image, /view) instead of direct filesystem access. Note: ComfyUI
// exposes no delete API, so online_temp staging files accumulate on the
// ComfyUI host in this mode.
const COMFY_REMOTE = process.env.COMFY_REMOTE === '1';

const COMFY_DIR = path.resolve(process.env.COMFY_DIR || 'D:/Comfy/ComfyUI');
const COMFY_INPUT_DIR = path.join(COMFY_DIR, 'input');
const COMFY_OUTPUT_DIR = path.join(COMFY_DIR, 'output');
const LOCAL_WORKFLOWS_DIR = path.join(__dirname, '..', 'workflows');
const WORKFLOWS_DIR = fs.existsSync(LOCAL_WORKFLOWS_DIR)
  ? LOCAL_WORKFLOWS_DIR
  : path.join(COMFY_DIR, 'user', 'workflows');

// Dedicated temporary folder inside ComfyUI to keep root input/output clean and separate
const COMFY_TEMP_INPUT_DIR = path.join(COMFY_INPUT_DIR, 'online_temp');
const COMFY_TEMP_OUTPUT_DIR = path.join(COMFY_OUTPUT_DIR, 'online_temp');

// Dedicated Project Storage Directories (Isolated inside this project directory!)
const PROJECT_DIR = path.join(__dirname, '..');
const STORAGE_DIR = path.join(PROJECT_DIR, 'storage');
const PROJECT_INPUT_DIR = path.join(STORAGE_DIR, 'inputs');
const PROJECT_OUTPUT_DIR = path.join(STORAGE_DIR, 'outputs');
const PROJECT_VIDEO_DIR = path.join(PROJECT_OUTPUT_DIR, 'videos');
const PROJECT_IMAGE_DIR = path.join(PROJECT_OUTPUT_DIR, 'images');

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

const SAMPLES_DIR = path.join(PROJECT_DIR, 'public', 'samples');

// Remote mode: ComfyUI dirs live on another machine — skip creating them locally.
function ensureStorageDirs() {
  [
    ...(COMFY_REMOTE ? [] : [COMFY_TEMP_INPUT_DIR, COMFY_TEMP_OUTPUT_DIR]),
    STORAGE_DIR,
    PROJECT_INPUT_DIR,
    PROJECT_OUTPUT_DIR,
    PROJECT_VIDEO_DIR,
    PROJECT_IMAGE_DIR
  ].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  // Seed preset sample garments from public/samples into PROJECT_INPUT_DIR if not present
  if (fs.existsSync(SAMPLES_DIR) && fs.existsSync(PROJECT_INPUT_DIR)) {
    try {
      const sampleFiles = fs.readdirSync(SAMPLES_DIR);
      for (const file of sampleFiles) {
        if (!file.endsWith('.png') && !file.endsWith('.jpg')) continue;
        const targetPath = path.join(PROJECT_INPUT_DIR, file);
        if (!fs.existsSync(targetPath)) {
          fs.copyFileSync(path.join(SAMPLES_DIR, file), targetPath);
        }
      }
    } catch (e) {
      console.warn('Failed to seed sample presets:', e.message);
    }
  }
}

module.exports = {
  PORT,
  HOST,
  COMFY_URL,
  COMFY_WS_URL,
  COMFY_REMOTE,
  COMFY_DIR,
  COMFY_INPUT_DIR,
  COMFY_OUTPUT_DIR,
  WORKFLOWS_DIR,
  COMFY_TEMP_INPUT_DIR,
  COMFY_TEMP_OUTPUT_DIR,
  PROJECT_DIR,
  STORAGE_DIR,
  PROJECT_INPUT_DIR,
  PROJECT_OUTPUT_DIR,
  PROJECT_VIDEO_DIR,
  PROJECT_IMAGE_DIR,
  SAMPLES_DIR,
  ASPECT_CANVAS,
  randomSeed,
  ensureStorageDirs
};