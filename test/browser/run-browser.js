/**
 * Essai dans un vrai navigateur (Chromium via Playwright, outil de test seulement) :
 * le cœur (PNG, rendus) et le visualiseur 3D marchent-ils hors de Node ?
 * Vérifie aussi qu'aucune requête ne part vers Internet.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(root, 'test', 'browser', 'out');
fs.mkdirSync(out, { recursive: true });
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.normalize(path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', types[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { console.log('Playwright absent : essai navigateur sauté'); process.exit(0); }
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const outside = [];
const errors = [];
page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outside.push(r.url()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${base}/test/browser/page.html`);
const skinB64 = fs.readFileSync(path.join(root, 'test', 'fixtures', 'pil', 'rgba.png')).toString('base64');
const capeB64 = fs.readFileSync(path.join(root, 'test', 'fixtures', 'pil', 'cape.png')).toString('base64');
const res = await page.evaluate(async ({ skinB64, capeB64 }) => {
  const L = await import('/src/index.js');
  const b = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const r = {};
  const skin = await L.loadSkin(b(skinB64));
  const cape = await L.loadCape(new Blob([b(capeB64)]));
  document.getElementById('head').src = await L.renderHead(skin, { size: 96 }).toDataURL();
  document.getElementById('front').src = await L.renderFront(skin, { scale: 6 }).toDataURL();
  r.imageData = L.renderHead(skin, { size: 8 }).toImageData().width === 8;
  try { await L.loadSkin('https://crafatar.com/x.png'); } catch (e) { r.urlRefused = e.code; }
  const before = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('vendor'));
  r.lazy = before.length === 0; // le gros fichier 3D n'est pas encore chargé
  const V = await import('/src/viewer/index.js');
  const viewer = await V.createViewer(document.getElementById('v'), { skin, cape, animation: 'walk', width: 300, height: 400, preserveDrawingBuffer: true });
  try { await viewer.setSkin('https://evil.example/skin.png'); } catch (e) { r.viewerUrlRefused = e.code; }
  viewer.setLayers({ hat: false });
  viewer.setAnimation('wave');
  await new Promise((ok) => setTimeout(ok, 800));
  const c = viewer.canvas;
  const g = document.createElement('canvas'); g.width = c.width; g.height = c.height;
  const ctx = g.getContext('2d'); ctx.drawImage(c, 0, 0);
  const d = ctx.getImageData(0, 0, g.width, g.height).data;
  let painted = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
  r.painted = painted;
  r.canvas = [c.width, c.height];
  await viewer.setCape(null);
  viewer.setElytra(true);
  await viewer.setCape(cape);
  await new Promise((ok) => setTimeout(ok, 300));
  return r;
}, { skinB64, capeB64 });
await page.screenshot({ path: path.join(out, 'navigateur.png') });
// Le visualiseur doit libérer proprement.
const disposed = await page.evaluate(async () => {
  const L = await import('/src/index.js');
  const V = await import('/src/viewer/index.js');
  const el = document.getElementById('v');
  const n = el.children.length;
  const skin = await L.loadSkin(await (await fetch('/test/fixtures/pil/rgba.png')).arrayBuffer());
  const v2 = await V.createViewer(el, { skin, animation: 'none' });
  v2.dispose();
  let bad = null;
  try { await V.createViewer(el, { skin, animation: 'danse' }); } catch (e) { bad = e.code; }
  try { await V.createViewer(el, { skin, zoom: -1 }); } catch (e) { bad = bad + '/' + e.code; }
  return el.children.length === n && bad === 'INVALID_OPTION/INVALID_OPTION';
});
await browser.close();
server.close();
const checks = {
  'rendu 2D en ImageData': res.imageData === true,
  'adresse refusée par loadSkin': res.urlRefused === 'SKIN_INVALID_FORMAT',
  '3D chargée seulement à la demande': res.lazy === true,
  'adresse refusée par le visualiseur': res.viewerUrlRefused === 'INVALID_OPTION',
  'visualiseur dessiné (pixels non vides)': res.painted > 2000,
  'visualiseur libéré proprement (et rien laissé si option invalide)': disposed,
  'aucune requête vers Internet': outside.length === 0,
  'aucune erreur dans la page': errors.length === 0,
};
let fail = 0;
for (const [k, ok] of Object.entries(checks)) { console.log(`${ok ? 'ok' : 'ÉCHEC'} - ${k}`); if (!ok) fail++; }
if (outside.length) console.log('requêtes externes :', outside);
if (errors.length) console.log('erreurs :', errors);
console.log(`pixels dessinés : ${res.painted} ; capture : ${path.join(out, 'navigateur.png')}`);
process.exit(fail ? 1 : 0);
