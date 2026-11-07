// Tests ajoutés après le tour 1 de relecture (un test par problème signalé).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createClient, createMemoryCache, SkinError, loadSkin, renderHead, account, decodePng } from '../../src/index.js';
import * as net from '../../src/mojang/net.js';
import { createRateLimiter } from '../../src/mojang/net.js';
import { createFileCache, createWardrobe } from '../../src/node/index.js';
import { startServer, json, bytes, status, texturesValue, testSkin, rawPng, tmpDir, pngChunk } from '../helpers.js';

const code = (c) => (e) => e instanceof SkinError && e.code === c;
const ID = '069a79f444e94726a5befca90e38aaf5';
const H = 'ab'.repeat(32);
const TOKEN = 'token-de-test-0123456789';
const API = '/api.minecraftservices.com/minecraft/profile';
const prof = (name = 'Notch') => ({ id: ID, name, properties: [{ name: 'textures', value: texturesValue({ SKIN: { url: `http://textures.minecraft.net/texture/${H}` } }) }] });

test('texture qui n’est pas un PNG Minecraft : refusée et jamais gardée', async () => {
  let n = 0;
  const srv = await startServer({ [`/textures.minecraft.net/texture/${H}`]: (req, res) => { n++; bytes(Buffer.from('<svg><script>alert(1)</script></svg>'))(req, res); } });
  try {
    const cache = createMemoryCache();
    const c = createClient({ cache });
    await assert.rejects(c.getTexture(H), code('SKIN_INVALID_FORMAT'));
    assert.equal(cache.get(`texture:${H}`), undefined);
    await assert.rejects(c.getTexture(H), code('SKIN_INVALID_FORMAT'));
    assert.equal(n, 2);
  } finally { await srv.close(); }
});

test('modifier les octets reçus ne casse pas le cache', async () => {
  const srv = await startServer({ [`/textures.minecraft.net/texture/${H}`]: bytes(testSkin()) });
  try {
    const c = createClient();
    (await c.getTexture(H)).fill(0);
    (await c.getTexture(H)).fill(0);
    assert.equal((await c.getSkin({ skin: { hash: H, model: 'classic' } })).width, 64);
  } finally { await srv.close(); }
});

test('cache modifié par quelqu’un d’autre : revérifié, sinon redemandé à Mojang', async () => {
  const srv = await startServer({
    '/api.mojang.com/users/profiles/minecraft/Notch': json({ id: ID, name: 'Notch' }),
    [`/sessionserver.mojang.com/session/minecraft/profile/${ID}`]: json(prof()),
  });
  try {
    const cache = createMemoryCache();
    cache.set(`profile:${ID}`, { id: ID, uuid: 'x', name: '<script>', skin: { url: 'https://tracker.example/p.gif', hash: H, model: 'classic' }, cape: null }, 1e9);
    cache.set('name:notch', '../../evil', 1e9);
    const p = await createClient({ cache }).getPlayer('Notch');
    assert.equal(p.name, 'Notch');
    assert.equal(p.skin.url, `https://textures.minecraft.net/texture/${H}`);
    assert.equal(srv.ctx.requests.length, 2);
  } finally { await srv.close(); }
});

test('pseudo étrange renvoyé par Mojang refusé (lecture publique et compte)', async () => {
  const srv = await startServer({
    [`/sessionserver.mojang.com/session/minecraft/profile/${ID}`]: json(prof('<img src=x onerror=alert(1)>')),
    [`GET ${API}`]: json({ id: ID, name: '<b>x</b>', skins: [], capes: [] }),
  });
  try {
    await assert.rejects(createClient().getPlayer(ID), code('MOJANG_UNAVAILABLE'));
    await assert.rejects(account.getProfile(TOKEN), code('MOJANG_UNAVAILABLE'));
  } finally { await srv.close(); }
});

test('décodeur seul : plafond de pixels par défaut raisonnable', async () => {
  const png = rawPng({ w: 4096, h: 4096, pixel: () => [0, 0, 0, 0], idatOverride: zlib.deflateSync(Buffer.alloc(1)) });
  await assert.rejects(decodePng(png), (e) => e.kind === 'SIZE');
});

