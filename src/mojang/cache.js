/**
 * Cache en mémoire (fonctionne partout). Interface commune à tous les caches :
 *   get(key) → valeur ou undefined (peut être une promesse)
 *   set(key, value, ttlMs) → ttlMs = Infinity pour « pour toujours »
 *   delete(key), clear()
 * Les images de textures.minecraft.net ne changent jamais pour un même lien :
 * gardées pour toujours. Les profils : environ 10 minutes.
 */

export const PROFILE_TTL = 10 * 60 * 1000;
export const NAME_TTL = 10 * 60 * 1000;
export const NOT_FOUND_TTL = 60 * 1000;
// « Pour toujours » = un an (un nombre fini : certains caches Redis/KV refusent Infinity).
export const TEXTURE_TTL = 365 * 24 * 3600 * 1000;

export function createMemoryCache({ maxEntries = 2000 } = {}) {
  const map = new Map();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (e.exp <= Date.now()) { map.delete(key); return undefined; }
      map.delete(key); map.set(key, e); // le plus récent à la fin
      return e.value;
    },
    set(key, value, ttlMs = Infinity) {
      map.delete(key);
      map.set(key, { value, exp: ttlMs === Infinity ? Infinity : Date.now() + ttlMs });
      while (map.size > maxEntries) map.delete(map.keys().next().value);
    },
    delete(key) { map.delete(key); },
    clear() { map.clear(); },
    get size() { return map.size; },
  };
}

/** Pas de cache du tout. */
export function createNoCache() {
  return { get() { return undefined; }, set() {}, delete() {}, clear() {} };
}

/**
 * En-têtes HTTP de cache conseillés pour une route du site qui renvoie
 * une texture (pour toujours) ou un profil (10 minutes), à mettre derrière
 * le cache de Cloudflare ou Vercel.
 * @param {'texture'|'profile'|'render'} kind
 */
export function cacheHeaders(kind) {
  if (kind === 'texture' || kind === 'render-by-hash') return { 'cache-control': 'public, max-age=31536000, immutable' };
  if (kind === 'profile' || kind === 'render') return { 'cache-control': 'public, max-age=600, s-maxage=600' };
  return { 'cache-control': 'no-store' };
}
