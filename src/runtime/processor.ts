import type { RawReading } from '../ble/shared.js';
import type { Exporter } from '../interfaces/exporter.js';
import type { BodyComposition, ScaleReading } from '../interfaces/scale-adapter.js';
import type { AppContext } from './context.js';
import { resolveUserProfile } from '../config/resolve.js';
import { dispatchExports } from '../orchestrator.js';
import { createLogger, isDebugEnabled } from '../logger.js';
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

  const serverNow = new Date();

  let lastSuccess = true;
  let latestPayload: BodyComposition | null = null;
  let latestReading: ScaleReading | null = null;

  // HS2S offline pull always replays up to 23 historic records every connection.
  // On first ever run (no state.json) that would flood Garmin with old data.
  // Only the newest force-live record is the current weigh-in.
  const isFirstRun = !state.lastTimestamp;
  const candidates = isFirstRun && all.length > 1 ? [all[all.length - 1]] : all;
  if (isFirstRun && all.length > 1) {
    log.info(`First run: ${all.length} historic records buffered, only uploading newest (device ts ${all[all.length-1].timestamp?.toISOString()})`);
  }

  for (let i = 0; i < candidates.length; i++) {
    const reading = candidates[i];
    const isLast = i === candidates.length - 1;

    if (isDuplicate(state, reading.timestamp, reading.weight)) {
      log.info(`Skipping duplicate (device ts ${reading.timestamp?.toISOString()}): ${fmtWeight(reading.weight, ctx.weightUnit)}`);
      continue;
    }

    const payload = raw.adapter.computeMetrics(reading, profile);
    // HS2S has 4 impedances in offline 35B records but none are used for Garmin;
    // Garmin gets scale-computed bodyFat/muscle/water directly (scaleComp).
    // Only show raw impedance in debug mode.
    if (isDebugEnabled()) {
      const imp = reading.impedance ? `${reading.impedance} Ohm` : 'n/a';
      const imps = (reading as any).impedances ? ` [raw4: ${(reading as any).impedances.join(',')}]` : '';
      const sc = (reading as any).scaleComp;
      const scStr = sc ? ` scaleComp: fat${sc.bodyFatPercent}% muscle${sc.muscleMass}kg water${sc.waterPercent}%` : ' (BIA fallback)';
      log.debug(`Raw: ${fmtWeight(reading.weight, ctx.weightUnit)} / ${imp}${imps}${scStr} [device ts ${reading.timestamp?.toISOString() ?? 'none'}]`);
    }
    // Always show what will be uploaded to Garmin (weight + body comp, no impedance)
    log.info(`Measurement: ${fmtWeight(payload.weight, ctx.weightUnit)} → server ${new Date(serverNow.getTime() - serverNow.getTimezoneOffset()*60000).toISOString().slice(0,19)} (local)`);
    log.info(`  Upload → Garmin: Fat ${payload.bodyFatPercent}% Water ${payload.waterPercent}% Muscle ${payload.muscleMass}kg Bone ${payload.boneMass}kg Visceral ${payload.visceralFat} BMI ${payload.bmi}`);

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
      timestamp: serverNow,
    };

    const { success } = await dispatchExports(exporters, payload, context as any);
    if (isLast) lastSuccess = success;
  }

  if (latestPayload && latestReading && lastSuccess) {
    await saveState(
      { lastTimestamp: latestReading.timestamp?.toISOString(), lastWeight: latestReading.weight },
      statePath,
    );
    if (isDebugEnabled()) log.debug(`State saved (device ts): ${latestReading.timestamp?.toISOString()}`);
  }

  return lastSuccess;
}
