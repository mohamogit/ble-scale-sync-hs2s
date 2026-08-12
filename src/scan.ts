import { scanDevices } from './ble/index.js';
import { adapters } from './scales/index.js';
import { createLogger } from './logger.js';

const log = createLogger('Scan');

async function main() {
  log.info('Scanning for BLE devices (15s) — step on scale to wake HS2S...\n');
  const results = await scanDevices(adapters, 15_000);
  for (const r of results) {
    const tag = r.matchedAdapter ? ` << ${r.matchedAdapter}` : '';
    log.info(`  ${r.address}  Name: ${r.name}${tag}`);
  }
  log.info(`\nDone. Found ${results.length} device(s).`);
  if (results.filter(r=>r.matchedAdapter).length===0) {
    log.info('No HS2S found. Try: bluetoothctl scan on (check if Pi sees anything)');
  }
  // Force exit (noble keeps handle)
  setTimeout(()=>process.exit(0), 300);
}
main().catch(e=>{ console.error(e.message); process.exit(1); });
