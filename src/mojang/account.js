/**
 * Écriture sur SON PROPRE compte (dans le launcher) : voir ses skins et capes,
 * changer de skin, revenir au skin par défaut, choisir ou cacher une cape.
 *
 * Le jeton Minecraft (accessToken) est fourni par l'appelant à chaque appel :
 * la bibliothèque ne le stocke jamais, ne l'écrit dans aucun journal ni aucune
 * erreur, et ne l'envoie qu'à api.minecraftservices.com.
 * La bibliothèque ne fait pas la connexion Microsoft : c'est le launcher qui
 * l'a déjà faite, avec son propre client ID.
 */

import { SkinError, toSkinError } from '../errors.js';
import { request, commonStatusError, parseJson } from './net.js';
import { textureFromUrl, dashUuid } from './client.js';
import { loadSkin, checkModel, Skin } from '../core/skin.js';
import { encodePng } from '../png/png.js';

const API = 'https://api.minecraftservices.com/minecraft/profile';
const CAPE_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

function checkToken(token) {
  if (typeof token !== 'string' || token.length < 8 || token.length > 16384 || /[\s\0]/.test(token)) {
    throw new SkinError('AUTH_REQUIRED');
  }
  return token;
}

function authHeaders(token, extra) {
  return { authorization: `Bearer ${checkToken(token)}`, accept: 'application/json', ...(extra || {}) };
}

/** Met en forme le profil renvoyé par Mojang. */
export function normalizeAccountProfile(j) {
  if (!j || typeof j.id !== 'string' || !/^[0-9a-f]{32}$/i.test(j.id) || typeof j.name !== 'string') {
    throw new SkinError('MOJANG_UNAVAILABLE', 'profil illisible');
  }
  const skins = (Array.isArray(j.skins) ? j.skins : []).map((s) => {
    const t = s && textureFromUrl(s.url);
    if (!t) return null;
    return {
      id: String(s.id || ''),
      active: s.state === 'ACTIVE',
      url: t.url,
      hash: t.hash,
      model: String(s.variant || '').toUpperCase() === 'SLIM' ? 'slim' : 'classic',
    };
  }).filter(Boolean);
  const capes = (Array.isArray(j.capes) ? j.capes : []).map((c) => {
    const t = c && textureFromUrl(c.url);
    if (!t || typeof c.id !== 'string') return null;
    return { id: c.id, active: c.state === 'ACTIVE', url: t.url, hash: t.hash, alias: typeof c.alias === 'string' ? c.alias : '' };
  }).filter(Boolean);
  const id = j.id.toLowerCase();
  return {
    id,
    uuid: dashUuid(id),
    name: j.name,
    skins,
    capes,
    activeSkin: skins.find((s) => s.active) || null,
    activeCape: capes.find((c) => c.active) || null,
  };
}

async function errorFromAccount(r, kind) {
  const common = commonStatusError(r);
  if (common) return common;
  if (r.status === 401) return new SkinError('AUTH_REQUIRED', undefined, { status: 401 });
  if (r.status === 403) return new SkinError('AUTH_REQUIRED', 'jeton refusé', { status: 403 });
  if (r.status === 404 && kind === 'profile') return new SkinError('NO_MINECRAFT', undefined, { status: 404 });
  if ((r.status === 400 || r.status === 404) && kind === 'cape') return new SkinError('CAPE_NOT_OWNED', undefined, { status: r.status });
  if (r.status === 400 && kind === 'skin') return new SkinError('SKIN_INVALID_FORMAT', 'refusé par Mojang', { status: 400 });
  return new SkinError('MOJANG_REJECTED', String(r.status), { status: r.status });
}

function afterChange(opts, profile) {
  // Le skin a changé : on oublie le profil public gardé en cache.
  try { opts.client?.cache?.delete?.(`profile:${profile.id}`); } catch { /* rien */ }
  return profile;
}

async function call(token, method, url, kind, { headers, body, signal, fetch, timeout } = {}) {
  const r = await request(url, { method, headers: authHeaders(token, headers), body, signal, fetch, timeout });
  if (r.status !== 200) throw await errorFromAccount(r, kind);
  return normalizeAccountProfile(parseJson(r));
}

/**
 * Mes skins et capes possédées.
 * @param {string} token jeton Minecraft du joueur
 * @param {{signal?: AbortSignal, fetch?: typeof fetch}} [opts]
 */
export async function getProfile(token, opts = {}) {
  try {
    return await call(token, 'GET', API, 'profile', opts);
  } catch (err) { throw toSkinError(err); }
}

/**
 * Change mon skin. Le fichier est vérifié puis redessiné (aucune métadonnée envoyée).
 * @param {string} token
 * @param {Uint8Array|ArrayBuffer|Blob|Skin} skin fichier PNG 64×64 ou 64×32
 * @param {{model?: 'classic'|'slim', signal?: AbortSignal, client?: object}} [opts]
 *   model : bras épais (classic) ou fins (slim). Par défaut, deviné d'après l'image.
 */
export async function setSkin(token, skin, opts = {}) {
  try {
    checkToken(token);
    const s = skin instanceof Skin ? skin : await loadSkin(skin);
    const model = opts.model ? checkModel(opts.model) : s.model;
    const png = await encodePng(s.source);
    const form = new FormData();
    form.append('variant', model);
    form.append('file', new Blob([png], { type: 'image/png' }), 'skin.png');
    const p = await call(token, 'POST', `${API}/skins`, 'skin', { ...opts, body: form });
    return afterChange(opts, p);
  } catch (err) { throw toSkinError(err); }
}

/** Revient au skin par défaut. */
export async function resetSkin(token, opts = {}) {
  try {
    return afterChange(opts, await call(token, 'DELETE', `${API}/skins/active`, 'skin', opts));
  } catch (err) { throw toSkinError(err); }
}

/**
 * Porte une cape que je possède.
 * @param {string} token
 * @param {string} capeId identifiant de la cape (voir getProfile().capes)
 */
export async function setCape(token, capeId, opts = {}) {
  try {
    checkToken(token);
    if (typeof capeId !== 'string' || !CAPE_ID_RE.test(capeId)) throw new SkinError('CAPE_NOT_OWNED', 'identifiant invalide');
    const mine = await getProfile(token, opts);
    if (!mine.capes.some((c) => c.id === capeId)) throw new SkinError('CAPE_NOT_OWNED');
    const p = await call(token, 'PUT', `${API}/capes/active`, 'cape', {
      ...opts,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capeId }),
    });
    return afterChange(opts, p);
  } catch (err) { throw toSkinError(err); }
}

/** Cache ma cape (n'en porte aucune). */
export async function hideCape(token, opts = {}) {
  try {
    return afterChange(opts, await call(token, 'DELETE', `${API}/capes/active`, 'cape', opts));
  } catch (err) { throw toSkinError(err); }
}

export const account = Object.freeze({ getProfile, setSkin, resetSkin, setCape, hideCape });