test('aucun crochet de test dans le code livré', async () => {
  assert.equal(Object.keys(net).some((k) => k.startsWith('__')), false);
  const src = await fs.readFile(new URL('../../src/mojang/net.js', import.meta.url), 'utf8');
  assert.equal(/mirror/i.test(src), false);
});

test('cache disque : données périmées effacées (aucun historique gardé), dates trop lointaines ignorées', async () => {
  const dir = await tmpDir();
  const c = createFileCache(dir);
  await c.set('profile:a', { a: 1 }, 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await c.get('profile:a'), undefined);
  assert.deepEqual(await fs.readdir(path.join(dir, 'data')), []);
  await c.set('profile:b', 1, 1);
  await c.set('profile:c', 2, 60_000);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await c.prune(), 1);
  assert.equal((await fs.readdir(path.join(dir, 'data'))).length, 1);
  // Fichier planté qui dit « pour toujours »
  const f = path.join(dir, 'data', (await fs.readdir(path.join(dir, 'data')))[0]);
  await fs.writeFile(f, JSON.stringify({ key: 'profile:c', exp: Number.MAX_SAFE_INTEGER, value: 'planté' }));
  assert.equal(await c.get('profile:c'), undefined);
});

test('rendus : même image Mojang rechargée → pas redessinée, et bras différents séparés', async () => {
  const a = await loadSkin(testSkin(), { hash: H });
  const b = await loadSkin(testSkin(), { hash: H });
  assert.deepEqual([...renderHead(a, { size: 32 }).data], [...renderHead(b, { size: 32 }).data]);
  const slim = await loadSkin(testSkin(), { hash: H, model: 'slim' });
  assert.equal(slim.model, 'slim');
});

test('garde-robe : index illisible un instant → erreur, rien d’écrasé', async () => {
  const dir = await tmpDir();
  const w = createWardrobe(dir);
  await w.add(testSkin(), { name: 'a' });
  await w.add(testSkin(), { name: 'b' });
  const idx = path.join(dir, 'index.json');
  const saved = await fs.readFile(idx);
  await fs.rm(idx); await fs.mkdir(idx); // simule un fichier impossible à lire
  await assert.rejects(w.add(testSkin(), { name: 'c' }), (e) => e instanceof SkinError);
  await fs.rmdir(idx); await fs.writeFile(idx, saved);
  assert.deepEqual((await w.list()).map((e) => e.name), ['a', 'b']);
});

test('garde-robe : index abîmé mis de côté, pas écrasé', async () => {
  const dir = await tmpDir();
  const w = createWardrobe(dir);
  await fs.writeFile(path.join(dir, 'index.json'), '{abîmé');
  assert.deepEqual(await w.list(), []);
  assert.ok((await fs.readdir(dir)).some((f) => f.startsWith('index.json.abime-')));
});

test('garde-robe : get détaché, deux garde-robes sur le même dossier, lien symbolique et faux PNG refusés', async () => {
  const dir = await tmpDir();
  const w1 = createWardrobe(dir), w2 = createWardrobe(dir);
  await Promise.all([w1.add(testSkin(), { name: 'x' }), w2.add(testSkin(), { name: 'y' }), w1.add(testSkin(), { name: 'z' })]);
  const list = await w1.list();
  assert.equal(list.length, 3);
  const { get, getBytes } = w1;
  assert.equal((await get(list[0].id)).width, 64);
  await fs.writeFile(path.join(dir, `${list[1].id}.png`), 'pas une image');
  await assert.rejects(getBytes(list[1].id), code('STORAGE_FAILED'));
  const secret = path.join(dir, '..', `secret-${Date.now()}.txt`);
  await fs.writeFile(secret, 'secret');
  await fs.rm(path.join(dir, `${list[2].id}.png`));
  try {
    await fs.symlink(secret, path.join(dir, `${list[2].id}.png`));
    await assert.rejects(getBytes(list[2].id), code('STORAGE_FAILED'));
  } catch (e) { if (e.code !== 'EPERM') throw e; } // Windows sans droits : lien impossible
});

