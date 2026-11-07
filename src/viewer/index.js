/**
 * Visualiseur 3D interactif (navigateur / Electron). Basé sur skinview3d et
 * three.js (licence MIT), embarqués dans le paquet : rien n'est chargé depuis
 * un site. Le gros fichier 3D (~520 Ko) n'est chargé qu'au premier createViewer().
 *
 * Seuls des skins/capes déjà vérifiés (loadSkin/loadCape) ou des octets PNG
 * sont acceptés : jamais d'adresse web, donc jamais de site tiers.
 */

import { SkinError } from '../errors.js';
import { loadSkin, loadCape, Skin, Cape } from '../core/skin.js';

let libPromise = null;
/** Charge le code 3D (une seule fois). */
export function loadViewerLibrary() {
  return (libPromise ||= import('./vendor/skinview3d.esm.js').catch((err) => {
    libPromise = null;
    throw new SkinError('NOT_SUPPORTED', '3D indisponible', { cause: err });
  }));
}

export const ANIMATIONS = Object.freeze(['none', 'idle', 'walk', 'run', 'wave', 'fly', 'crouch']);

function makeAnimation(lib, name, speed) {
  if (name === undefined || name === 'idle') name = 'idle';
  if (!ANIMATIONS.includes(name)) throw new SkinError('INVALID_OPTION', `animation : ${ANIMATIONS.join(', ')}`);
  const C = { idle: lib.IdleAnimation, walk: lib.WalkingAnimation, run: lib.RunningAnimation, wave: lib.WaveAnimation, fly: lib.FlyingAnimation, crouch: lib.CrouchAnimation }[name];
  if (!C) return null;
  const a = new C();
  if (speed !== undefined) {
    if (typeof speed !== 'number' || !(speed > 0) || speed > 10) throw new SkinError('INVALID_OPTION', 'speed');
    a.speed = speed;
  }
  return a;
}

function toCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

async function asSkin(v) {
  if (v instanceof Skin) return v;
  if (typeof v === 'string' || v instanceof URL) throw new SkinError('INVALID_OPTION', 'adresse refusée : donner un skin chargé avec loadSkin()');
  return loadSkin(v);
}
async function asCape(v) {
  if (v == null) return null;
  if (v instanceof Cape) return v;
  if (typeof v === 'string' || v instanceof URL) throw new SkinError('INVALID_OPTION', 'adresse refusée : donner une cape chargée avec loadCape()');
  return loadCape(v);
}

function applyLayers(viewer, layers) {
  const L = layers === undefined || layers === true ? {} : layers === false ? { hat: false, jacket: false, sleeves: false, pants: false } : layers;
  if (typeof L !== 'object' || L === null) throw new SkinError('INVALID_OPTION', 'layers');
  const s = viewer.playerObject.skin;
  s.head.outerLayer.visible = L.hat !== false;
  s.body.outerLayer.visible = L.jacket !== false;
  s.rightArm.outerLayer.visible = L.sleeves !== false;
  s.leftArm.outerLayer.visible = L.sleeves !== false;
  s.rightLeg.outerLayer.visible = L.pants !== false;
  s.leftLeg.outerLayer.visible = L.pants !== false;
}

/**
 * Crée le visualiseur dans un élément de la page.
 * @param {HTMLElement} container zone où afficher (un <canvas> y est ajouté)
 * @param {{skin: Skin|Uint8Array|ArrayBuffer|Blob, cape?: Cape|Uint8Array|null,
 *   animation?: 'none'|'idle'|'walk'|'run'|'wave'|'fly'|'crouch', speed?: number,
 *   layers?: boolean|{hat?:boolean,jacket?:boolean,sleeves?:boolean,pants?:boolean},
 *   width?: number, height?: number, autoRotate?: boolean, zoom?: number,
 *   background?: string|number|null, controls?: boolean, elytra?: boolean}} opts
 */
