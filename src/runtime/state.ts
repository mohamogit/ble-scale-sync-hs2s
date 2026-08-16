import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

export interface SyncState {
  lastTimestamp?: string; // ISO device ts
  lastWeight?: number;
  lastServerTime?: string; // ISO server wall time of last successful upload (for stale RTC dedup)
  lastHistoryHash?: string; // hash of last uploaded history (to detect new weigh-in with stale RTC)
}

const DEFAULT_STATE_PATH = join(process.cwd(), 'state.json');

export async function loadState(path = DEFAULT_STATE_PATH): Promise<SyncState> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as SyncState;
  } catch {
    return {};
  }
}

export async function saveState(state: SyncState, path = DEFAULT_STATE_PATH): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(state, null, 2));
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
}

export function isDuplicate(state: SyncState, timestamp: Date | undefined, weight: number, now?: Date, historyHash?: string): boolean {
  if (!timestamp || !state.lastTimestamp) return false;
  const lastMs = new Date(state.lastTimestamp).getTime();
  const curMs = timestamp.getTime();
  // older than last synced → already seen (historic replay, e.g. 23-record HS2S offline pull)
  if (curMs < lastMs) return true;
  if (curMs > lastMs) return false;
  // same second: normally duplicate if weight matches, but HS2S RTC is stale
  // (device ts stuck at 2026-08-14) so a real new weigh-in next day has same device ts.
  // Use server time gap to distinguish: if >30min since last upload, treat as new measurement.
  const sameWeight = state.lastWeight !== undefined && Math.abs(state.lastWeight - weight) < 0.1;
  if (!sameWeight) return false;
  // same ts + same weight → check server time gap
  // For stale RTC (device ts stuck), same weight next day should be allowed, but
  // polling every 2min with same weight should be suppressed. Use 12h gap.
  if (state.lastServerTime && now) {
    const lastServerMs = new Date(state.lastServerTime).getTime();
    const gapMin = (now.getTime() - lastServerMs) / 60000;
    if (gapMin > 720) return false; // stale RTC, new weigh-in after 12h
  } else if (!state.lastServerTime && now) {
    // old state file without lastServerTime: use device ts age vs now as fallback
    const ageMin = (now.getTime() - curMs) / 60000;
    if (ageMin > 720) return false; // device ts is >12h old, likely stale RTC new measurement
  } else if (state.lastServerTime) {
    // no now provided, be conservative
    return true;
  }
  return true;
}
