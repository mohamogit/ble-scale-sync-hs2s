import { loadYamlConfig } from './yaml-load.js';
const path = process.argv[2];
try { loadYamlConfig(path); console.log('Config OK'); } catch(e){ console.error((e as Error).message); process.exit(1); }
