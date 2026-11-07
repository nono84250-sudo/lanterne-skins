/**
 * Lecture publique Mojang : pseudo → UUID, UUID → skin, bras, cape, et
 * téléchargement des images depuis textures.minecraft.net. Tout passe par ce
 * fichier et net.js : si Mojang change son API, c'est le seul endroit à corriger.
 */

import { SkinError, toSkinError } from '../errors.js';
import { request, commonStatusError, parseJson, createRateLimiter } from './net.js';
import { createMemoryCache, PROFILE_TTL, NAME_TTL, NOT_FOUND_TTL, TEXTURE_TTL } from './cache.js';
import { fromBase64 } from '../core/image.js';
import { isPng, readHeader } from '../png/png.js';
import { loadSkin, loadCape, DEFAULT_MAX_BYTES, checkModel, trustHash, decodeChecked } from '../core/skin.js';
import { encodePng } from '../png/png.js';
import { defaultSkinFor } from './defaults.js';

const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
// Pseudos renvoyés par Mojang : quelques très vieux comptes dépassent 16 caractères.
const PROFILE_NAME_RE = /^[A-Za-z0-9_]{1,25}$/;
const UUID_RE = /^[0-9a-f]{32}$/i;
const UUID_DASHED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-fA-F]{16,128}$/;
// Marque « joueur introuvable » dans le cache (null/undefined = pas dans le cache, comme Redis/KV).
const NOT_FOUND = Object.freeze({ notFound: true });
const isNotFound = (v) => !!v && typeof v === 'object' && v.notFound === true && Object.keys(v).length === 1;

export function dashUuid(id) {
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** 'Notch', '069a79f4…' ou '069a79f4-44e9-…' → { kind, value }. */
export function parsePlayerQuery(q) {
  if (typeof q !== 'string') throw new SkinError('INVALID_NAME');
  const s = q.trim();
  if (UUID_DASHED_RE.test(s)) return { kind: 'uuid', value: s.replace(/-/g, '').toLowerCase() };
  if (UUID_RE.test(s)) return { kind: 'uuid', value: s.toLowerCase() };
  if (NAME_RE.test(s)) return { kind: 'name', value: s };
  throw new SkinError('INVALID_NAME');
}

/** Ne garde qu'un lien officiel textures.minecraft.net/texture/<empreinte>, passé en https. */
export function textureFromUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.hostname.toLowerCase() !== 'textures.minecraft.net' || u.port || u.username || u.password || u.search || u.hash) return null;
  const m = /^\/texture\/([0-9a-fA-F]{16,128})$/.exec(u.pathname);
  if (!m) return null;
  const hash = m[1].toLowerCase();
  return { hash, url: `https://textures.minecraft.net/texture/${hash}` };
}

export function textureUrl(hashOrUrl) {
  if (typeof hashOrUrl === 'string' && HASH_RE.test(hashOrUrl)) {
    const h = hashOrUrl.toLowerCase();
    return { hash: h, url: `https://textures.minecraft.net/texture/${h}` };
  }
  const t = textureFromUrl(hashOrUrl);
  if (!t) throw new SkinError('HOST_NOT_ALLOWED', 'texture non officielle');
  return t;
}

/** Lit le champ « textures » (base64) d'un profil de sessionserver. */
export function parseProfile(json) {
  if (!json || typeof json.id !== 'string' || !UUID_RE.test(json.id) || typeof json.name !== 'string' || !PROFILE_NAME_RE.test(json.name)) {
    throw new SkinError('MOJANG_UNAVAILABLE', 'profil illisible');
  }
  const id = json.id.toLowerCase();
  let skin = null;
  let cape = null;
  const prop = Array.isArray(json.properties) ? json.properties.find((p) => p && p.name === 'textures') : null;
  if (prop && typeof prop.value === 'string' && prop.value.length < 64 * 1024) {
    let tex = null;
    try { tex = JSON.parse(new TextDecoder().decode(fromBase64(prop.value))).textures; } catch { tex = null; }
    if (tex && typeof tex === 'object') {
      const s = tex.SKIN && textureFromUrl(tex.SKIN.url);
      if (s) skin = { ...s, model: tex.SKIN.metadata && tex.SKIN.metadata.model === 'slim' ? 'slim' : 'classic' };
      const c = tex.CAPE && textureFromUrl(tex.CAPE.url);
      if (c) cape = c;
    }
  }
  const isDefaultSkin = !skin;
  if (!skin) skin = defaultSkinFor(id);
  return { id, uuid: dashUuid(id), name: json.name, skin, cape, isDefaultSkin };
}

