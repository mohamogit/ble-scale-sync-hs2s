/**
 * iHealth HS2S (Nexus) — BLE scale adapter.
 *
 * Protocol: `com.jiuan.BFSV22` (Jiuan / iHealth line), reverse-engineered from
 * the official Android SDK (`iHealthSDK_2.9.4.4.jar`, CFR decompile) and
 * verified against a real unit (SN `004M2DXNE`, FW `202600`) with
 * @stoprocent/noble captures — see `hs2s-probe/` and HS2S_PROTOCOL.md.
 *
 * GATT:
 *   service  com.jiuan.BFSV22  (636F6D2E6A6975616E2E424653563232)
 *     sed.jiuan.BFSV22  notify   — device -> app data channel
 *     rec.jiuan.BFSV22  write    — app -> device command channel
 *
 * Every payload is wrapped in the vendor `BleCommProtocol2` frame
 * `[0xB0][0x02+payloadLen][0x00][seq][payload...][checksum]` (frame header
 * 0xA0 on the device->app direction, 0xB0 on app->device). Frames longer than
 * 20 bytes are chunked at 20 bytes (legacy MTU-23 transport) and reassembled
 * on the receiving side from the `len` field. Checksum = `sum(byte[2..len-2])
 * & 0xFF`.
 *
 * Handshake (IdentifyIns2) is mandatory — every business command is silently
 * ignored until R1/R2 completes:
 *   app -> A9 FA + 16B random (R1)
 *   app <- A9 FB + R2(16) + R1_stroke(20) + deviceID(16)
 *   app -> A9 FC + XXTEA2(R2, ka)          (ka = XXTEA2(deviceID, KEY_HS2S))
 *   app <- A9 FD / A9 FE                   (authentication done)
 *
 * Measurement is "record locally + sync". Live behavior, verified on a real
 * unit (2026-08): while the user stands on the scale it pushes only 0x24
 * "measure finish" markers — no live weight frames (0x40/0x41/0x42 never
 * arrive). Every completed weigh-in (with no App connection) appends a record
 * to the ANONYMOUS area (0x33 count -> 0x34 pages -> 0xB4 records), which the
 * adapter pulls after auth and resolves the newest record as the weigh-in
 * result. The getUserInfo (0x20) profile weight is a USER-SET value, not a
 * measurement — it is ignored. The offline area (0x30/0x31, user-id keyed)
 * stays empty until an App sync clears it, so it is not used.
 *
 * Anonymous history record layout (verified against real captures, 2026-08):
 *   22B each: [type 1B][weight 2B BE /100][impedance x6 12B][ts 4B BE][pad 3B]
 * Records under 10 kg (factory calibration weights / junk) are dropped.
 */

