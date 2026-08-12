#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { adapters } from './scales/index.js';
import { createLogger, setLogLevel, LogLevel } from './logger.js';
import { loadAppConfig } from './config/load.js';
import { resolveRuntimeConfig } from './config/resolve.js';
import { createAppContext } from './runtime/context.js';
import { processReading } from './runtime/processor.js';
import { PollReadingSource } from './runtime/poll-source.js';
import { runContinuousLoop } from './runtime/loop.js';
import { createExporterFromEntry } from './exporters/registry.js';
import { join } from 'node:path';

const { values: cliFlags } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
    'state': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: false,
});

if (cliFlags.help) {
  console.log('Usage: npm start [-- --config <path>] [--state <path>]');
  console.log('  -c, --config <path>  config.yaml path');
  console.log('  --state <path>       state.json path (default ./state.json)');
  process.exit(0);
}

const log = createLogger('Sync');
const loaded = loadAppConfig(cliFlags.config as string | undefined);
const config = loaded.config;
const resolved = resolveRuntimeConfig(config);
if (config.runtime?.debug) setLogLevel(LogLevel.DEBUG);

const ac = new AbortController();
process.on('SIGINT', () => ac.abort('SIGINT'));
process.on('SIGTERM', () => ac.abort('SIGTERM'));

const ctx = createAppContext({
  config,
  resolved,
  configSource: loaded.source,
  configPath: loaded.configPath,
  signal: ac.signal,
  abortApp: (r) => ac.abort(r),
});

const statePath = (cliFlags.state as string | undefined) ?? join(process.cwd(), 'state.json');

async function main() {
  log.info(`Adapters: ${adapters.map(a=>a.name).join(', ')}`);
  if (ctx.scaleMac) log.info(`Target scale: ${ctx.scaleMac}`);
  else log.info('Scanning for HS2S...');

  const user = config.users[0];
  const entries = user.exporters ?? config.global_exporters ?? [{type:'garmin'}];
  const exporters = ctx.dryRun ? undefined : entries.map(e=>createExporterFromEntry(e));

  const source = new PollReadingSource(ctx, adapters);
  const runProcess = (raw: any) => processReading(ctx, raw, exporters, statePath);

  if (!resolved.continuousMode) {
    const raw = await source.nextReading(ctx.signal);
    const ok = await runProcess(raw);
    if (!ok) process.exitCode = 1;
    return;
  }

  log.info(`Continuous mode, cooldown ${resolved.scanCooldownSec}s`);
  await runContinuousLoop({
    source,
    processReading: runProcess,
    signal: ctx.signal,
    scanCooldownSec: resolved.scanCooldownSec,
    continuous: true,
  });
  log.info('Stopped.');
}

main().catch(err=>{
  if (ctx.signal.aborted) { log.info('Stopped.'); return; }
  log.error(err.message);
  process.exitCode = 1;
});