/** Revérifie un profil lu dans le cache (un cache peut avoir été modifié par quelqu'un d'autre). */
export function validCachedProfile(p, id) {
  if (!p || typeof p !== 'object' || p.id !== id || typeof p.name !== 'string' || !PROFILE_NAME_RE.test(p.name)) return null;
  const s = p.skin && textureFromUrl(p.skin.url);
  if (!s || s.hash !== p.skin.hash || (p.skin.model !== 'classic' && p.skin.model !== 'slim')) return null;
  let cape = null;
  if (p.cape) {
    cape = textureFromUrl(p.cape.url);
    if (!cape || cape.hash !== p.cape.hash) return null;
  }
  const skin = { url: s.url, hash: s.hash, model: p.skin.model };
  if (typeof p.skin.defaultName === 'string' && /^[a-z]{1,16}$/.test(p.skin.defaultName)) skin.defaultName = p.skin.defaultName;
  return { id, uuid: dashUuid(id), name: p.name, skin, cape, isDefaultSkin: p.isDefaultSkin === true };
}

/** Accepte seulement une image PNG de taille Minecraft (skin 64×64/64×32, cape 64×32). */
function checkTextureBytes(b) {
  if (!(b instanceof Uint8Array) || !isPng(b)) return false;
  try {
    const h = readHeader(b);
    return h.width === 64 && (h.height === 64 || h.height === 32);
  } catch { return false; }
}

/** Décode complètement puis réécrit l'image (PNG propre, sans rien d'autre que les pixels). */
async function cleanTexture(b) {
  const img = await decodeChecked(b, [[64, 64], [64, 32]], 'skin');
  return encodePng(img);
}

