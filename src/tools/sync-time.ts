#!/usr/bin/env tsx
/**
 * HS2S RTC 同步工具 — 直接用本仓库的 TS 逆向版
 * 只做一件事：连秤 → 握手 → 拿 userId → 发 A9 23 时间同步 → 退出
 * 不依赖 Garmin，不写 state.json
 * 
 * 用法: npm run sync:time  或  tsx src/tools/sync-time.ts --config ./config.yaml
 */
import { parseArgs } from 'node:util';
import { loadAppConfig } from '../config/load.js';
import { resolveRuntimeConfig } from '../config/resolve.js';
import { createAppContext } from '../runtime/context.js';
import { scanAndReadRaw } from '../ble/index.js';
import { IHealthHs2sAdapter } from '../scales/ihealth-hs2s.js';
import { createLogger } from '../logger.js';

const { values: flags } = parseArgs({
  options: { config: { type: 'string', short: 'c' }, help: { type: 'boolean', short: 'h' } },
  strict: false,
});
if (flags.help) {
  console.log('Usage: tsx src/tools/sync-time.ts [--config <path>]');
  console.log('  连上 HS2S，发送 A9 23 时间同步帧，校正秤内 RTC');
  process.exit(0);
}
const log = createLogger('SyncTime');
const loaded = loadAppConfig(flags.config as string | undefined);
const config = loaded.config;
const resolved = resolveRuntimeConfig(config);

// 强制 dryRun，不触发 Garmin
const ac = new AbortController();
const ctx = createAppContext({ config, resolved, configSource: loaded.source, configPath: loaded.configPath, signal: ac.signal, abortApp: (r)=>ac.abort(r) });

// 用 HS2S 专用适配器，加一个一次性 time-sync 钩子
class TimeSyncAdapter extends IHealthHs2sAdapter {
  // 重写 onConnected：在标准流程前插入立即校时
  override async onConnected(c: any): Promise<void> {
    // 先走原版握手+拉取流程，但我们会在拿到 userId 后立刻补发 23
    await super.onConnected(c);
    // 原版的 sendOnlineUser 已在 finishOfflinePull 末尾发，这里再补一次“拿到 id 立刻发”
    // 通过轮询 userId，3s 内一旦有就发
    for (let i=0; i<30; i++) {
      await new Promise(r=>setTimeout(r, 100));
      const uid = (this as any).offlinePull?.userId as Buffer | null;
      if (uid) {
        log.info(`TimeSync: 检测到 userId ${uid.toString().trim()}, 立即补发 A9 23 时间同步...`);
        await (this as any).sendOnlineUser(uid).catch(()=>{});
        break;
      }
      if ((this as any).offlinePull === null) break; // 已进入匿名分支，无 user
    }
    // 无论如何再等2s让 23 发完
    await new Promise(r=>setTimeout(r, 2000));
  }
}

async function main() {
  const user = config.users[0];
  log.info(`HS2S 时间同步 — 目标: ${ctx.scaleMac ?? '自动扫描'}  用户: ${user.name} ${user.gender}/${user.height}cm`);
  log.info('请现在踩上秤唤醒（HS2S 需亮屏才会响应 R1），15s 内连接...');
  const { resolveUserProfile } = await import('../config/resolve.js');
  const profile = resolveUserProfile(user, config.scale);
  log.info(`当前本机时间: ${new Date().toISOString()}  unix=${Math.floor(Date.now()/1000)} (BE 4B 将写入秤 RTC)`);
  const adapter = new TimeSyncAdapter();
  const adapterAny = adapter as any;
  const origSendOnline = adapterAny.sendOnlineUser.bind(adapter);
  let syncSent = false;
  adapterAny.sendOnlineUser = async (uid?: Buffer) => {
    syncSent = true;
    log.info(`→ 发送 A9 23 时间同步帧 (uid=${uid?.toString().trim() ?? 'cached'}) @ ${new Date().toISOString()}`);
    return origSendOnline(uid);
  };

  try {
    const raw = await scanAndReadRaw({
      targetMac: ctx.scaleMac,
      adapters: [adapter],
      profile,
      weightUnit: ctx.weightUnit,
      abortSignal: ac.signal,
      bleAdapter: ctx.bleAdapter,
    } as any);
    log.info(`完成。raw count=${(raw as any).history?.length ?? (raw as any).all?.length ?? 0}  syncSent=${syncSent}`);
    if (syncSent) log.info('✅ 已发送时间同步，下次称重的时间戳将使用新 RTC。若 RTC 仍卡住，请检查：1) 秤是否在发送后断电 2) 再称一次看 ts 是否更新');
    else log.warn('⚠️ 未发送 A9 23（无注册用户，匿名模式不校时）。请先在官方 App 绑定一次用户，或本次工具已尝试匿名校时变体。');
  } catch (e) {
    log.error(`失败: ${(e as Error).message}`);
    log.info('排查: 1) bluetoothctl scan on 能否看到 HS2S  2) npm run scan 3) 靠近秤再试');
    process.exitCode = 1;
  } finally {
    setTimeout(()=>process.exit(process.exitCode ?? 0), 500);
  }
}
main();
