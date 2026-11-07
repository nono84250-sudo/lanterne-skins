import test from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import { account, getProfile, setSkin, resetSkin, setCape, hideCape, createClient, SkinError, loadSkin } from '../../src/index.js';
import { startServer, json, status, testSkin, pngChunk, texturesValue } from '../helpers.js';
import { decodePng } from '../../src/png/png.js';

const code = (c) => (e) => e instanceof SkinError && e.code === c;
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.SECRET-TOKEN-1234567890.sig';
const ID = '069a79f444e94726a5befca90e38aaf5';
const H1 = '11'.repeat(32), H2 = '22'.repeat(32), HC = '33'.repeat(32);
const API = '/api.minecraftservices.com/minecraft/profile';

function me({ capeActive = false, slim = false } = {}) {
  return {
    id: ID, name: 'Notch',
    skins: [{ id: 's1', state: 'ACTIVE', url: `http://textures.minecraft.net/texture/${H1}`, variant: slim ? 'SLIM' : 'CLASSIC' }, { id: 's2', state: 'INACTIVE', url: `https://evil.example/${H2}`, variant: 'CLASSIC' }],
    capes: [{ id: 'c0ffee00-1111-2222-3333-444455556666', state: capeActive ? 'ACTIVE' : 'INACTIVE', url: `http://textures.minecraft.net/texture/${HC}`, alias: 'Migrator' }],
  };
}

function noToken(err) {
  const all = [err.message, err.detail, err.stack, JSON.stringify(err), util.inspect(err, { depth: 5 }), String(err.cause && err.cause.stack)].join('\n');
  assert.equal(all.includes('SECRET-TOKEN'), false, 'le jeton ne doit jamais apparaître');
  return true;
}

