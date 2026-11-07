/**
 * Partie réservée à Node / Electron (processus principal) :
 * - un cache sur le disque du PC (images pour toujours, profils ~10 min) ;
 * - la garde-robe locale : les skins que le joueur choisit lui-même de ranger.
 * Toutes les écritures passent par un fichier .part puis un renommage.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { SkinError, toSkinError } from '../errors.js';
import { isPng, encodePng } from '../png/png.js';
import { loadSkin, checkModel } from '../core/skin.js';

const MAX_FILE = 1024 * 1024;

async function atomicWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
  try {
    await fs.writeFile(part, data);
    for (let i = 0; ; i++) {
      try { await fs.rename(part, file); break; } catch (err) {
        // Windows : un antivirus peut bloquer un court instant.
        if (i < 4 && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) { await new Promise((r) => setTimeout(r, 50 * (i + 1))); continue; }
        throw err;
      }
    }
  } catch (err) {
    await fs.rm(part, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Lit un petit fichier normal (pas un lien symbolique). Absent → undefined.
 * strict : les autres erreurs (fichier verrouillé, droits…) sont relancées au lieu d'être prises pour « vide ».
 */
async function readSmall(file, { strict = false } = {}) {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > MAX_FILE) {
      if (strict) throw new SkinError('STORAGE_FAILED', 'fichier inattendu');
      return undefined;
    }
    return await fs.readFile(file);
  } catch (err) {
    if (!strict || (err && err.code === 'ENOENT')) return undefined;
    throw err;
  }
}

const MAX_DATA_TTL = 30 * 24 * 3600 * 1000;

function checkDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new SkinError('INVALID_OPTION', 'dossier');
  return path.resolve(dir);
}

/**
 * Cache sur disque, utilisable comme option `cache` de createClient().
 * @param {string} dir dossier du cache (ex. <dossier du launcher>/cache/skins)
 */
export function createFileCache(dir) {
  const root = checkDir(dir);
  const texFile = (hash) => path.join(root, 'textures', `${hash}.png`);
  const dataFile = (key) => path.join(root, 'data', `${crypto.createHash('sha256').update(key).digest('hex')}.json`);
  const texKey = (key) => {
    const m = /^texture:([0-9a-f]{16,128})$/.exec(key);
    return m ? m[1] : null;
  };
  const api = {
    async get(key) {
      const h = texKey(key);
      if (h) {
        const b = await readSmall(texFile(h));
        return b && isPng(b) ? new Uint8Array(b) : undefined;
      }
      const b = await readSmall(dataFile(key));
      if (!b) return undefined;
      try {
        const e = JSON.parse(b.toString('utf8'));
        if (!e || e.key !== key || typeof e.exp !== 'number' || e.exp > Date.now() + MAX_DATA_TTL) return undefined;
        if (e.exp <= Date.now()) {
          await fs.rm(dataFile(key), { force: true }).catch(() => {}); // périmé : effacé (aucun historique gardé)
          return undefined;
        }
        return e.value;
      } catch {
        return undefined; // fichier abîmé : on refait la demande
      }
    },
    async set(key, value, ttlMs = Infinity) {
      const h = texKey(key);
      if (h) {
        if (!(value instanceof Uint8Array) || !isPng(value)) return;
        return atomicWrite(texFile(h), value);
      }
      const exp = Date.now() + Math.min(ttlMs, MAX_DATA_TTL);
      return atomicWrite(dataFile(key), JSON.stringify({ key, exp, value }));
    },
    async delete(key) {
      const h = texKey(key);
      await fs.rm(h ? texFile(h) : dataFile(key), { force: true });
    },
    /** Efface les données périmées (profils des autres joueurs, etc.). */
    async prune() {
      const dir = path.join(root, 'data');
      let names = [];
      try { names = await fs.readdir(dir); } catch { return 0; }
      let n = 0;
      for (const f of names) {
        const full = path.join(dir, f);
        let drop = !/^[0-9a-f]{64}\.json$/.test(f);
        if (!drop) {
          const b = await readSmall(full);
          try { const e = JSON.parse(b.toString('utf8')); drop = !(typeof e.exp === 'number' && e.exp > Date.now() && e.exp <= Date.now() + MAX_DATA_TTL); } catch { drop = true; }
        }
        if (drop) { await fs.rm(full, { force: true }).catch(() => {}); n++; }
      }
      return n;
    },
    async clear() {
      await fs.rm(path.join(root, 'textures'), { recursive: true, force: true });
      await fs.rm(path.join(root, 'data'), { recursive: true, force: true });
    },
  };
  // Au démarrage, on efface les données périmées (en arrière-plan, sans jamais bloquer).
  const t = setTimeout(() => { api.prune().catch(() => {}); }, 0);
  if (t.unref) t.unref();
  return api;
}

