#!/usr/bin/env bash
set -e

# Change to project root directory
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
PID=$(lsof -ti :"$PORT" || true)

if [ -n "$PID" ]; then
  echo "Stopping AI Fashion Studio on port $PORT (PID $PID)..."
  kill -15 "$PID" || true
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" || true
  fi
  echo "[OK] AI Fashion Studio stopped."
else
  echo "[INFO] No process listening on port $PORT."
fi
