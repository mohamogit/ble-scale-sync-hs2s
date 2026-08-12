import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { Exporter } from '../interfaces/exporter.js';
import type { ExporterEntry } from '../config/schema.js';
import { garminSchema, GarminExporter } from './garmin.js';

interface ExporterRegistryEntry {
  schema: ExporterSchema;
  factory: (config: Record<string, unknown>) => Exporter;
}

export const EXPORTER_REGISTRY: ExporterRegistryEntry[] = [
  {
    schema: garminSchema,
    factory: (config) =>
      new GarminExporter({
        email: config.email as string | undefined,
        password: config.password as string | undefined,
        token_dir: config.token_dir as string | undefined,
      }),
  },
];

export const EXPORTER_SCHEMAS: ExporterSchema[] = EXPORTER_REGISTRY.map((e) => e.schema);
export const KNOWN_EXPORTER_NAMES = new Set(EXPORTER_REGISTRY.map((e) => e.schema.name));

export function createExporterFromEntry(entry: ExporterEntry): Exporter {
  const registryEntry = EXPORTER_REGISTRY.find((e) => e.schema.name === entry.type);
  if (!registryEntry) {
    throw new Error(`Unknown exporter type '${entry.type}'. Known: ${[...KNOWN_EXPORTER_NAMES].join(', ')}`);
  }
  const { type: _, ...config } = entry;
  return registryEntry.factory(config);
}
