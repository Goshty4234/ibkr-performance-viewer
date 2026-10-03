/**
 * Lossless compact storage of result files (summary / portfolio detail).
 *
 * A result is mostly long numeric time series (10 000 days x 350 tickers). Stored as JSON text they
 * are bulky even after gzip. Here every long list of numbers that is exact at some decimal scale
 * (cents, 4 decimals...) is written as delta + zig-zag varint bytes, runs of consecutive daily dates
 * become {start, count}, and the whole thing is gzipped. Decoding gives back exactly the same JSON
 * value (checked at save time: if anything differed the plain format is used instead).
 *
 * Layout (before gzip): "LN1\n" | u32 header length | header JSON | binary buffer.
 * The header is the original JSON with markers: {"$i":[scale,count,offset,bytes]} (ints),
 * {"$n":[scale,count,offset,bytes,[null positions]]} (ints with nulls), {"$d":[firstDate,count]}
 * (daily dates) and {"$e":{...}} (an original object whose key started with "$").
 */

const MAGIC = [0x4c, 0x4e, 0x31, 0x0a]; // "LN1\n"
const MIN_LIST = 1000; // shorter lists gain nothing
const SCALES = [0, 1, 2, 3, 4, 5, 6, 8];
const MAX_INT = 2 ** 50;
const DAY_MS = 86_400_000;

