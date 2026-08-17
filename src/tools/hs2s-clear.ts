#!/usr/bin/env tsx
// SDK 原样清空 — 按 Hs2sProfile.ACTION_DELETE_HISTORY_DATA 的 deleteOfflineData(A9 32)
process.env.HS2S_CLEAR = '1'
import { loadAppConfig } from '../config/load.js'
import { resolveRuntimeConfig } from '../config/resolve.js'
import { createAppContext } from '../runtime/context.js'
import { resolveUserProfile } from '../config/resolve.js'
import { scanAndReadRaw } from '../ble/index.js'
import { IHealthHs2sAdapter } from '../scales/ihealth-hs2s.js'

const loaded = loadAppConfig(undefined)
const config = loaded.config
const resolved = resolveRuntimeConfig(config)
const ctx = createAppContext({ config, resolved, configSource: loaded.source, configPath: loaded.configPath, signal: new AbortController().signal, abortApp: ()=>{} })
const profile = resolveUserProfile(config.users[0], config.scale)
console.log('=== HS2S SDK 清空 — 将在拉取 23 条后发送 A9 32 删除 (Hs2sControl.deleteOfflineData) ===')
const adapter = new IHealthHs2sAdapter()
try{
  const raw = await scanAndReadRaw({ targetMac: ctx.scaleMac, adapters: [adapter], profile, weightUnit: ctx.weightUnit, abortSignal: ctx.signal, bleAdapter: ctx.bleAdapter } as any)
  console.log('clear done, raw count', (raw as any)?.all?.length ?? (raw as any)?.history?.length ?? 0)
}catch(e){ console.error('clear err', (e as Error).message) }
setTimeout(()=>process.exit(0), 800)
