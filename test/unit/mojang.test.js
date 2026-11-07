import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, SkinError, Skin, Cape, createMemoryCache, parsePlayerQuery, defaultSkinFor, DEFAULT_SKINS, cacheHeaders } from '../../src/index.js';
import { checkUrl, createRateLimiter, request } from '../../src/mojang/net.js';
import { javaUuidHash } from '../../src/mojang/defaults.js';
import { startServer, json, bytes, status, texturesValue, testSkin, rawPng } from '../helpers.js';

const code = (c) => (e) => e instanceof SkinError && e.code === c;
const ID = '069a79f444e94726a5befca90e38aaf5';
const SKIN_HASH = 'aa'.repeat(32);
const CAPE_HASH = 'bb'.repeat(32);
const capePng = rawPng({ w: 64, h: 32, pixel: (x, y) => [x, y, 1, 255] });

function profile({ skinUrl = `http://textures.minecraft.net/texture/${SKIN_HASH}`, slim = false, cape = true, id = ID, name = 'Notch' } = {}) {
  const textures = {};
  if (skinUrl) textures.SKIN = { url: skinUrl, ...(slim ? { metadata: { model: 'slim' } } : {}) };
  if (cape) textures.CAPE = { url: `http://textures.minecraft.net/texture/${CAPE_HASH}` };
  return { id, name, properties: [{ name: 'textures', value: texturesValue(textures, id, name) }], profileActions: [] };
}

function routes(extra = {}) {
  return {
    '/api.mojang.com/users/profiles/minecraft/Notch': json({ id: ID, name: 'Notch' }),
    [`/sessionserver.mojang.com/session/minecraft/profile/${ID}`]: json(profile()),
    [`/textures.minecraft.net/texture/${SKIN_HASH}`]: bytes(testSkin()),
    [`/textures.minecraft.net/texture/${CAPE_HASH}`]: bytes(capePng),
    ...extra,
  };
}

test('pseudo → joueur complet (UUID, skin, bras, cape), liens passés en https', async () => {
  const srv = await startServer(routes());
  try {
    const c = createClient();
    const p = await c.getPlayer('Notch');
    assert.equal(p.id, ID);
    assert.equal(p.uuid, '069a79f4-44e9-4726-a5be-fca90e38aaf5');
    assert.equal(p.name, 'Notch');
    assert.equal(p.skin.url, `https://textures.minecraft.net/texture/${SKIN_HASH}`);
    assert.equal(p.skin.model, 'classic');
    assert.equal(p.cape.hash, CAPE_HASH);
    assert.equal(p.isDefaultSkin, false);
    const s = await c.getSkin(p);
    assert.ok(s instanceof Skin);
    assert.equal(s.hash, SKIN_HASH);
    const cape = await c.getCape('Notch');
    assert.ok(cape instanceof Cape);
  } finally { await srv.close(); }
});

test('recherche par UUID (avec ou sans tirets) : pas d’appel à api.mojang.com', async () => {
  const srv = await startServer(routes());
  try {
    const c = createClient();
    await c.getPlayer('069a79f4-44e9-4726-a5be-fca90e38aaf5');
    await c.getPlayer(ID.toUpperCase());
    assert.equal(srv.ctx.hits['/api.mojang.com/users/profiles/minecraft/Notch'], undefined);
    assert.equal(srv.ctx.hits[`/sessionserver.mojang.com/session/minecraft/profile/${ID}`], 1); // 2e fois : cache
  } finally { await srv.close(); }
});

test('pseudo invalide refusé sans requête', async () => {
  const srv = await startServer(routes());
  try {
    const c = createClient();
    for (const q of ['', 'a b', 'x'.repeat(17), '../etc', 'é', 'Notch?x=1', null, 42]) await assert.rejects(c.getPlayer(q), code('INVALID_NAME'));
    assert.equal(srv.ctx.requests.length, 0);
    assert.deepEqual(parsePlayerQuery(' Notch '), { kind: 'name', value: 'Notch' });
  } finally { await srv.close(); }
});

