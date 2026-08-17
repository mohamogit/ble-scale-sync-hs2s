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

export function isDuplicate(
  state: SyncState,
  all: { weight: number; timestamp?: string; impedance?: number; _isNewWeighIn?: boolean }[],
  now?: Date,
): boolean {
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
    if (Math.abs(at - bt) > 2000) return false;
    if ((a.impedance ?? 0) !== (b.impedance ?? 0)) return false;
  }
  // RTC stuck 场景：设备时间不再走，history 指纹完全相同但用户确实又站了一次。
  // 此时靠 _isNewWeighIn (scale 在本次连接中收到 0x24 measure finish) 且距离上次上传 >5min 才放行，避免 2 分钟轮询空转误推。
  const latest: any = all[all.length - 1];
  if (latest && latest._isNewWeighIn) {
    if (state.lastServerTime && now) {
      const gapMin = (now.getTime() - new Date(state.lastServerTime).getTime()) / 60000;
      if (gapMin > 5) return false;
    } else {
      return false;
    }
  }
  return true;
}
