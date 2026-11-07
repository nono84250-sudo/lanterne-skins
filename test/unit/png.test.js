import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodePng, encodePng, readHeader, isPng, PngError } from '../../src/png/png.js';
import { crc32 } from '../../src/png/crc32.js';
import { rawPng, pngChunk, FIX } from '../helpers.js';

const rejects = (p, kind) => assert.rejects(p, (e) => e instanceof PngError && (!kind || e.kind === kind));

test('CRC-32 identique à celui de zlib', () => {
  const b = Buffer.from('lanterne-skins 123456789');
  assert.equal(crc32(b), zlib.crc32(b));
});

test('signature : PNG reconnu, le reste refusé', async () => {
  assert.equal(isPng(rawPng({ w: 1, h: 1, pixel: () => [1, 2, 3, 4] })), true);
  assert.equal(isPng(Buffer.from('GIF89a......')), false);
  assert.equal(isPng(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), false);
  assert.equal(isPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), false); // JPEG
  await rejects(decodePng(Buffer.from('<svg></svg>')), 'FORMAT');
  await rejects(decodePng(new Uint8Array(0)), 'FORMAT');
});

test('lit les dimensions sans décompresser', () => {
  const h = readHeader(rawPng({ w: 64, h: 32, pixel: () => [0, 0, 0, 0] }));
  assert.deepEqual([h.width, h.height, h.depth, h.colorType], [64, 32, 8, 6]);
});

test('dimensions refusées AVANT la décompression (bombe)', async () => {
  // IDAT illisible : si on décompressait, l'erreur serait FORMAT ; on doit voir l'erreur de taille.
  const png = rawPng({ w: 100000, h: 100000, pixel: () => [0, 0, 0, 0], idatOverride: Buffer.from('nimportequoi') });
  let called = null;
  await assert.rejects(decodePng(png, { checkSize: (w, h) => { called = [w, h]; throw new Error('taille refusée'); } }), /taille refusée/);
  assert.deepEqual(called, [100000, 100000]);
  await rejects(decodePng(png), 'SIZE'); // plafond de pixels par défaut
});

test('bombe zlib : données décompressées plus grosses que prévu → refus', async () => {
  const big = zlib.deflateSync(Buffer.alloc(50 * 1024 * 1024)); // 50 Mo de zéros, ~50 Ko compressés
  const png = rawPng({ w: 64, h: 64, pixel: () => [0, 0, 0, 0], idatOverride: big });
  const t = Date.now();
  await rejects(decodePng(png), 'FORMAT');
  assert.ok(Date.now() - t < 3000, 'arrêt rapide');
});

test('données trop courtes, CRC faux, tronqué, IEND absent, bloc critique inconnu → refus', async () => {
  const ok = rawPng({ w: 4, h: 4, pixel: () => [1, 2, 3, 255] });
  await rejects(decodePng(rawPng({ w: 4, h: 4, pixel: () => [0, 0, 0, 0], idatOverride: zlib.deflateSync(Buffer.alloc(10)) })), 'FORMAT');
  const bad = Buffer.from(ok); bad[bad.length - 20] ^= 0xff; // octet dans IDAT
  await rejects(decodePng(bad), 'FORMAT');
  await rejects(decodePng(ok.subarray(0, ok.length - 12)), 'FORMAT');
  await rejects(decodePng(ok.subarray(0, 40)), 'FORMAT');
  await rejects(decodePng(rawPng({ w: 4, h: 4, pixel: () => [1, 2, 3, 255], extra: [pngChunk('ZZZZ', Buffer.from('x'))] })), 'FORMAT');
  await rejects(decodePng(rawPng({ w: 4, h: 4, pixel: () => [1, 2, 3, 255], extra: [pngChunk('tEXt', Buffer.from('a\0b'), { badCrc: true })] })), 'FORMAT');
  const hdr = Buffer.from(ok); hdr[20] ^= 1; // dimension modifiée → CRC de l'en-tête faux
  assert.throws(() => readHeader(hdr), PngError);
  // filtre de ligne inconnu
  const rows = Buffer.alloc(4 * 17); rows[0] = 9;
  await rejects(decodePng(rawPng({ w: 4, h: 4, pixel: () => [0, 0, 0, 0], idatOverride: zlib.deflateSync(rows) })), 'FORMAT');
  // type de couleur / profondeur invalides
  const weird = rawPng({ w: 2, h: 2, colorType: 2, depth: 4, pixel: () => [1, 1, 1] });
  assert.throws(() => readHeader(weird), PngError);
});

test('blocs annexes (texte, date…) ignorés', async () => {
  const png = rawPng({ w: 2, h: 2, pixel: () => [10, 20, 30, 40], extra: [pngChunk('tEXt', Buffer.from('Comment\0secret')), pngChunk('tIME', Buffer.alloc(7))] });
  const img = await decodePng(png);
  assert.deepEqual([...img.data.subarray(0, 4)], [10, 20, 30, 40]);
});

