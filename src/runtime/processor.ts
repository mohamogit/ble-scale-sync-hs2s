import type { RawReading } from '../ble/shared.js';
import type { Exporter } from '../interfaces/exporter.js';
import type { BodyComposition, ScaleReading } from '../interfaces/scale-adapter.js';
import type { AppContext } from './context.js';
import { resolveUserProfile } from '../config/resolve.js';
import { dispatchExports } from '../orchestrator.js';
import { createLogger } from '../logger.js';
import { fmtWeight } from './format.js';
import { loadState, saveState, isDuplicate } from './state.js';

const log = createLogger('Sync');

export async function processReading(
  ctx: AppContext,
  raw: RawReading,
  exporters: Exporter[] | undefined,
  statePath?: string,
): Promise<boolean> {
  const user = ctx.config.users[0];
  const all: ScaleReading[] = raw.history ? [...raw.history, raw.reading] : [raw.reading];
  const profile = resolveUserProfile(user, ctx.config.scale);
  const state = await loadState(statePath);

  // Server time - we pulled data at this moment, disconnect already done
  // (scanAndReadRaw returns only after GATT disconnect). Upload will use this.
  const serverNow = new Date();

  let lastSuccess = true;
  let latestPayload: BodyComposition | null = null;
  let latestReading: ScaleReading | null = null;

  for (let i = 0; i < all.length; i++) {
    const reading = all[i];
    const isLast = i === all.length - 1;

    // Dedup based on DEVICE timestamp + weight (to detect truly new record)
    // Even though we upload with server time, we need device ts to know if it's new.
    if (isDuplicate(state, reading.timestamp, reading.weight)) {
      log.info(`Skipping duplicate (device ts ${reading.timestamp?.toISOString()}): ${fmtWeight(reading.weight, ctx.weightUnit)}`);
      continue;
    }

    const payload = raw.adapter.computeMetrics(reading, profile);
    log.info(`Measurement: ${fmtWeight(payload.weight, ctx.weightUnit)} / ${payload.impedance} Ohm [device ts ${reading.timestamp?.toISOString() ?? 'none'} → server ${serverNow.toISOString()}]`);
    log.info(`  BMI ${payload.bmi} Fat ${payload.bodyFatPercent}% Water ${payload.waterPercent}%`);

    if (ctx.dryRun || !exporters) {
      log.info('Dry run - skipping export');
      continue;
    }

    if (isLast) {
      latestPayload = payload;
      latestReading = reading;
    }

    // Upload uses SERVER time, not device RTC (avoids drift / battery reset issues)
    const context = {
      userName: user.name,
      userSlug: user.slug ?? 'user',
      userConfig: user as any,
      timestamp: serverNow,
    };

    const { success } = await dispatchExports(exporters, payload, context as any);
    if (isLast) lastSuccess = success;
  }

  // Save device timestamp for dedup, not server time
  if (latestPayload && latestReading && lastSuccess) {
    await saveState(
      { lastTimestamp: latestReading.timestamp?.toISOString(), lastWeight: latestReading.weight },
      statePath,
    );
    log.info(`State saved (device ts): ${latestReading.timestamp?.toISOString()}`);
  }

  return lastSuccess;
}
