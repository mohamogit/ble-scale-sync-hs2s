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

  let lastSuccess = true;
  let latestPayload: BodyComposition | null = null;
  let latestReading: ScaleReading | null = null;

  for (let i = 0; i < all.length; i++) {
    const reading = all[i];
    const isLast = i === all.length - 1;

    // state-based dedup: same timestamp + weight within 0.1kg
    if (isDuplicate(state, reading.timestamp, reading.weight)) {
      log.info(`Skipping duplicate: ${fmtWeight(reading.weight, ctx.weightUnit)} @ ${reading.timestamp?.toISOString()}`);
      continue;
    }

    const payload = raw.adapter.computeMetrics(reading, profile);
    log.info(`Measurement: ${fmtWeight(payload.weight, ctx.weightUnit)} / ${payload.impedance} Ohm${reading.timestamp ? ` [historic ${reading.timestamp.toISOString()}]` : ''}`);
    log.info(`  BMI ${payload.bmi} Fat ${payload.bodyFatPercent}% Water ${payload.waterPercent}%`);

    if (ctx.dryRun || !exporters) {
      log.info('Dry run - skipping export');
      continue;
    }

    if (isLast) {
      latestPayload = payload;
      latestReading = reading;
    }

    const context = {
      userName: user.name,
      userSlug: user.slug ?? 'user',
      userConfig: user as any,
      ...(reading.timestamp ? { timestamp: reading.timestamp } : {}),
    };

    const { success } = await dispatchExports(exporters, payload, context as any);
    if (isLast) lastSuccess = success;
  }

  if (latestPayload && latestReading && lastSuccess) {
    await saveState(
      { lastTimestamp: latestReading.timestamp?.toISOString(), lastWeight: latestReading.weight },
      statePath,
    );
  }

  return lastSuccess;
}
