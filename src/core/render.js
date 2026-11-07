/**
 * Rendus 2D fixes : tête, vue de face (corps entier ou buste), cape.
 * Pixels nets (au plus proche), fond transparent. Les rendus sont gardés en
 * mémoire tant que le skin existe, pour ne pas les recalculer.
 */

import { SkinError } from '../errors.js';
import { RgbaImage, blit } from './image.js';
import { Skin, Cape, trustedHash } from './skin.js';
import { crc32 } from '../png/crc32.js';

const MAX_OUT = 2048;
// Rendus gardés en mémoire, avec un budget total (un serveur peut recevoir des tailles variées).
// Clé : l'empreinte Mojang de l'image quand on l'a (le même joueur ne sera pas redessiné même
// si son skin est rechargé), sinon l'objet lui-même.
const MEMO_BUDGET = 32 * 1024 * 1024;
const MEMO_ITEM_MAX = 1024 * 1024;
const byHash = new Map();
let byHashBytes = 0;
const byObject = new WeakMap();

function cached(src, key, make) {
  const hash = trustedHash(src);
  if (hash) {
    // L'empreinte des pixels est ajoutée : un skin modifié sur place n'est jamais confondu.
    const k = `${hash}:${crc32(src.data)}:${src.model || ''}:${key}`;
    const hit = byHash.get(k);
    if (hit) { byHash.delete(k); byHash.set(k, hit); return hit; }
    const v = make();
    if (v.data.length <= MEMO_ITEM_MAX) {
      byHash.set(k, v);
      byHashBytes += v.data.length;
      while (byHashBytes > MEMO_BUDGET) {
        const [oldK, old] = byHash.entries().next().value;
        byHash.delete(oldK);
        byHashBytes -= old.data.length;
      }
    }
    return v;
  }
  let m = byObject.get(src);
  if (!m) { m = new Map(); byObject.set(src, m); }
  key = `${crc32(src.data)}:${key}`; // un skin modifié sur place est redessiné
  let v = m.get(key);
  if (!v) {
    v = make();
    if (v.data.length > MEMO_ITEM_MAX) return v;
    if (m.size >= 16) m.delete(m.keys().next().value);
    m.set(key, v);
  }
  return v;
}

function intOpt(v, def, min, max, name) {
  if (v === undefined) return def;
  if (!Number.isInteger(v) || v < min || v > max) throw new SkinError('INVALID_OPTION', `${name} doit être un entier entre ${min} et ${max}`);
  return v;
}

/** Agrandit (ou réduit) au plus proche. */
export function resizeNearest(img, w, h) {
  if (img.width === w && img.height === h) return img.clone();
  const out = new RgbaImage(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w));
      const si = (sy * img.width + sx) * 4, di = (y * w + x) * 4;
      out.data[di] = img.data[si]; out.data[di + 1] = img.data[si + 1]; out.data[di + 2] = img.data[si + 2]; out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}

function needSkin(skin) {
  if (!(skin instanceof Skin)) throw new SkinError('INVALID_OPTION', 'utiliser loadSkin() avant de dessiner');
}

/**
 * Tête du joueur (face avant), avec ou sans la 2e couche (chapeau).
 * @param {Skin} skin
 * @param {{size?: number, hat?: boolean}} [opts] size en pixels (8 à 2048, défaut 64)
 * @returns {RgbaImage}
 */
export function renderHead(skin, opts = {}) {
  needSkin(skin);
  const size = intOpt(opts.size, 64, 8, MAX_OUT, 'size');
  const hat = opts.hat !== false;
  return cached(skin, `head:${size}:${hat}`, () => {
    const base = new RgbaImage(8, 8);
    blit(skin, 8, 8, 8, 8, base, 0, 0);
    if (hat) blit(skin, 40, 8, 8, 8, base, 0, 0, 1, { mode: 'over' });
    return resizeNearest(base, size, size);
  }).clone();
}

function layerFlags(layers) {
  if (layers === undefined || layers === true) return { hat: true, jacket: true, sleeves: true, pants: true };
  if (layers === false) return { hat: false, jacket: false, sleeves: false, pants: false };
  if (typeof layers !== 'object' || layers === null) throw new SkinError('INVALID_OPTION', 'layers');
  return { hat: layers.hat !== false, jacket: layers.jacket !== false, sleeves: layers.sleeves !== false, pants: layers.pants !== false };
}

/**
 * Vue fixe de face. Le bras droit du joueur est à gauche de l'image (comme en vrai).
 * @param {Skin} skin
 * @param {{scale?: number, layers?: boolean|{hat?:boolean,jacket?:boolean,sleeves?:boolean,pants?:boolean}, view?: 'full'|'bust'}} [opts]
 *   scale : pixels par pixel du skin (1 à 64, défaut 8 → 128×256 pour le corps entier) ;
 *   view 'bust' : tête et haut du corps seulement (16×16 avant agrandissement).
 * @returns {RgbaImage}
 */
export function renderFront(skin, opts = {}) {
  needSkin(skin);
  const scale = intOpt(opts.scale, 8, 1, 64, 'scale');
  const view = opts.view ?? 'full';
  if (view !== 'full' && view !== 'bust') throw new SkinError('INVALID_OPTION', 'view doit être "full" ou "bust"');
  const L = layerFlags(opts.layers);
  const key = `front:${scale}:${view}:${L.hat}${L.jacket}${L.sleeves}${L.pants}`;
  return cached(skin, key, () => {
    const slim = skin.model === 'slim';
    const aw = slim ? 3 : 4;
    const img = new RgbaImage(16, 32);
    const part = (sx, sy, w, h, dx, dy, over) => blit(skin, sx, sy, w, h, img, dx, dy, 1, over ? { mode: 'over' } : undefined);
    // Base
    part(8, 8, 8, 8, 4, 0); // tête
    part(20, 20, 8, 12, 4, 8); // corps
    part(44, 20, aw, 12, 4 - aw, 8); // bras droit
    part(36, 52, aw, 12, 12, 8); // bras gauche
    part(4, 20, 4, 12, 4, 20); // jambe droite
    part(20, 52, 4, 12, 8, 20); // jambe gauche
    // 2e couche
    if (L.pants) { part(4, 36, 4, 12, 4, 20, true); part(4, 52, 4, 12, 8, 20, true); }
    if (L.jacket) part(20, 36, 8, 12, 4, 8, true);
    if (L.sleeves) { part(44, 36, aw, 12, 4 - aw, 8, true); part(52, 52, aw, 12, 12, 8, true); }
    if (L.hat) part(40, 8, 8, 8, 4, 0, true);
    let out = img;
    if (view === 'bust') {
      out = new RgbaImage(16, 16);
      blit(img, 0, 0, 16, 16, out, 0, 0);
    }
    return resizeNearest(out, out.width * scale, out.height * scale);
  }).clone();
}

/**
 * Face extérieure de la cape (celle qu'on voit dans le dos du joueur).
 * @param {Cape} cape
 * @param {{scale?: number}} [opts] défaut 8 → 80×128
 */
export function renderCape(cape, opts = {}) {
  if (!(cape instanceof Cape)) throw new SkinError('INVALID_OPTION', 'utiliser loadCape() avant de dessiner');
  const scale = intOpt(opts.scale, 8, 1, 64, 'scale');
  return cached(cape, `cape:${scale}`, () => {
    const img = new RgbaImage(10, 16);
    blit(cape, 1, 1, 10, 16, img, 0, 0);
    return resizeNearest(img, 10 * scale, 16 * scale);
  }).clone();
}
