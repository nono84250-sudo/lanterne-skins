/**
 * Réseau sécurisé : seulement les adresses officielles Mojang/Microsoft (liste fixe),
 * https obligatoire, redirections revérifiées une par une, délai maximum,
 * taille de réponse plafonnée. Le jeton (en-tête Authorization) n'est jamais
 * recopié dans une erreur ni un journal, et n'est jamais envoyé après une redirection.
 */

import { SkinError } from '../errors.js';

export const ALLOWED_HOSTS = Object.freeze([
  'api.mojang.com',
  'sessionserver.mojang.com',
  'textures.minecraft.net',
  'api.minecraftservices.com',
]);

export const USER_AGENT = 'lanterne-skins/0.1';
const MAX_REDIRECTS = 3;


/** Vérifie qu'une adresse est https et officielle. @returns {URL} */
export function checkUrl(raw) {
  let url;
  try { url = raw instanceof URL ? raw : new URL(String(raw)); } catch { throw new SkinError('INSECURE_URL', 'adresse illisible'); }
  if (url.protocol !== 'https:') throw new SkinError('INSECURE_URL', url.protocol);
  if (url.username || url.password) throw new SkinError('INSECURE_URL', 'identifiants dans l’adresse');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.port !== '' || !ALLOWED_HOSTS.includes(host)) throw new SkinError('HOST_NOT_ALLOWED', url.host);
  return url;
}


/** Petit limiteur : au plus `max` requêtes par fenêtre de `windowMs`. */
export function createRateLimiter(max = 300, windowMs = 10_000) {
  if (!Number.isInteger(max) || max < 1) throw new SkinError('INVALID_OPTION', 'rateLimit.max');
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new SkinError('INVALID_OPTION', 'rateLimit.windowMs');
  const stamps = [];
  let chain = Promise.resolve();
  return function take(signal) {
    const p = chain.then(async () => {
      for (;;) {
        if (signal && signal.aborted) throw new SkinError('CANCELLED');
        const now = Date.now();
        while (stamps.length && now - stamps[0] >= windowMs) stamps.shift();
        if (stamps.length < max) { stamps.push(now); return; }
        await new Promise((resolve, reject) => {
          const onAbort = () => { clearTimeout(t); reject(new SkinError('CANCELLED')); };
          const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, windowMs - (now - stamps[0]) + 1);
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    });
    chain = p.catch(() => {});
    if (!signal) return p;
    // L'annulation compte tout de suite, même si on attend encore son tour dans la file.
    return new Promise((resolve, reject) => {
      if (signal.aborted) { p.catch(() => {}); return reject(new SkinError('CANCELLED')); }
      const onAbort = () => { p.catch(() => {}); reject(new SkinError('CANCELLED')); };
      signal.addEventListener('abort', onAbort, { once: true });
      p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
    });
  };
}

/**
 * Requête vers une adresse officielle.
 * @param {string|URL} rawUrl
 * @param {{method?: string, headers?: Record<string,string>, body?: any, maxBytes?: number,
 *   timeout?: number, signal?: AbortSignal, fetch?: typeof fetch, limiter?: Function}} [opts]
 * @returns {Promise<{status:number, headers:Headers, bytes:Uint8Array, url:string}>}
 */
export async function request(rawUrl, opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch;
  const timeout = opts.timeout ?? 15_000;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const method = opts.method || 'GET';
  const userSignal = opts.signal;
  let url = checkUrl(rawUrl);
  let headers = { ...(opts.headers || {}) };
  if (typeof window === 'undefined') headers['user-agent'] = USER_AGENT;
  let body = opts.body;
  if (opts.limiter) await opts.limiter(userSignal);

  for (let hop = 0; ; hop++) {
    if (userSignal && userSignal.aborted) throw new SkinError('CANCELLED');
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout);
    if (timer.unref) timer.unref();
    const onAbort = () => ctrl.abort();
    if (userSignal) userSignal.addEventListener('abort', onAbort, { once: true });
    try {
      let res;
      try {
        res = await doFetch(url, { method, headers, body, redirect: 'manual', signal: ctrl.signal });
      } catch (err) {
        throw netError(err, timedOut, userSignal, url);
      }
      let loc;
      try { loc = res.headers.get('location'); } catch (err) { throw netError(err, timedOut, userSignal, url); }
      if (res.status >= 300 && res.status < 400 && loc) {
        try { await res.body?.cancel(); } catch { /* rien */ }
        if (hop >= MAX_REDIRECTS) throw new SkinError('MOJANG_UNAVAILABLE', 'trop de redirections');
        let next;
        try { next = new URL(loc, url); } catch { throw new SkinError('INSECURE_URL', 'redirection illisible'); }
        url = checkUrl(next); // https + site officiel, même après redirection
        // Jamais de jeton ni de corps renvoyés après une redirection.
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'authorization'));
        if (method !== 'GET') throw new SkinError('MOJANG_UNAVAILABLE', 'redirection inattendue');
        body = undefined;
        continue;
      }
      if (res.type === 'opaqueredirect' || res.status === 0) throw new SkinError('MOJANG_UNAVAILABLE', 'redirection');
      // Un fetch fourni par l'appelant qui suivrait lui-même les redirections : refusé.
      if (res.redirected === true) throw new SkinError('MOJANG_UNAVAILABLE', 'redirection suivie par fetch');
      if (res.url) {
        let same = false;
        try { same = new URL(res.url).href === url.href; } catch { same = false; }
        if (!same) { try { checkUrl(res.url); } catch (err) { throw err; } }
      }
      const bytes = await readCapped(res, maxBytes, () => timedOut, userSignal, url);
      return { status: res.status, headers: res.headers, bytes, url: url.href };
    } finally {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener('abort', onAbort);
    }
  }
}

function netError(err, timedOut, userSignal, url) {
  if (err instanceof SkinError) return err;
  if (userSignal && userSignal.aborted) return new SkinError('CANCELLED');
  if (timedOut) return new SkinError('MOJANG_UNAVAILABLE', `délai dépassé ${url.host}`);
  const raw = (err && err.cause && err.cause.code) || (err && err.code);
  const code = typeof raw === 'string' && /^[A-Z0-9_]{1,40}$/.test(raw) ? raw : 'réseau'; // jamais de texte libre
  return new SkinError('MOJANG_UNAVAILABLE', `${code} ${url.host}`);
}

async function readCapped(res, maxBytes, isTimedOut, userSignal, url) {
  const len = Number(res.headers.get('content-length'));
  if (len && len > maxBytes) {
    try { await res.body?.cancel(); } catch { /* rien */ }
    throw new SkinError('MOJANG_REJECTED', `réponse trop grosse ${url.host}`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new SkinError('MOJANG_REJECTED', `réponse trop grosse ${url.host}`);
      parts.push(value);
    }
  } catch (err) {
    try { await reader.cancel(); } catch { /* rien */ }
    throw netError(err, isTimedOut(), userSignal, url);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Erreurs communes à toutes les réponses Mojang. */
export function commonStatusError(r) {
  if (r.status === 429) {
    const ra = Number(r.headers.get('retry-after'));
    return new SkinError('RATE_LIMITED', undefined, { status: 429, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 60 });
  }
  if (r.status >= 500) return new SkinError('MOJANG_UNAVAILABLE', `${r.status}`, { status: r.status });
  return null;
}

export function parseJson(r) {
  try {
    return JSON.parse(new TextDecoder().decode(r.bytes));
  } catch {
    throw new SkinError('MOJANG_UNAVAILABLE', 'réponse illisible', { status: r.status });
  }
}
