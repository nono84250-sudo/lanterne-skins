import { encodePng } from '../png/png.js';
import { SkinError } from '../errors.js';

/**
 * Image en pixels RVBA 8 bits (4 octets par pixel, ligne par ligne).
 * `data` est directement utilisable par `new ImageData(data, width, height)` dans un navigateur.
 */
export class RgbaImage {
  constructor(width, height, data) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new SkinError('INVALID_OPTION', 'dimensions');
    }
    this.width = width;
    this.height = height;
    this.data = data || new Uint8ClampedArray(width * height * 4);
    if (this.data.length !== width * height * 4) throw new SkinError('INVALID_OPTION', 'pixels');
  }

  /** PNG propre (aucune métadonnée). */
  toPNG() { return encodePng(this); }

  /** Adresse « data:image/png;base64,… » pour une balise <img>. */
  async toDataURL() { return 'data:image/png;base64,' + toBase64(await this.toPNG()); }

  /** ImageData (navigateur / Electron seulement). */
  toImageData() {
    if (typeof ImageData !== 'function') throw new SkinError('NOT_SUPPORTED', 'ImageData');
    return new ImageData(new Uint8ClampedArray(this.data), this.width, this.height);
  }

  clone() { return new RgbaImage(this.width, this.height, new Uint8ClampedArray(this.data)); }

  /** Alpha d'un pixel. */
  alphaAt(x, y) { return this.data[(y * this.width + x) * 4 + 3]; }
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Copie un rectangle de src vers dst, avec mise à l'échelle entière (au plus proche)
 * et miroir horizontal facultatif.
 * mode 'copy' remplace, 'over' superpose selon l'alpha.
 */
export function blit(src, sx, sy, sw, sh, dst, dx, dy, scale = 1, { mirror = false, mode = 'copy' } = {}) {
  const s = src.data, d = dst.data;
  for (let y = 0; y < sh * scale; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    const syy = sy + Math.floor(y / scale);
    for (let x = 0; x < sw * scale; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      let sxx = Math.floor(x / scale);
      if (mirror) sxx = sw - 1 - sxx;
      const si = (syy * src.width + sx + sxx) * 4;
      const di = (ty * dst.width + tx) * 4;
      if (mode === 'copy') {
        d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = s[si + 3];
      } else {
        const a = s[si + 3];
        if (a === 0) continue;
        if (a === 255) { d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = 255; continue; }
        const da = d[di + 3];
        const oa = a + (da * (255 - a)) / 255;
        for (let c = 0; c < 3; c++) d[di + c] = Math.round((s[si + c] * a + (d[di + c] * da * (255 - a)) / 255) / oa);
        d[di + 3] = Math.round(oa);
      }
    }
  }
}