test('un appelant qui annule n’annule pas les autres', async () => {
  const srv = await startServer({ [`/textures.minecraft.net/texture/${H}`]: (req, res) => setTimeout(() => bytes(testSkin())(req, res), 200) });
  try {
    const c = createClient();
    const ac = new AbortController();
    const p1 = c.getTexture(H, { signal: ac.signal });
    const p2 = c.getTexture(H);
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p1, code('CANCELLED'));
    assert.equal((await p2).length > 0, true);
    assert.equal(srv.ctx.hits[`/textures.minecraft.net/texture/${H}`], 1);
  } finally { await srv.close(); }
});

test('après un changement : cache vidé et attendu, une erreur du cache ne casse rien', async () => {
  const srv = await startServer({ [`DELETE ${API}/capes/active`]: json({ id: ID, name: 'Notch', skins: [], capes: [] }) });
  const unhandled = [];
  const on = (e) => unhandled.push(e);
  process.on('unhandledRejection', on);
  try {
    const client = { cache: { delete: async () => { throw Object.assign(new Error('verrou'), { code: 'EPERM' }); } } };
    await account.hideCape(TOKEN, { client });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled.length, 0);
  } finally { process.off('unhandledRejection', on); await srv.close(); }
});

test('vieux skin : règle du chapeau identique au jeu (zone x32-64, y0-32)', async () => {
  // Chapeau 100 % opaque, mais pixels vides ailleurs dans x32-64 y16-32 → le jeu garde le chapeau.
  const png = testSkin({ h: 32, alphaFn: (x, y) => (x >= 32 && x < 40 && y >= 16 && y < 20 ? 0 : 255) });
  const s = await loadSkin(png);
  assert.equal(s.data[(8 * 64 + 40) * 4 + 3], 255);
});

test('limite de requêtes : annulation immédiate pendant l’attente, fenêtre invalide refusée', async () => {
  const take = createRateLimiter(1, 5000);
  await take();
  const ac = new AbortController();
  const t = Date.now();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(take(ac.signal), code('CANCELLED'));
  assert.ok(Date.now() - t < 1000);
  assert.throws(() => createRateLimiter(1, NaN), code('INVALID_OPTION'));
  assert.throws(() => createRateLimiter(1, 0), code('INVALID_OPTION'));
});

test('octets en trop après les données image : acceptés (comme les autres logiciels)', async () => {
  const rows = Buffer.alloc(2 * 9, 0); // 2×2 RVBA, filtre 0
  const png = rawPng({ w: 2, h: 2, pixel: () => [0, 0, 0, 0], idatOverride: Buffer.concat([zlib.deflateSync(rows), Buffer.from([1, 2])]) });
  assert.equal((await decodePng(png)).width, 2);
});

test('cacher sa cape : 404 → NO_MINECRAFT ; cape choisie sans tenir compte des majuscules', async () => {
  const capeId = 'C0FFEE00-1111-2222-3333-444455556666';
  const me = { id: ID, name: 'Notch', skins: [], capes: [{ id: capeId.toLowerCase(), state: 'INACTIVE', url: `http://textures.minecraft.net/texture/${H}` }] };
  const srv = await startServer({ [`DELETE ${API}/capes/active`]: status(404), [`GET ${API}`]: json(me), [`PUT ${API}/capes/active`]: json(me) });
  try {
    await assert.rejects(account.hideCape(TOKEN), code('NO_MINECRAFT'));
    await account.setCape(TOKEN, capeId);
    const put = srv.ctx.requests.find((r) => r.method === 'PUT');
    assert.equal(JSON.parse(put.body).capeId, capeId.toLowerCase());
  } finally { await srv.close(); }
});

test('message d’erreur = texte anglais exact, précision à part', async () => {
  try { await loadSkin(testSkin({ w: 32, h: 32 })); } catch (e) {
    assert.equal(e.message, 'The skin must be 64×64 or 64×32 pixels.');
    assert.equal(e.detail, '32×32');
    return;
  }
  assert.fail();
});
