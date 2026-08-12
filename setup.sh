#!/bin/bash
set -e
echo "== HS2S minimal setup =="

# Node
if ! command -v node >/dev/null 2>&1; then
  echo "Need node >=22"; exit 1
fi
npm ci --omit=dev 2>/dev/null || npm install
npm run build

# Python venv (isolated, Pi-friendly)
if [ ! -d ".venv" ]; then
  echo "Creating Python venv..."
  python3 -m venv .venv
fi
echo "Installing Python deps..."
.venv/bin/pip install --upgrade pip -q
.venv/bin/pip install -r requirements.txt -q

echo "Done. Edit config.min.example.yaml -> config.yaml then npm start"
