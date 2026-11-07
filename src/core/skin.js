import { decodePng, readHeader, PngError } from '../png/png.js';
import { SkinError } from '../errors.js';
import { RgbaImage, blit } from './image.js';

export const DEFAULT_MAX_BYTES = 64 * 1024;

/**
 * Transforme ce que l'appelant donne (Uint8Array, Buffer, ArrayBuffer, Blob/File)
 * en octets, en refusant les fichiers trop gros AVANT de les lire en entier.
 */
export async function toBytes(input, maxBytes, kind) {
  const tooLarge = () => new SkinError('SKIN_TOO_LARGE', `plus de ${maxBytes} octets`);
  const badFormat = () => new SkinError(kind === 'cape' ? 'CAPE_INVALID_FORMAT' : 'SKIN_INVALID_FORMAT');
  if (input == null) throw badFormat();
  if (typeof Blob === 'function' && input instanceof Blob) {
    if (input.size > maxBytes) throw tooLarge();
    input = new Uint8Array(await input.arrayBuffer());
  }
  let bytes;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else throw badFormat(); // jamais de chemin, de texte, de SVG ou d'adresse : seulement des octets
  if (bytes.length > maxBytes) throw tooLarge();
  return bytes;
}

/** Décode un PNG en vérifiant ses dimensions avant la décompression. */
export async function decodeChecked(bytes, allowed, kind) {
  const fmt = kind === 'cape' ? 'CAPE_INVALID_FORMAT' : 'SKIN_INVALID_FORMAT';
  const size = kind === 'cape' ? 'CAPE_INVALID_SIZE' : 'SKIN_INVALID_SIZE';
  try {
    const img = await decodePng(bytes, {
      checkSize: (w, h) => {
        if (!allowed.some(([aw, ah]) => aw === w && ah === h)) throw new SkinError(size, `${w}×${h}`);
      },
    });
    return new RgbaImage(img.width, img.height, img.data);
  } catch (err) {
    if (err instanceof SkinError) throw err;
    if (err instanceof PngError) throw new SkinError(err.kind === 'SIZE' ? size : fmt, err.message);
    throw new SkinError(fmt, undefined, { cause: err });
  }
}

/** Lit juste les dimensions d'un PNG, sans le décoder. */
export function pngSize(bytes) {
  try {
    const h = readHeader(bytes);
    return { width: h.width, height: h.height };
  } catch {
    throw new SkinError('SKIN_INVALID_FORMAT');
  }
}

// Conversion 64×32 → 64×64 (la même que celle du jeu) : la jambe et le bras gauches
// sont créés en miroir de la jambe et du bras droits. [srcX, srcY, w, h, dstX, dstY]
const LEGACY_COPIES = [
  [4, 16, 4, 4, 20, 48], [8, 16, 4, 4, 24, 48], [8, 20, 4, 12, 16, 52], [4, 20, 4, 12, 20, 52], [0, 20, 4, 12, 24, 52], [12, 20, 4, 12, 28, 52],
  [44, 16, 4, 4, 36, 48], [48, 16, 4, 4, 40, 48], [48, 20, 4, 12, 32, 52], [44, 20, 4, 12, 36, 52], [40, 20, 4, 12, 40, 52], [52, 20, 4, 12, 44, 52],
];

/** Convertit un vieux skin 64×32 en 64×64. */
export function convertLegacy(img) {
  if (img.width === 64 && img.height === 64) return img.clone();
  if (img.width !== 64 || img.height !== 32) throw new SkinError('SKIN_INVALID_SIZE', `${img.width}×${img.height}`);
  const out = new RgbaImage(64, 64);
  blit(img, 0, 0, 64, 32, out, 0, 0);
  for (const [sx, sy, w, h, dx, dy] of LEGACY_COPIES) blit(img, sx, sy, w, h, out, dx, dy, 1, { mirror: true });
  return out;
}

