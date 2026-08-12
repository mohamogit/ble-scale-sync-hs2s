import type { BleDeviceInfo, ScaleAdapter } from '../interfaces/scale-adapter.js';
import { adapters as defaultRegistry } from './index.js';
export function resolveAdapter(device: BleDeviceInfo, registry: readonly ScaleAdapter[] = defaultRegistry): ScaleAdapter | undefined {
  return registry.find(a=>a.matches(device));
}
