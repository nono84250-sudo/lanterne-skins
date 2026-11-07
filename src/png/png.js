/**
 * Lecture et écriture PNG, notre propre code, zéro dépendance.
 *
 * Sécurité :
 * - signature PNG vérifiée (pas l'extension) ;
 * - dimensions lues dans l'en-tête AVANT toute décompression (anti « bombe ») ;
 * - la décompression s'arrête dès qu'elle dépasse la taille attendue ;
 * - CRC de chaque bloc vérifié, blocs critiques inconnus refusés ;
 * - l'image ré-écrite ne contient que les pixels (aucune métadonnée).
 */

import { crc32 } from './crc32.js';
import { inflate, deflate } from './zlib.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const ADAM7 = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];
const MAX_CHUNKS = 4096;

export class PngError extends Error {
  /** @param {'FORMAT'|'SIZE'|'TOO_LARGE'} kind */
  constructor(kind, detail) {
    super(detail);
    this.name = 'PngError';
    this.kind = kind;
  }
}

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** Vérifie la signature PNG (8 premiers octets). */
export function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return false;
  return true;
}

/**
 * Lit seulement l'en-tête (dimensions, type) sans rien décompresser.
 * @param {Uint8Array} bytes
 */
export function readHeader(bytes) {
  if (!isPng(bytes)) throw new PngError('FORMAT', 'signature PNG absente');
  if (bytes.length < 33) throw new PngError('FORMAT', 'fichier tronqué');
  const len = u32(bytes, 8);
  const type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (type !== 'IHDR' || len !== 13) throw new PngError('FORMAT', 'en-tête IHDR absent');
  if (crc32(bytes, 12, 29) !== u32(bytes, 29)) throw new PngError('FORMAT', 'en-tête abîmé (CRC)');
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  const depth = bytes[24];
  const colorType = bytes[25];
  const compression = bytes[26];
  const filter = bytes[27];
  const interlace = bytes[28];
  if (!width || !height) throw new PngError('SIZE', 'dimensions nulles');
  if (!(colorType in CHANNELS) || !DEPTHS[colorType].includes(depth)) throw new PngError('FORMAT', 'type de couleur inconnu');
  if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) throw new PngError('FORMAT', 'méthode inconnue');
  return { width, height, depth, colorType, interlace };
}

/**
 * Décode un PNG en pixels RVBA 8 bits.
 * @param {Uint8Array} bytes
 * @param {{checkSize?: (w:number,h:number)=>void, maxPixels?: number}} [opts]
 *   checkSize est appelé avec les dimensions AVANT la décompression ; il lève une erreur pour refuser.
 * @returns {Promise<{width:number,height:number,data:Uint8ClampedArray}>}
 */
export async function decodePng(bytes, opts = {}) {
  const h = readHeader(bytes);
  if (opts.checkSize) opts.checkSize(h.width, h.height);
  const maxPixels = opts.maxPixels ?? 4096 * 4096;
  if (h.width * h.height > maxPixels) throw new PngError('SIZE', 'image trop grande');

  // Parcours des blocs.
  let off = 8;
  let palette = null;
  let trns = null;
  const idat = [];
  let idatLen = 0;
  let seenEnd = false;
  let count = 0;
  while (off < bytes.length) {
    if (++count > MAX_CHUNKS) throw new PngError('FORMAT', 'trop de blocs');
    if (off + 12 > bytes.length) throw new PngError('FORMAT', 'bloc tronqué');
    const len = u32(bytes, off);
    if (len > bytes.length - off - 12) throw new PngError('FORMAT', 'bloc tronqué');
    const t0 = bytes[off + 4], t1 = bytes[off + 5], t2 = bytes[off + 6], t3 = bytes[off + 7];
    const type = String.fromCharCode(t0, t1, t2, t3);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new PngError('FORMAT', 'nom de bloc invalide');
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (crc32(bytes, off + 4, dataEnd) !== u32(bytes, dataEnd)) throw new PngError('FORMAT', `bloc ${type} abîmé (CRC)`);
    const data = bytes.subarray(dataStart, dataEnd);
    if (count === 1 && type !== 'IHDR') throw new PngError('FORMAT', 'IHDR doit être le premier bloc');
    if (type === 'IHDR') {
      if (count !== 1) throw new PngError('FORMAT', 'IHDR en double');
    } else if (type === 'PLTE') {
      if (len % 3 !== 0 || len === 0 || len / 3 > 256 || idat.length) throw new PngError('FORMAT', 'palette invalide');
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
      idatLen += len;
    } else if (type === 'IEND') {
      seenEnd = true;
      break;
    } else if ((t0 & 0x20) === 0) {
      // Bloc « critique » inconnu : la norme impose de refuser.
      throw new PngError('FORMAT', `bloc critique inconnu ${type}`);
    }
    // Les autres blocs (texte, date, profil couleur…) sont ignorés : ils disparaissent à la ré-écriture.
    off = dataEnd + 4;
  }
  if (!seenEnd) throw new PngError('FORMAT', 'fin de fichier (IEND) absente');
  if (!idatLen) throw new PngError('FORMAT', 'aucune donnée image');
  if (h.colorType === 3 && !palette) throw new PngError('FORMAT', 'palette absente');

  const channels = CHANNELS[h.colorType];
  const bitsPP = channels * h.depth;
  const bpp = Math.max(1, bitsPP >> 3);
  const passes = h.interlace ? ADAM7 : [[0, 0, 1, 1]];
  let expected = 0;
  const passDims = passes.map(([x0, y0, dx, dy]) => {
    const pw = h.width > x0 ? Math.ceil((h.width - x0) / dx) : 0;
    const ph = h.height > y0 ? Math.ceil((h.height - y0) / dy) : 0;
    const stride = Math.ceil((pw * bitsPP) / 8);
    if (pw && ph) expected += ph * (stride + 1);
    return { pw, ph, stride };
  });

  const comp = new Uint8Array(idatLen);
  { let o = 0; for (const p of idat) { comp.set(p, o); o += p.length; } }
  let raw;
  try {
    raw = await inflate(comp, expected);
  } catch (err) {
    if (err && err.tooLarge) throw new PngError('FORMAT', 'données image trop grosses');
    throw new PngError('FORMAT', 'données image illisibles');
  }
  if (raw.length !== expected) throw new PngError('FORMAT', 'données image de mauvaise taille');

  const out = new Uint8ClampedArray(h.width * h.height * 4);
  const maxv = (1 << h.depth) - 1;
  let pos = 0;
  passes.forEach(([x0, y0, dx, dy], pi) => {
    const { pw, ph, stride } = passDims[pi];
    if (!pw || !ph) return;
    let prev = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      const ft = raw[pos++];
      const line = raw.subarray(pos, pos + stride);
      pos += stride;
      unfilter(ft, line, prev, bpp);
      for (let x = 0; x < pw; x++) {
        const o = ((y0 + y * dy) * h.width + (x0 + x * dx)) * 4;
        writePixel(h, line, x, out, o, palette, trns, maxv);
      }
      prev = line;
    }
  });
  return { width: h.width, height: h.height, data: out };
}