function areaAll(img, x0, y0, x1, y1, pred) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!pred(img.data[(y * img.width + x) * 4 + 3])) return false;
  return true;
}

function setAlpha(img, x0, y0, x1, y1, a) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data[(y * img.width + x) * 4 + 3] = a;
}

/** Devine bras fins (« slim », Alex) ou épais (« classic », Steve) d'après les pixels. */
export function detectModel(img64) {
  // Sur un skin à bras fins, la dernière colonne du bras droit (x 54-55, y 20-31) est vide.
  return areaAll(img64, 54, 20, 56, 32, (a) => a === 0) ? 'slim' : 'classic';
}

/**
 * Prépare un skin comme le fait le jeu : 64×64, couche de base opaque, et pour les
 * vieux skins, chapeau entièrement opaque considéré comme absent.
 */
export function normalizeForGame(img64, legacy) {
  const out = img64.clone();
  if (legacy && areaAll(out, 32, 0, 64, 16, (a) => a >= 128)) setAlpha(out, 32, 0, 64, 16, 0);
  setAlpha(out, 0, 0, 32, 16, 255);
  setAlpha(out, 0, 16, 64, 32, 255);
  setAlpha(out, 16, 48, 48, 64, 255);
  return out;
}

/**
 * Skin prêt à afficher (64×64, comme dans le jeu).
 * - `model` : 'classic' (bras épais) ou 'slim' (bras fins)
 * - `legacy` : vrai si le fichier d'origine faisait 64×32
 * - `source` : les pixels d'origine convertis en 64×64, sans retouche (c'est ce qu'on envoie à Mojang)
 */
export class Skin extends RgbaImage {
  constructor(img, { model, legacy, source, hash }) {
    super(img.width, img.height, img.data);
    this.model = model;
    this.legacy = legacy;
    this.source = source;
    if (hash) this.hash = hash;
  }
}

/**
 * Vérifie et prépare un skin.
 * @param {Uint8Array|ArrayBuffer|Blob|Skin} input octets d'un fichier PNG
 * @param {{model?: 'classic'|'slim', maxBytes?: number, hash?: string}} [opts]
 * @returns {Promise<Skin>}
 */
export async function loadSkin(input, opts = {}) {
  if (input instanceof Skin) {
    if (opts.model && opts.model !== input.model) return new Skin(input, { ...input, model: checkModel(opts.model) });
    return input;
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const bytes = await toBytes(input, maxBytes, 'skin');
  const decoded = await decodeChecked(bytes, [[64, 64], [64, 32]], 'skin');
  const legacy = decoded.height === 32;
  const source = convertLegacy(decoded);
  const model = opts.model ? checkModel(opts.model) : legacy ? 'classic' : detectModel(source);
  return new Skin(normalizeForGame(source, legacy), { model, legacy, source, hash: opts.hash });
}

export function checkModel(m) {
  if (m === 'classic' || m === 'slim') return m;
  if (m === 'default' || m === 'wide' || m === 'steve') return 'classic';
  if (m === 'alex') return 'slim';
  throw new SkinError('INVALID_OPTION', 'model doit être "classic" ou "slim"');
}

/** Cape (64×32). Les capes Mojang ont toutes ce format. */
export class Cape extends RgbaImage {
  constructor(img, { hash } = {}) {
    super(img.width, img.height, img.data);
    if (hash) this.hash = hash;
  }
}

/**
 * Vérifie et prépare une cape.
 * @param {Uint8Array|ArrayBuffer|Blob|Cape} input
 * @param {{maxBytes?: number, hash?: string}} [opts]
 */
export async function loadCape(input, opts = {}) {
  if (input instanceof Cape) return input;
  const bytes = await toBytes(input, opts.maxBytes ?? DEFAULT_MAX_BYTES, 'cape');
  const img = await decodeChecked(bytes, [[64, 32]], 'cape');
  return new Cape(img, { hash: opts.hash });
}