export async function createViewer(container, opts = {}) {
  if (typeof document === 'undefined' || typeof window === 'undefined') throw new SkinError('NOT_SUPPORTED', 'pas de page web ici');
  if (!container || typeof container.appendChild !== 'function') throw new SkinError('INVALID_OPTION', 'zone d’affichage');
  const skin = await asSkin(opts.skin);
  let cape = await asCape(opts.cape);
  const lib = await loadViewerLibrary();
  const width = opts.width ?? (container.clientWidth || 300);
  const height = opts.height ?? (container.clientHeight || 400);
  for (const [k, v] of [['width', width], ['height', height]]) {
    if (!Number.isFinite(v) || v < 16 || v > 8192) throw new SkinError('INVALID_OPTION', k);
  }
  // Toutes les options vérifiées AVANT de réserver la carte graphique.
  const firstAnimation = makeAnimation(lib, opts.animation, opts.speed);
  if (opts.zoom !== undefined && (typeof opts.zoom !== 'number' || !(opts.zoom > 0) || opts.zoom > 10)) throw new SkinError('INVALID_OPTION', 'zoom');
  if (opts.layers !== undefined && opts.layers !== true && opts.layers !== false && (typeof opts.layers !== 'object' || opts.layers === null)) throw new SkinError('INVALID_OPTION', 'layers');
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);
  let viewer;
  try {
    viewer = new lib.SkinViewer({ canvas, width, height, enableControls: opts.controls !== false, preserveDrawingBuffer: !!opts.preserveDrawingBuffer });
  } catch (err) {
    canvas.remove();
    throw new SkinError('NOT_SUPPORTED', '3D (WebGL) indisponible', { cause: err });
  }
  let current = { skin, cape, elytra: !!opts.elytra };
  let skinSeq = 0, capeSeq = 0;
  try {
  viewer.loadSkin(toCanvas(skin), { model: skin.model === 'slim' ? 'slim' : 'default' });
  const showCape = () => {
    if (current.cape) {
      viewer.loadCape(toCanvas(current.cape), { backEquipment: current.elytra ? 'elytra' : 'cape' });
    } else {
      viewer.loadCape(null);
    }
  };
  showCape();
  applyLayers(viewer, opts.layers);
  viewer.animation = firstAnimation;
  viewer.autoRotate = !!opts.autoRotate;
  if (opts.zoom !== undefined) viewer.zoom = opts.zoom;
  if (opts.background !== undefined) viewer.background = opts.background;
  } catch (err) {
    viewer.dispose();
    canvas.remove();
    throw err instanceof SkinError ? err : new SkinError('INVALID_OPTION', undefined, { cause: err });
  }

  return {
    /** Le canvas affiché. */
    canvas,
    /** Change le skin affiché (aperçu avant d'appliquer, par exemple). */
    async setSkin(next) {
      const seq = ++skinSeq;
      const s = await asSkin(next);
      if (seq !== skinSeq) return; // un appel plus récent a gagné
      current.skin = s;
      viewer.loadSkin(toCanvas(s), { model: s.model === 'slim' ? 'slim' : 'default' });
    },
    /** Change ou enlève (null) la cape. */
    async setCape(next) {
      const seq = ++capeSeq;
      const c = await asCape(next);
      if (seq !== capeSeq) return;
      current.cape = c;
      showCape();
    },
    /** Cape ou élytres. */
    setElytra(on) { current.elytra = !!on; showCape(); },
    setAnimation(name, speed) { viewer.animation = makeAnimation(lib, name, speed); },
    setLayers(layers) { applyLayers(viewer, layers); },
    setAutoRotate(on) { viewer.autoRotate = !!on; },
    setSize(w, h) { viewer.setSize(w, h); },
    setZoom(z) { if (typeof z !== 'number' || !(z > 0) || z > 10) throw new SkinError('INVALID_OPTION', 'zoom'); viewer.zoom = z; },
    setPaused(on) { viewer.renderPaused = !!on; },
    resetCamera() { viewer.resetCameraPose(); },
    /** Libère la carte graphique et retire le canvas. */
    dispose() { viewer.dispose(); canvas.remove(); },
    /**
     * Accès direct à skinview3d pour les usages avancés. Attention : ses fonctions acceptent
     * des adresses web ; ne jamais lui donner d'adresse qui ne soit pas officielle.
     */
    get raw() { return viewer; },
  };
}
