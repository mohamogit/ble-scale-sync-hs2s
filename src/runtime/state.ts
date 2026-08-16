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
  // Pi saves complete history: any history change -> new operation.
  // Same history + same weight -> duplicate, but allow after 12h for same-weight same-history new step
  // (full history wraparound same data) and for rawCount-based same-weight new step.
  if (!state.lastHistoryHash) return false;
  if (historyHash && historyHash !== state.lastHistoryHash) return false;
  // history same -> check weight (weight is part of hash, but keep explicit)
  if (state.lastWeight !== undefined && Math.abs(state.lastWeight - weight) >= 0.1) return false;
  // history same + weight same -> check 12h window for full-wrap same data
  if (now && state.lastServerTime) {
    const gapMin = (now.getTime() - new Date(state.lastServerTime).getTime()) / 60000;
    if (gapMin > 720) return false;
  }
  return true;
}
