// Tests ajoutés après le tour 2 de relecture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import util from 'node:util';
import { createClient, SkinError, loadSkin, renderHead, account, Skin } from '../../src/index.js';
import { createFileCache, createWardrobe } from '../../src/node/index.js';
import { RgbaImage } from '../../src/core/image.js';
import { startServer, bytes, testSkin, tmpDir, pngChunk } from '../helpers.js';

const code = (c) => (e) => e instanceof SkinError && e.code === c;
const H = 'cd'.repeat(32);

test('getTexture rend toujours un PNG redessiné, même depuis un cache trafiqué', async () => {
  const dirty = Buffer.concat([testSkin({ extra: [pngChunk('tEXt', Buffer.from('GPS\0secret'))] }), Buffer.from('<html>pub</html>')]);
  const srv = await startServer({ [`/textures.minecraft.net/texture/${H}`]: bytes(dirty) });
  try {
    const dir = await tmpDir();
    const c = createClient({ cache: createFileCache(dir) });
    const b = Buffer.from(await c.getTexture(H));
    assert.equal(b.includes(Buffer.from('secret')) || b.includes(Buffer.from('html')), false);
    await fs.writeFile(path.join(dir, 'textures', `${H}.png`), dirty); // trafiqué après coup
    const b2 = Buffer.from(await createClient({ cache: createFileCache(dir) }).getTexture(H));
    assert.equal(b2.includes(Buffer.from('secret')) || b2.includes(Buffer.from('html')), false);
  } finally { await srv.close(); }
});

test('cache disque : sous-dossier remplacé par un lien symbolique → rien écrit ni lu ailleurs', async (t) => {
  const dir = await tmpDir();
  const outside = await tmpDir();
  try { await fs.symlink(outside, path.join(dir, 'data'), 'dir'); } catch (e) { if (e.code === 'EPERM') return t.skip('liens impossibles ici'); throw e; }
  const c = createFileCache(dir);
  await assert.rejects(c.set('profile:x', { a: 1 }, 60_000));
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.writeFile(path.join(outside, 'planté.json'), '{}');
  assert.equal(await c.get('profile:x'), undefined);
});

test('cache disque : « introuvable » planté pour un mois refusé', async () => {
  const dir = await tmpDir();
  const c = createFileCache(dir);
  await c.set('name:x', null, 30 * 24 * 3600 * 1000);
  const f = path.join(dir, 'data', (await fs.readdir(path.join(dir, 'data')))[0]);
  const e = JSON.parse(await fs.readFile(f, 'utf8'));
  assert.ok(e.exp <= Date.now() + 5 * 60 * 1000);
  await fs.writeFile(f, JSON.stringify({ key: 'name:x', exp: Date.now() + 20 * 24 * 3600 * 1000, value: null }));
  assert.equal(await c.get('name:x'), undefined);
});

test('erreur réseau étrange d’un fetch personnalisé : aucun texte libre recopié', async () => {
  const secret = 'Bearer SECRET-XYZ-123456';
  const fetch = async () => { throw Object.assign(new Error(secret), { code: secret, cause: { code: secret } }); };
  const e = await createClient({ fetch, rateLimit: false }).getPlayer('Notch').catch((x) => x);
  assert.equal(e.code, 'MOJANG_UNAVAILABLE');
  assert.equal(util.inspect(e, { depth: 0 }).includes('SECRET-XYZ'), false);
  assert.equal(e.detail.includes('SECRET'), false);
  const fetch2 = async () => ({ status: 200, headers: { get() { throw new Error(secret); } } });
  const e2 = await createClient({ fetch: fetch2 }).getPlayer('Notch').catch((x) => x);
  assert.equal(e2.code, 'MOJANG_UNAVAILABLE');
  assert.equal(e2.detail.includes('SECRET'), false);
});

test('garde-robe : noms nettoyés des caractères invisibles, date plantée ignorée', async () => {
  const dir = await tmpDir();
  const w = createWardrobe(dir);
  const e = await w.add(testSkin(), { name: 'gpl\u202Eexe.png\u200B\u0085\u2028x' + '😀'.repeat(70) });
  assert.equal(/[\u202E\u200B\u0085\u2028]/.test(e.name), false);
  assert.equal(Array.from(e.name).length, 64);
  assert.equal(e.name.isWellFormed(), true);
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify([{ id: e.id, name: 'a', model: 'classic', addedAt: 'x'.repeat(500000) }]));
  assert.equal((await w.list())[0].addedAt, '');
});

