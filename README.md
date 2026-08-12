# HS2S Minimal — iHealth HS2S → Garmin (Pi)

极简：只支持 **iHealth HS2S**，单 `node-ble` 后端，单 `garmin` exporter，`state.json` 去重，每次上传**全新登录**（无 token 过期），保留 `npm start` + `continuous_mode`。

## 快速开始

```bash
cp config.min.example.yaml config.yaml
# 编辑 config.yaml: 填 height/birth_date/gender + garmin email/password
npm run build
npm start              # continuous_mode: true 常驻；false 单次
npm start -- --config ./config.yaml --state ./state.json
```

## 配置

见 `config.min.example.yaml`。`email`/`password` 必填，每次上传都会 `Garmin(email,password).login()` 全新登录，不依赖 `garmin-tokens` 目录（token 过期问题已规避）。`token_dir` 为可选 fallback。

- `ble.scale_mac` / `ble.adapter`
- `users[0]` + `runtime.continuous_mode/scan_cooldown/dry_run/debug`
- `state.json` 自动生成，去重同 timestamp+weight

## 树莓派

```bash
./setup.sh                      # Pi: npm --ignore-scripts + .venv + pip install garminconnect
npm run build
sudo systemctl enable --now bluetooth
npm start                       # continuous_mode: true 常驻；false 单次后退出
```

### Pi 3B+ 生产部署（推荐 cron，非 continuous）

Pi 3B+ 的 UART 蓝牙（BCM4345C0）容易 `0x200c tx timeout -110` wedged，continuous 重启后会丢。
推荐用 cron 每 2 分钟跑一次一撮 + `flock` + `timeout` + `run.sh` 自动恢复：

```bash
# 1. 先设成单次模式
# config.yaml: runtime.continuous_mode: false

# 2. 加 cron（选一种，推荐 logger 省 SD 卡写入）
crontab -e
# 方案 A — 写内存日志（推荐，最省 SD）
*/2 * * * * flock -n /tmp/hs2s.lock bash -c 'timeout 130 /home/pi/ble-scale-sync-hs2s/run.sh 2>&1 | logger -t hs2s'
# 查看： journalctl -t hs2s -f  或  journalctl -t hs2s --since "1 hour ago"

# 方案 B — 写文件（调试用，记得配 logrotate）
# */2 * * * * flock -n /tmp/hs2s.lock timeout 130 /home/pi/ble-scale-sync-hs2s/run.sh >>/tmp/hs2s.log 2>&1

# 3. 手工自检（脱离项目测蓝牙）
bluetoothctl scan on             # 2-3s 应刷出 HS2S 11070
npm run scan                     # 15s 列所有 BLE
npm start                        # 单次：连秤→去重→Garmin
```

`run.sh` 会在每次启动前检查 `rfkill` / `Powered: no` / `dmesg 0x200c -110` 并自动 `hciconfig hci0 reset`。
Node 建议 `22 LTS`（`nvm install 22`），`24` 在 Pi3B+ 上会让 `@stoprocent/noble` 编译失败。
```

## 裁剪说明

- 删除 Docker/Home Assistant/firmware/docs 等全部未用
- 依赖 5 个：node-ble, yaml, zod, dotenv, tsx
- 体积 46M (原 257M)