/** Attend une promesse partagée, mais abandonne (pour cet appelant seulement) si son signal est annulé. */
function withSignal(p, signal) {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new SkinError('CANCELLED'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new SkinError('CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/**
 * Crée un client Mojang (avec son propre cache et sa limite de requêtes).
 * @param {{cache?: object, fetch?: typeof fetch, timeout?: number,
 *   rateLimit?: {max:number, windowMs:number}|false, profileTtl?: number}} [opts]
 */
export function createClient(opts = {}) {
  const cache = opts.cache || createMemoryCache();
  const profileTtl = opts.profileTtl ?? PROFILE_TTL;
  const limiter = opts.rateLimit === false ? null : createRateLimiter(opts.rateLimit?.max ?? 300, opts.rateLimit?.windowMs ?? 10_000);
  const base = { fetch: opts.fetch, timeout: opts.timeout, limiter };
  const inflight = new Map();

  // Demandes identiques simultanées regroupées. La requête partagée n'utilise le signal
  // de personne (seulement le délai max) ; chaque appelant peut abandonner de son côté.
  function once(key, fn, signal) {
    let p = inflight.get(key);
    if (!p) {
      p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
      p.catch(() => {});
      inflight.set(key, p);
    }
    return withSignal(p, signal);
  }

  async function cacheGet(key) {
    try { return await cache.get(key); } catch { return undefined; } // un cache abîmé ne bloque jamais
  }
  async function cacheSet(key, v, ttl) {
    try { await cache.set(key, v, ttl); } catch { /* disque plein, etc. : on continue sans cache */ }
  }

  async function nameToId(name, signal) {
    const key = `name:${name.toLowerCase()}`;
    const hit = await cacheGet(key);
    if (isNotFound(hit)) throw new SkinError('PLAYER_NOT_FOUND');
    if (typeof hit === 'string' && UUID_RE.test(hit)) return hit.toLowerCase();
    if (signal && signal.aborted) throw new SkinError('CANCELLED');
    return once(key, async () => {
      const r = await request(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, base);
      const e = commonStatusError(r);
      if (e) throw e;
      if (r.status === 204 || r.status === 404) {
        await cacheSet(key, NOT_FOUND, NOT_FOUND_TTL);
        throw new SkinError('PLAYER_NOT_FOUND');
      }
      if (r.status === 400) throw new SkinError('INVALID_NAME');
      if (r.status !== 200) throw new SkinError('MOJANG_REJECTED', String(r.status), { status: r.status });
      const j = parseJson(r);
      if (!j || typeof j.id !== 'string' || !UUID_RE.test(j.id)) throw new SkinError('MOJANG_UNAVAILABLE', 'réponse illisible');
      const id = j.id.toLowerCase();
      await cacheSet(key, id, NAME_TTL);
      return id;
    }, signal);
  }

  async function profile(id, signal) {
    const key = `profile:${id}`;
    const hit = await cacheGet(key);
    if (isNotFound(hit)) throw new SkinError('PLAYER_NOT_FOUND');
    const valid = hit && validCachedProfile(hit, id);
    if (valid) return valid;
    if (signal && signal.aborted) throw new SkinError('CANCELLED');
    return once(key, async () => {
      const r = await request(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`, base);
      const e = commonStatusError(r);
      if (e) throw e;
      if (r.status === 204 || r.status === 404) {
        await cacheSet(key, NOT_FOUND, NOT_FOUND_TTL);
        throw new SkinError('PLAYER_NOT_FOUND');
      }
      if (r.status === 400) throw new SkinError('INVALID_NAME');
      if (r.status !== 200) throw new SkinError('MOJANG_REJECTED', String(r.status), { status: r.status });
      const p = parseProfile(parseJson(r));
      if (p.id !== id) throw new SkinError('MOJANG_UNAVAILABLE', 'profil inattendu');
      await cacheSet(key, p, profileTtl);
      return p;
    }, signal);
  }

  /**
   * Trouve un joueur par pseudo ou UUID.
   * @returns {Promise<{id:string, uuid:string, name:string,
   *   skin:{url:string, hash:string, model:'classic'|'slim', defaultName?:string},
   *   cape:{url:string, hash:string}|null, isDefaultSkin:boolean}>}
   */
  async function getPlayer(query, { signal } = {}) {
    try {
      const q = parsePlayerQuery(query);
      const id = q.kind === 'uuid' ? q.value : await nameToId(q.value, signal);
      return structuredCloneSafe(await profile(id, signal));
    } catch (err) {
      throw toSkinError(err);
    }
  }

  /** Octets PNG d'une image officielle (gardée pour toujours dans le cache). */
  async function getTexture(hashOrUrl, { signal } = {}) {
    try {
      const { hash, url } = textureUrl(hashOrUrl);
      const key = `texture:${hash}`;
      const hit = await cacheGet(key);
      if (checkTextureBytes(hit)) {
        const clean = await cleanTexture(hit).catch(() => null); // revérifiée même depuis le cache
        if (clean) return clean;
      }
      if (signal && signal.aborted) throw new SkinError('CANCELLED');
      const bytes = await once(key, async () => {
        const r = await request(url, { ...base, maxBytes: DEFAULT_MAX_BYTES });
        const e = commonStatusError(r);
        if (e) throw e;
        if (r.status === 404) throw new SkinError('MOJANG_REJECTED', 'texture introuvable', { status: 404 });
        if (r.status !== 200) throw new SkinError('MOJANG_REJECTED', String(r.status), { status: r.status });
        // Jamais de page d'erreur, de SVG ou d'autre chose gardé « pour toujours » : seulement un PNG Minecraft.
        if (!checkTextureBytes(r.bytes)) throw new SkinError('SKIN_INVALID_FORMAT', 'texture reçue invalide');
        const clean = await cleanTexture(r.bytes); // redessinée : seulement les pixels, aucune métadonnée
        await cacheSet(key, clean.slice(), TEXTURE_TTL);
        return clean;
      }, signal);
      return bytes.slice();
    } catch (err) {
      throw toSkinError(err);
    }
  }

  async function resolve(playerOrQuery, signal) {
    if (playerOrQuery && typeof playerOrQuery === 'object' && playerOrQuery.skin) return playerOrQuery;
    return getPlayer(playerOrQuery, { signal });
  }

  /** Skin prêt à afficher d'un joueur (pseudo, UUID ou résultat de getPlayer). */
  async function getSkin(playerOrQuery, { signal } = {}) {
    const p = await resolve(playerOrQuery, signal);
    const bytes = await getTexture(p.skin.hash, { signal });
    return trustHash(await loadSkin(bytes, { model: checkModel(p.skin.model), hash: p.skin.hash }), p.skin.hash);
  }

  /** Cape Mojang d'un joueur, ou null s'il n'en porte pas. */
  async function getCape(playerOrQuery, { signal } = {}) {
    const p = await resolve(playerOrQuery, signal);
    if (!p.cape) return null;
    let bytes;
    try {
      bytes = await getTexture(p.cape.hash, { signal });
    } catch (err) {
      if (err.code === 'SKIN_INVALID_FORMAT') throw new SkinError('CAPE_INVALID_FORMAT', err.detail);
      if (err.code === 'SKIN_INVALID_SIZE') throw new SkinError('CAPE_INVALID_SIZE', err.detail);
      throw err;
    }
    return trustHash(await loadCape(bytes, { hash: p.cape.hash }), p.cape.hash);
  }

  return { getPlayer, getTexture, getSkin, getCape, cache };
}

function structuredCloneSafe(p) {
  return { ...p, skin: { ...p.skin }, cape: p.cape ? { ...p.cape } : null };
}