import { randomBytes } from 'node:crypto';
import { computeBiaFat, buildPayload } from './body-comp-helpers.js';
import { matchesDescriptor } from './match-descriptor.js';
import type {
  BleDeviceInfo,
  BodyComposition,
  CharacteristicBinding,
  ConnectionContext,
  GattWiring,
  MatchDescriptor,
  MultiCharNotify,
  ScaleAdapterCore,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { bleLog, normalizeUuid } from '../ble/types.js';
import { xxtea2Decrypt, xxtea2Encrypt } from './xxtea2.js';

/** Service UUID of the iHealth HS2S protocol (`com.jiuan.BFSV22`), dash-free 32-hex. */
export const HS2S_SERVICE = '636f6d2e6a6975616e2e424653563232';
/** Notify characteristic (`sed.jiuan.BFSV22`) — device -> app data channel. */
export const HS2S_NOTIFY_CHAR = '7365642e6a6975616e2e424653563232';
/** Write characteristic (`rec.jiuan.BFSV22`) — app -> device command channel. */
export const HS2S_WRITE_CHAR = '7265632e6a6975616e2e424653563232';

/**
 * HS2S handshake key (NOT the HS2S Pro one — the Pro uses
 * `b3c9d23d155fce5e51e7c8a2fed48e89` and `sed/rec.jiuan.HS2S032` chars).
 */
export const HS2S_KEY = Buffer.from('2EE5CF42871CF69BD50104C82B80827A', 'hex');

/** Legacy MTU-23 transport chunk size; frames above this must be split. */
const CHUNK_SIZE = 20;
/** Largest plausible full frame length (B1 with 4×35B + header = 151B). */
const MAX_FRAME_LEN = 200;
/** Plausible weight range for a body scale, in kg. */
const MIN_WEIGHT_KG = 2;
const MAX_WEIGHT_KG = 300;
/** Hold window (ms) for the live-preview stability gate, mirroring the Eufy P2 adapter. */
const WEIGHT_STABLE_HOLD_MS = 3000;

/** Direction byte: app -> scale command frames. */
const FRAME_HEADER_APP_TO_DEVICE = 0xb0;
/** Direction byte: scale -> app response frames. */
const FRAME_HEADER_DEVICE_TO_APP = 0xa0;

/** Command opcodes (payload byte 1, after the 0xA9 marker). */
const CMD_IDENTIFY_R1 = 0xfa;
const CMD_IDENTIFY_R2 = 0xfc;
const CMD_CHALLENGE = 0xfb; // A9 FB + R2(16) + R1_stroke(20) + deviceID(16)
const CMD_AUTH_DONE = 0xfd; // authentication successful
const CMD_AUTH_END = 0xfe; // measurement critical-end marker (also ends auth)
const CMD_LIVE_WEIGHT = 0x40; // live weight preview: weight 2B BE /100
const CMD_RESULT_WEIGHT = 0x41; // weigh-in result: status + weight 2B BE /100
const CMD_RESULT_COMPOSITION = 0x42; // composition: status + user + weight 2B + imp x6 ...
const CMD_MEASURE_FINISH = 0x24; // action_measure_finish_at_critical
const CMD_GET_USER_INFO = 0x20; // registered-user profile request
const CMD_GET_USER_INFO_RESP = 0xa0; // profile response (carries user id)
const CMD_OFFLINE_COUNT = 0x30; // offline count request
const CMD_OFFLINE_COUNT_RESP = 0x30; // offline count response (A9 30 01 00 02)
const CMD_OFFLINE_DATA_RESP = 0xb1; // offline (registered-user) data block
const CMD_ANON_COUNT = 0x33; // anonymous data count request / response
const CMD_ANON_DATA = 0x34; // anonymous data pull (index 2B BE)
const CMD_ANON_DATA_RESP = 0xb4; // anonymous data page response

/** Number of records per 0x34 pull page (the scale returns a 4-record window). */
const ANON_PAGE_SIZE = 4;
/**
 * Anonymous history records below this weight are factory calibration weights /
 * junk (real captures: 5.8/7.3/6.1/6.8 kg calibration, 5.5-9.1 kg oddities),
 * so they are dropped from history. Keep the general MIN_WEIGHT_KG for live
 * readings, which have a different frame and no calibration records.
 */
const MIN_ANON_WEIGHT_KG = 10;
/** Cap on anonymous history records pulled per session (239 = full history). */
const MAX_ANON_PULL = 239;
/** Cap on offline (registered-user) records pulled per session. */
const MAX_OFFLINE_PULL = 20;

// ─── Registered-user offline data (0x30/0x31 -> 0xB1) ─────────────────────────

/**
 * Parse a getUserInfo (0xA0) response into the first registered user's id.
 * Layout, verified against real captures:
 *   [A9 A0][user count 1B][per user: id 16B ascii][ts 4B BE][weight 2B BE /100]
 *   [gender 1B][age 1B][height 1B][impedance 1B][bodybuilding 1B]
 * Only the user id is used here — the profile weight is a user-set value.
 */
export function parseUserProfile(payload: Buffer): Buffer | null {
  const body = payload.subarray(2);
  if (body.length < 23 || body[0] < 1) return null;
  return body.subarray(1, 17);
}

/**
 * Parse an offline-data 0xB1 payload into readings. Layout, verified against
 * real captures (2026-08) — a weigh-in made with NO App connection:
 *   [A9 B1][meta 4B][records: 35B each]
 *   35B record: [weight 2B BE /100][R1..R4 2B BE each][user 2B]
 *               [age/height 2B = 0x1CB0 for 28y/176cm][ts 4B BE][body 15B]
 * Impedance is REAL here (unlike the anonymous area) so BIA body composition
 * is available. Records are ordered oldest -> newest; take the last one for
 * the primary reading.
 */
export function parseOfflineBlockPayload(payload: Buffer): ScaleReading[] {
  const body = payload.subarray(2);
  const readings: ScaleReading[] = [];
  let off = 4; // skip the 4B meta prefix
  while (off + 35 <= body.length) {
    const rec = body.subarray(off, off + 35);
    off += 35;
    const weight = (rec[0] * 256 + rec[1]) / 100;
    if (!Number.isFinite(weight) || weight < MIN_ANON_WEIGHT_KG || weight > MAX_WEIGHT_KG) {
      continue;
    }
    // Four segment impedances (multi-frequency/segmental).
    const impedances: number[] = [];
    for (let j = 0; j < 4; j++) {
      const raw = rec[2 + j * 2] * 256 + rec[3 + j * 2];
      impedances.push(raw);
    }
    let impedance = 0;
    for (const raw of impedances) {
      if (raw > 200 && raw < 1000) {
        impedance = raw;
        break;
      }
    }
    const ts = rec.readUInt32BE(14);
    // Tail 17B: [01][00][06][bodyFat2B][muscle2B][bone1B][water2B][protein2B][...5B]
    // Verified against 4 captures (94.44/94.47/94.54/96.58 vs App 30.3-30.9% etc):
    //  bodyFat @ rec[20..21] BE /10, muscle @ rec[22..23] BE /10,
    //  bone @ rec[24] /10, water @ rec[25..26] BE /10, protein @ rec[27..28] BE /10
    const tail = rec.subarray(18);
    const scaleBodyFat = tail.length >= 11 ? (tail[3] * 256 + tail[4]) / 10 : undefined;
    const scaleMuscle = tail.length >= 11 ? (tail[5] * 256 + tail[6]) / 10 : undefined;
    const scaleBone = tail.length >= 11 ? tail[7] / 10 : undefined;
    const scaleWater = tail.length >= 11 ? (tail[8] * 256 + tail[9]) / 10 : undefined;
    const scaleProtein = tail.length >= 11 ? (tail[10] * 256 + tail[11]) / 10 : undefined;
    const reading: ScaleReading & {
      impedances?: number[];
      scaleComp?: { bodyFatPercent?: number; muscleMass?: number; boneMass?: number; waterPercent?: number; proteinPercent?: number };
    } = { weight, impedance, timestamp: new Date(ts * 1000) };
    (reading as any).impedances = impedances;
    if (
      scaleBodyFat !== undefined &&
      scaleBodyFat >= 3 &&
      scaleBodyFat <= 75 &&
      scaleMuscle !== undefined &&
      scaleWater !== undefined
    ) {
      (reading as any).scaleComp = {
        bodyFatPercent: scaleBodyFat,
        muscleMass: scaleMuscle,
        boneMass: scaleBone,
        waterPercent: scaleWater,
        proteinPercent: scaleProtein,
      };
    }
    readings.push(reading);
  }
  return readings;
}

// ─── BleCommProtocol2 framing ─────────────────────────────────────────────────

/** Checksum over bytes [2 .. len-2] of a frame (`sum & 0xFF`). */
export function bleCommChecksum(frame: Buffer): number {
  let sum = 0;
  for (let i = 2; i < frame.length - 1; i++) sum += frame[i];
  return sum & 0xff;
}

/**
 * Wrap a payload in a BleCommProtocol2 frame headed for the device.
 * `seq` is the command id (starts at 1, increments by 2 per command).
 */
export function buildBleCommFrame(payload: Buffer, seq: number): Buffer {
  const frame = Buffer.alloc(4 + payload.length + 1);
  frame[0] = FRAME_HEADER_APP_TO_DEVICE;
  frame[1] = 2 + payload.length;
  frame[2] = 0x00;
  frame[3] = seq & 0xff;
  payload.copy(frame, 4);
  frame[frame.length - 1] = bleCommChecksum(frame);
  return frame;
}

/** Split a frame into <= `chunkSize` byte chunks (legacy MTU-23 transport). */
export function splitFrame(frame: Buffer, chunkSize = CHUNK_SIZE): Buffer[] {
  const chunks: Buffer[] = [];
  for (let off = 0; off < frame.length; off += chunkSize) {
    chunks.push(frame.subarray(off, off + chunkSize));
  }
  return chunks;
}

/**
 * Reassemble chunked BleCommProtocol2 frames arriving over one notify channel.
 * The device streams 20-byte chunks with no inter-chunk headers; the full
 * frame length is recovered from the `len` byte (total = len + 3).
 */
export class BleCommReassembler {
  private buffer = Buffer.alloc(0);

  /** Feed one notify chunk; returns every complete, checksum-valid frame. */
  feed(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    while (this.buffer.length >= 5) {
      const header = this.buffer[0];
      if (header !== FRAME_HEADER_DEVICE_TO_APP && header !== FRAME_HEADER_APP_TO_DEVICE) {
        // Lost sync — drop bytes until the next plausible frame header.
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      const total = this.buffer[1] + 3;
      if (total < 5 || total > MAX_FRAME_LEN) {
        // Corrupted length byte (too small or implausibly large) — treat as
        // desync and drop one byte instead of wedging on a length we could
        // never satisfy or would have to buffer unboundedly for.
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      if (this.buffer.length < total) break;
      const frame = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);
      if (bleCommChecksum(frame) === frame[frame.length - 1]) {
        frames.push(frame);
      } else {
        bleLog.debug(
          `iHealth HS2S: dropping frame with bad checksum (seq ${frame[3]}, ${frame.length}B)`,
        );
      }
    }
    return frames;
  }
}

// ─── IdentifyIns2 handshake helpers ───────────────────────────────────────────

/** Build the A9 FA payload carrying the 16-byte non-negative random R1. */
export function buildR1Payload(r1: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xa9, CMD_IDENTIFY_R1]), r1]);
}

