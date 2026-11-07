import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSkin, loadCape, renderHead, renderFront, renderCape, SkinError, RgbaImage } from '../../src/index.js';
import { testSkin, rawPng } from '../helpers.js';

const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const code = (c) => (e) => e instanceof SkinError && e.code === c;
// Skin avec chapeau transparent sauf un pixel rouge en (41, 9)
const skinBytes = testSkin({ alphaFn: (x, y) => (x >= 32 && y < 16 ? (x === 41 && y === 9 ? 255 : 0) : 255) });

test('tête : face (8,8)-(16,16), chapeau par-dessus, agrandie', async () => {
  const s = await loadSkin(skinBytes);
  const h = renderHead(s, { size: 8, hat: false });
  assert.deepEqual([h.width, h.height], [8, 8]);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) assert.deepEqual(px(h, x, y), px(s, 8 + x, 8 + y));
  const withHat = renderHead(s, { size: 8 });
  assert.deepEqual(px(withHat, 1, 1), px(s, 41, 9));
  assert.deepEqual(px(withHat, 2, 2), px(s, 10, 10));
  const big = renderHead(s, { size: 64 });
  assert.deepEqual([big.width, big.height], [64, 64]);
  assert.deepEqual(px(big, 8 * 3 + 5, 8 * 4 + 7), px(s, 11, 12));
  assert.equal(renderHead(s).width, 64); // taille par défaut
  const odd = renderHead(s, { size: 100 });
  assert.equal(odd.width, 100);
});

test('tête : options invalides refusées', async () => {
  const s = await loadSkin(skinBytes);
  for (const size of [0, 7, 3000, 1.5, '64', NaN]) assert.throws(() => renderHead(s, { size }), code('INVALID_OPTION'));
  assert.throws(() => renderHead({ width: 64 }), code('INVALID_OPTION'));
});

test('les rendus gardés en mémoire ne sont pas abîmés si on modifie le résultat', async () => {
  const s = await loadSkin(skinBytes);
  const a = renderHead(s, { size: 16 });
  a.data.fill(0);
  const b = renderHead(s, { size: 16 });
  assert.notEqual(b.data[3], 0);
});

test('vue de face classique : positions de chaque partie', async () => {
  const s = await loadSkin(skinBytes, { model: 'classic' });
  const f = renderFront(s, { scale: 1, layers: false });
  assert.deepEqual([f.width, f.height], [16, 32]);
  assert.deepEqual(px(f, 4, 0), px(s, 8, 8)); // tête
  assert.deepEqual(px(f, 4, 8), px(s, 20, 20)); // corps
  assert.deepEqual(px(f, 0, 8), px(s, 44, 20)); // bras droit
  assert.deepEqual(px(f, 12, 8), px(s, 36, 52)); // bras gauche
  assert.deepEqual(px(f, 4, 20), px(s, 4, 20)); // jambe droite
  assert.deepEqual(px(f, 8, 20), px(s, 20, 52)); // jambe gauche
  assert.equal(px(f, 0, 0)[3], 0); // fond transparent
});

test('vue de face bras fins : bras de 3 pixels collés au corps', async () => {
  const s = await loadSkin(skinBytes, { model: 'slim' });
  const f = renderFront(s, { scale: 1, layers: false });
  assert.equal(px(f, 0, 8)[3], 0);
  assert.deepEqual(px(f, 1, 8), px(s, 44, 20));
  assert.deepEqual(px(f, 14, 8), px(s, 38, 52));
  assert.equal(px(f, 15, 8)[3], 0);
});

test('vue de face : 2e couche activable, buste, échelle', async () => {
  const s = await loadSkin(skinBytes);
  const on = renderFront(s, { scale: 1 });
  assert.deepEqual(px(on, 5, 1), px(s, 41, 9));
  const off = renderFront(s, { scale: 1, layers: { hat: false } });
  assert.deepEqual(px(off, 5, 1), px(s, 9, 9));
  const bust = renderFront(s, { view: 'bust', scale: 4 });
  assert.deepEqual([bust.width, bust.height], [64, 64]);
  assert.equal(renderFront(s).height, 256);
  assert.throws(() => renderFront(s, { view: '3/4' }), code('INVALID_OPTION'));
  assert.throws(() => renderFront(s, { scale: 0 }), code('INVALID_OPTION'));
  assert.throws(() => renderFront(s, { layers: 'oui' }), code('INVALID_OPTION'));
});

test('cape : face extérieure (1,1)-(11,17)', async () => {
  const c = await loadCape(rawPng({ w: 64, h: 32, pixel: (x, y) => [x, y, 9, 255] }));
  const r = renderCape(c, { scale: 2 });
  assert.deepEqual([r.width, r.height], [20, 32]);
  assert.deepEqual(px(r, 0, 0), [1, 1, 9, 255]);
  assert.deepEqual(px(r, 19, 31), [10, 16, 9, 255]);
  assert.throws(() => renderCape({}), code('INVALID_OPTION'));
});

test('rendus → PNG et ImageData', async () => {
  const s = await loadSkin(skinBytes);
  const png = await renderHead(s, { size: 32 }).toPNG();
  assert.equal(png[1], 0x50);
  assert.throws(() => new RgbaImage(0, 1), code('INVALID_OPTION'));
  if (typeof ImageData !== 'function') assert.throws(() => renderHead(s).toImageData(), code('NOT_SUPPORTED'));
});