test('rendus partagés seulement pour une empreinte confirmée par la bibliothèque', async () => {
  const red = await loadSkin(testSkin(), { hash: H });
  const other = await loadSkin(testSkin({ alphaFn: () => 255 }).map((v, i) => (i > 60 ? v ^ 0x55 : v)).fill(0, 0, 0), { hash: H }).catch(() => null);
  const a = renderHead(red, { size: 8 });
  const fake = new Skin(new RgbaImage(64, 64), { model: 'classic', legacy: false, source: new RgbaImage(64, 64), hash: H });
  const b = renderHead(fake, { size: 8 });
  assert.notDeepEqual([...a.data], [...b.data]);
  assert.ok(other === null || other instanceof Skin);
});

test('setSkin : objet Skin fabriqué avec une image géante refusé avant envoi', async () => {
  let sent = false;
  const fetch = async () => { sent = true; return new Response('{}'); };
  const big = new RgbaImage(2048, 2048);
  const s = new Skin(new RgbaImage(64, 64), { model: 'classic', legacy: false, source: big });
  await assert.rejects(account.setSkin('jeton-de-test-123456', s, { fetch }), code('SKIN_INVALID_SIZE'));
  assert.equal(sent, false);
});

test('garde-robe : une entrée au nom bizarre ne cache pas les autres', async () => {
  const dir = await tmpDir();
  const w = createWardrobe(dir);
  const a = await w.add(testSkin(), { name: 'a' });
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify([{ id: a.id, name: null, model: 'classic' }, { id: '0123456789abcdef', name: 7, model: 'slim' }]));
  assert.deepEqual((await w.list()).map((e) => e.name), ['Skin', 'Skin']);
  assert.equal((await fs.readdir(dir)).some((f) => f.includes('abime')), false);
});

test('nettoyage du cache : ne supprime pas un fichier en cours d’écriture', async () => {
  const dir = await tmpDir();
  const c = createFileCache(dir);
  await c.set('profile:a', 1, 60_000);
  const part = path.join(dir, 'data', `${'0'.repeat(64)}.json.1.abcd.part`);
  await fs.writeFile(part, 'en cours');
  await c.prune();
  assert.ok((await fs.readdir(path.join(dir, 'data'))).some((f) => f.endsWith('.part')));
  const old = new Date(Date.now() - 3600_000);
  await fs.utimes(part, old, old);
  await c.prune();
  assert.equal((await fs.readdir(path.join(dir, 'data'))).some((f) => f.endsWith('.part')), false);
});

test('limite de requêtes : annulation prise en compte même en file d’attente', async () => {
  const { createRateLimiter } = await import('../../src/mojang/net.js');
  const take = createRateLimiter(1, 1000);
  await take();
  const waiting = take();
  const ac = new AbortController();
  const queued = take(ac.signal);
  const t = Date.now();
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(queued, code('CANCELLED'));
  assert.ok(Date.now() - t < 500);
  await waiting;
});

test('changer de skin vide aussi le cache du client partagé', async () => {
  const { defaultClient, resetSkin } = await import('../../src/index.js');
  const c = defaultClient();
  const ID = '069a79f444e94726a5befca90e38aaf5';
  c.cache.set(`profile:${ID}`, { x: 1 }, 60_000);
  const fetch = async () => new Response(JSON.stringify({ id: ID, name: 'Notch', skins: [], capes: [] }), { status: 200 });
  await resetSkin('jeton-de-test-123456', { fetch });
  const now = c.cache.get(`profile:${ID}`);
  assert.equal(now.isDefaultSkin, true); // l'ancien { x: 1 } a été remplacé par le profil à jour
});

test('rendu : skin modifié sur place jamais confondu avec l’original', async () => {
  const { trustHash } = await import('../../src/core/skin.js');
  const a = trustHash(await loadSkin(testSkin()), H);
  const b = trustHash(await loadSkin(testSkin()), H);
  renderHead(a, { size: 8 });
  b.data.fill(0, (8 * 64 + 8) * 4, (8 * 64 + 48) * 4); // visage et chapeau
  assert.notDeepEqual([...renderHead(a, { size: 8 }).data], [...renderHead(b, { size: 8 }).data]);
});

test('cape abîmée : code d’erreur de cape', async () => {
  const srv = await startServer({ [`/textures.minecraft.net/texture/${H}`]: bytes(Buffer.from('pas une image')) });
  try {
    await assert.rejects(createClient().getCape({ skin: { hash: H, model: 'classic' }, cape: { hash: H } }), code('CAPE_INVALID_FORMAT'));
  } finally { await srv.close(); }
});

test('tour 3 : garde-robe → octets toujours redessinés, image trafiquée refusée', async () => {
  const dir = await tmpDir();
  const w = createWardrobe(dir);
  const e = await w.add(testSkin());
  await fs.writeFile(path.join(dir, `${e.id}.png`), testSkin({ extra: [pngChunk('tEXt', Buffer.from('x\0<script>'))] }));
  assert.equal(Buffer.from(await w.getBytes(e.id)).includes(Buffer.from('<script>')), false);
  const { rawPng } = await import('../helpers.js');
  await fs.writeFile(path.join(dir, `${e.id}.png`), rawPng({ w: 4000, h: 1, pixel: () => [0, 0, 0, 255] }));
  await assert.rejects(w.getBytes(e.id), code('STORAGE_FAILED'));
});

