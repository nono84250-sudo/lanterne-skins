import test from 'node:test';
import assert from 'node:assert/strict';
import { SkinError, MESSAGES, ERROR_CODES, getMessage } from '../../src/index.js';
import { toSkinError } from '../../src/errors.js';

test('chaque code a un message anglais et français ; ceux du document sont là', () => {
  for (const c of ERROR_CODES) {
    assert.ok(MESSAGES.en[c] && MESSAGES.fr[c], c);
  }
  for (const c of ['PLAYER_NOT_FOUND', 'SKIN_INVALID_FORMAT', 'SKIN_INVALID_SIZE', 'CAPE_NOT_OWNED', 'AUTH_REQUIRED', 'RATE_LIMITED', 'MOJANG_UNAVAILABLE']) assert.ok(ERROR_CODES.includes(c));
  assert.equal(MESSAGES.en.PLAYER_NOT_FOUND, 'No Minecraft player with this name.');
  assert.equal(MESSAGES.en.SKIN_INVALID_SIZE, 'The skin must be 64×64 or 64×32 pixels.');
});

test('message dans la langue du joueur, anglais par défaut', () => {
  const e = new SkinError('CAPE_NOT_OWNED');
  assert.equal(e.message, "You don't own this cape.");
  assert.equal(e.localized('fr'), 'Tu ne possèdes pas cette cape.');
  assert.equal(e.localized('fr-BE'), 'Tu ne possèdes pas cette cape.');
  assert.equal(e.localized('de'), "You don't own this cape.");
  assert.equal(getMessage('INCONNU', 'fr'), MESSAGES.en.INTERNAL);
  assert.equal(new SkinError('PAS_UN_CODE').code, 'INTERNAL');
});

test('erreurs système traduites', () => {
  assert.equal(toSkinError(Object.assign(new Error('x'), { code: 'ENOSPC' })).code, 'DISK_FULL');
  assert.equal(toSkinError(Object.assign(new Error('x'), { code: 'EACCES' })).code, 'STORAGE_FAILED');
  assert.equal(toSkinError(Object.assign(new Error('x'), { name: 'AbortError' })).code, 'CANCELLED');
  assert.equal(toSkinError(new TypeError('boom')).code, 'INTERNAL');
  const e = new SkinError('RATE_LIMITED');
  assert.equal(toSkinError(e), e);
});
