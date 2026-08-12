import { createLogger } from '../logger.js';
import type { AppConfig } from './schema.js';
const log = createLogger('Config');
export function parseBleAdapterEnv(): string | null | undefined {
  const raw = process.env.BLE_ADAPTER;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const adapter = trimmed.toLowerCase();
  if (/^hci\d+$/.test(adapter)) return adapter;
  log.warn(`BLE_ADAPTER='${raw}' is not valid`);
  return undefined;
}
export function applyEnvOverrides(config: AppConfig): AppConfig {
  const runtime = { continuous_mode: config.runtime?.continuous_mode ?? false, scan_cooldown: config.runtime?.scan_cooldown ?? 30, dry_run: config.runtime?.dry_run ?? false, debug: config.runtime?.debug ?? false } as AppConfig['runtime'];
  const ble = { ...config.ble } as AppConfig['ble'];
  if (process.env.CONTINUOUS_MODE !== undefined) runtime!.continuous_mode = ['true','yes','1'].includes(process.env.CONTINUOUS_MODE.toLowerCase());
  if (process.env.DRY_RUN !== undefined) runtime!.dry_run = ['true','yes','1'].includes(process.env.DRY_RUN.toLowerCase());
  if (process.env.DEBUG !== undefined) runtime!.debug = ['true','yes','1'].includes(process.env.DEBUG.toLowerCase());
  if (process.env.SCAN_COOLDOWN !== undefined) { const n=Number(process.env.SCAN_COOLDOWN); if(Number.isFinite(n)&&n>=5&&n<=3600) runtime!.scan_cooldown=n; }
  if (process.env.SCALE_MAC !== undefined) (ble as any).scale_mac = process.env.SCALE_MAC;
  const adapter = parseBleAdapterEnv();
  if (adapter !== undefined) (ble as any).adapter = adapter;
  return { ...config, runtime, ble };
}
export function filterValidExporters(entries: any): any { return entries; }
