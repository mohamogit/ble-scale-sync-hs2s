import type { RawReading } from '../ble/shared.js';
import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { scanAndReadRaw } from '../ble/index.js';
import { withTimeout, POLL_CYCLE_TIMEOUT_MS } from '../ble/types.js';
import { resolveUserProfile } from '../config/resolve.js';
import type { AppContext } from './context.js';
import type { ReadingSource } from './loop.js';

export class PollReadingSource implements ReadingSource {
  constructor(private readonly ctx: AppContext, private readonly adapters: ScaleAdapter[]) {}
  async nextReading(signal: AbortSignal): Promise<RawReading> {
    const user = this.ctx.config.users[0];
    const profile = resolveUserProfile(user, this.ctx.config.scale);
    const scan = scanAndReadRaw({
      targetMac: this.ctx.scaleMac,
      adapters: this.adapters,
      profile,
      weightUnit: this.ctx.weightUnit,
      abortSignal: signal,
      bleAdapter: this.ctx.bleAdapter,
    });
    return withTimeout(scan, POLL_CYCLE_TIMEOUT_MS, `Scan cycle exceeded ${POLL_CYCLE_TIMEOUT_MS/1000}s`);
  }
}
