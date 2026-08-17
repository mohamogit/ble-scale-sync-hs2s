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
  // RTC drift visibility (required by user)
  const _deviceTs = all[all.length-1]?.timestamp;
  if (_deviceTs) {
    const driftH = (serverNow.getTime() - _deviceTs.getTime())/3600000;
    if (Math.abs(driftH) > 24) log.warn(`Device RTC drift ${driftH.toFixed(1)}h — device clock inaccurate (RTC stuck), using server time for Garmin`);
    else log.info(`Device RTC ${_deviceTs.toISOString()} (drift ${driftH.toFixed(1)}h) → Server ${serverNow.toISOString()}`);
  }

  let lastSuccess = true;
  let latestPayload: BodyComposition | null = null;
  let latestReading: ScaleReading | null = null;
  // 保留 _isNewWeighIn 用于 RTC 卡住时的“确实又站了一次”判断（其余易失字段已去掉），RTC 展示保留
  const allForCompare = all.map(r => ({ weight: r.weight, timestamp: r.timestamp?.toISOString(), impedance: r.impedance, _isNewWeighIn: (r as any)._isNewWeighIn }));

  // HS2S offline pull always replays up to 23 historic records every connection.
  // On first ever run (no state.json) that would flood Garmin with old data.
  // Only the newest force-live record is the current weigh-in.
  const isFirstRun = !state.lastAll || state.lastAll.length === 0;
  const isMigratingFromSingle = state.lastAll?.length === 1 && all.length > 1;
  const candidates = (isFirstRun || isMigratingFromSingle) && all.length > 1 ? [all[all.length - 1]] : all;
  if ((isFirstRun || isMigratingFromSingle) && all.length > 1) {
    log.info(`First run: ${all.length} historic records buffered, only uploading newest (device ts ${all[all.length-1].timestamp?.toISOString()})`);
  }

  for (let i = 0; i < candidates.length; i++) {
    const reading = candidates[i];
    const isLast = i === candidates.length - 1;

    if (isDuplicate(state, allForCompare, serverNow)) {
      log.info(`Skipping duplicate (all ${all.length} records, latest ${fmtWeight(reading.weight, ctx.weightUnit)}): history unchanged`);
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
    // Use same TZ as Garmin export so log matches FIT timestamp
    const _tz2 = process.env.TZ || 'America/Los_Angeles';
    let _localStr2: string;
    try {
      const _fmt2 = new Intl.DateTimeFormat('en-CA', { timeZone: _tz2, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false});
      const _parts2 = Object.fromEntries(_fmt2.formatToParts(serverNow).map(p=>[p.type,p.value]));
      _localStr2 = `${_parts2.year}-${_parts2.month}-${_parts2.day} ${_parts2.hour}:${_parts2.minute}:${_parts2.second}`;
    } catch { _localStr2 = new Date(serverNow.getTime() - serverNow.getTimezoneOffset()*60000).toISOString().slice(0,19).replace('T',' '); }
    log.info(`Measurement: ${fmtWeight(payload.weight, ctx.weightUnit)} → server ${_localStr2} (${_tz2})`);
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
      { lastAll: allForCompare, lastWeight: latestReading.weight, lastServerTime: serverNow.toISOString() },
      statePath,
    );
    if (isDebugEnabled()) log.debug(`State saved (device ts): ${latestReading.timestamp?.toISOString()}`);
  }

  return lastSuccess;
}
