const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Single resolution point for the Python interpreter used by the image
// fitting scripts (crop_to_canvas.py / detect_flatlay.py).
//
// Resolution order:
//   1. PYTHON_BIN env var — pin to a known-good interpreter, e.g. the ComfyUI
//      venv on Windows: D:\Comfy\ComfyUI\venv\Scripts\python.exe
//   2. 'python' on win32 / 'python3' elsewhere (PATH)
//
// Pillow is the one required module for the fitting scripts. A one-time
// preflight verifies it and surfaces an actionable warning instead of letting
// every fit silently degrade to a raw file copy (which feeds mismatched
// first frames into the H3 workflow — the head-clipping bug).

let pilPreflight = null;

function getPythonBin() {
  return process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
}

async function ensurePilPreflight() {
  if (pilPreflight) return pilPreflight;
  pilPreflight = (async () => {
    const bin = getPythonBin();
    try {
      await execFileAsync(bin, ['-c', 'import PIL'], { timeout: 10000 });
      return { ok: true, bin };
    } catch (err) {
      // 区分错误形态：解释器不存在/不可执行 vs 解释器在但缺 Pillow
      const detail = err.code === 'ENOENT'
        ? `解释器不存在（ENOENT）：PYTHON_BIN="${bin}" 指向的文件无效`
        : err.code === 'EACCES'
          ? `解释器不可执行（EACCES）：检查文件权限`
          : err.killed || err.signal
            ? `预检超时被终止（${err.signal || 'timeout'}）`
            : `缺少 Pillow 模块`;
      console.warn(
        `[Python] ${bin} 不可用：${detail} — 图像画布适配将退化为直接复制，` +
        `视频首帧可能被 H3 裁切头部。\n` +
        `修复方式：pip install Pillow，或设置环境变量 PYTHON_BIN 指向含 Pillow 的解释器` +
        `（如 D:\\Comfy\\ComfyUI\\venv\\Scripts\\python.exe）。详情: ${err.message}`
      );
      return { ok: false, bin, reason: detail };
    }
  })();
  return pilPreflight;
}

// Run one of the project's python fitting scripts with the resolved
// interpreter. Throws on failure — callers own their fallback behavior.
async function runPythonScript(scriptPath, args, { timeout = 10000, encoding, maxBuffer } = {}) {
  const { bin } = await ensurePilPreflight();
  const opts = { timeout };
  if (encoding) opts.encoding = encoding;
  if (maxBuffer) opts.maxBuffer = maxBuffer;
  return execFileAsync(bin, [scriptPath, ...args], opts);
}

module.exports = { getPythonBin, ensurePilPreflight, runPythonScript };
