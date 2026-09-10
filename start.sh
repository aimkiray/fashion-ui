#!/usr/bin/env bash
set -e

# Change to project root directory
cd "$(dirname "$0")"

echo "======================================================="
echo "Starting AI Fashion Studio..."
echo "======================================================="

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not found. Please install Node.js >= 18."
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "[WARN] Node.js version is $NODE_VERSION. Recommended version >= 18."
fi

# Check Python and dependencies
PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

if [ -n "$PYTHON_BIN" ]; then
  if ! "$PYTHON_BIN" -c "import PIL, numpy" >/dev/null 2>&1; then
    echo "[WARN] Python dependencies (Pillow, numpy) not fully installed."
    echo "       Run: pip install -r requirements.txt"
  else
    echo "[OK] Python 3 + Pillow + numpy detected."
  fi
else
  echo "[WARN] Python 3 not found in PATH. Image cropping / flatlay detection will fallback."
fi

# Install npm dependencies if missing
if [ ! -f "node_modules/express/package.json" ]; then
  echo "[SETUP] Installing Node.js dependencies..."
  npm install --no-fund --no-audit
fi

# Check ComfyUI connectivity
COMFY_CHECK_URL="${COMFY_URL:-http://127.0.0.1:8188}"
if command -v curl >/dev/null 2>&1; then
  if curl --silent --fail --max-time 2 "${COMFY_CHECK_URL}/system_stats" >/dev/null 2>&1; then
    echo "[OK] ComfyUI detected online at ${COMFY_CHECK_URL}"
  else
    echo "[INFO] ComfyUI not responding at ${COMFY_CHECK_URL}. Generation requires ComfyUI to be running."
  fi
fi

# Start server
node server.js