/** Parse the A9 FB challenge payload into R2, R1_stroke and deviceID. */
export function parseChallengePayload(
  payload: Buffer,
): { r2: Buffer; r1Stroke: Buffer; deviceId: Buffer } | null {
  if (payload.length < 2 + 52) return null;
  const body = payload.subarray(2);
  return {
    r2: body.subarray(0, 16),
    r1Stroke: body.subarray(16, 36),
    deviceId: body.subarray(36, 52),
  };
}

/** ka = XXTEA2(deviceID, KEY_HS2S) — the per-device session key. */
export function deriveHs2sKa(deviceId: Buffer): Buffer {
  return xxtea2Encrypt(deviceId, HS2S_KEY);
}

/** Build the A9 FC payload: XXTEA2(R2, ka), 20 bytes. */
export function buildR2Payload(r2: Buffer, ka: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xa9, CMD_IDENTIFY_R2]), xxtea2Encrypt(r2, ka)]);
}

// ─── Live weigh-in parsing ────────────────────────────────────────────────────

function plausibleWeightKg(raw: number): boolean {
  return Number.isFinite(raw) && raw >= MIN_WEIGHT_KG && raw <= MAX_WEIGHT_KG;
}

/**
 * Parse a live weigh-in payload (after the A9 <cmd> marker) into a reading.
 * Returns null for unknown / malformed commands or implausible weights.
 *
 *  0x40 live weight preview:    [weight 2B BE /100]
 *  0x41 weigh-in result:        [status][weight 2B BE /100]
 *  0x42 composition result:     [status][user][weight 2B BE /100][impedance x6 2B]...
 */