test('joueur inexistant → PLAYER_NOT_FOUND (204 et 404), réponse négative gardée 1 minute', async () => {
  const srv = await startServer(routes({
    '/api.mojang.com/users/profiles/minecraft/Personne': status(204),
    '/api.mojang.com/users/profiles/minecraft/Absent': json({ error: 'NOT_FOUND' }, 404),
    [`/sessionserver.mojang.com/session/minecraft/profile/${'cc'.repeat(16)}`]: status(204),
  }));
  try {
    const c = createClient();
    await assert.rejects(c.getPlayer('Personne'), code('PLAYER_NOT_FOUND'));
    await assert.rejects(c.getPlayer('Personne'), code('PLAYER_NOT_FOUND'));
    assert.equal(srv.ctx.hits['/api.mojang.com/users/profiles/minecraft/Personne'], 1);
    await assert.rejects(c.getPlayer('Absent'), code('PLAYER_NOT_FOUND'));
    await assert.rejects(c.getPlayer('cc'.repeat(16)), code('PLAYER_NOT_FOUND'));
  } finally { await srv.close(); }
});

test('trop de demandes (429) → RATE_LIMITED avec délai ; panne (500/503) → MOJANG_UNAVAILABLE', async () => {
  const srv = await startServer(routes({
    '/api.mojang.com/users/profiles/minecraft/Lent': status(429, { 'retry-after': '30' }),
    '/api.mojang.com/users/profiles/minecraft/Panne': status(503),
    '/api.mojang.com/users/profiles/minecraft/Bizarre': json('{pas du json', 200),
    '/api.mojang.com/users/profiles/minecraft/Faux': json({ id: '../../x', name: 'Faux' }),
  }));
  try {
    const c = createClient();
    await assert.rejects(c.getPlayer('Lent'), (e) => code('RATE_LIMITED')(e) && e.retryAfter === 30);
    await assert.rejects(c.getPlayer('Panne'), code('MOJANG_UNAVAILABLE'));
    await assert.rejects(c.getPlayer('Bizarre'), code('MOJANG_UNAVAILABLE'));
    await assert.rejects(c.getPlayer('Faux'), code('MOJANG_UNAVAILABLE'));
  } finally { await srv.close(); }
});

test('réseau coupé → MOJANG_UNAVAILABLE', async () => {
  const srv = await startServer({});
  await srv.close();
  const { __setTestMirror } = await import('../../src/mojang/net.js');
  __setTestMirror(`https://localhost:${srv.port}/`); // plus personne n'écoute
  try {
    await assert.rejects(createClient().getPlayer('Notch'), code('MOJANG_UNAVAILABLE'));
  } finally { __setTestMirror(null); }
});

