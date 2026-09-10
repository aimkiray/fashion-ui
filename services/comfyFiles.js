const fs = require('fs');
const path = require('path');

// Bridge to a REMOTE ComfyUI instance (COMFY_REMOTE=1): stage workflow inputs
// via POST /upload/image and fetch outputs via GET /view, instead of direct
// filesystem access into the ComfyUI installation. ComfyUI exposes no delete
// API, so staged online_temp files accumulate on the ComfyUI host in this mode.

function resolveComfyUrl(comfyUrl) {
  return comfyUrl || process.env.COMFY_URL || 'http://127.0.0.1:8188';
}

/**
 * Upload a local file into the remote ComfyUI input tree.
 * @returns {Promise<{name: string, subfolder: string, type: string}>} the
 *   stored file coordinates; LoadImage nodes reference `subfolder/name`.
 */
async function uploadToComfyInput(localPath, { subfolder = 'online_temp', type = 'input', overwrite = true, comfyUrl } = {}) {
  const base = resolveComfyUrl(comfyUrl);
  const data = fs.readFileSync(localPath);
  const fd = new FormData();
  fd.append('image', new Blob([data]), path.basename(localPath));
  fd.append('subfolder', subfolder);
  fd.append('type', type);
  fd.append('overwrite', String(overwrite));
  const res = await fetch(`${base}/upload/image`, { method: 'POST', body: fd });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ComfyUI 上传失败 (HTTP ${res.status}): ${String(detail).slice(0, 200)}`);
  }
  const j = await res.json();
  return { name: j.name, subfolder: j.subfolder || subfolder, type: j.type || type };
}

/**
 * Download a generated file from the remote ComfyUI output/temp tree.
 * `ref` uses the same coordinates found in ComfyUI history outputs:
 * { filename, subfolder, type: 'output' | 'temp' | 'input' }.
 */
async function downloadFromComfy(ref, destPath, comfyUrl) {
  const base = resolveComfyUrl(comfyUrl);
  const qs = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder || '',
    type: ref.type || 'output'
  });
  const res = await fetch(`${base}/view?${qs.toString()}`);
  if (!res.ok) {
    throw new Error(`ComfyUI 文件获取失败 (HTTP ${res.status}): ${ref.filename}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

/** Resolve when the file is retrievable via /view, reject otherwise. */
async function comfyViewExists(ref, comfyUrl) {
  const base = resolveComfyUrl(comfyUrl);
  const qs = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder || '',
    type: ref.type || 'output'
  });
  try {
    const res = await fetch(`${base}/view?${qs.toString()}`);
    return res.ok;
  } catch (e) {
    return false;
  }
}

module.exports = { uploadToComfyInput, downloadFromComfy, comfyViewExists };
