/**
 * XXTEA2 — the iHealth SDK variant of XXTEA (Wheeler & Needham) used by the
 * HS2S `IdentifyIns2` handshake.
 *
 * Ported from the reverse-engineered `XXTEA2.class` inside the official
 * `iHealthSDK_2.9.4.4.jar` (verified against the SDK's own test vectors in
 * `hs2s-probe/verify_xxtea.js`). Differs from the common `xxtea` npm package:
 *
 *  - little-endian word packing;
 *  - `encrypt()` appends the plaintext byte length as one extra trailing word
 *    (output = data + 4 bytes), `decrypt()` truncates by that length field;
 *  - key is fixed at 16 bytes (truncated / zero-padded);
 *  - the SDK's decryption passes `mx(sum, z, y, ...)` with y/z swapped
 *    relative to the reference implementation.
 */

const DELTA = 0x9e3779b9;

/** Pack bytes into little-endian uint32 words; optionally append a length word. */
function toIntArrayLE(bytes: Buffer, withLength: boolean): number[] {
  const n = Math.ceil(bytes.length / 4);
  const arr = new Array<number>(n + (withLength ? 1 : 0)).fill(0);
  for (let i = 0; i < bytes.length; i++) {
    arr[i >>> 2] = (arr[i >>> 2] | ((bytes[i] & 0xff) << ((i & 3) << 3))) >>> 0;
  }
  if (withLength) arr[n] = bytes.length >>> 0;
  return arr;
}

function toBytesLE(arr: number[]): Buffer {
  const out = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i] >>> 0;
    out[i * 4] = v & 0xff;
    out[i * 4 + 1] = (v >>> 8) & 0xff;
    out[i * 4 + 2] = (v >>> 16) & 0xff;
    out[i * 4 + 3] = (v >>> 24) & 0xff;
  }
  return out;
}

/** The XXTEA mixing function; all intermediate arithmetic stays uint32. */
function mx(sum: number, y: number, z: number, p: number, e: number, k: number[]): number {
  return (
    ((((z >>> 5) ^ ((y << 2) >>> 0)) + (((y >>> 3) ^ ((z << 4) >>> 0)) >>> 0)) ^
      ((((sum ^ y) >>> 0) + ((k[(p & 3) ^ e] ^ z) >>> 0)) >>> 0)) >>>
    0
  );
}

function encryptWords(v: number[], k: number[]): number[] {
  const n = v.length - 1;
  if (n < 1) return v;
  let z = v[n] >>> 0;
  let sum = 0;
  const q = 6 + Math.floor(52 / (n + 1));
  for (let r = 0; r < q; r++) {
    sum = (sum + DELTA) >>> 0;
    const e = (sum >>> 2) & 3;
    let p: number;
    for (p = 0; p < n; p++) {
      const y = v[p + 1] >>> 0;
      v[p] = ((v[p] >>> 0) + mx(sum, y, z, p, e, k)) >>> 0;
      z = v[p];
    }
    const y0 = v[0] >>> 0;
    v[n] = ((v[n] >>> 0) + mx(sum, y0, z, n, e, k)) >>> 0;
    z = v[n];
  }
  return v;
}

function decryptWords(v: number[], k: number[]): number[] {
  const n = v.length - 1;
  if (n < 1) return v;
  let z = v[0] >>> 0;
  const q = 6 + Math.floor(52 / (n + 1));
  let sum = ((q * DELTA) & 0xffffffff) >>> 0;
  while (sum !== 0) {
    const e = (sum >>> 2) & 3;
    // SDK quirk: mx(sum, z, y, ...) with y/z swapped vs the reference.
    for (let p = n; p > 0; p--) {
      const y = v[p - 1] >>> 0;
      v[p] = (((v[p] >>> 0) - mx(sum, z, y, p, e, k)) & 0xffffffff) >>> 0;
      z = v[p];
    }
    const yN = v[n] >>> 0;
    v[0] = (((v[0] >>> 0) - mx(sum, z, yN, 0, e, k)) & 0xffffffff) >>> 0;
    z = v[0];
    sum = (sum - DELTA) >>> 0;
  }
  return v;
}

/** The HS2S key material is exactly 16 bytes; truncate / zero-pad anything else. */
function padKey(key: Buffer): Buffer {
  const out = Buffer.alloc(16);
  Buffer.from(key).copy(out, 0, 0, Math.min(key.length, 16));
  return out;
}

/**
 * XXTEA2 encrypt: little-endian words, plaintext length appended as the last
 * word, so the output is `data.length + 4` bytes.
 */
export function xxtea2Encrypt(data: Buffer, key: Buffer): Buffer {
  if (data.length === 0) return data;
  const k = toIntArrayLE(padKey(key), false);
  const v = encryptWords(toIntArrayLE(Buffer.from(data), true), k);
  return toBytesLE(v);
}

/** XXTEA2 decrypt: truncate the decrypted words by the embedded length field. */
export function xxtea2Decrypt(data: Buffer, key: Buffer): Buffer {
  if (data.length === 0) return data;
  const k = toIntArrayLE(padKey(key), false);
  const v = decryptWords(toIntArrayLE(Buffer.from(data), false), k);
  const raw = toBytesLE(v);
  const len = raw.readUInt32LE(raw.length - 4);
  return raw.subarray(0, len);
}