function unfilter(ft, line, prev, bpp) {
  const n = line.length;
  switch (ft) {
    case 0: return;
    case 1: for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 255; return;
    case 2: for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 255; return;
    case 3:
      for (let i = 0; i < n; i++) line[i] = (line[i] + ((i >= bpp ? line[i - bpp] : 0) + prev[i] >> 1)) & 255;
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        line[i] = (line[i] + paeth(a, b, c)) & 255;
      }
      return;
    default:
      throw new PngError('FORMAT', 'filtre de ligne inconnu');
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function sample(line, idx, depth) {
  if (depth === 8) return line[idx];
  if (depth === 16) return (line[idx * 2] << 8) | line[idx * 2 + 1];
  const bit = idx * depth;
  return (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
}

function writePixel(h, line, x, out, o, palette, trns, maxv) {
  const d = h.depth;
  const to8 = (v) => (d === 16 ? v >> 8 : d === 8 ? v : Math.round((v * 255) / maxv));
  switch (h.colorType) {
    case 0: {
      const v = sample(line, x, d);
      const g = to8(v);
      out[o] = out[o + 1] = out[o + 2] = g;
      out[o + 3] = trns && trns.length >= 2 && v === ((trns[0] << 8) | trns[1]) ? 0 : 255;
      return;
    }
    case 2: {
      const r = sample(line, x * 3, d), g = sample(line, x * 3 + 1, d), b = sample(line, x * 3 + 2, d);
      out[o] = to8(r); out[o + 1] = to8(g); out[o + 2] = to8(b);
      out[o + 3] = trns && trns.length >= 6 && r === ((trns[0] << 8) | trns[1]) && g === ((trns[2] << 8) | trns[3]) && b === ((trns[4] << 8) | trns[5]) ? 0 : 255;
      return;
    }
    case 3: {
      const i = sample(line, x, d);
      if (i * 3 + 2 >= palette.length) throw new PngError('FORMAT', 'couleur hors palette');
      out[o] = palette[i * 3]; out[o + 1] = palette[i * 3 + 1]; out[o + 2] = palette[i * 3 + 2];
      out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      return;
    }
    case 4: {
      const g = to8(sample(line, x * 2, d));
      out[o] = out[o + 1] = out[o + 2] = g;
      out[o + 3] = to8(sample(line, x * 2 + 1, d));
      return;
    }
    case 6:
      out[o] = to8(sample(line, x * 4, d)); out[o + 1] = to8(sample(line, x * 4 + 1, d));
      out[o + 2] = to8(sample(line, x * 4 + 2, d)); out[o + 3] = to8(sample(line, x * 4 + 3, d));
      return;
  }
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/**
 * Écrit des pixels RVBA 8 bits en PNG propre (IHDR, IDAT, IEND seulement).
 * @param {{width:number,height:number,data:Uint8Array|Uint8ClampedArray}} img
 * @returns {Promise<Uint8Array>}
 */
export async function encodePng(img) {
  const { width, height, data } = img;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height * 4) {
    throw new PngError('SIZE', 'image invalide');
  }
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = data.subarray(y * stride, (y + 1) * stride);
    const prev = y ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? cur[i - 4] : 0;
        const b = prev ? prev[i] : 0;
        const cc = prev && i >= 4 ? prev[i - 4] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, cc);
        const v = (cur[i] - pred) & 255;
        c[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    raw[y * (stride + 1)] = best;
    raw.set(cand[best], y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [Uint8Array.from(SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
