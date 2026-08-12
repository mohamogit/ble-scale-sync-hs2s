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
pip install -r requirements.txt  # garminconnect
npm ci --omit=dev
npm run build
sudo systemctl enable --now bluetooth
npm start
```

## 裁剪说明

- 删除 Docker/Home Assistant/firmware/docs 等全部未用
- 依赖 5 个：node-ble, yaml, zod, dotenv, tsx
- 体积 46M (原 257M)
