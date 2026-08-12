import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { IHealthHs2sAdapter } from './ihealth-hs2s.js';

export const adapters: ScaleAdapter[] = [new IHealthHs2sAdapter()];
