import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const tmpDir = (p = 'lanterne-skins-') => fsp.mkdtemp(path.join(os.tmpdir(), p));

/** Ancien CRC (indépendant du code testé). */
function crc(buf) { return zlib.crc32 ? zlib.crc32(buf) : 0; }

export function pngChunk(type, data = Buffer.alloc(0), { badCrc = false } = {}) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(badCrc ? (crc(td) ^ 1) >>> 0 : crc(td));
  return Buffer.concat([len, td, c]);
}

/**
 * Encodeur PNG de test, indépendant de celui de la bibliothèque.
 * pixel(x, y) renvoie les échantillons bruts (tableau) pour le type de couleur.
 */
export function rawPng({ w, h, colorType = 6, depth = 8, interlace = 0, pixel, palette, trns, extra = [], idatOverride, filter = 0 }) {
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = [];
  for (const [x0, y0, dx, dy] of idatOverride ? [] : passes) {
    const pw = w > x0 ? Math.ceil((w - x0) / dx) : 0;
    const ph = h > y0 ? Math.ceil((h - y0) / dy) : 0;
    if (!pw || !ph) continue;
    for (let y = 0; y < ph; y++) {
      const bits = [];
      for (let x = 0; x < pw; x++) for (const s of pixel(x0 + x * dx, y0 + y * dy)) bits.push(s);
      const stride = Math.ceil((pw * ch * depth) / 8);
      const line = Buffer.alloc(stride);
      if (depth === 8) bits.forEach((v, i) => { line[i] = v; });
      else if (depth === 16) bits.forEach((v, i) => { line.writeUInt16BE(v, i * 2); });
      else bits.forEach((v, i) => { const b = i * depth; line[b >> 3] |= v << (8 - depth - (b & 7)); });
      let out = line;
      if (filter === 1) { // Sub
        const bpp = Math.max(1, (ch * depth) >> 3);
        out = Buffer.from(line.map((v, i) => (v - (i >= bpp ? line[i - bpp] : 0)) & 255));
      }
      rows.push(Buffer.from([filter]), out);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth; ihdr[9] = colorType; ihdr[12] = interlace;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr)];
  if (palette) parts.push(pngChunk('PLTE', Buffer.from(palette)));
  if (trns) parts.push(pngChunk('tRNS', Buffer.from(trns)));
  for (const e of extra) parts.push(e);
  parts.push(pngChunk('IDAT', idatOverride || zlib.deflateSync(Buffer.concat(rows))));
  parts.push(pngChunk('IEND'));
  return Buffer.concat(parts);
}

/** Skin de test : chaque pixel a une couleur qui dépend de sa position (x, y), alpha donné par alphaFn. */
export function testSkin({ w = 64, h = 64, alphaFn = () => 255, extra = [] } = {}) {
  return rawPng({ w, h, pixel: (x, y) => [x * 4, y * 4, (x + y) & 255, alphaFn(x, y)], extra });
}

/**
 * Pendant les tests, fetch est remplacé par un relais qui envoie chaque adresse officielle
 * (déjà vérifiée par la bibliothèque) vers le faux serveur local https://localhost:port/<site>/<chemin>.
 * La bibliothèque elle-même ne contient aucun crochet de test.
 */
const realFetch = globalThis.fetch;
export function mirrorTo(port) {
  globalThis.fetch = (url, init) => {
    const u = new URL(String(url));
    return realFetch(`https://localhost:${port}/${u.host}${u.pathname}${u.search}`, init)
      .then((r) => Object.defineProperty(r, 'url', { value: String(url) })); // comme si on parlait au vrai site
  };
  return () => { globalThis.fetch = realFetch; };
}

/** Faux serveur HTTPS local. Les adresses officielles y sont redirigées : /<site>/<chemin>. */
export async function startServer(routes) {
  const ctx = { hits: {}, requests: [] };
  const server = https.createServer({ key: fs.readFileSync(path.join(FIX, 'test-key.pem')), cert: fs.readFileSync(path.join(FIX, 'test-cert.pem')) }, (req, res) => {
    const u = new URL(req.url, 'https://localhost');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      ctx.hits[u.pathname] = (ctx.hits[u.pathname] || 0) + 1;
      ctx.requests.push({ method: req.method, path: u.pathname, headers: req.headers, body });
      const key = `${req.method} ${u.pathname}`;
      const hnd = routes[key] || routes[u.pathname];
      if (!hnd) { res.statusCode = 404; return res.end('absent'); }
      hnd(req, res, { body, ctx });
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const restore = mirrorTo(port);
  return {
    port,
    ctx,
    close: () => new Promise((r) => { restore(); for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

export const json = (obj, status = 200, headers = {}) => (req, res) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
};
export const bytes = (buf, status = 200) => (req, res) => { res.writeHead(status, { 'content-type': 'image/png' }); res.end(buf); };
export const status = (code, headers = {}) => (req, res) => { res.writeHead(code, headers); res.end(); };

export function texturesValue(textures, id = '069a79f444e94726a5befca90e38aaf5', name = 'Notch') {
  return Buffer.from(JSON.stringify({ timestamp: 1, profileId: id, profileName: name, textures })).toString('base64');
}