export function parseHs2sReading(cmd: number, payload: Buffer): ScaleReading | null {
  const body = payload.subarray(2);

  if (cmd === CMD_LIVE_WEIGHT) {
    if (body.length < 2) return null;
    const weight = (body[0] * 256 + body[1]) / 100;
    if (!plausibleWeightKg(weight)) return null;
    return { weight, impedance: 0 };
  }

  if (cmd === CMD_RESULT_WEIGHT) {
    if (body.length < 3) return null;
    const weight = (body[1] * 256 + body[2]) / 100;
    if (!plausibleWeightKg(weight)) return null;
    return { weight, impedance: 0 };
  }

  if (cmd === CMD_RESULT_COMPOSITION) {
    // [status][user][weight 2B][imp x6 (12B)] then gender/age/height.
    if (body.length < 19) return null;
    const weight = (body[2] * 256 + body[3]) / 100;
    if (!plausibleWeightKg(weight)) return null;
    // First valid impedance (0xFFFF = invalid). The scale reports six
    // segment readings; any single valid one drives the shared BIA estimate.
    let impedance = 0;
    for (let i = 0; i < 6; i++) {
      const raw = body[4 + i * 2] * 256 + body[5 + i * 2];
      if (raw > 200 && raw !== 0xffff) {
        impedance = raw;
        break;
      }
    }
    return { weight, impedance };
  }

  return null;
}

// ─── Anonymous history parsing (0xB4) ─────────────────────────────────────────

/**
 * Parse an anonymous-history 0xB4 payload into historical readings.
 *
 * Layout, verified against real captures (2026-08):
 *   [A9 B4][n 2B BE = requested window start][n2 1B = record count]
 *   then n2 records of 22B each:
 *   [type 1B][weight 2B BE /100][impedance x6 12B][ts 4B BE][flag 1B][pad 2B]
 *
 * Records below {@link MIN_ANON_WEIGHT_KG} (calibration weights / junk) are
 * dropped. Timestamp policy follows the beurer-bf720 convention: the device
 * clock value is trusted as-is for history. Verified on a real unit (2026-08):
 * the RTC runs continuously and each record's ts matches the actual weigh-in
 * moment (a weigh-in at 08:04 local recorded ts 08:04:15Z). The only
 * unreliable entries — factory calibration records pinned to the factory
 * clock (2019-01-01) — are all under 10 kg and already filtered above.
 */
