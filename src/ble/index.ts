/**
 * BLE entry point — auto-select: Linux → node-ble, macOS → @stoprocent/noble
 * HS2S-only, works on Pi (prod) and Mac (test)
 */
import type { ScaleAdapter, BodyComposition } from '../interfaces/scale-adapter.js';
import type { ScanOptions, ScanResult } from './types.js';
import type { RawReading } from './shared.js';

export type { ScanOptions, ScanResult } from './types.js';
export type { RawReading } from './shared.js';

function isLinux(): boolean { return process.platform === 'linux'; }

export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  if (isLinux()) {
    const h = await import('./handler-node-ble/index.js');
    return (h as any).scanAndRead(opts);
  }
  const h = await import('./handler-noble.js');
  return (h as any).scanAndRead(opts);
}

export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  if (isLinux()) {
    const h = await import('./handler-node-ble/index.js');
    return (h as any).scanAndReadRaw(opts);
  }
  const h = await import('./handler-noble.js');
  return (h as any).scanAndReadRaw(opts);
}

export async function scanDevices(
  adapters: ScaleAdapter[],
  durationMs?: number,
  _bleHandler?: unknown,
  _mqttProxy?: unknown,
  bleAdapter?: string,
): Promise<ScanResult[]> {
  if (isLinux()) {
    const h = await import('./handler-node-ble/index.js');
    return h.scanDevices(adapters, durationMs, bleAdapter);
  }
  const h = await import('./handler-noble.js');
  return (h as any).scanDevices(adapters, durationMs);
}
