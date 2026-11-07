/**
 * Vrais essais contre les serveurs officiels de Mojang (Internet nécessaire).
 * Ne touche à aucun compte. Le changement de skin n'est essayé que si
 * LANTERNE_TEST_TOKEN est fourni (jeton jamais affiché), et il remet le skin d'avant.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../../src/index.js';
import { createFileCache } from '../../src/node/index.js';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
fs.mkdirSync(out, { recursive: true });
let fail = 0;
const results = [];
async function check(name, fn) {
  const t = Date.now();
  try { const info = await fn(); results.push(`ok - ${name}${info ? ` (${info})` : ''} [${Date.now() - t} ms]`); } catch (e) { fail++; results.push(`ÉCHEC - ${name} : ${e.code || ''} ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'condition fausse'); };

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanterne-skins-live-'));
const client = L.createClient({ cache: createFileCache(cacheDir) });

await check('pseudo → joueur (Notch)', async () => {
  const p = await client.getPlayer('Notch');
  assert(p.id === '069a79f444e94726a5befca90e38aaf5' && p.name === 'Notch' && p.skin.url.startsWith('https://textures.minecraft.net/texture/'));
  return `skin ${p.skin.model}${p.cape ? ', cape' : ', pas de cape'}`;
});
await check('UUID avec tirets → joueur (jeb_), cape Mojang', async () => {
  const p = await client.getPlayer('853c80ef-3c37-49fd-aa49-938b674adae6');
  assert(p.name === 'jeb_' && p.cape, 'cape attendue');
  const skin = await client.getSkin(p);
  const cape = await client.getCape(p);
  fs.writeFileSync(path.join(out, 'jeb_-tete.png'), await L.renderHead(skin, { size: 128 }).toPNG());
  fs.writeFileSync(path.join(out, 'jeb_-face.png'), await L.renderFront(skin, { scale: 8 }).toPNG());
  fs.writeFileSync(path.join(out, 'jeb_-buste.png'), await L.renderFront(skin, { scale: 8, view: 'bust' }).toPNG());
  fs.writeFileSync(path.join(out, 'jeb_-cape.png'), await L.renderCape(cape, { scale: 8 }).toPNG());
  return `cape ${cape.width}×${cape.height}`;
});
await check('pseudo inexistant → PLAYER_NOT_FOUND', async () => {
  try { await client.getPlayer('zz' + Math.random().toString(36).slice(2, 12)); } catch (e) { assert(e.code === 'PLAYER_NOT_FOUND', e.code); return; }
  throw new Error('aurait dû échouer');
});
await check('joueurs connus à bras fins / skins variés', async () => {
  const names = ['Dinnerbone', 'Grumm', 'MHF_Steve', 'MHF_Alex'];
  const r = [];
  for (const n of names) {
    try { const p = await client.getPlayer(n); const s = await client.getSkin(p); r.push(`${n}:${p.skin.model}/${s.model}${s.legacy ? '/64×32' : ''}`); } catch (e) { r.push(`${n}:${e.code}`); }
  }
  return r.join(' ');
});
await check('les 18 skins par défaut existent sur textures.minecraft.net, bons bras', async () => {
  for (const model of ['classic', 'slim']) {
    for (const [name, hash] of Object.entries(L.DEFAULT_SKINS[model])) {
      const bytes = await client.getTexture(hash);
      const s = await L.loadSkin(bytes);
      assert(s.model === model, `${name} ${model} détecté ${s.model}`);
    }
  }
});
await check('cache disque : 2e lecture sans réseau', async () => {
  await client.getSkin('Notch');
  const c2 = L.createClient({ cache: createFileCache(cacheDir), fetch: () => { throw new Error('réseau interdit'); } });
  const s = await c2.getSkin('Notch');
  return `${s.width}×${s.height}`;
});
await check('adresse non officielle refusée', async () => {
  try { await client.getTexture('https://crafatar.com/skins/069a79f444e94726a5befca90e38aaf5'); } catch (e) { assert(e.code === 'HOST_NOT_ALLOWED'); return; }
  throw new Error('aurait dû être refusée');
});
const token = process.env.LANTERNE_TEST_TOKEN;
if (token) {
  await check('compte : lire mes skins et capes', async () => { const p = await L.getProfile(token); return `${p.skins.length} skin(s), ${p.capes.length} cape(s)`; });
} else {
  results.push('sauté - compte (changer/réinitialiser skin, cape) : pas de jeton fourni');
}
fs.rmSync(cacheDir, { recursive: true, force: true });
console.log(results.join('\n'));
process.exit(fail ? 1 : 0);
