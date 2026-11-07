/**
 * Toutes les erreurs de la bibliothèque sont des SkinError : un code fixe
 * (stable, pour le code appelant), un message en anglais par défaut, et le
 * français fourni. Le launcher ou le site affiche le message dans la langue
 * du joueur à partir du code. Aucun jeton n'est jamais mis dans une erreur.
 */

export const MESSAGES = Object.freeze({
  en: Object.freeze({
    PLAYER_NOT_FOUND: 'No Minecraft player with this name.',
    INVALID_NAME: 'This is not a valid Minecraft name or UUID.',
    SKIN_INVALID_FORMAT: 'The skin must be a PNG image.',
    SKIN_INVALID_SIZE: 'The skin must be 64×64 or 64×32 pixels.',
    SKIN_TOO_LARGE: 'The skin file is too large.',
    CAPE_INVALID_FORMAT: 'The cape must be a PNG image.',
    CAPE_INVALID_SIZE: 'The cape must be 64×32 pixels.',
    CAPE_NOT_OWNED: "You don't own this cape.",
    AUTH_REQUIRED: 'Sign in with Microsoft to change your skin.',
    NO_MINECRAFT: "This Microsoft account doesn't own Minecraft.",
    RATE_LIMITED: 'Too many requests. Try again in a minute.',
    MOJANG_UNAVAILABLE: 'Minecraft services are not responding.',
    MOJANG_REJECTED: 'Minecraft services refused the request.',
    HOST_NOT_ALLOWED: 'This address is not an official Minecraft address.',
    INSECURE_URL: 'Only secure (https) addresses are allowed.',
    CANCELLED: 'Cancelled.',
    INVALID_OPTION: 'Invalid option.',
    STORAGE_FAILED: 'Could not read or write the local files.',
    DISK_FULL: 'The disk is full.',
    NOT_SUPPORTED: 'This feature is not available here.',
    INTERNAL: 'Unexpected error.',
  }),
  fr: Object.freeze({
    PLAYER_NOT_FOUND: "Aucun joueur Minecraft ne porte ce pseudo.",
    INVALID_NAME: "Ce n'est pas un pseudo ou un UUID Minecraft valide.",
    SKIN_INVALID_FORMAT: 'Le skin doit être une image PNG.',
    SKIN_INVALID_SIZE: 'Le skin doit faire 64×64 ou 64×32 pixels.',
    SKIN_TOO_LARGE: 'Le fichier du skin est trop gros.',
    CAPE_INVALID_FORMAT: 'La cape doit être une image PNG.',
    CAPE_INVALID_SIZE: 'La cape doit faire 64×32 pixels.',
    CAPE_NOT_OWNED: "Tu ne possèdes pas cette cape.",
    AUTH_REQUIRED: 'Connecte-toi avec Microsoft pour changer ton skin.',
    NO_MINECRAFT: "Ce compte Microsoft ne possède pas Minecraft.",
    RATE_LIMITED: 'Trop de demandes. Réessaie dans une minute.',
    MOJANG_UNAVAILABLE: 'Les services Minecraft ne répondent pas.',
    MOJANG_REJECTED: 'Les services Minecraft ont refusé la demande.',
    HOST_NOT_ALLOWED: "Cette adresse n'est pas une adresse officielle de Minecraft.",
    INSECURE_URL: 'Seules les adresses sécurisées (https) sont acceptées.',
    CANCELLED: 'Annulé.',
    INVALID_OPTION: 'Option invalide.',
    STORAGE_FAILED: 'Impossible de lire ou d’écrire les fichiers sur le disque.',
    DISK_FULL: 'Le disque est plein.',
    NOT_SUPPORTED: "Cette fonction n'est pas disponible ici.",
    INTERNAL: 'Erreur inattendue.',
  }),
});

export const ERROR_CODES = Object.freeze(Object.keys(MESSAGES.en));

/** Message d'un code dans une langue (anglais si la langue ou le code est inconnu). */
export function getMessage(code, lang = 'en') {
  const table = MESSAGES[String(lang).slice(0, 2).toLowerCase()] || MESSAGES.en;
  return table[code] || MESSAGES.en[code] || MESSAGES.en.INTERNAL;
}

export class SkinError extends Error {
  /**
   * @param {string} code un des ERROR_CODES
   * @param {string} [detail] précision technique courte (jamais de jeton)
   * @param {{cause?: unknown, status?: number, retryAfter?: number}} [extra]
   */
  constructor(code, detail, extra = {}) {
    const base = MESSAGES.en[code] ? code : 'INTERNAL';
    const msg = MESSAGES.en[base];
    super(detail ? `${msg} (${detail})` : msg, extra.cause ? { cause: extra.cause } : undefined);
    this.name = 'SkinError';
    this.code = base;
    this.detail = detail ? String(detail).slice(0, 300) : '';
    if (extra.status) this.status = extra.status;
    if (extra.retryAfter) this.retryAfter = extra.retryAfter;
  }

  /** Message pour le joueur dans sa langue ('en' ou 'fr'). */
  localized(lang) { return getMessage(this.code, lang); }
}

/** Toute erreur qui sort de la bibliothèque devient une SkinError. */
export function toSkinError(err) {
  if (err instanceof SkinError) return err;
  if (err && err.name === 'AbortError') return new SkinError('CANCELLED', undefined, { cause: err });
  const code = err && err.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return new SkinError('DISK_FULL', undefined, { cause: err });
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return new SkinError('STORAGE_FAILED', code, { cause: err });
  return new SkinError('INTERNAL', err && err.message ? String(err.message).slice(0, 200) : undefined, { cause: err });
}
