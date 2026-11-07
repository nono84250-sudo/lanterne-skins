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
import { loadSkin, checkModel, DEFAULT_MAX_BYTES } from '../core/skin.js';
import { constants as FS } from 'node:fs';

const MAX_FILE = 1024 * 1024;

/** Le dossier doit être un vrai dossier (pas un lien symbolique vers ailleurs). Créé s'il manque. */
async function realDir(dir) {
  try {
    const st = await fs.lstat(dir);
    if (!st.isDirectory()) throw new SkinError('STORAGE_FAILED', 'dossier inattendu (lien ?)');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
    await fs.mkdir(dir, { recursive: true });
  }
}

async function atomicWrite(file, data, { checkDir = true } = {}) {
  if (checkDir) await realDir(path.dirname(file));
  else await fs.mkdir(path.dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
  try {
    await fs.writeFile(part, data, { flag: 'wx' });
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
    // Ouverture sans suivre un lien symbolique (là où le système le permet), puis lecture par le même descripteur.
    const fh = await fs.open(file, FS.O_RDONLY | (FS.O_NOFOLLOW || 0));
    try {
      const st2 = await fh.stat();
      if (!st2.isFile() || st2.size > MAX_FILE) throw Object.assign(new Error('fichier inattendu'), { code: 'EINVAL' });
      return await fh.readFile();
    } finally { await fh.close(); }
  } catch (err) {
    if (!strict || (err && err.code === 'ENOENT')) return undefined;
    throw err;
  }
}

const MAX_DATA_TTL = 30 * 24 * 3600 * 1000;
// « Joueur introuvable » n'est gardé qu'une minute ; on refuse une entrée plantée qui durerait plus.
const MAX_NULL_TTL = 61 * 1000;
// Profils et pseudos des joueurs : jamais plus d'une heure, même si un fichier planté dit le contraire.
const MAX_PLAYER_TTL = 60 * 60 * 1000;
const maxTtlFor = (key, v) => (isShort(v) ? MAX_NULL_TTL : /^(name|profile):/.test(key) ? MAX_PLAYER_TTL : MAX_DATA_TTL);
const isShort = (v) => v === null || (!!v && typeof v === 'object' && v.notFound === true);
const PRUNE_EVERY = 10 * 60 * 1000;

async function realDirOnly(dir) {
  const st = await fs.lstat(dir);
  if (!st.isDirectory()) throw new SkinError('STORAGE_FAILED', 'dossier inattendu');
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
  const api = {
    async get(key) {
      const h = texKey(key);
      try { await realDirOnly(path.join(root, h ? 'textures' : 'data')); } catch { return undefined; }
      if (h) {
        const b = await readSmall(texFile(h));
        return b && isPng(b) ? new Uint8Array(b) : undefined;
      }
      const b = await readSmall(dataFile(key));
      if (!b) return undefined;
      try {
        const e = JSON.parse(b.toString('utf8'));
        if (!e || e.key !== key || typeof e.exp !== 'number' || e.exp > Date.now() + maxTtlFor(key, e.value)) return undefined;
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
      const exp = Date.now() + Math.min(ttlMs, maxTtlFor(key, value));
      return atomicWrite(dataFile(key), JSON.stringify({ key, exp, value }));
    },
    async delete(key) {
      const h = texKey(key);
      await fs.rm(h ? texFile(h) : dataFile(key), { force: true });
    },
    /** Efface les données périmées (profils des autres joueurs, etc.). */
    async prune() {
      const dir = path.join(root, 'data');
      try { await realDirOnly(dir); } catch { return 0; }
      let names = [];
      try { names = await fs.readdir(dir); } catch { return 0; }
      let n = 0;
      for (const f of names) {
        const full = path.join(dir, f);
        if (f.endsWith('.part')) {
          // Fichier en cours d'écriture : on ne touche qu'aux restes vieux de plus de 10 minutes.
          try { const st = await fs.lstat(full); if (Date.now() - st.mtimeMs < PRUNE_EVERY) continue; } catch { continue; }
        }
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
  // Au démarrage puis toutes les 10 minutes, on efface les données périmées
  // (en arrière-plan, sans jamais bloquer ni empêcher le programme de se fermer).
  const t = setTimeout(() => { api.prune().catch(() => {}); }, 0);
  if (t.unref) t.unref();
  const iv = setInterval(() => { api.prune().catch(() => {}); }, PRUNE_EVERY);
  if (iv.unref) iv.unref();
  /** Arrête le nettoyage automatique (utile si on crée un cache par requête sur un serveur). */
  api.close = () => { clearTimeout(t); clearInterval(iv); };
  return api;
}

const ID_RE = /^[0-9a-f]{16}$/;
const queues = new Map();
const MAX_ITEMS = 500;

function cleanName(name) {
  if (name === undefined) return 'Skin';
  if (typeof name !== 'string') throw new SkinError('INVALID_OPTION', 'nom');
  // Ni caractères de contrôle, ni caractères invisibles ou d'inversion de sens (U+202E…).
  const s = Array.from(name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim()).slice(0, 64).join('').trim();
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
  const qkey = process.platform === 'win32' || process.platform === 'darwin' ? root.toLowerCase() : root;
  // Une seule file d'attente par dossier, même avec plusieurs createWardrobe() sur le même dossier.
  const serial = (fn) => {
    const prev = queues.get(qkey) || Promise.resolve();
    const p = prev.then(fn);
    const tail = p.catch(() => {});
    queues.set(qkey, tail);
    tail.then(() => { if (queues.get(qkey) === tail) queues.delete(qkey); });
    return p.catch((err) => { throw toSkinError(err); });
  };

  async function readIndex() {
    // Un fichier verrouillé un instant (antivirus…) ne doit jamais être pris pour une garde-robe vide.
    const b = await readSmall(indexFile, { strict: true });
    if (!b) return [];
    let j;
    try {
      j = JSON.parse(b.toString('utf8'));
    } catch {
      // Index illisible : on le met de côté au lieu de l'écraser.
      await fs.rename(indexFile, `${indexFile}.abime-${Date.now()}`).catch(() => {});
      return [];
    }
    {
      // Une entrée bizarre est ignorée ou réparée, jamais toute la garde-robe.
      return Array.isArray(j) ? j.filter((e) => e && typeof e.id === 'string' && ID_RE.test(e.id) && (e.model === 'classic' || e.model === 'slim')).map((e) => ({
        id: e.id, name: typeof e.name === 'string' ? cleanName(e.name) : 'Skin', model: e.model, addedAt: typeof e.addedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(e.addedAt) ? e.addedAt : '',
      })) : [];
    }
  }
  // Le dossier de la garde-robe est choisi par l'application (il peut être un lien voulu).
  const writeIndex = (items) => atomicWrite(indexFile, JSON.stringify(items, null, 2), { checkDir: false });

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
    if (b.length > DEFAULT_MAX_BYTES) throw new SkinError('STORAGE_FAILED', 'fichier trop gros');
    // Toujours revérifié et redessiné : un fichier modifié sur le disque ne ressort jamais tel quel.
    let skin;
    try { skin = await loadSkin(new Uint8Array(b), { model: entry.model }); } catch { throw new SkinError('STORAGE_FAILED', 'fichier abîmé'); }
    return { entry, skin, bytes: await encodePng(skin.source) };
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
      await atomicWrite(pngFile(id), await encodePng(skin.source), { checkDir: false });
      const entry = { id, name, model: skin.model, addedAt: new Date().toISOString() };
      items.push(entry);
      try { await writeIndex(items); } catch (err) { await fs.rm(pngFile(id), { force: true }); throw err; }
      return entry;
    }),

    /** Octets PNG d'un skin rangé. */
    getBytes: (id) => serial(async () => (await readEntry(id)).bytes),

    /** Skin rangé, prêt à afficher. */
    get: (id) => serial(async () => {
      return (await readEntry(id)).skin;
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
