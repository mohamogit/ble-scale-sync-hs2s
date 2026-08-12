import type { AppConfig, WeightUnit } from '../config/schema.js';
import type { ResolvedRuntimeConfig } from '../config/resolve.js';
import type { ConfigSource } from '../config/load.js';

export interface AppContext {
  config: AppConfig;
  scaleMac: string | undefined;
  weightUnit: WeightUnit;
  dryRun: boolean;
  readonly configSource: ConfigSource;
  readonly configPath: string | undefined;
  readonly bleAdapter: string | undefined;
  readonly signal: AbortSignal;
  abortApp(reason?: unknown): void;
}

export interface AppContextInit {
  config: AppConfig;
  resolved: ResolvedRuntimeConfig;
  configSource: ConfigSource;
  configPath: string | undefined;
  signal: AbortSignal;
  abortApp: (reason?: unknown) => void;
}

export function createAppContext(init: AppContextInit): AppContext {
  return {
    config: init.config,
    scaleMac: init.resolved.scaleMac,
    weightUnit: init.resolved.weightUnit,
    dryRun: init.resolved.dryRun,
    configSource: init.configSource,
    configPath: init.configPath,
    bleAdapter: init.resolved.bleAdapter,
    signal: init.signal,
    abortApp: init.abortApp,
  };
}
