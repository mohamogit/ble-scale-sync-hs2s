import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';
import type { RawReading } from '../ble/shared.js';
import { abortableSleep } from '../ble/types.js';

const log = createLogger('Sync');

export interface ReadingSource {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  nextReading(signal: AbortSignal): Promise<RawReading>;
}

export interface SimpleLoopDeps {
  source: ReadingSource;
  processReading: (raw: RawReading) => Promise<boolean>;
  signal: AbortSignal;
  scanCooldownSec: number;
  continuous: boolean;
}

export async function runContinuousLoop(deps: SimpleLoopDeps): Promise<void> {
  const { source, processReading, signal, scanCooldownSec, continuous } = deps;
  try {
    while (!signal.aborted) {
      try {
        await source.start?.();
        const raw = await source.nextReading(signal);
        await processReading(raw);
        if (!continuous) break;
      } catch (err) {
        if (signal.aborted) break;
        log.error(`Error: ${errMsg(err)}, retrying in ${scanCooldownSec}s...`);
        await abortableSleep(scanCooldownSec * 1000, signal).catch(() => {});
        if (!continuous) break;
        continue;
      }
      if (signal.aborted || !continuous) break;
      log.info(`Cooldown ${scanCooldownSec}s...`);
      await abortableSleep(scanCooldownSec * 1000, signal).catch(() => {});
    }
  } finally {
    await source.stop?.();
  }
}
