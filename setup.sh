#!/bin/bash
set -e
echo "== HS2S minimal setup =="

if ! command -v node >/dev/null 2>&1; then
  echo "Need node >=22"; exit 1
fi

# On Pi (linux) noble is optional (only for Mac test), ignore build failures
if [ "$(uname)" = "Linux" ]; then
  echo "Linux detected: installing without optional Mac BLE driver..."
  npm install --ignore-scripts 2>&1 | tail -n 5 || true
  # Try to build noble optionally, ignore failure
  npm install --ignore-scripts 2>&1 | grep -v "gyp ERR" || true
else
  npm ci --omit=dev 2>/dev/null || npm install
fi
npm run build

if [ ! -d ".venv" ]; then
  echo "Creating Python venv..."
  python3 -m venv .venv
fi
echo "Installing Python deps..."
.venv/bin/pip install --upgrade pip -q 2>&1 | tail -n 2 || true
.venv/bin/pip install -r requirements.txt -q 2>&1 | tail -n 2 || true

echo "Done. Edit config.min.example.yaml -> config.yaml then npm start"
