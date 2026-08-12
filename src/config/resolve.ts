import type { UserProfile } from '../interfaces/scale-adapter.js';
import type { AppConfig, UserConfig, ScaleConfig, ExporterEntry, WeightUnit } from './schema.js';

function computeAge(birthDate: string): number {
  const [y, m, d] = birthDate.split('-').map(Number);
  const today = new Date();
  let age = today.getFullYear() - y;
  const monthDiff = today.getMonth() - (m - 1);
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < d)) age--;
  return age;
}

export function resolveUserProfile(user: UserConfig, scaleConfig: ScaleConfig): UserProfile {
  let height = user.height;
  if (scaleConfig.height_unit === 'in') height = height * 2.54;
  return { height, age: computeAge(user.birth_date), gender: user.gender, isAthlete: user.is_athlete };
}

export interface ResolvedRuntimeConfig {
  profile: UserProfile;
  scaleMac?: string;
  weightUnit: WeightUnit;
  dryRun: boolean;
  continuousMode: boolean;
  scanCooldownSec: number;
  bleAdapter?: string;
}

export function resolveRuntimeConfig(config: AppConfig): ResolvedRuntimeConfig {
  const user = config.users[0];
  const profile = resolveUserProfile(user, config.scale);
  return {
    profile,
    scaleMac: config.ble?.scale_mac ?? undefined,
    weightUnit: config.scale.weight_unit,
    dryRun: config.runtime?.dry_run ?? false,
    continuousMode: config.runtime?.continuous_mode ?? false,
    scanCooldownSec: config.runtime?.scan_cooldown ?? 30,
    bleAdapter: config.ble?.adapter ?? undefined,
  };
}

export function resolveExportersForUser(config: AppConfig, user: UserConfig): ExporterEntry[] {
  const entries: ExporterEntry[] = [];
  const seen = new Set<string>();
  if (user.exporters) for (const e of user.exporters) { entries.push(e); seen.add(e.type); }
  if (config.global_exporters) for (const e of config.global_exporters) if (!seen.has(e.type)) { entries.push(e); seen.add(e.type); }
  return entries;
}

export interface ResolvedSingleUser extends ResolvedRuntimeConfig { exporterEntries: ExporterEntry[]; }

export function resolveForSingleUser(config: AppConfig): ResolvedSingleUser {
  const runtime = resolveRuntimeConfig(config);
  const exporterEntries = resolveExportersForUser(config, config.users[0]);
  return { ...runtime, exporterEntries };
}
