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
  // Simplest Pi-side complete record: no RTC, no windows.
  // Pi saves lastHistoryHash (hash of all history+reading). If history changed -> new weigh-in.
  // If history same -> duplicate (2-min polling with same data).
  if (!state.lastHistoryHash) return false; // first run
  if (historyHash && historyHash !== state.lastHistoryHash) return false; // history changed -> new
  // history same -> check weight as well (weight is part of hash, but keep explicit)
  if (state.lastWeight !== undefined && Math.abs(state.lastWeight - weight) >= 0.1) return false; // weight changed -> new
  return true; // history same + weight same -> duplicate
}