test('mes skins et capes : liste propre, liens non officiels écartés, jeton envoyé seulement à Mojang', async () => {
  const srv = await startServer({ [`GET ${API}`]: json(me({ capeActive: true })) });
  try {
    const p = await getProfile(TOKEN);
    assert.equal(p.uuid, '069a79f4-44e9-4726-a5be-fca90e38aaf5');
    assert.equal(p.skins.length, 1);
    assert.equal(p.activeSkin.url, `https://textures.minecraft.net/texture/${H1}`);
    assert.equal(p.activeCape.alias, 'Migrator');
    assert.equal(srv.ctx.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(srv.ctx.requests[0].path, API);
  } finally { await srv.close(); }
});

test('jeton absent, invalide ou refusé → AUTH_REQUIRED, et jamais dans l’erreur', async () => {
  const srv = await startServer({ [`GET ${API}`]: status(401), [`POST ${API}/skins`]: status(401) });
  try {
    for (const bad of [undefined, null, '', 'court', 'a b c d e f g h', 'x\r\ninjected: 1abcdefgh', 42]) {
      await assert.rejects(getProfile(bad), (e) => code('AUTH_REQUIRED')(e));
    }
    assert.equal(srv.ctx.requests.length, 0);
    await assert.rejects(getProfile(TOKEN), (e) => code('AUTH_REQUIRED')(e) && noToken(e));
    await assert.rejects(setSkin(TOKEN, testSkin()), (e) => code('AUTH_REQUIRED')(e) && noToken(e));
  } finally { await srv.close(); }
});

test('compte sans Minecraft → NO_MINECRAFT ; 429 → RATE_LIMITED ; 500 → MOJANG_UNAVAILABLE', async () => {
  for (const [st, c] of [[404, 'NO_MINECRAFT'], [429, 'RATE_LIMITED'], [500, 'MOJANG_UNAVAILABLE'], [418, 'MOJANG_REJECTED']]) {
    const srv = await startServer({ [`GET ${API}`]: status(st) });
    try { await assert.rejects(getProfile(TOKEN), (e) => code(c)(e) && noToken(e)); } finally { await srv.close(); }
  }
});

test('changer de skin : fichier vérifié, redessiné sans métadonnées, envoyé avec le type de bras', async () => {
  let form = null;
  const srv = await startServer({
    [`POST ${API}/skins`]: (req, res, { body }) => {
      form = new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData().then(async (f) => ({
        variant: f.get('variant'), file: new Uint8Array(await f.get('file').arrayBuffer()), type: f.get('file').type,
      }));
      json(me({ slim: true }))(req, res);
    },
  });
  try {
    const src = testSkin({ extra: [pngChunk('tEXt', Buffer.from('Comment\0cache-cache'))] });
    const p = await setSkin(TOKEN, src, { model: 'slim' });
    assert.equal(p.activeSkin.model, 'slim');
    const f = await form;
    assert.equal(f.variant, 'slim');
    assert.equal(f.type, 'image/png');
    assert.equal(Buffer.from(f.file).includes(Buffer.from('cache-cache')), false);
    const back = await decodePng(f.file);
    assert.deepEqual([back.width, back.height], [64, 64]);
    assert.equal(srv.ctx.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    // modèle deviné si non donné ; Skin déjà chargé accepté ; vieux 64×32 envoyé converti en 64×64
    await setSkin(TOKEN, await loadSkin(testSkin()));
    assert.equal((await form).variant, 'classic');
    await setSkin(TOKEN, testSkin({ h: 32 }));
    assert.equal((await decodePng((await form).file)).height, 64);
  } finally { await srv.close(); }
});

test('changer de skin : mauvais fichier refusé AVANT tout envoi ; refus de Mojang compris', async () => {
  const srv = await startServer({ [`POST ${API}/skins`]: json({ errorMessage: 'bad' }, 400) });
  try {
    await assert.rejects(setSkin(TOKEN, Buffer.from('<svg/>')), code('SKIN_INVALID_FORMAT'));
    await assert.rejects(setSkin(TOKEN, testSkin({ w: 128, h: 128 }), {}), (e) => code('SKIN_INVALID_SIZE')(e) || code('SKIN_TOO_LARGE')(e));
    await assert.rejects(setSkin(TOKEN, testSkin(), { model: 'xxl' }), code('INVALID_OPTION'));
    assert.equal(srv.ctx.requests.length, 0);
    await assert.rejects(setSkin(TOKEN, testSkin()), code('SKIN_INVALID_FORMAT'));
  } finally { await srv.close(); }
});

test('réinitialiser le skin, cacher la cape', async () => {
  const srv = await startServer({ [`DELETE ${API}/skins/active`]: json(me()), [`DELETE ${API}/capes/active`]: json(me()) });
  try {
    assert.equal((await resetSkin(TOKEN)).id, ID);
    assert.equal((await hideCape(TOKEN)).activeCape, null);
    assert.deepEqual(srv.ctx.requests.map((r) => r.method), ['DELETE', 'DELETE']);
  } finally { await srv.close(); }
});

test('choisir une cape possédée ; cape non possédée refusée sans PUT', async () => {
  const capeId = 'c0ffee00-1111-2222-3333-444455556666';
  const srv = await startServer({ [`GET ${API}`]: json(me()), [`PUT ${API}/capes/active`]: json(me({ capeActive: true })) });
  try {
    const p = await setCape(TOKEN, capeId);
    assert.equal(p.activeCape.id, capeId);
    const put = srv.ctx.requests.find((r) => r.method === 'PUT');
    assert.deepEqual(JSON.parse(put.body.toString()), { capeId });
    assert.equal(put.headers['content-type'], 'application/json');
    const n = srv.ctx.requests.length;
    await assert.rejects(setCape(TOKEN, 'deadbeef-0000-0000-0000-000000000000'), code('CAPE_NOT_OWNED'));
    await assert.rejects(setCape(TOKEN, '../../x'), code('CAPE_NOT_OWNED'));
    assert.equal(srv.ctx.requests.filter((r) => r.method === 'PUT').length, 1);
    assert.ok(srv.ctx.requests.length <= n + 1);
  } finally { await srv.close(); }
});

test('cape refusée par Mojang (400) → CAPE_NOT_OWNED', async () => {
  const srv = await startServer({ [`GET ${API}`]: json(me()), [`PUT ${API}/capes/active`]: status(400) });
  try { await assert.rejects(setCape(TOKEN, 'c0ffee00-1111-2222-3333-444455556666'), code('CAPE_NOT_OWNED')); } finally { await srv.close(); }
});

test('redirection : le jeton n’est jamais renvoyé ailleurs', async () => {
  const srv = await startServer({
    [`GET ${API}`]: status(302, { location: 'https://api.minecraftservices.com/minecraft/profile2' }),
    'GET /api.minecraftservices.com/minecraft/profile2': json(me()),
    [`POST ${API}/skins`]: status(307, { location: 'https://api.minecraftservices.com/minecraft/x' }),
  });
  try {
    await getProfile(TOKEN);
    assert.equal(srv.ctx.requests[1].headers.authorization, undefined);
    await assert.rejects(setSkin(TOKEN, testSkin()), code('MOJANG_UNAVAILABLE'));
  } finally { await srv.close(); }
});

test('après un changement, le profil public gardé en cache est oublié', async () => {
  const srv = await startServer({
    [`/sessionserver.mojang.com/session/minecraft/profile/${ID}`]: json({ id: ID, name: 'Notch', properties: [{ name: 'textures', value: texturesValue({}) }] }),
    [`DELETE ${API}/skins/active`]: json(me()),
  });
  try {
    const client = createClient();
    await client.getPlayer(ID);
    await account.resetSkin(TOKEN, { client });
    const p = await client.getPlayer(ID);
    // Le profil du compte (déjà à jour) remplace l'ancien tout de suite, sans redemander à Mojang.
    assert.equal(p.skin.hash, H1);
    assert.equal(srv.ctx.hits[`/sessionserver.mojang.com/session/minecraft/profile/${ID}`], 1);
  } finally { await srv.close(); }
});
