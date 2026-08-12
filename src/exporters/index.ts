import type { Exporter } from '../interfaces/exporter.js';
import type { ExporterConfig, ExporterName } from './config.js';
import { GarminExporter } from './garmin.js';

export { loadExporterConfig } from './config.js';
export { createExporterFromEntry, EXPORTER_SCHEMAS, KNOWN_EXPORTER_NAMES } from './registry.js';

export function createExporters(config: ExporterConfig): Exporter[] {
  const exporters: Exporter[] = [];
  for (const name of config.exporters) {
    if (name === 'garmin') exporters.push(new GarminExporter());
    else throw new Error(`Unhandled exporter: ${name as string} (only garmin kept)`);
  }
  return exporters;
}
