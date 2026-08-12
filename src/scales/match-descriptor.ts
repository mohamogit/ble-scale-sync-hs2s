import type { BleDeviceInfo } from '../interfaces/scale-adapter.js';
export interface MatchDescriptor {
  priority?: number;
  names?: { includes: string[] };
  serviceUuids?: string[];
  manufacturerIds?: number[];
  serviceDataUuids?: string[];
}
export function matchesDescriptor(info: BleDeviceInfo, desc: MatchDescriptor): boolean {
  if (desc.names) {
    const name = (info.localName || '').toLowerCase();
    if (!desc.names.includes.some(n => name.includes(n.toLowerCase()))) return false;
  }
  if (desc.serviceUuids) {
    const uuids = info.serviceUuids.map(u=>u.toLowerCase());
    if (!desc.serviceUuids.some(u=>uuids.includes(u.toLowerCase()))) return false;
  }
  return true;
}
