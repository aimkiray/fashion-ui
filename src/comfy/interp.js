const { COMFY_URL } = require('../paths');

// The remote ComfyUI core FrameInterpolationModelLoader requires RIFE/FILM
// weights to be placed manually in models/frame_interpolation (no auto
// download). The object_info combo options list is the source of truth for
// whether an interpolation model is installed. Probed with a short TTL cache
// so per-task lookups don't hammer the ComfyUI API.

const CACHE_TTL_MS = 60 * 1000;
// 空结果（未装模型）用短 TTL：装好模型后最多 5s 即可被检测到，而不是等满 60s
const CACHE_TTL_EMPTY_MS = 5 * 1000;
let cache = { value: null, expires: 0 };

// Returns the first available RIFE frame interpolation model name, or null
// when none is installed (enhanced runs then fall back to 24fps and tell the
// user). RIFE is preferred over FILM: options are returned alphabetically
// (film_net first), but the HD template and smoke validation were tuned on
// RIFE — only fall back to a non-RIFE model if no RIFE variant exists.
async function getFrameInterpModel({ signal } = {}) {
  if (cache.expires > Date.now()) return cache.value;
  try {
    const res = await fetch(`${COMFY_URL}/object_info/FrameInterpolationModelLoader`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    const entry = info && info.FrameInterpolationModelLoader;
    const options = entry && entry.input && entry.input.required &&
      entry.input.required.model_name && entry.input.required.model_name[1] &&
      entry.input.required.model_name[1].options;
    const list = Array.isArray(options) ? options.map(String) : [];
    const model = list.find(o => /rife/i.test(o)) || list[0] || null;
    cache = { value: model, expires: Date.now() + (model ? CACHE_TTL_MS : CACHE_TTL_EMPTY_MS) };
    return model;
  } catch (e) {
    // Unreachable ComfyUI: don't cache the failure — the next task retries.
    if (e.name === 'AbortError') throw e;
    console.warn('Frame interpolation probe failed:', e.message);
    return null;
  }
}

function resetInterpCache() {
  cache = { value: null, expires: 0 };
}

module.exports = { getFrameInterpModel, resetInterpCache };