test('serveur muet → délai dépassé → MOJANG_UNAVAILABLE ; annulation → CANCELLED', async () => {
  const srv = await startServer({ '/api.mojang.com/users/profiles/minecraft/Muet': () => {} });
  try {
    const t = Date.now();
    await assert.rejects(createClient({ timeout: 300 }).getPlayer('Muet'), code('MOJANG_UNAVAILABLE'));
    assert.ok(Date.now() - t < 3000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(createClient().getPlayer('Muet', { signal: ac.signal }), code('CANCELLED'));
  } finally { await srv.close(); }
});

test('redirections : vers un site non officiel ou en http → refus ; officiel → suivi', async () => {
  const srv = await startServer(routes({
    '/api.mojang.com/users/profiles/minecraft/Evil': status(302, { location: 'https://crafatar.com/avatars/x' }),
    '/api.mojang.com/users/profiles/minecraft/Http': status(302, { location: 'http://api.mojang.com/users/profiles/minecraft/Notch' }),
    '/api.mojang.com/users/profiles/minecraft/Port': status(302, { location: 'https://api.mojang.com:8443/x' }),
    '/api.mojang.com/users/profiles/minecraft/Boucle': status(302, { location: '/users/profiles/minecraft/Boucle' }),
    '/api.mojang.com/users/profiles/minecraft/Ok': status(301, { location: 'https://api.mojang.com/users/profiles/minecraft/Notch' }),
  }));
  try {
    const c = createClient();
    await assert.rejects(c.getPlayer('Evil'), code('HOST_NOT_ALLOWED'));
    await assert.rejects(c.getPlayer('Http'), code('INSECURE_URL'));
    await assert.rejects(c.getPlayer('Port'), code('HOST_NOT_ALLOWED'));
    await assert.rejects(c.getPlayer('Boucle'), code('MOJANG_UNAVAILABLE'));
    assert.equal((await c.getPlayer('Ok')).id, ID);
  } finally { await srv.close(); }
});

test('liste fixe des sites : seuls les 4 sites officiels, en https, port standard', () => {
  for (const u of ['https://api.mojang.com/x', 'https://sessionserver.mojang.com/x', 'https://textures.minecraft.net/texture/ab', 'https://api.minecraftservices.com/minecraft/profile']) assert.ok(checkUrl(u));
  assert.throws(() => checkUrl('http://api.mojang.com/x'), code('INSECURE_URL'));
  assert.throws(() => checkUrl('https://crafatar.com/x'), code('HOST_NOT_ALLOWED'));
  assert.throws(() => checkUrl('https://mc-heads.net/x'), code('HOST_NOT_ALLOWED'));
  assert.throws(() => checkUrl('https://api.mojang.com.evil.com/x'), code('HOST_NOT_ALLOWED'));
  assert.throws(() => checkUrl('https://user:pw@api.mojang.com/x'), code('INSECURE_URL'));
  assert.throws(() => checkUrl('file:///etc/passwd'), code('INSECURE_URL'));
  assert.throws(() => checkUrl('pas une adresse'), code('INSECURE_URL'));
});

test('réponse énorme refusée (plafond de taille)', async () => {
  const huge = Buffer.alloc(400 * 1024, 32);
  const srv = await startServer(routes({
    '/api.mojang.com/users/profiles/minecraft/Gros': (req, res) => { res.writeHead(200); res.end(huge); }, // sans content-length annoncé ? Node l'ajoute
    [`/textures.minecraft.net/texture/${'dd'.repeat(32)}`]: (req, res) => { res.writeHead(200, { 'transfer-encoding': 'chunked' }); res.write(Buffer.alloc(40 * 1024)); res.end(Buffer.alloc(40 * 1024)); },
  }));
  try {
    const c = createClient();
    await assert.rejects(c.getPlayer('Gros'), code('MOJANG_REJECTED'));
    await assert.rejects(c.getTexture('dd'.repeat(32)), code('MOJANG_REJECTED'));
  } finally { await srv.close(); }
});

test('textures : liens non officiels ignorés → skin par défaut ; http converti en https', async () => {
  const id2 = '853c80ef3c3749fdaa49938b674adae6';
  const id3 = '11111111222233334444555555555555';
  const srv = await startServer(routes({
    [`/sessionserver.mojang.com/session/minecraft/profile/${id2}`]: json(profile({ id: id2, name: 'X', skinUrl: 'https://evil.example/texture/' + SKIN_HASH, cape: false })),
    [`/sessionserver.mojang.com/session/minecraft/profile/${id3}`]: json({ id: id3, name: 'Y', properties: [{ name: 'textures', value: '!!!pas du base64' }] }),
  }));
  try {
    const c = createClient();
    const p = await c.getPlayer(id2);
    assert.equal(p.isDefaultSkin, true);
    assert.equal(p.cape, null);
    assert.equal(p.skin.hash, defaultSkinFor(id2).hash);
    assert.equal(await c.getCape(p), null);
    const p3 = await c.getPlayer(id3);
    assert.equal(p3.isDefaultSkin, true);
    await assert.rejects(c.getTexture('https://evil.example/texture/abc'), code('HOST_NOT_ALLOWED'));
    await assert.rejects(c.getTexture('../../etc/passwd'), code('HOST_NOT_ALLOWED'));
  } finally { await srv.close(); }
});

test('bras fins lus depuis Mojang', async () => {
  const srv = await startServer(routes({ [`/sessionserver.mojang.com/session/minecraft/profile/${ID}`]: json(profile({ slim: true })) }));
  try {
    const c = createClient();
    assert.equal((await c.getPlayer('Notch')).skin.model, 'slim');
    assert.equal((await c.getSkin('Notch')).model, 'slim');
  } finally { await srv.close(); }
});

test('texture abîmée ou pas PNG → erreur claire', async () => {
  const srv = await startServer(routes({ [`/textures.minecraft.net/texture/${SKIN_HASH}`]: bytes(Buffer.from('<html>pub</html>')) }));
  try {
    await assert.rejects(createClient().getSkin('Notch'), code('SKIN_INVALID_FORMAT'));
  } finally { await srv.close(); }
});

test('cache : images gardées pour toujours, profils 10 min, demandes simultanées regroupées', async () => {
  const srv = await startServer(routes());
  try {
    const cache = createMemoryCache();
    const c = createClient({ cache });
    await Promise.all([c.getSkin('Notch'), c.getSkin('Notch'), c.getSkin('Notch')]);
    await c.getSkin('Notch');
    assert.equal(srv.ctx.hits['/api.mojang.com/users/profiles/minecraft/Notch'], 1);
    assert.equal(srv.ctx.hits[`/textures.minecraft.net/texture/${SKIN_HASH}`], 1);
    const c2 = createClient({ cache: createMemoryCache(), profileTtl: -1 }); // profils toujours périmés
    await c2.getPlayer(ID);
    await c2.getPlayer(ID);
    assert.equal(srv.ctx.hits[`/sessionserver.mojang.com/session/minecraft/profile/${ID}`], 3);
  } finally { await srv.close(); }
});

test('cache en panne (disque plein) : on continue sans cache', async () => {
  const srv = await startServer(routes());
  try {
    const broken = { get() { throw Object.assign(new Error('x'), { code: 'EIO' }); }, set() { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); }, delete() {} };
    const p = await createClient({ cache: broken }).getPlayer('Notch');
    assert.equal(p.id, ID);
  } finally { await srv.close(); }
});

