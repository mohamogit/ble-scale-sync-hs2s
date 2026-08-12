import { createLogger } from './logger.js';
import { errMsg } from './utils/error.js';
import type { Exporter, ExportContext } from './interfaces/exporter.js';
import type { BodyComposition } from './interfaces/scale-adapter.js';

const log = createLogger('Sync');

export async function dispatchExports(exporters: Exporter[], payload: BodyComposition, context?: ExportContext) {
  if (exporters.length === 0) { log.warn('No exporters'); return { success: true }; }
  log.info(`Exporting to: ${exporters.map(e=>e.name).join(', ')}...`);
  const results = await Promise.allSettled(exporters.map(e=> context ? e.export(payload, context) : e.export(payload)));
  let allFailed = true;
  for (let i=0;i<results.length;i++) {
    const r = results[i]; const name = exporters[i].name;
    if (r.status==='fulfilled' && r.value.success) allFailed=false;
    else if (r.status==='fulfilled') log.error(`${name}: ${r.value.error}`);
    else log.error(`${name}: ${errMsg((r as any).reason)}`);
  }
  if (allFailed) { log.error('All exports failed.'); return { success:false }; }
  log.info('Done.');
  return { success:true };
}
