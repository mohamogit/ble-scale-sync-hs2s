import { createLogger } from '../logger.js';
import type { AppConfig } from './schema.js';
import { DEFAULT_CONFIG_PATH } from './paths.js';
import { loadYamlConfig } from './yaml-load.js';

const log = createLogger('Config');
export type ConfigSource = 'yaml' | 'env' | 'none';
export interface LoadedConfig { source: ConfigSource; config: AppConfig; configPath?: string; }

export function loadAppConfig(configPath?: string): LoadedConfig {
  const yamlPath = configPath ?? DEFAULT_CONFIG_PATH;
  try {
    const config = loadYamlConfig(configPath);
    log.info(`Loading config from ${configPath ?? 'config.yaml'}`);
    return { source: 'yaml', config, configPath: yamlPath };
  } catch (e) {
    log.error('No valid config.yaml found: ' + (e as Error).message);
    log.error('Create config.yaml (see config.example.yaml)');
    process.exit(1);
  }
}
export { resolveEnvReferences } from './env-refs.js';
export { loadYamlConfig } from './yaml-load.js';