test('modifier le résultat ne pollue pas le cache', async () => {
  const srv = await startServer(routes());
  try {
    const c = createClient();
    const p = await c.getPlayer('Notch');
    p.skin.url = 'https://evil.example/';
    assert.equal((await c.getPlayer('Notch')).skin.url, `https://textures.minecraft.net/texture/${SKIN_HASH}`);
  } finally { await srv.close(); }
});

test('limite de requêtes : au-delà, on attend', async () => {
  const take = createRateLimiter(2, 300);
  const t = Date.now();
  await take(); await take(); await take();
  assert.ok(Date.now() - t >= 250);
  const ac = new AbortController(); ac.abort();
  await take();
  await assert.rejects(createRateLimiter(1, 10_000)(ac.signal), code('CANCELLED'));
  assert.throws(() => createRateLimiter(0), code('INVALID_OPTION'));
});

test('skin par défaut choisi d’après l’UUID comme le jeu (9 personnages × 2 bras)', () => {
  // UUID.hashCode() de Java, vérifié à la main : (msb ^ lsb) replié sur 32 bits.
  assert.equal(javaUuidHash('00000000000000000000000000000001'), 1);
  assert.equal(javaUuidHash('00000001000000000000000000000000'), 1);
  assert.equal(javaUuidHash('ffffffffffffffff0000000000000000'), 0);
  assert.equal(defaultSkinFor('00000000000000000000000000000000').defaultName, 'alex');
  assert.equal(defaultSkinFor('00000000000000000000000000000000').model, 'slim');
  assert.equal(defaultSkinFor('00000000000000000000000000000009').defaultName, 'alex');
  assert.equal(defaultSkinFor('00000000000000000000000000000009').model, 'classic');
  assert.equal(defaultSkinFor('00000000000000000000000000000006').defaultName, 'steve');
  assert.equal(defaultSkinFor('0000000000000000000000000000000f').defaultName, 'steve');
  assert.equal(defaultSkinFor('ffffffffffffffffffffffffffffffff').defaultName, 'alex'); // hash 0
  assert.equal(Object.keys(DEFAULT_SKINS.slim).length, 9);
  assert.equal(new Set([...Object.values(DEFAULT_SKINS.slim), ...Object.values(DEFAULT_SKINS.classic)]).size, 18);
});

test('en-têtes de cache conseillés pour le site', () => {
  assert.match(cacheHeaders('texture')['cache-control'], /immutable/);
  assert.match(cacheHeaders('profile')['cache-control'], /max-age=600/);
  assert.equal(cacheHeaders('x')['cache-control'], 'no-store');
});

test('request : user-agent propre, jamais de cookie, fetch remplaçable', async () => {
  let seen = null;
  const fakeFetch = async (url, init) => { seen = { url: String(url), init }; return new Response('{}', { status: 200 }); };
  const r = await request('https://api.mojang.com/x', { fetch: fakeFetch });
  assert.equal(r.status, 200);
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(seen.init.headers['user-agent'], 'lanterne-skins/0.1');
});
