const WebSocket = require("ws");
const { randomUUID: uuidv4 } = require("crypto");
const { COMFY_URL, COMFY_WS_URL } = require("../paths");
// Helper: ComfyUI HTTP Submission with Real-time WebSocket Progress & Circuit Breaker
async function submitComfyWorkflowWithProgress(workflow, onProgress = () => {}, { signal, timeoutMs } = {}) {
  if (signal && signal.aborted) {
    throw new Error('任务已被用户取消');
  }

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

  if (signal && signal.aborted) {
    if (ws) { try { ws.close(); } catch(e) {} }
    throw new Error('任务已被用户取消');
  }

  try {
    const postOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId })
    };
    if (signal) postOptions.signal = signal;

    const res = await fetch(`${COMFY_URL}/prompt`, postOptions);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ComfyUI rejected prompt (${res.status}): ${text}`);
    }

    const { prompt_id } = await res.json();
    const startTime = Date.now();
    // Default 30min covers the base workflow; 超清增强 runs pass options.timeoutMs
    // (60min) — its upscale + RIFE + re-encode chain is far longer than baseline.
    const deadlineMs = timeoutMs || 30 * 60 * 1000;
    let consecutiveNetworkErrors = 0;
    const MAX_CONSECUTIVE_NETWORK_ERRORS = 10; // ~12 seconds of complete disconnection

    while (Date.now() - startTime < deadlineMs) {
      if (signal && signal.aborted) {
        try { await fetch(`${COMFY_URL}/interrupt`, { method: 'POST' }); } catch(e) {}
        throw new Error('任务已被用户取消');
      }

      await new Promise(r => setTimeout(r, 1200));

      if (signal && signal.aborted) {
        try { await fetch(`${COMFY_URL}/interrupt`, { method: 'POST' }); } catch(e) {}
        throw new Error('任务已被用户取消');
      }

      let histRes;
      let history;
      try {
        const fetchOpts = { method: 'GET' };
        if (signal) fetchOpts.signal = signal;
        histRes = await fetch(`${COMFY_URL}/history/${prompt_id}`, fetchOpts);
        if (!histRes.ok) {
          consecutiveNetworkErrors++;
          if (consecutiveNetworkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) {
            throw new Error(`ComfyUI 服务响应异常 (HTTP ${histRes.status}，连续 ${MAX_CONSECUTIVE_NETWORK_ERRORS} 次失败，请检查 ${COMFY_URL})`);
          }
          continue;
        }
        consecutiveNetworkErrors = 0;
        history = await histRes.json();
      } catch (e) {
        if (signal && signal.aborted) {
          try { await fetch(`${COMFY_URL}/interrupt`, { method: 'POST' }); } catch(err) {}
          throw new Error('任务已被用户取消');
        }
        if (e.message.includes('ComfyUI 服务响应异常')) throw e;

        consecutiveNetworkErrors++;
        if (consecutiveNetworkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) {
          throw new Error(`ComfyUI 服务连接中断（连续 ${MAX_CONSECUTIVE_NETWORK_ERRORS} 次请求失败，请检查 ComfyUI 服务是否存活于 ${COMFY_URL}）`);
        }
        continue;
      }
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
    throw new Error(`ComfyUI execution timed out after ${Math.round(deadlineMs / 60000)} minutes.`);
  } finally {
    if (ws) {
      try { ws.close(); } catch(e) {}
    }
  }
}


module.exports = { submitComfyWorkflowWithProgress };