function expectAll(img, fn) {
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const o = (y * img.width + x) * 4;
    assert.deepEqual([...img.data.subarray(o, o + 4)], fn(x, y), `pixel ${x},${y}`);
  }
}

test('tous les types de couleur et profondeurs, avec et sans entrelacement', async () => {
  for (const interlace of [0, 1]) {
    for (const filter of [0, 1]) {
      // RVBA 8
      expectAll(await decodePng(rawPng({ w: 13, h: 11, interlace, filter, pixel: (x, y) => [x, y, x + y, 200] })), (x, y) => [x, y, x + y, 200]);
      // RVB 8 et 16
      expectAll(await decodePng(rawPng({ w: 9, h: 7, colorType: 2, interlace, filter, pixel: (x, y) => [x, y, 5] })), (x, y) => [x, y, 5, 255]);
      expectAll(await decodePng(rawPng({ w: 9, h: 7, colorType: 2, depth: 16, interlace, filter, pixel: (x, y) => [x << 8, y << 8, 0xffff] })), (x, y) => [x, y, 255, 255]);
      // RVBA 16
      expectAll(await decodePng(rawPng({ w: 5, h: 5, colorType: 6, depth: 16, interlace, filter, pixel: (x) => [x << 8 | 7, 0, 0, 0x8000] })), (x) => [x, 0, 0, 128]);
      // gris 1, 2, 4, 8, 16
      for (const d of [1, 2, 4, 8]) {
        const max = (1 << d) - 1;
        expectAll(await decodePng(rawPng({ w: 11, h: 3, colorType: 0, depth: d, interlace, filter, pixel: (x) => [x % (max + 1)] })), (x) => { const g = Math.round(((x % (max + 1)) * 255) / max); return [g, g, g, 255]; });
      }
      expectAll(await decodePng(rawPng({ w: 4, h: 4, colorType: 0, depth: 16, interlace, filter, pixel: (x) => [x * 0x4000] })), (x) => [x * 64, x * 64, x * 64, 255]);
      // gris + alpha
      expectAll(await decodePng(rawPng({ w: 6, h: 6, colorType: 4, interlace, filter, pixel: (x, y) => [x * 10, y * 10] })), (x, y) => [x * 10, x * 10, x * 10, y * 10]);
      // palette 1, 2, 4, 8 avec transparence
      for (const d of [1, 2, 4, 8]) {
        const n = 1 << d;
        const pal = []; for (let i = 0; i < n; i++) pal.push(i, 255 - i, i * 2 & 255);
        const tr = [0, 128];
        expectAll(await decodePng(rawPng({ w: 10, h: 3, colorType: 3, depth: d, interlace, filter, palette: pal, trns: tr, pixel: (x) => [x % n] })), (x) => { const i = x % n; return [i, 255 - i, i * 2 & 255, i < 2 ? tr[i] : 255]; });
      }
    }
  }
});

test('transparence simple (tRNS) en gris et en RVB', async () => {
  expectAll(await decodePng(rawPng({ w: 3, h: 1, colorType: 0, pixel: (x) => [x], trns: [0, 1] })), (x) => [x, x, x, x === 1 ? 0 : 255]);
  expectAll(await decodePng(rawPng({ w: 3, h: 1, colorType: 2, pixel: (x) => [x, 0, 0], trns: [0, 2, 0, 0, 0, 0] })), (x) => [x, 0, 0, x === 2 ? 0 : 255]);
});

test('palette absente ou couleur hors palette → refus', async () => {
  await rejects(decodePng(rawPng({ w: 2, h: 1, colorType: 3, pixel: () => [0] })), 'FORMAT');
  await rejects(decodePng(rawPng({ w: 2, h: 1, colorType: 3, palette: [1, 2, 3], pixel: () => [5] })), 'FORMAT');
});

test('fichiers réels créés par un autre logiciel (Pillow) : mêmes pixels', async () => {
  const dir = path.join(FIX, 'pil');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.png'))) {
    if (f === 'gray16.png') continue; // Pillow coupe à 255 au lieu de garder l'octet fort
    const img = await decodePng(fs.readFileSync(path.join(dir, f)));
    const want = fs.readFileSync(path.join(dir, f.replace('.png', '.rgba')));
    assert.ok(Buffer.from(img.data.buffer).equals(want), f);
  }
});

test('écriture : relecture identique, seulement IHDR/IDAT/IEND', async () => {
  const data = new Uint8ClampedArray(17 * 9 * 4).map((_, i) => (i * 37) & 255);
  const png = await encodePng({ width: 17, height: 9, data });
  const back = await decodePng(png);
  assert.deepEqual([...back.data], [...data]);
  const types = [];
  for (let o = 8; o < png.length;) { const len = Buffer.from(png).readUInt32BE(o); types.push(Buffer.from(png.subarray(o + 4, o + 8)).toString('latin1')); o += 12 + len; }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  await assert.rejects(encodePng({ width: 2, height: 2, data: new Uint8Array(3) }), PngError);
});
