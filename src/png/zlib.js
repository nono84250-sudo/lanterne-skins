/**
 * Compression zlib via les flux standard (CompressionStream / DecompressionStream),
 * présents dans Node 18+, Electron et tous les navigateurs récents.
 * Aucune dépendance.
 */

function need(name) {
  const C = globalThis[name];
  if (typeof C !== 'function') throw new Error(`${name} indisponible`);
  return C;
}

async function readAll(readable, maxBytes, okIfComplete = false) {
  const reader = readable.getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      let r;
      try {
        r = await reader.read();
      } catch (err) {
        // Octets en trop après la fin des données (toléré par les autres lecteurs PNG) :
        // si tout ce qui était attendu est déjà là, on garde le résultat.
        if (okIfComplete && total === maxBytes) break;
        throw err;
      }
      const { value, done } = r;
      if (done) break;
      total += value.length;
      if (maxBytes !== undefined && total > maxBytes) {
        const e = new Error('décompression trop grosse');
        e.tooLarge = true;
        throw e;
      }
      parts.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* déjà fermé */ }
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Décompresse un flux zlib en s'arrêtant dès que maxBytes est dépassé (anti-bombe).
 * @param {Uint8Array} data
 * @param {number} maxBytes
 */
export async function inflate(data, maxBytes) {
  const DS = need('DecompressionStream');
  const ds = new DS('deflate');
  const writer = ds.writable.getWriter();
  // L'écriture se fait en parallèle de la lecture ; ses erreurs sont relues par la lecture.
  const w = writer.write(data).then(() => writer.close()).catch(() => {});
  try {
    return await readAll(ds.readable, maxBytes, true);
  } finally {
    try { await writer.abort(); } catch { /* rien */ }
    await w;
  }
}

/** Compresse en zlib. */
export async function deflate(data) {
  const CS = need('CompressionStream');
  const cs = new CS('deflate');
  const writer = cs.writable.getWriter();
  const w = writer.write(data).then(() => writer.close());
  w.catch(() => {}); // l'erreur éventuelle ressort par la lecture
  const out = await readAll(cs.readable);
  await w;
  return out;
}
