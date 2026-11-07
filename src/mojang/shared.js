import { createClient } from './client.js';

let shared = null;
/** Client partagé utilisé par getPlayer/getSkin/getCape au niveau du paquet. */
export function sharedClient() { return (shared ||= createClient()); }
/** Le client partagé s'il existe déjà (sans le créer). */
export function existingSharedClient() { return shared; }
