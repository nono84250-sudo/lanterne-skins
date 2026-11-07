import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFileCache, createWardrobe } from '../../src/node/index.js';
import { createClient, SkinError } from '../../src/index.js';
import { tmpDir, testSkin, startServer, json, bytes, texturesValue, pngChunk } from '../helpers.js';

const code = (c) => (e) => e instanceof SkinError && e.code === c;
const listAll = async (d) => (await fs.readdir(d, { recursive: true })).map(String);

test('cache disque : textures pour toujours, données avec expiration, aucun .part laissé', async () => {
  const dir = await tmpDir();
  const c = createFileCache(dir);
  const png = new Uint8Array(testSkin());
  await c.set('texture:' + 'ab'.repeat(32), png);
  assert.deepEqual(await c.get('texture:' + 'ab'.repeat(32)), png);
  await c.set('texture:' + 'cd'.repeat(32), new Uint8Array([1, 2, 3])); // pas un PNG : ignoré
  assert.equal(await c.get('texture:' + 'cd'.repeat(32)), undefined);
  await c.set('profile:x', { a: 1 }, 60_000);
  assert.deepEqual(await c.get('profile:x'), { a: 1 });
  await c.set('name:y', null, 60_000);
  assert.equal(await c.get('name:y'), null);
  await c.set('old', 1, -1);
  assert.equal(await c.get('old'), undefined);
  assert.equal((await listAll(dir)).some((f) => f.endsWith('.part')), false);
  await c.delete('profile:x');
  assert.equal(await c.get('profile:x'), undefined);
  await c.clear();
  assert.equal(await c.get('texture:' + 'ab'.repeat(32)), undefined);
});

test('cache disque : fichier abîmé ignoré, clé piégée sans effet hors du dossier', async () => {
  const dir = await tmpDir();
  const c = createFileCache(dir);
  await c.set('profile:z', { ok: true }, 60_000);
  const files = (await listAll(path.join(dir, 'data'))).map((f) => path.join(dir, 'data', f));
  await fs.writeFile(files[0], '{abîmé');
  assert.equal(await c.get('profile:z'), undefined);
  await c.set('../../../../evil', 1, 60_000);
  assert.ok((await listAll(dir)).every((f) => !f.includes('evil')));
  await c.set('texture:../../evil', new Uint8Array(testSkin()));
  assert.ok((await listAll(dir)).every((f) => !f.includes('evil')));
  assert.throws(() => createFileCache(''), code('INVALID_OPTION'));
});

test('cache disque branché sur le client : 2e lancement sans réseau pour l’image', async () => {
  const ID = '069a79f444e94726a5befca90e38aaf5';
  const H = 'ee'.repeat(32);
  const srv = await startServer({
    [`/sessionserver.mojang.com/session/minecraft/profile/${ID}`]: json({ id: ID, name: 'Notch', properties: [{ name: 'textures', value: texturesValue({ SKIN: { url: `http://textures.minecraft.net/texture/${H}` } }) }] }),
    [`/textures.minecraft.net/texture/${H}`]: bytes(testSkin()),
  });
  try {
    const dir = await tmpDir();
    await createClient({ cache: createFileCache(dir) }).getSkin(ID);
    const s = await createClient({ cache: createFileCache(dir) }).getSkin(ID); // nouveau client = relance du launcher
    assert.equal(s.width, 64);
    assert.equal(srv.ctx.hits[`/textures.minecraft.net/texture/${H}`], 1);
    assert.equal(srv.ctx.hits[`/sessionserver.mojang.com/session/minecraft/profile/${ID}`], 1);
  } finally { await srv.close(); }
});

test('cache disque impossible à écrire (disque plein / dossier bloqué) : le client marche quand même', async () => {
  const ID = '069a79f444e94726a5befca90e38aaf5';
  const srv = await startServer({ [`/sessionserver.mojang.com/session/minecraft/profile/${ID}`]: json({ id: ID, name: 'Notch', properties: [] }) });
  try {
    const dir = await tmpDir();
    const blocker = path.join(dir, 'bloque');
    await fs.writeFile(blocker, 'un fichier à la place du dossier');
    const p = await createClient({ cache: createFileCache(blocker) }).getPlayer(ID);
    assert.equal(p.isDefaultSkin, true);
  } finally { await srv.close(); }
});

test('garde-robe : ranger, lister, relire, renommer, supprimer', async () => {
  const dir = await tmpDir();
  const w = createWardrobe(dir);
  const a = await w.add(testSkin({ extra: [pngChunk('tEXt', Buffer.from('x\0secret'))] }), { name: '  Mon\u0007 skin  ' });
  assert.equal(a.name, 'Mon skin');
  assert.match(a.id, /^[0-9a-f]{16}$/);
  const b = await w.add(testSkin({ alphaFn: (x, y) => (x >= 54 && x < 56 && y >= 20 && y < 32 ? 0 : 255) }));
  assert.equal(b.model, 'slim');
  assert.equal((await w.list()).length, 2);
  const s = await w.get(a.id);
  assert.equal(s.width, 64);
  const raw = Buffer.from(await w.getBytes(a.id));
  assert.equal(raw.includes(Buffer.from('secret')), false);
  assert.equal((await w.rename(a.id, 'Nouveau')).name, 'Nouveau');
  assert.equal(await w.remove(a.id), true);
  assert.equal(await w.remove(a.id), false);
  assert.deepEqual((await w.list()).map((e) => e.id), [b.id]);
  assert.equal((await listAll(dir)).some((f) => f.endsWith('.part')), false);
});

test('garde-robe : identifiants piégés, mauvais fichiers, index abîmé, ajouts simultanés', async () => {
  const dir = await tmpDir();
  const w = createWardrobe(dir);
  for (const id of ['../../etc/passwd', 'index', '', null, 'ABCDEF0123456789']) {
    await assert.rejects(w.getBytes(id), code('INVALID_OPTION'));
    await assert.rejects(w.remove(id), code('INVALID_OPTION'));
  }
  await assert.rejects(w.add(Buffer.from('<svg/>')), code('SKIN_INVALID_FORMAT'));
  await assert.rejects(w.add(testSkin(), { name: 42 }), code('INVALID_OPTION'));
  await Promise.all(Array.from({ length: 8 }, (_, i) => w.add(testSkin(), { name: `n${i}` })));
  assert.equal((await w.list()).length, 8);
  await fs.writeFile(path.join(dir, 'index.json'), '[{"id":"../x","name":"a","model":"classic"}, 5, "x"');
  assert.deepEqual(await w.list(), []);
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify([{ id: '../../x', model: 'classic' }, { id: '0123456789abcdef', name: 'ok', model: 'slim' }]));
  assert.deepEqual((await w.list()).map((e) => e.id), ['0123456789abcdef']);
});