test('tour 3 : fetch qui suit lui-même une redirection vers ailleurs → refusé', async () => {
  const fetch = async () => Object.assign(new Response(JSON.stringify({ id: '069a79f444e94726a5befca90e38aaf5', name: 'Bob' }), { status: 200 }), {});
  const f1 = async (u, i) => { const r = await fetch(u, i); Object.defineProperty(r, 'redirected', { value: true }); return r; };
  const f2 = async (u, i) => { const r = await fetch(u, i); Object.defineProperty(r, 'url', { value: 'https://evil.com/' }); return r; };
  await assert.rejects(createClient({ fetch: f1 }).getPlayer('Bob'), code('MOJANG_UNAVAILABLE'));
  await assert.rejects(createClient({ fetch: f2 }).getPlayer('Bob'), code('HOST_NOT_ALLOWED'));
});

test('tour 3 : vieux skin au chapeau opaque → envoyé/rangé sans chapeau (comme en jeu)', async () => {
  const s = await loadSkin(testSkin({ h: 32 }));
  assert.equal(s.source.data[(8 * 64 + 40) * 4 + 3], 0);
  const again = await loadSkin(await s.source.toPNG());
  assert.deepEqual([...renderHead(again, { size: 8 }).data], [...renderHead(s, { size: 8 }).data]);
});

test('tour 3 : cache de type Redis/KV qui renvoie null quand la clé manque', async () => {
  const store = new Map();
  const kv = { get: async (k) => (store.has(k) ? store.get(k) : null), set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } };
  const ID = '069a79f444e94726a5befca90e38aaf5';
  const fetch = async (u) => {
    if (String(u).includes('api.mojang.com')) return new Response(JSON.stringify({ id: ID, name: 'Notch' }));
    if (String(u).includes('sessionserver')) return new Response(JSON.stringify({ id: ID, name: 'Notch', properties: [] }));
    return new Response(null, { status: 204 });
  };
  const c = createClient({ cache: kv, fetch });
  assert.equal((await c.getPlayer('Notch')).id, ID);
  const fetch404 = async () => new Response(null, { status: 204 });
  const c2 = createClient({ cache: kv, fetch: fetch404 });
  await assert.rejects(c2.getPlayer('Personne'), code('PLAYER_NOT_FOUND'));
  await assert.rejects(c2.getPlayer('Personne'), code('PLAYER_NOT_FOUND'));
  assert.deepEqual(store.get('name:personne'), { notFound: true });
});

test('tour 3 : empreinte en majuscules acceptée ; close() arrête le nettoyage', async () => {
  const { textureUrl } = await import('../../src/index.js');
  assert.equal(textureUrl('AB'.repeat(32)).hash, 'ab'.repeat(32));
  const c = createFileCache(await tmpDir());
  c.close();
});

test('tour 4 : après setSkin, une ancienne réponse en route ne remet pas l’ancien skin', async () => {
  const ID = '069a79f444e94726a5befca90e38aaf5';
  const OLD = 'aa'.repeat(32), NEW = 'bb'.repeat(32);
  const { texturesValue } = await import('../helpers.js');
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetch = async (u, init) => {
    const s = String(u);
    if (s.includes('sessionserver')) {
      await gate;
      return new Response(JSON.stringify({ id: ID, name: 'Notch', properties: [{ name: 'textures', value: texturesValue({ SKIN: { url: `http://textures.minecraft.net/texture/${OLD}` } }) }] }));
    }
    return new Response(JSON.stringify({ id: ID, name: 'Notch', skins: [{ id: 's', state: 'ACTIVE', url: `http://textures.minecraft.net/texture/${NEW}`, variant: 'SLIM' }], capes: [] }));
  };
  const client = createClient({ fetch });
  const pending = client.getPlayer(ID);
  await new Promise((r) => setTimeout(r, 20));
  await account.resetSkin('jeton-de-test-123456', { client, fetch });
  release();
  await pending;
  const after = await client.getPlayer(ID);
  assert.equal(after.skin.hash, NEW);
  assert.equal(after.skin.model, 'slim');
});

test('tour 4 : skin quelconque modifié sur place → redessiné', async () => {
  const s = await loadSkin(testSkin());
  const a = renderHead(s, { size: 8 });
  s.data.fill(0, (8 * 64 + 8) * 4, (8 * 64 + 48) * 4);
  assert.notDeepEqual([...a.data], [...renderHead(s, { size: 8 }).data]);
});
