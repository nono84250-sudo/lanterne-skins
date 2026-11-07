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

async function readSmall(file) {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > MAX_FILE) return undefined;
    return await fs.readFile(file);
  } catch {
    return undefined;
  }
}

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
  return {
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
        if (!e || e.key !== key || typeof e.exp !== 'number' || e.exp <= Date.now()) return undefined;
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
      const exp = ttlMs === Infinity ? Number.MAX_SAFE_INTEGER : Date.now() + ttlMs;
      return atomicWrite(dataFile(key), JSON.stringify({ key, exp, value }));
    },
    async delete(key) {
      const h = texKey(key);
      await fs.rm(h ? texFile(h) : dataFile(key), { force: true });
    },
    async clear() {
      await fs.rm(path.join(root, 'textures'), { recursive: true, force: true });
      await fs.rm(path.join(root, 'data'), { recursive: true, force: true });
    },
  };
}

const ID_RE = /^[0-9a-f]{16}$/;
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
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p.catch((err) => { throw toSkinError(err); });
  };

  async function readIndex() {
    const b = await readSmall(indexFile);
    if (!b) return [];
    try {
      const j = JSON.parse(b.toString('utf8'));
      return Array.isArray(j) ? j.filter((e) => e && ID_RE.test(e.id) && (e.model === 'classic' || e.model === 'slim')).map((e) => ({
        id: e.id, name: cleanName(e.name), model: e.model, addedAt: typeof e.addedAt === 'string' ? e.addedAt : '',
      })) : [];
    } catch {
      return [];
    }
  }
  const writeIndex = (items) => atomicWrite(indexFile, JSON.stringify(items, null, 2));

  function need(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new SkinError('INVALID_OPTION', 'identifiant');
    return id;
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
    getBytes: (id) => serial(async () => {
      need(id);
      const items = await readIndex();
      if (!items.some((e) => e.id === id)) throw new SkinError('INVALID_OPTION', 'skin absent');
      const b = await readSmall(pngFile(id));
      if (!b) throw new SkinError('STORAGE_FAILED', 'fichier absent');
      return new Uint8Array(b);
    }),

    /** Skin rangé, prêt à afficher. */
    async get(id) {
      const items = await this.list();
      const e = items.find((x) => x.id === need(id));
      if (!e) throw new SkinError('INVALID_OPTION', 'skin absent');
      return loadSkin(await this.getBytes(id), { model: e.model });
    },

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