class Writer {
  buf = new Uint8Array(1 << 16);
  len = 0;
  private grow(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  varint(zz: number) {
    this.grow(8);
    let v = zz;
    while (v >= 128) {
      this.buf[this.len++] = (v % 128) | 128;
      v = Math.floor(v / 128);
    }
    this.buf[this.len++] = v;
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Smallest scale at which every value is exactly int / 10^scale, with the ints. */
function toInts(values: number[]): { scale: number; ints: number[] } | null {
  for (const scale of SCALES) {
    const m = 10 ** scale;
    const ints = new Array<number>(values.length);
    let ok = true;
    for (let i = 0; i < values.length; i += 1) {
      const x = Math.round(values[i] * m);
      if (Math.abs(x) > MAX_INT || x / m !== values[i]) {
        ok = false;
        break;
      }
      ints[i] = x;
    }
    if (ok) return { scale, ints };
  }
  return null;
}

function isDailyDates(list: unknown[]): boolean {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!list.every((v) => typeof v === 'string' && re.test(v))) return false;
  const t0 = Date.parse(`${list[0]}T00:00:00Z`);
  if (!Number.isFinite(t0)) return false;
  for (let i = 1; i < list.length; i += 1) {
    if (Date.parse(`${list[i]}T00:00:00Z`) !== t0 + i * DAY_MS) return false;
  }
  return new Date(t0 + (list.length - 1) * DAY_MS).toISOString().slice(0, 10) === list[list.length - 1];
}

function encodeValue(o: unknown, w: Writer): unknown {
  if (Array.isArray(o)) {
    if (o.length >= MIN_LIST) {
      if (isDailyDates(o)) return { $d: [o[0], o.length] };
      const nullPos: number[] = [];
      const nums: number[] = [];
      let numeric = true;
      for (let i = 0; i < o.length; i += 1) {
        const v = o[i];
        if (v === null) nullPos.push(i);
        else if (isNum(v)) nums.push(v);
        else {
          numeric = false;
          break;
        }
      }
      if (numeric && nums.length >= MIN_LIST * 0.9) {
        const r = toInts(nums);
        if (r) {
          const start = w.len;
          let prev = 0;
          for (const x of r.ints) {
            const d = x - prev;
            w.varint(d < 0 ? -2 * d - 1 : 2 * d);
            prev = x;
          }
          return nullPos.length
            ? { $n: [r.scale, nums.length, start, w.len - start, nullPos] }
            : { $i: [r.scale, nums.length, start, w.len - start] };
        }
      }
    }
    return o.map((v) => encodeValue(v, w));
  }
  if (o && typeof o === 'object') {
    const entries = Object.entries(o as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = encodeValue(v, w);
    return entries.some(([k]) => k.startsWith('$')) ? { $e: out } : out;
  }
  return o;
}

function decodeInts(buf: Uint8Array, count: number, start: number, scale: number): number[] {
  const out = new Array<number>(count);
  const m = 10 ** scale;
  let p = start;
  let prev = 0;
  for (let i = 0; i < count; i += 1) {
    let v = 0;
    let mul = 1;
    for (;;) {
      const b = buf[p++];
      v += (b & 127) * mul;
      if (b < 128) break;
      mul *= 128;
    }
    const d = v % 2 === 1 ? -(v + 1) / 2 : v / 2;
    prev += d;
    out[i] = prev / m;
  }
  return out;
}

function decodeValue(o: unknown, buf: Uint8Array): unknown {
  if (Array.isArray(o)) return o.map((v) => decodeValue(v, buf));
  if (o && typeof o === 'object') {
    const rec = o as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length === 1) {
      const k = keys[0];
      if (k === '$i') {
        const [scale, count, start] = rec.$i as number[];
        return decodeInts(buf, count, start, scale);
      }
      if (k === '$n') {
        const [scale, count, start, , nullPos] = rec.$n as [number, number, number, number, number[]];
        const nums = decodeInts(buf, count, start, scale);
        const out: (number | null)[] = new Array(count + nullPos.length);
        let ni = 0;
        let pi = 0;
        for (let i = 0; i < out.length; i += 1) {
          if (pi < nullPos.length && nullPos[pi] === i) {
            out[i] = null;
            pi += 1;
          } else out[i] = nums[ni++];
        }
        return out;
      }
      if (k === '$d') {
        const [first, count] = rec.$d as [string, number];
        const t0 = Date.parse(`${first}T00:00:00Z`);
        return Array.from({ length: count }, (_, i) => new Date(t0 + i * DAY_MS).toISOString().slice(0, 10));
      }
      if (k === '$e') return decodeObject(rec.$e as Record<string, unknown>, buf);
    }
    return decodeObject(rec, buf);
  }
  return o;
}

function decodeObject(rec: Record<string, unknown>, buf: Uint8Array): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = decodeValue(v, buf);
  return out;
}

/** Lean bytes of a JSON value (before gzip). */
export function encodeLean(value: unknown): Uint8Array {
  const w = new Writer();
  const header = new TextEncoder().encode(JSON.stringify(encodeValue(value, w)));
  const out = new Uint8Array(4 + 4 + header.length + w.len);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  out.set(w.buf.subarray(0, w.len), 8 + header.length);
  return out;
}

export function isLean(bytes: Uint8Array): boolean {
  return MAGIC.every((b, i) => bytes[i] === b);
}

export function decodeLean(bytes: Uint8Array): unknown {
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen)));
  return decodeValue(header, bytes.subarray(8 + headerLen));
}

async function gzipBytes(bytes: Uint8Array): Promise<Blob> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

/** Bytes of a stored file: gunzipped when it starts with the gzip magic. */
async function storedBytes(blob: Blob): Promise<Uint8Array> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Compact gzip of a JSON value, or of its plain JSON text when the lean form would not decode to
 * exactly the same value. `text` is the JSON the value came from (avoids stringifying twice).
 */
export async function packResult(value: unknown, text?: string): Promise<{ blob: Blob; lean: boolean }> {
  const plain = text ?? JSON.stringify(value);
  try {
    const bytes = encodeLean(value);
    if (JSON.stringify(decodeLean(bytes)) === plain) return { blob: await gzipBytes(bytes), lean: true };
  } catch {
    /* fall through to plain */
  }
  return { blob: await gzipBytes(new TextEncoder().encode(plain)), lean: false };
}

/** Parsed JSON of any stored result file (lean, gzipped JSON or plain JSON). */
export async function readStoredJson(blob: Blob): Promise<unknown> {
  const bytes = await storedBytes(blob);
  return isLean(bytes) ? decodeLean(bytes) : JSON.parse(new TextDecoder().decode(bytes));
}