const ID_RE = /^[0-9a-f]{16}$/;
const queues = new Map();
const MAX_ITEMS = 500;

function cleanName(name) {
  if (name === undefined) return 'Skin';
  if (typeof name !== 'string') throw new SkinError('INVALID_OPTION', 'nom');
  // eslint-disable-next-line no-control-regex
  const s = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return s || 'Skin';
}

/**
 * Garde-robe locale : les skins du joueur rangés dans le launcher (sur son PC seulement).
 * @param {string} dir dossier de la garde-robe
 */
export function createWardrobe(dir) {
  const root = checkDir(dir);
  const indexFile = path.join(root, 'index.json');
  const pngFile = (id) => path.join(root, `${id}.png`);
  // Une seule file d'attente par dossier, même avec plusieurs createWardrobe() sur le même dossier.
  const serial = (fn) => {
    const prev = queues.get(root) || Promise.resolve();
    const p = prev.then(fn);
    const tail = p.catch(() => {});
    queues.set(root, tail);
    tail.then(() => { if (queues.get(root) === tail) queues.delete(root); });
    return p.catch((err) => { throw toSkinError(err); });
  };

  async function readIndex() {
    // Un fichier verrouillé un instant (antivirus…) ne doit jamais être pris pour une garde-robe vide.
    const b = await readSmall(indexFile, { strict: true });
    if (!b) return [];
    try {
      const j = JSON.parse(b.toString('utf8'));
      return Array.isArray(j) ? j.filter((e) => e && ID_RE.test(e.id) && (e.model === 'classic' || e.model === 'slim')).map((e) => ({
        id: e.id, name: cleanName(e.name), model: e.model, addedAt: typeof e.addedAt === 'string' ? e.addedAt : '',
      })) : [];
    } catch {
      // Index illisible : on le met de côté au lieu de l'écraser.
      await fs.rename(indexFile, `${indexFile}.abime-${Date.now()}`).catch(() => {});
      return [];
    }
  }
  const writeIndex = (items) => atomicWrite(indexFile, JSON.stringify(items, null, 2));

  function need(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new SkinError('INVALID_OPTION', 'identifiant');
    return id;
  }

  async function readEntry(id) {
    need(id);
    const entry = (await readIndex()).find((e) => e.id === id);
    if (!entry) throw new SkinError('INVALID_OPTION', 'skin absent');
    const b = await readSmall(pngFile(id));
    if (!b || !isPng(b)) throw new SkinError('STORAGE_FAILED', 'fichier absent ou abîmé');
    return { entry, bytes: new Uint8Array(b) };
  }

  return {
    /** Liste des skins rangés. */
    list: () => serial(readIndex),

    /**
     * Range un skin (vérifié puis redessiné, sans métadonnées).
     * @param {Uint8Array|ArrayBuffer|Blob} input fichier PNG
     * @param {{name?: string, model?: 'classic'|'slim'}} [opts]
     */
    add: (input, opts = {}) => serial(async () => {
      const name = cleanName(opts.name);
      const skin = await loadSkin(input, { model: opts.model ? checkModel(opts.model) : undefined });
      const items = await readIndex();
      if (items.length >= MAX_ITEMS) throw new SkinError('INVALID_OPTION', `garde-robe pleine (${MAX_ITEMS})`);
      const id = crypto.randomBytes(8).toString('hex');
      await atomicWrite(pngFile(id), await encodePng(skin.source));
      const entry = { id, name, model: skin.model, addedAt: new Date().toISOString() };
      items.push(entry);
      try { await writeIndex(items); } catch (err) { await fs.rm(pngFile(id), { force: true }); throw err; }
      return entry;
    }),

    /** Octets PNG d'un skin rangé. */
    getBytes: (id) => serial(async () => (await readEntry(id)).bytes),

    /** Skin rangé, prêt à afficher. */
    get: (id) => serial(async () => {
      const { entry, bytes } = await readEntry(id);
      return loadSkin(bytes, { model: entry.model });
    }),

    rename: (id, name) => serial(async () => {
      need(id);
      const items = await readIndex();
      const e = items.find((x) => x.id === id);
      if (!e) throw new SkinError('INVALID_OPTION', 'skin absent');
      e.name = cleanName(name);
      await writeIndex(items);
      return { ...e };
    }),

    remove: (id) => serial(async () => {
      need(id);
      const items = await readIndex();
      const left = items.filter((x) => x.id !== id);
      if (left.length === items.length) return false;
      await writeIndex(left);
      await fs.rm(pngFile(id), { force: true });
      return true;
    }),
  };
}
