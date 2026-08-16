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
  // Pi saves complete history: any change -> new operation, faithful to actual steps.
  // Don't look at weight values, just history. Even same weight twice -> historyHash changes (rawCount) -> new.
  if (!state.lastHistoryHash) return false;
  if (historyHash && historyHash !== state.lastHistoryHash) return false;
  return true;
}
