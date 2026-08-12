import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

export interface SyncState {
  lastTimestamp?: string; // ISO
  lastWeight?: number;
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

export function isDuplicate(state: SyncState, timestamp: Date | undefined, weight: number): boolean {
  if (!timestamp || !state.lastTimestamp) return false;
  const sameTs = state.lastTimestamp === timestamp.toISOString();
  const sameWeight = state.lastWeight !== undefined && Math.abs(state.lastWeight - weight) < 0.1;
  return sameTs && sameWeight;
}
