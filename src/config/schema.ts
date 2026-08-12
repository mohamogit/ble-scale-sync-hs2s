import { z } from 'zod';
import { isValidScaleId, SCALE_ID_HINT } from '../ble/scale-id.js';

export const BleSchema = z.object({
  scale_mac: z.string().refine((v) => isValidScaleId(v), { message: `Must be ${SCALE_ID_HINT}` }).optional().nullable(),
  adapter: z.string().regex(/^hci\d+$/, 'Must be hci0/hci1').optional().nullable(),
});

export const ScaleSchema = z.object({
  weight_unit: z.enum(['kg', 'lbs']).default('kg'),
  height_unit: z.enum(['cm', 'in']).default('cm'),
});

export const ExporterEntrySchema = z.object({ type: z.string().min(1) }).passthrough();

export const UserSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  height: z.number().positive(),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gender: z.enum(['male', 'female']),
  is_athlete: z.boolean(),
  exporters: z.array(ExporterEntrySchema).optional(),
});

export const RuntimeSchema = z.object({
  continuous_mode: z.boolean().default(false),
  scan_cooldown: z.number().int().min(5).max(3600).default(30),
  dry_run: z.boolean().default(false),
  debug: z.boolean().default(false),
});

export const AppConfigSchema = z.object({
  version: z.literal(1),
  ble: BleSchema.optional(),
  scale: ScaleSchema.default({ weight_unit: 'kg', height_unit: 'cm' }),
  users: z.array(UserSchema).min(1),
  global_exporters: z.array(ExporterEntrySchema).optional(),
  runtime: RuntimeSchema.optional(),
});

export type BleConfig = z.infer<typeof BleSchema>;
export type ScaleConfig = z.infer<typeof ScaleSchema>;
export type ExporterEntry = z.infer<typeof ExporterEntrySchema>;
export type UserConfig = z.infer<typeof UserSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
export type WeightUnit = 'kg' | 'lbs';
export type MqttProxyConfig = never;
export type EsphomeProxyConfig = never;
export type UnknownUserStrategy = 'nearest';

export function formatConfigError(error: z.ZodError): string {
  const lines = ['Configuration error:', ''];
  for (const issue of error.issues) {
    lines.push(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  return lines.join('\n');
}
