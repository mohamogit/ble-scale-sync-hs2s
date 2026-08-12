export type ExporterName = 'garmin';
export interface ExporterConfig { exporters: ExporterName[]; mqtt?: any; webhook?: any; influxdb?: any; ntfy?: any; file?: any; strava?: any; telegram?: any; intervals?: any; runalyze?: any; wger?: any; }
export function loadExporterConfig(): ExporterConfig { return { exporters: ['garmin'] }; }
