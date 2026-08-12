/**
 * Minimal BLE entry point — HS2S only, node-ble only.
 */
import type { ScaleAdapter, BodyComposition, UserProfile } from '../interfaces/scale-adapter.js';
import type { ScanOptions, ScanResult } from './types.js';
import type { RawReading } from './shared.js';

export type { ScanOptions, ScanResult } from './types.js';
export type { RawReading } from './shared.js';

export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  const { scanAndRead } = await import('./handler-node-ble/index.js');
  return scanAndRead(opts);
}

export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  const { scanAndReadRaw } = await import('./handler-node-ble/index.js');
  return scanAndReadRaw(opts);
}

export async function scanDevices(
  adapters: ScaleAdapter[],
  durationMs?: number,
  _bleHandler?: unknown,
  _mqttProxy?: unknown,
  bleAdapter?: string,
): Promise<ScanResult[]> {
  const { scanDevices } = await import('./handler-node-ble/index.js');
  return scanDevices(adapters, durationMs, bleAdapter);
}
