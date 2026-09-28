/**
 * Configuration JSON as a PDF (Streamlit "Download JSON as PDF" / "Drag & Drop JSON PDF").
 *
 * The PDF shows the JSON as selectable Courier text and also carries the exact JSON (base64 in the
 * document info) so re-importing never depends on text extraction. PDFs made by Streamlit
 * (reportlab, Flate-compressed text) are read by extracting their text operators.
 */

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 36;
const FONT_SIZE = 9;
const LEADING = 11;
const MAX_COLS = Math.floor((PAGE_W - 2 * MARGIN) / (FONT_SIZE * 0.6));
const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);
const JSON_KEY = 'BacktestJson';

const WIN_ANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99,
};
const WIN_ANSI_BACK = Object.fromEntries(Object.entries(WIN_ANSI).map(([c, b]) => [b, c])) as Record<number, string>;

function toWinAnsi(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code < 0x7f) out += ch;
    else if (WIN_ANSI[ch]) out += String.fromCharCode(WIN_ANSI[ch]);
    else if (code >= 0xa0 && code <= 0xff) out += ch;
    else out += '?';
  }
  return out;
}

function pdfString(s: string): string {
  return `(${toWinAnsi(s).replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/** Document-info text string: UTF-16BE with BOM so any title survives. */
function pdfTextString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return pdfString(s);
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

/** Wraps long lines at a space or comma when possible so copied text stays readable. */
function wrap(line: string): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > MAX_COLS) {
    const window = rest.slice(0, MAX_COLS);
    const cut = Math.max(window.lastIndexOf(' '), window.lastIndexOf(',') + 1);
    const at = cut > MAX_COLS / 2 ? cut : MAX_COLS;
    out.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  out.push(rest);
  return out;
}

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function jsonToPdf(json: string, title: string): Blob {
  const lines = json.split('\n').flatMap(wrap);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
  if (!pages.length) pages.push(['']);

  const objects: string[] = [];
  const add = (body: string) => objects.push(body) + 0;
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const page of pages) {
    const ops = [`BT /F1 ${FONT_SIZE} Tf ${LEADING} TL ${MARGIN} ${PAGE_H - MARGIN - FONT_SIZE} Td`];
    page.forEach((l, i) => ops.push(`${i ? 'T* ' : ''}${pdfString(l)} Tj`));
    ops.push('ET');
    const content = ops.join('\n');
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const contentId = objects.length;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  add(`<< /Title ${pdfTextString(title)} /Creator (Momentum Backtester) /${JSON_KEY} (${utf8ToBase64(json)}) >>`);
  const infoId = objects.length;

  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type: 'application/pdf' });
}

// ---- reading ------------------------------------------------------------------------------

async function inflate(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

function ascii85(data: Uint8Array): Uint8Array {
  const src = latin1(data).replace(/\s+/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
  const out: number[] = [];
  let group: number[] = [];
  const flush = (n: number) => {
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.push(...b.slice(0, n));
    group = [];
  };
  for (const ch of src) {
    if (ch === 'z' && !group.length) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) flush(4);
  }
  if (group.length) flush(group.length - 1);
  return new Uint8Array(out);
}

function asciiHex(data: Uint8Array): Uint8Array {
  const hex = latin1(data).replace(/[\s>]/g, '');
  const out = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2).padEnd(2, '0'), 16);
  return out;
}

/** Applies the stream's /Filter chain; null when a filter is unsupported (images, fonts…). */
async function decodeStream(dict: string, data: Uint8Array): Promise<Uint8Array | null> {
  const f = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict);
  const filters = f ? f[1].match(/\/\w+/g) ?? [] : [];
  let out: Uint8Array | null = data;
  for (const name of filters) {
    if (!out) return null;
    if (name === '/ASCII85Decode' || name === '/A85') out = ascii85(out);
    else if (name === '/ASCIIHexDecode' || name === '/AHx') out = asciiHex(out);
    else if (name === '/FlateDecode' || name === '/Fl') out = await inflate(out);
    else return null;
  }
  return out;
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

function decodeByte(b: number): string {
  return WIN_ANSI_BACK[b] ?? String.fromCharCode(b);
}

/** Text of a content stream: literal/hex strings of Tj, TJ, ' and ", with line breaks on moves. */
function contentText(src: string): string {
  let out = '';
  let pendingBreak = false;
  let i = 0;
  const emit = (s: string) => {
    if (pendingBreak && out) out += '\n';
    pendingBreak = false;
    out += s;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '(') {
      let depth = 1;
      let s = '';
      i++;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '\\') {
          const n = src[i + 1];
          const esc: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
          if (n in esc) { s += esc[n]; i += 2; continue; }
          const oct = /^[0-7]{1,3}/.exec(src.slice(i + 1, i + 4));
          if (oct) { s += decodeByte(parseInt(oct[0], 8)); i += 1 + oct[0].length; continue; }
          if (n === '\n' || n === '\r') { i += 2; continue; }
          i++;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) { i++; break; }
        s += decodeByte(ch.charCodeAt(0));
        i++;
      }
      emit(s);
      continue;
    }
    if (c === '<' && src[i + 1] !== '<') {
      const end = src.indexOf('>', i);
      const hex = src.slice(i + 1, end).replace(/\s+/g, '');
      let s = '';
      for (let k = 0; k < hex.length; k += 2) s += decodeByte(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      emit(s);
      i = end + 1;
      continue;
    }
    const op = /^(T\*|Td|TD|Tm|BT|'|")(?![A-Za-z*])/.exec(src.slice(i, i + 3));
    if (op && (i === 0 || /[\s\]>)]/.test(src[i - 1]))) {
      if (op[1] !== 'BT' || out) pendingBreak = true;
      i += op[1].length;
      continue;
    }
    i++;
  }
  return out;
}

function parseLoose(text: string): string | null {
  const t = text.trim();
  const tryParse = (s: string) => {
    try {
      JSON.parse(s);
      return s;
    } catch {
      return null;
    }
  };
  const direct = tryParse(t);
  if (direct) return direct;
  const start = t.search(/[[{]/);
  const end = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  return start >= 0 && end > start ? tryParse(t.slice(start, end + 1)) : null;
}

/** JSON text carried by a configuration PDF, or throws with a readable reason. */
export async function jsonFromPdf(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const raw = latin1(bytes);
  if (!raw.startsWith('%PDF')) throw new Error('Ce fichier n’est pas un PDF.');

  const embedded = new RegExp(`/${JSON_KEY}\\s*\\(([A-Za-z0-9+/=\\s]+)\\)`).exec(raw);
  if (embedded) return base64ToUtf8(embedded[1].replace(/\s+/g, ''));

  const texts: string[] = [];
  const re = /\d+\s+\d+\s+obj\s*<<((?:(?!endobj)[\s\S])*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const dict = m[1];
    const start = m.index + m[0].length;
    if (/\/Subtype\s*\/(Image|XML|Type1C|CIDFontType0C|OpenType)|\/Type\s*\/(XRef|ObjStm|Metadata)|\/Length[123]\s/.test(dict)) continue;
    const lenMatch = /\/Length\s+(\d+)(?!\d)(?!\s+\d+\s+R)/.exec(dict);
    let end = lenMatch ? start + Number(lenMatch[1]) : -1;
    if (end < start || end > raw.length || !/^\s*endstream/.test(raw.slice(end, end + 20))) {
      end = raw.indexOf('endstream', start);
      while (end > start && /\s/.test(raw[end - 1])) end--;
    }
    if (end <= start) continue;
    const data = await decodeStream(dict, bytes.subarray(start, end));
    if (!data) continue;
    const text = contentText(latin1(data));
    if (text.trim()) texts.push(text);
  }
  const json = parseLoose(texts.join('\n'));
  if (!json) throw new Error('Aucun JSON valide trouvé dans ce PDF (il doit contenir la configuration exportée par l’application).');
  return json;
}
