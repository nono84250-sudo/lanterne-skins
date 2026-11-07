/**
 * Skins par défaut du jeu (depuis 1.19.3 : 9 personnages × 2 types de bras).
 * Ce ne sont que des liens vers textures.minecraft.net (rien n'est redistribué).
 * Le jeu choisit le skin par défaut d'après l'UUID du joueur, comme ici.
 */

const NAMES = ['alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'steve', 'sunny', 'zuri'];

export const DEFAULT_SKINS = Object.freeze({
  slim: Object.freeze({
    alex: '46acd06e8483b176e8ea39fc12fe105eb3a2a4970f5100057e9d84d4b60bdfa7',
    ari: '6ac6ca262d67bcfb3dbc924ba8215a18195497c780058a5749de674217721892',
    efe: 'fece7017b1bb13926d1158864b283b8b930271f80a90482f174cca6a17e88236',
    kai: '226c617fde5b1ba569aa08bd2cb6fd84c93337532a872b3eb7bf66bdd5b395f8',
    makena: '7cb3ba52ddd5cc82c0b050c3f920f87da36add80165846f479079663805433db',
    noor: '6c160fbd16adbc4bff2409e70180d911002aebcfa811eb6ec3d1040761aea6dd',
    steve: 'd5c4ee5ce20aed9e33e866c66caa37178606234b3721084bf01d13320fb2eb3f',
    sunny: 'b66bc80f002b10371e2fa23de6f230dd5e2f3affc2e15786f65bc9be4c6eb71a',
    zuri: 'eee522611005acf256dbd152e992c60c0bb7978cb0f3127807700e478ad97664',
  }),
  classic: Object.freeze({
    alex: '1abc803022d8300ab7578b189294cce39622d9a404cdc00d3feacfdf45be6981',
    ari: '4c05ab9e07b3505dc3ec11370c3bdce5570ad2fb2b562e9b9dd9cf271f81aa44',
    efe: 'daf3d88ccb38f11f74814e92053d92f7728ddb1a7955652a60e30cb27ae6659f',
    kai: 'e5cdc3243b2153ab28a159861be643a4fc1e3c17d291cdd3e57a7f370ad676f3',
    makena: 'dc0fcfaf2aa040a83dc0de4e56058d1bbb2ea40157501f3e7d15dc245e493095',
    noor: '90e75cd429ba6331cd210b9bd19399527ee3bab467b5a9f61cb8a27b177f6789',
    steve: '31f477eb1a7beee631c2ca64d06f8f68fa93a3386d04452ab27f43acdf1b60cb',
    sunny: 'a3bd16079f764cd541e072e888fe43885e711f98658323db0f9a6045da91ee7a',
    zuri: 'f5dddb41dcafef616e959c2817808e0be741c89ffbfed39134a13e75b811863d',
  }),
});

/** UUID.hashCode() de Java, pour un UUID en 32 caractères hexadécimaux. */
export function javaUuidHash(id) {
  const n = (s) => parseInt(s, 16) | 0;
  const msHi = n(id.slice(0, 8)), msLo = n(id.slice(8, 16)), lsHi = n(id.slice(16, 24)), lsLo = n(id.slice(24, 32));
  return (msHi ^ lsHi) ^ (msLo ^ lsLo);
}

/** Skin par défaut qu'affiche le jeu pour cet UUID. */
export function defaultSkinFor(id) {
  const idx = ((javaUuidHash(id) % 18) + 18) % 18;
  const model = idx < 9 ? 'slim' : 'classic';
  const name = NAMES[idx % 9];
  const hash = DEFAULT_SKINS[model][name];
  return { url: `https://textures.minecraft.net/texture/${hash}`, hash, model, defaultName: name };
}
