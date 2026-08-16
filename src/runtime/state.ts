import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

export interface SyncState {
  lastAll?: { weight: number; timestamp?: string; impedance?: number; _isNewWeighIn?: boolean }[];
  lastWeight?: number;
  lastServerTime?: string;
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

export function isDuplicate(state: SyncState, all: { weight: number; timestamp?: string; impedance?: number; _isNewWeighIn?: boolean }[]): boolean {
  // Pi saves complete history, direct逐条比对, handles same-time order by sorting.
  // Any new history change (new weigh-in) -> not duplicate, even with same weight.
  if (!state.lastAll || state.lastAll.length === 0) return false;
  if (all.length !== state.lastAll.length) return false;
  const sortFn = (a: any, b: any) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return a.weight - b.weight;
  };
  const sAll = [...all].sort(sortFn);
  const sLast = [...state.lastAll].sort(sortFn);
  for (let i = 0; i < sAll.length; i++) {
    const a = sAll[i], b = sLast[i];
    if (Math.abs(a.weight - b.weight) >= 0.1) return false;
    const at = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const bt = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    if (Math.abs(at - bt) > 1000) return false;
    if ((a.impedance ?? 0) !== (b.impedance ?? 0)) return false;
  }
  // all same, check if latest has _isNewWeighIn flag (real new step with same data, full history wrap)
  const latest: any = all[all.length - 1];
  if (latest && latest._isNewWeighIn) return false;
  return true;
}
