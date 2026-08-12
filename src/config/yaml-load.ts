import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { config as dotenvConfig } from 'dotenv';
import { createLogger } from '../logger.js';
import { AppConfigSchema, formatConfigError } from './schema.js';
import type { AppConfig } from './schema.js';
import { DEFAULT_CONFIG_PATH, DEFAULT_ENV_PATH } from './paths.js';
import { resolveEnvReferences } from './env-refs.js';
import { applyEnvOverrides } from './env-overrides.js';

const log = createLogger('Config');

export function loadYamlConfig(configPath?: string): AppConfig {
  if (existsSync(DEFAULT_ENV_PATH)) dotenvConfig({ path: DEFAULT_ENV_PATH });
  const yamlPath = configPath ?? DEFAULT_CONFIG_PATH;
  const raw = readFileSync(yamlPath, 'utf8');
  const parsed: unknown = parseYaml(raw);
  const resolved = resolveEnvReferences(parsed);
  const result = AppConfigSchema.safeParse(resolved);
  if (!result.success) {
    const msg = formatConfigError(result.error);
    log.error(msg);
    throw new Error(msg);
  }
  let config = result.data;
  if (config.runtime?.debug) process.env.DEBUG = 'true';
  config = applyEnvOverrides(config);
  return config;
}
