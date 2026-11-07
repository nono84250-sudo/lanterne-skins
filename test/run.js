/**
 * Lance les tests automatiques (node:test, intégré à Node) avec le certificat
 * du faux serveur local ajouté aux certificats de confiance.
 * Marche sous Windows, Mac et Linux.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cert = path.join(here, 'fixtures', 'test-cert.pem');
let caFile = cert;
if (process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(process.env.NODE_EXTRA_CA_CERTS)) {
  caFile = path.join(os.tmpdir(), `lanterne-skins-ca-${process.pid}.pem`);
  fs.writeFileSync(caFile, fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8') + '\n' + fs.readFileSync(cert, 'utf8'));
}
const dir = path.join(here, 'unit');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
const env = { ...process.env, NODE_EXTRA_CA_CERTS: caFile, NODE_NO_WARNINGS: '1' };
delete env.NODE_USE_ENV_PROXY; // le faux serveur est local
env.NO_PROXY = [env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',');
if (env.NODE_OPTIONS) env.NODE_OPTIONS = env.NODE_OPTIONS.replace('--use-openssl-ca', '').trim();
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...files], { stdio: 'inherit', env });
if (caFile !== cert) fs.rmSync(caFile, { force: true });
process.exit(r.status === null ? 1 : r.status);
