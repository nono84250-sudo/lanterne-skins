import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadSkin, loadCape, Skin, Cape, convertLegacy, detectModel, SkinError, decodePng } from '../../src/index.js';
import { testSkin, rawPng, pngChunk, FIX } from '../helpers.js';

const code = (c) => (e) => e instanceof SkinError && e.code === c;
const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

test('skin 64×64 : chargé, bras épais deviné', async () => {
  const s = await loadSkin(testSkin());
  assert.ok(s instanceof Skin);
  assert.deepEqual([s.width, s.height, s.model, s.legacy], [64, 64, 'classic', false]);
  assert.deepEqual(px(s, 10, 9), [40, 36, 19, 255]);
});

test('bras fins deviné quand la colonne 54-55 est vide', async () => {
  const slim = await loadSkin(testSkin({ alphaFn: (x, y) => (x >= 54 && x < 56 && y >= 20 && y < 32 ? 0 : 255) }));
  assert.equal(slim.model, 'slim');
  const forced = await loadSkin(testSkin(), { model: 'slim' });
  assert.equal(forced.model, 'slim');
  await assert.rejects(loadSkin(testSkin(), { model: 'geant' }), code('INVALID_OPTION'));
});

test('vieux skin 64×32 converti en 64×64, membres gauches en miroir (comme le jeu)', async () => {
  const s = await loadSkin(testSkin({ h: 32 }));
  assert.deepEqual([s.width, s.height, s.legacy, s.model], [64, 64, true, 'classic']);
  // Jambe gauche, face avant (20..24, 52..64) = jambe droite face avant (4..8, 20..32) en miroir.
  for (let y = 0; y < 12; y++) for (let x = 0; x < 4; x++) {
    assert.deepEqual(px(s.source, 20 + x, 52 + y), px(s.source, 4 + (3 - x), 20 + y));
    assert.deepEqual(px(s.source, 36 + x, 52 + y), px(s.source, 44 + (3 - x), 20 + y)); // bras
  }
  // Le haut de l'image est conservé.
  assert.deepEqual(px(s.source, 10, 10), [40, 40, 20, 255]);
  // Zones vides d'origine en dehors des copies : transparentes.
  assert.equal(px(s.source, 0, 40)[3], 0);
});

test('vieux skin avec chapeau 100 % opaque : chapeau ignoré (comme le jeu)', async () => {
  const s = await loadSkin(testSkin({ h: 32 }));
  assert.equal(px(s, 40, 8)[3], 0);
  const s2 = await loadSkin(testSkin({ h: 32, alphaFn: (x, y) => (x === 40 && y === 8 ? 0 : 255) }));
  assert.equal(px(s2, 41, 8)[3], 255);
});

test('couche de base rendue opaque, 2e couche garde sa transparence', async () => {
  const s = await loadSkin(testSkin({ alphaFn: () => 0 }));
  assert.equal(px(s, 8, 8)[3], 255); // visage
  assert.equal(px(s, 40, 8)[3], 0); // chapeau
  assert.equal(px(s.source, 8, 8)[3], 0); // l'original n'est pas retouché
});

test('mauvaises tailles refusées (HD 128×128, 32×32, cape 64×32 ok pour cape seulement)', async () => {
  await assert.rejects(loadSkin(testSkin({ w: 128, h: 128 }), { maxBytes: 1e6 }), code('SKIN_INVALID_SIZE'));
  await assert.rejects(loadSkin(testSkin({ w: 32, h: 32 })), code('SKIN_INVALID_SIZE'));
  await assert.rejects(loadSkin(testSkin({ w: 64, h: 65 })), code('SKIN_INVALID_SIZE'));
  await assert.rejects(loadCape(testSkin({ w: 64, h: 64 })), code('CAPE_INVALID_SIZE'));
  const c = await loadCape(fs.readFileSync(path.join(FIX, 'pil', 'cape.png')));
  assert.ok(c instanceof Cape);
  assert.deepEqual(px(c, 1, 1), [200, 10, 10, 255]);
});

test('formats refusés : JPEG, GIF, SVG, texte, chemin, adresse, rien', async () => {
  for (const bad of [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), Buffer.from('GIF89a'), Buffer.from('<svg onload="alert(1)"/>')]) {
    await assert.rejects(loadSkin(bad), code('SKIN_INVALID_FORMAT'));
    await assert.rejects(loadCape(bad), code('CAPE_INVALID_FORMAT'));
  }
  for (const bad of ['/etc/passwd', 'https://exemple.com/skin.png', null, undefined, 42, {}]) await assert.rejects(loadSkin(bad), code('SKIN_INVALID_FORMAT'));
});

test('fichier trop gros refusé avant décodage (64 Ko par défaut, réglable)', async () => {
  const big = testSkin({ extra: [pngChunk('tEXt', Buffer.alloc(70 * 1024, 65))] });
  await assert.rejects(loadSkin(big), code('SKIN_TOO_LARGE'));
  await assert.rejects(loadSkin(new Blob([big])), code('SKIN_TOO_LARGE'));
  assert.ok(await loadSkin(big, { maxBytes: 200 * 1024 }));
});

test('accepte Uint8Array, Buffer, ArrayBuffer, DataView et Blob', async () => {
  const b = testSkin();
  for (const input of [b, new Uint8Array(b), b.buffer.slice(b.byteOffset, b.byteOffset + b.length), new DataView(b.buffer, b.byteOffset, b.length), new Blob([b])]) {
    const s = await loadSkin(input);
    assert.equal(s.width, 64);
  }
});

test('PNG abîmé ou piégé → SKIN_INVALID_FORMAT (jamais d’erreur interne)', async () => {
  const b = Buffer.from(testSkin()); b[50] ^= 0xff;
  await assert.rejects(loadSkin(b), code('SKIN_INVALID_FORMAT'));
  await assert.rejects(loadSkin(rawPng({ w: 64, h: 64, pixel: () => [0, 0, 0, 0], idatOverride: Buffer.from('xx') })), code('SKIN_INVALID_FORMAT'));
  for (let i = 0; i < 200; i++) { // octets au hasard
    const r = Buffer.from(testSkin());
    r[8 + Math.floor(Math.random() * (r.length - 8))] = Math.floor(Math.random() * 256);
    try { await loadSkin(r); } catch (e) { assert.ok(e instanceof SkinError && ['SKIN_INVALID_FORMAT', 'SKIN_INVALID_SIZE'].includes(e.code), e.code); }
  }
});

test('métadonnées cachées supprimées à la ré-écriture', async () => {
  const s = await loadSkin(testSkin({ extra: [pngChunk('tEXt', Buffer.from('Author\0secret-gps-48.85,2.35'))] }));
  const png = Buffer.from(await s.source.toPNG());
  assert.equal(png.includes(Buffer.from('secret')), false);
  const back = await decodePng(png);
  assert.deepEqual([...back.data], [...s.source.data]);
  assert.match(await s.toDataURL(), /^data:image\/png;base64,/);
});

test('convertLegacy / detectModel utilisables seuls', async () => {
  const img = await decodePng(testSkin({ h: 32 }));
  const { RgbaImage } = await import('../../src/core/image.js');
  const out = convertLegacy(new RgbaImage(img.width, img.height, img.data));
  assert.equal(out.height, 64);
  assert.equal(detectModel(out), 'classic');
});
