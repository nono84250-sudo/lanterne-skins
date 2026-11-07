/**
 * lanterne-skins : têtes, skins, capes Minecraft, sans aucun service tiers.
 * Marche dans Node, Electron et le navigateur (sauf ./node, réservé à Node/Electron).
 * Le visualiseur 3D est à part : import('lanterne-skins/viewer'), chargé seulement quand on l'affiche.
 */

import { createClient } from './mojang/client.js';

export { SkinError, MESSAGES, ERROR_CODES, getMessage } from './errors.js';
export { RgbaImage } from './core/image.js';
export { loadSkin, loadCape, Skin, Cape, convertLegacy, detectModel, DEFAULT_MAX_BYTES } from './core/skin.js';
export { renderHead, renderFront, renderCape } from './core/render.js';
export { decodePng, encodePng, isPng, readHeader } from './png/png.js';
export { createClient, parsePlayerQuery, textureUrl } from './mojang/client.js';
export { createMemoryCache, createNoCache, cacheHeaders } from './mojang/cache.js';
export { ALLOWED_HOSTS } from './mojang/net.js';
export { DEFAULT_SKINS, defaultSkinFor } from './mojang/defaults.js';
export { account, getProfile, setSkin, resetSkin, setCape, hideCape } from './mojang/account.js';

let shared = null;
const client = () => (shared ||= createClient());

/** Joueur par pseudo ou UUID : UUID, pseudo, lien du skin, bras, cape. */
export const getPlayer = (q, o) => client().getPlayer(q, o);
/** Skin prêt à afficher d'un joueur. */
export const getSkin = (q, o) => client().getSkin(q, o);
/** Cape Mojang d'un joueur, ou null. */
export const getCape = (q, o) => client().getCape(q, o);
/** Octets PNG d'une image officielle de textures.minecraft.net. */
export const getTexture = (h, o) => client().getTexture(h, o);
/** Le client partagé utilisé par getPlayer/getSkin/getCape (utile pour vider son cache). */
export const defaultClient = () => client();
