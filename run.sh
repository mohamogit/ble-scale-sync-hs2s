#!/bin/bash
# HS2S Pi runner — robust for Pi 3B+ BCM4345C0 UART BT (hci0)
# Use with cron: flock -n keeps overlaps out, timeout kills wedged scans
#   crontab -e:
#   */2 * * * * flock -n /tmp/hs2s.lock timeout 130 /home/pi/ble-scale-sync-hs2s/run.sh >>/tmp/hs2s.log 2>&1
# Or with logger (SD-friendly):
#   */2 * * * * flock -n /tmp/hs2s.lock bash -c 'timeout 130 /home/pi/ble-scale-sync-hs2s/run.sh 2>&1 | logger -t hs2s'

set -e
cd "$(dirname "$0")"

# nvm on Pi (Node 22 LTS recommended; Node 24 fails noble gyp on aarch64)
if [ -f "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh" 2>/dev/null || true
fi

# 1) Preflight: recover wedged hci0 (0x200c tx timeout / PowerState off-blocked)
#    Pi 3B+ UART BT wedges if Discovery was left running (Ctrl-C) or concurrent scans.
recover_bt() {
  local need_reset=0

  # rfkill soft-blocked?
  if command -v rfkill >/dev/null 2>&1; then
    if rfkill list bluetooth 2>/dev/null | grep -q "Soft blocked: yes"; then
      echo "[run.sh] rfkill soft blocked, unblocking..."
      sudo rfkill unblock bluetooth 2>/dev/null || true
      need_reset=1
    fi
  fi

  # bluetoothctl Powered check (timeout 5s to avoid hang)
  if command -v bluetoothctl >/dev/null 2>&1; then
    if ! timeout 5 bluetoothctl show 2>/dev/null | grep -q "Powered: yes"; then
      echo "[run.sh] hci0 not powered, trying power on..."
      timeout 5 bluetoothctl power on 2>/dev/null || true
      sleep 1
      if ! timeout 5 bluetoothctl show 2>/dev/null | grep -q "Powered: yes"; then
        need_reset=1
      fi
    fi
  fi

  # dmesg wedged signature (last 10 lines)
  if dmesg 2>/dev/null | tail -n 10 | grep -qE "0x200c.*-110|Unable to disable scanning|Frame reassembly failed"; then
    echo "[run.sh] dmesg shows hci0 wedged, will reset"
    need_reset=1
  fi

  if [ "$need_reset" = "1" ]; then
    echo "[run.sh] resetting hci0..."
    sudo hciconfig hci0 reset 2>/dev/null || sudo hciconfig hci0 down 2>/dev/null || true
    sleep 1
    sudo hciconfig hci0 up 2>/dev/null || true
    sleep 1
    sudo rfkill unblock bluetooth 2>/dev/null || true
    # also restart bluetoothd's discovery state if stuck
    # (harmless if not wedged)
  fi
}

recover_bt

# 2) Run one-shot sync (non-continuous). For continuous_mode=true, this script
#    is NOT used — run `npm start` manually or via systemd instead.
CONFIG="${1:-./config.yaml}"
STATE="${2:-./state.json}"

# Prefer built dist (faster on Pi), fallback to tsx
if [ -f "dist/index.js" ]; then
  exec node dist/index.js --config "$CONFIG" --state "$STATE"
else
  exec npx --yes tsx src/index.ts --config "$CONFIG" --state "$STATE"
fi