export function parseAnonBlockPayload(payload: Buffer): ScaleReading[] {
  const body = payload.subarray(2);
  if (body.length < 3) return [];
  const count = body[2];
  const readings: ScaleReading[] = [];
  let off = 3;
  for (let i = 0; i < count; i++) {
    if (off + 22 > body.length) break;
    const rec = body.subarray(off, off + 22);
    off += 22;
    const weight = (rec[1] * 256 + rec[2]) / 100;
    if (!Number.isFinite(weight) || weight < MIN_ANON_WEIGHT_KG || weight > MAX_WEIGHT_KG) {
      continue;
    }
    // First valid impedance (0xFFFF = invalid); anonymous records are usually
    // weight-only, so impedance stays 0 and composition falls back to BMI.
    let impedance = 0;
    for (let j = 0; j < 6; j++) {
      const raw = rec[3 + j * 2] * 256 + rec[4 + j * 2];
      if (raw > 200 && raw !== 0xffff) {
        impedance = raw;
        break;
      }
    }
    const ts = rec.readUInt32BE(15);
    readings.push({ weight, impedance, timestamp: new Date(ts * 1000) });
  }
  return readings;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

type AuthPhase = 'await-challenge' | 'await-final' | 'authenticated' | 'failed';

export class IHealthHs2sAdapter implements ScaleAdapterCore, GattWiring, MultiCharNotify {
  readonly name = 'iHealth HS2S';
  readonly match: MatchDescriptor = {
    priority: 275,
    names: { includes: ['hs2s'] },
    serviceUuids: [HS2S_SERVICE],
  };
  readonly normalizesWeight = true;
  readonly charNotifyUuid = HS2S_NOTIFY_CHAR;
  readonly charWriteUuid = HS2S_WRITE_CHAR;

  readonly characteristics: CharacteristicBinding[] = [
    { service: HS2S_SERVICE, uuid: HS2S_WRITE_CHAR, type: 'write' },
    { service: HS2S_SERVICE, uuid: HS2S_NOTIFY_CHAR, type: 'notify' },
  ];

  /** Hold the link open after the first live preview so the weight can settle. */
  readonly completionHoldMs = WEIGHT_STABLE_HOLD_MS;

  private ctx: ConnectionContext | null = null;
  private seq = 1;
  private reassembler = new BleCommReassembler();
  private authPhase: 'await-challenge' | 'await-final' | 'authenticated' | 'failed' =
    'await-challenge';
  private r1: Buffer | null = null;
  private lastCmd = 0;
  /** True once a definitive result frame (0x41/0x42) arrived this session. */
  private sawResultFrame = false;
  /** Offline-area primary (newest registered-user measurement) awaiting delivery. */
  private offlinePrimary: ScaleReading | null = null;
  /** Anonymous-history pull state; null when not pulling. */
  private anonPull: { active: boolean; nextWindow: number; total: number } | null = null;
  /**
   * Accumulated anonymous-history measurements, newest record at the head.
   * Delivered oldest-first per notify into the shared history buffer.
   */
  private pendingHistory: ScaleReading[] = [];
  /** Drain buffered history (excludes force-live newest) for HistoryBuffer. */
  drainHistory(): ScaleReading[] { const out = [...this.pendingHistory]; this.pendingHistory = []; return out; }
  /** Registered-user offline pull state (the authoritative BIA-capable source). */
  private offlinePull: {
    active: boolean;
    nextIndex: number;
    userId: Buffer | null;
    pending: ScaleReading[];
  } | null = null;
  private anonStallRetries = 0;
  private anonStallTimer: NodeJS.Timeout | null = null;
  private offlineStallTimer: NodeJS.Timeout | null = null;
  private offlineStallRetries = 0;
  private measurePending = false;
  private lastOfflineReport: { ts: number; weight: number } | null = null;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    // The HS2S Pro shares the "HS2S" name token but uses different
    // characteristics and a different ka key (see HS2S_KEY above); it needs
    // its own adapter, so do not claim it here.
    if (name.includes('hs2s') && name.includes('pro')) return false;
    return matchesDescriptor(device, this.match);
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    // Reset all per-connection state (the adapter instance is reused).
    this.ctx = ctx;
    this.seq = 1;
    this.reassembler = new BleCommReassembler();
    this.authPhase = 'await-challenge';
    this.r1 = null;
    this.lastCmd = 0;
    this.sawResultFrame = false;
    this.offlinePrimary = null;
    this.anonPull = null;
    this.pendingHistory = [];
    this.offlinePull = null;
    this.anonStallRetries = 0;
    this.clearAnonStallTimer();
    this.offlineStallRetries = 0;
    this.clearOfflineStallTimer();

    const r1 = randomNonZeroBytes(16);
    this.r1 = r1;
    bleLog.debug('iHealth HS2S: sending identify R1');
    await this.send(buildR1Payload(r1));

    // The scale only answers the challenge while awake; retry once after 3s
    // (stepping on the scale wakes it), mirroring the hs2s-probe client.
    try {
      await this.waitUntil(() => this.authPhase !== 'await-challenge', 3000, 'R1 challenge');
    } catch {
      bleLog.warn(
        'iHealth HS2S: R1 challenge timed out, retrying once (step on the scale to wake it)',
      );
      await this.send(buildR1Payload(r1));
      await this.waitUntil(
        () => this.authPhase !== 'await-challenge',
        3000,
        'R1 challenge (retry)',
      );
    }

    await this.waitUntil(
      () => this.authPhase === 'authenticated' || this.authPhase === 'failed',
      6000,
      'authentication completion',
    );
    const phase: AuthPhase = this.readAuthPhase();
    if (phase === 'failed') {
      throw new Error('iHealth HS2S: authentication failed (scale rejected the challenge)');
    }
    bleLog.info('iHealth HS2S: authenticated — step on the scale');
    // A weigh-in made with NO App connection lands in the registered-user
    // OFFLINE area (0x30/0x31 -> 0xB1, 35B records) with REAL impedance — the
    // authoritative BIA-capable source. The anonymous area holds tourist
    // measurements (no impedance). The getUserInfo profile weight is a user-set
    // value. Real units push no live weight frames (only 0x24 finish markers),
    // so the newest pulled offline record IS the weigh-in result.
    void this.startOfflinePull().catch((error: unknown) => {
      bleLog.warn(
        `iHealth HS2S: offline pull failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (this.offlinePull) this.offlinePull.active = false;
    });
  }

  /** Multi-char dispatch: only the sed.jiuan.BFSV22 notify channel is live. */
  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null {
    if (normalizeUuid(charUuid) !== HS2S_NOTIFY_CHAR) return null;

    let reading: ScaleReading | null = null;
    for (const frame of this.reassembler.feed(data)) {
      const payload = frame.subarray(4, frame.length - 1);
      if (payload.length < 2 || payload[0] !== 0xa9) continue;
      const cmd = payload[1];

      if (cmd === CMD_CHALLENGE) {
        this.handleChallenge(payload);
        continue;
      }
      if (cmd === CMD_AUTH_DONE || cmd === CMD_AUTH_END) {
        this.authPhase = 'authenticated';
        continue;
      }
      if (cmd === CMD_MEASURE_FINISH) {
        bleLog.debug('iHealth HS2S: measure finish marker (0x24)');
        // Online weigh while connected: device has just stored a new record
        // in the anonymous area. Trigger a fresh anon pull if idle.
        if (this.authPhase === 'authenticated' && !this.anonPull?.active) {
          bleLog.info('iHealth HS2S: measure finish — pulling anonymous history');
          this.measurePending = true;
          void this.startAnonymousPull().catch((error: unknown) => {
            bleLog.warn(
              `iHealth HS2S: anon pull after measure failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
        continue;
      }

      if (cmd === CMD_GET_USER_INFO_RESP && this.offlinePull?.active) {
        // The profile weight is a user-set value — only the user id is used.
        this.offlinePull.userId = parseUserProfile(payload);
        if (this.offlinePull.userId) {
          // Must query offline count (0x30) before pulling 0x31 - device
          // returns 0 records for 0x31 unless 0x30 was sent first.
          void this.sendOfflineCount().catch((error: unknown) => {
            bleLog.warn(
              `iHealth HS2S: offline count failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            if (this.offlinePull) this.offlinePull.active = false;
          });
        } else {
          bleLog.info('iHealth HS2S: no registered user (A0 count 0) — skipping offline area');
          // Treat as empty offline pull; fall through to anonymous tourist area.
          this.finishOfflinePull();
        }
        continue;
      }

      if (cmd === CMD_OFFLINE_COUNT_RESP && this.offlinePull?.active) {
        const body = payload.subarray(2);
        // Payload: [userCount 1B][count 2B]? Verified: A9 30 01 00 02 -> 2 records
        const count = body.length >= 3 ? body.readUInt16BE(1) : 0;
        bleLog.debug(`iHealth HS2S: offline count ${count}`);
        if (count === 0) {
          this.finishOfflinePull();
        } else {
          void this.pullNextOffline().catch((error: unknown) => {
            bleLog.warn(
              `iHealth HS2S: offline pull failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            if (this.offlinePull) this.offlinePull.active = false;
          });
        }
        continue;
      }

      if (cmd === CMD_OFFLINE_DATA_RESP && this.offlinePull?.active) {
        this.clearOfflineStallTimer();
        const page = parseOfflineBlockPayload(payload);
        this.offlinePull.pending.push(...page);
        bleLog.debug(
          `iHealth HS2S: offline page idx=${this.offlinePull.nextIndex - 1} -> ${page.length} record(s), total pending ${this.offlinePull.pending.length}`,
        );
        if (page.length === 0 || this.offlinePull.nextIndex >= MAX_OFFLINE_PULL) {
          this.finishOfflinePull();
        } else {
          void this.pullNextOffline().catch((error: unknown) => {
            bleLog.warn(
              `iHealth HS2S: offline pull failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            if (this.offlinePull) this.offlinePull.active = false;
          });
        }
        continue;
      }

      if (cmd === CMD_ANON_COUNT && this.anonPull?.active) {
        this.handleAnonCount(payload);
        continue;
      }
      if (cmd === CMD_ANON_DATA_RESP && this.anonPull?.active) {
        // Page arrived: clear the stall timer, accumulate newest-first.
        this.clearAnonStallTimer();
        const page = parseAnonBlockPayload(payload);
        page.reverse(); // window records are oldest-first -> newest at head
        this.pendingHistory.push(...page);
        this.advanceAnonPull();
        continue;
      }

      if (this.authPhase !== 'authenticated') continue;

      const r = parseHs2sReading(cmd, payload);
      if (r) {
        this.lastCmd = cmd;
        if (cmd !== CMD_LIVE_WEIGHT) this.sawResultFrame = true;
        reading = r;
      }
    }

    // Delivery gate — one record per notify, so the shared handler's standard
    // single-reading reporting path sees plain readings:
    // 1. The offline-area primary (newest registered-user measurement, no
    //    timestamp -> live semantics) resolves the weigh-in result; it carries
    //    REAL impedance so BIA body composition is computed, not BMI-estimated.
    // 2. Otherwise pop one anonymous (tourist) record oldest-first per notify
    //    into the shared cache-replay HistoryBuffer.
    if (this.offlinePrimary) {
      const primary = this.offlinePrimary;
      this.offlinePrimary = null;
      return primary;
    }
    if (reading) return reading;
    if (this.pendingHistory.length > 0) {
      return this.pendingHistory.pop()!;
    }
    return null;
  }

  /** Single-char fallback (unused while parseCharNotification is defined). */
  parseNotification(data: Buffer): ScaleReading | null {
    return this.parseCharNotification(HS2S_NOTIFY_CHAR, data);
  }

  isComplete(reading: ScaleReading): boolean {
    if (reading.impedance > 0) return reading.weight >= MIN_WEIGHT_KG && reading.impedance > 200;
    return reading.weight >= MIN_WEIGHT_KG;
  }

  /**
   * Resolve on the pulled newest record (no timestamp -> live semantics) or a
   * definitive result frame (0x41 weight / 0x42 composition). Live weight
   * previews (0x40) never resolve on their own: they stream while the weight
   * settles and the shared handler holds the link open for `completionHoldMs`.
   */
  isFinal(_reading: ScaleReading): boolean {
    return this.sawResultFrame || this.lastCmd !== CMD_LIVE_WEIGHT;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const sc = (reading as any).scaleComp as
      | { bodyFatPercent?: number; muscleMass?: number; boneMass?: number; waterPercent?: number; proteinPercent?: number }
      | undefined;
    if (sc && sc.bodyFatPercent !== undefined) {
      // Directly use scale-computed multi-frequency segmental values (35B tail).
      // Muscle in buildPayload is expected as % of weight.
      const musclePct = sc.muscleMass !== undefined ? (sc.muscleMass / reading.weight) * 100 : undefined;
      return buildPayload(reading.weight, reading.impedance, {
        fat: sc.bodyFatPercent,
        muscle: musclePct,
        bone: sc.boneMass,
        water: sc.waterPercent,
      }, profile);
    }
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Start the registered-user offline pull: getUserInfo first for the id. */
  private async startOfflinePull(): Promise<void> {
    this.offlinePull = { active: true, nextIndex: 0, userId: null, pending: [] };
    await this.send(Buffer.from([0xa9, CMD_GET_USER_INFO]));
  }

  private async sendOfflineCount(): Promise<void> {
    if (!this.offlinePull?.active || !this.offlinePull.userId) return;
    const p = Buffer.concat([Buffer.from([0xa9, CMD_OFFLINE_COUNT, 0x01]), this.offlinePull.userId]);
    this.armOfflineStallTimer();
    await this.send(p);
  }

  private async sendOnlineUser(uid?: Buffer): Promise<void> {
    if (!this.ctx) return;
    const userId = uid ?? this.offlinePull?.userId;
    if (!userId) return;
    const profile = this.ctx.profile;
    const id = userId;
    const now = Math.floor(Date.now() / 1000);
    const p = Buffer.alloc(3 + 16 + 4 + 2 + 1 + 1 + 1 + 1 + 1);
    let off = 0;
    p[off++] = 0xa9;
    p[off++] = 0x23;
    p[off++] = 0x01;
    id.copy(p, off);
    off += 16;
    p.writeUInt32BE(now, off);
    off += 4;
    // Weight placeholder 0 (scale will fill), gender/age/height from profile
    p.writeUInt16BE(0, off);
    off += 2;
    const gender = profile.gender === 'male' ? 0x01 : 0x00;
    p[off++] = gender;
    p[off++] = profile.age & 0xff;
    p[off++] = profile.height & 0xff;
    p[off++] = 0x00; // impedance placeholder
    p[off++] = profile.isAthlete ? 0x01 : 0x00;
    await this.send(p);
    bleLog.info(`iHealth HS2S: online user ${id.toString().trim()} ${profile.gender}/${profile.age}y/${profile.height}cm`);
  }

  /** Request the next offline record window (0x31 + id + index). */
  private async pullNextOffline(): Promise<void> {
    if (!this.offlinePull?.active || !this.offlinePull.userId) return;
    const p = Buffer.alloc(2 + 16 + 2);
    p[0] = 0xa9;
    p[1] = 0x31;
    this.offlinePull.userId.copy(p, 2);
    p.writeUInt16BE(this.offlinePull.nextIndex, 18);
    this.offlinePull.nextIndex++;
    this.offlineStallRetries = 0;
    this.armOfflineStallTimer();
    await this.send(p);
  }

  /**
   * The offline pull is done (empty page or cap): resolve the newest record
   * as the weigh-in result. It carries REAL impedance -> BIA body composition.
   */
  private finishOfflinePull(): void {
    if (!this.offlinePull) return;
    this.clearOfflineStallTimer();
    this.offlinePull.active = false;
    const pending = this.offlinePull.pending;
    const uid = this.offlinePull.userId;
    const hadUser = !!uid;
    this.offlinePull = null;
    if (pending.length === 0) {
      bleLog.info('iHealth HS2S: no offline (registered-user) measurements');
      if (!hadUser) {
        // No registered user -> tourist mode, allow anon fallback.
        void this.startAnonymousPull().catch((error: unknown) => {
          bleLog.warn(
            `iHealth HS2S: anonymous pull failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      } else {
        bleLog.info('iHealth HS2S: registered user present — skipping tourist history');
        void this.sendOnlineUser(uid ?? undefined).catch(() => {});
      }
      return;
    }
    // Deduplicate overlapping B1 windows (idx0 3 rec + idx1 2 rec etc for count 4) by timestamp
    const uniq = new Map<number, (typeof pending)[number]>();
    for (const r of pending) {
      const k = r.timestamp ? r.timestamp.getTime() : Math.round(r.weight * 100);
      if (!uniq.has(k)) uniq.set(k, r);
    }
    const deduped = [...uniq.values()].sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));
    for (let i = 0; i < deduped.length; i++) {
      const r = deduped[i];
      if (r.timestamp) {
        if (i === deduped.length - 1) {
          (r as any)._forceLive = true;
          (r as any)._isNewWeighIn = this.measurePending;
          (r as any)._rawCount = pending.length;
        }
        this.pendingHistory.push(r);
      }
    }
    bleLog.info(`iHealth HS2S: offline pull complete — ${deduped.length} unique / ${pending.length} raw record(s) buffered as historic (newest force-live)`);
    this.measurePending = false;
    {
      const newestTs = deduped[deduped.length-1]?.timestamp?.getTime() ?? 0;
      const driftH = (Date.now() - newestTs)/3600000;
      if (Math.abs(driftH) > 24) bleLog.warn(`iHealth HS2S: RTC drift ${driftH.toFixed(1)}h — device clock stuck/inaccurate`);
    }
    if (hadUser) void this.sendOnlineUser(uid ?? undefined).catch(() => {});
    // Update last seen for driver-level continuous dedup (historic path also dedups via processor, this is belt-and-suspenders)
    const newest = deduped[deduped.length - 1];
    this.lastOfflineReport = { ts: newest.timestamp?.getTime() ?? 0, weight: newest.weight };
  }

  private armOfflineStallTimer(): void {
    this.clearOfflineStallTimer();
    this.offlineStallTimer = setTimeout(() => this.onOfflineStall(), 3000);
  }

  private onOfflineStall(): void {
    if (!this.offlinePull?.active) return;
    if (this.offlineStallRetries < 1) {
      this.offlineStallRetries++;
      bleLog.warn('iHealth HS2S: offline page timeout — retrying once');
      void this.pullNextOffline().catch(() => this.abortOfflinePull());
    } else {
      bleLog.warn('iHealth HS2S: offline pull stalled — completing with what we have');
      // Treat whatever we have as complete (covers single-page devices that
      // never send an empty terminator).
      this.finishOfflinePull();
    }
  }

  private abortOfflinePull(): void {
    this.clearOfflineStallTimer();
    if (this.offlinePull) this.offlinePull.active = false;
    bleLog.warn('iHealth HS2S: offline pull abandoned');
  }

  private clearOfflineStallTimer(): void {
    if (this.offlineStallTimer) {
      clearTimeout(this.offlineStallTimer);
      this.offlineStallTimer = null;
    }
  }

  /** Start the anonymous-history pull: ask for the record count first. */
  private async startAnonymousPull(): Promise<void> {
    this.anonPull = { active: true, nextWindow: -1, total: 0 };
    this.pendingHistory = [];
    await this.send(Buffer.from([0xa9, CMD_ANON_COUNT]));
  }

  /** Handle the count response (0x33): schedule the newest window first. */
  private handleAnonCount(payload: Buffer): void {
    const body = payload.subarray(2);
    if (body.length < 2 || !this.anonPull) return;
    const total = body.readUInt16BE(0);
    this.anonPull.total = total;
    // First window aligned so every record is covered: total=239 -> 236
    // ([236..238] then 232, ..., 0), total=8 -> 4, total=5 -> 4, total=4 -> 0.
    const rem = total % ANON_PAGE_SIZE;
    this.anonPull.nextWindow = total === 0 ? -1 : total - (rem === 0 ? ANON_PAGE_SIZE : rem);
    bleLog.info(
      `iHealth HS2S: ${total} anonymous record(s), pulling newest first (cap ${MAX_ANON_PULL})`,
    );
    if (this.anonPull.nextWindow < 0) {
      this.anonPull.active = false;
      bleLog.info('iHealth HS2S: no anonymous records to pull');
      return;
    }
    void this.pullNextAnonPage().catch((error: unknown) => {
      bleLog.warn(
        `iHealth HS2S: anonymous pull failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.abortAnonPull();
    });
  }

  /** Send one 0x34 page request for the current window. */
  private async pullNextAnonPage(): Promise<void> {
    if (!this.anonPull || !this.anonPull.active) return;
    const p = Buffer.alloc(4);
    p[0] = 0xa9;
    p[1] = CMD_ANON_DATA;
    p.writeUInt16BE(this.anonPull.nextWindow, 2);
    this.anonStallRetries = 0;
    this.armAnonStallTimer();
    await this.send(p);
  }

  /**
   * Advance the pull cursor after a page arrived; request the next window.
   * Marks the pull done once every window was requested (or the cap reached).
   */
  private advanceAnonPull(): void {
    if (!this.anonPull) return;
    this.anonPull.nextWindow -= ANON_PAGE_SIZE;
    const capped = this.pendingHistory.length >= MAX_ANON_PULL;
    const exhausted = this.anonPull.nextWindow < 0;
    if (!capped && !exhausted) {
      void this.pullNextAnonPage().catch((error: unknown) => {
        bleLog.warn(
          `iHealth HS2S: anonymous pull failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.abortAnonPull();
      });
      return;
    }
    this.anonPull.active = false;
    this.clearAnonStallTimer();
    // Reorder anon to oldest-first so pop() yields newest first, and mark newest as force-live
    if (this.pendingHistory.length > 0) {
      this.pendingHistory.reverse();
      (this.pendingHistory[this.pendingHistory.length - 1] as any)._forceLive = true;
      (this.pendingHistory[this.pendingHistory.length - 1] as any)._isNewWeighIn = this.measurePending;
      (this.pendingHistory[this.pendingHistory.length - 1] as any)._rawCount = this.pendingHistory.length;
    }
    bleLog.info(`iHealth HS2S: anon pull complete — ${this.pendingHistory.length} record(s) buffered as historic (newest force-live)`);
    this.measurePending = false;
  }

  private armAnonStallTimer(): void {
    this.clearAnonStallTimer();
    this.anonStallTimer = setTimeout(() => this.onAnonStall(), 3000);
  }

  private onAnonStall(): void {
    if (!this.anonPull?.active) return;
    if (this.anonStallRetries < 1) {
      this.anonStallRetries++;
      bleLog.warn('iHealth HS2S: anonymous page timeout — retrying once');
      void this.pullNextAnonPage().catch(() => this.abortAnonPull());
    } else {
      this.abortAnonPull();
    }
  }

  private abortAnonPull(): void {
    this.clearAnonStallTimer();
    if (this.anonPull) this.anonPull.active = false;
    this.measurePending = false;
    bleLog.warn('iHealth HS2S: anonymous pull abandoned');
  }

  private clearAnonStallTimer(): void {
    if (this.anonStallTimer) {
      clearTimeout(this.anonStallTimer);
      this.anonStallTimer = null;
    }
  }

  /** Read the auth phase through a method so TS does not over-narrow the field. */
  private readAuthPhase(): AuthPhase {
    return this.authPhase;
  }

  private async send(payload: Buffer): Promise<void> {
    if (!this.ctx) return;
    bleLog.debug(`iHealth HS2S: send ${payload.toString('hex')}`);
    const frame = buildBleCommFrame(payload, this.seq);
    this.seq = (this.seq + 2) & 0xff;
    for (const chunk of splitFrame(frame)) {
      await this.ctx.write(HS2S_WRITE_CHAR, chunk, false);
    }
  }

  private handleChallenge(payload: Buffer): void {
    const parsed = parseChallengePayload(payload);
    if (!parsed) {
      this.authPhase = 'failed';
      return;
    }
    const ka = deriveHs2sKa(parsed.deviceId);
    const r1Back = xxtea2Decrypt(parsed.r1Stroke, ka);
    if (this.r1 && !r1Back.equals(this.r1)) {
      bleLog.warn('iHealth HS2S: R1 verification failed — XXTEA2 mismatch');
    }
    bleLog.debug('iHealth HS2S: challenge received, sending R2_stroke');
    this.authPhase = 'await-final';
    void this.send(buildR2Payload(parsed.r2, ka)).catch((error: unknown) => {
      bleLog.warn(
        `iHealth HS2S: failed to send R2_stroke (${error instanceof Error ? error.message : String(error)})`,
      );
      this.authPhase = 'failed';
    });
  }

  private async waitUntil(
    predicate: () => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) {
        throw new Error(`iHealth HS2S: ${what} timed out`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}

/** 16 bytes of non-zero randomness (the scale rejects zero bytes in R1). */
function randomNonZeroBytes(len: number): Buffer {
  for (;;) {
    const out = randomBytes(len);
    if (!out.includes(0)) return out;
  }
}
