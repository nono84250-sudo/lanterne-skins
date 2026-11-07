# lanterne-skins

Têtes, skins et capes Minecraft, **sans aucun service tiers** : seulement l'API officielle de Mojang/Microsoft et notre propre code.
Marche dans Node.js (≥ 20), Electron et le navigateur. Zéro dépendance (le visualiseur 3D embarque skinview3d et three.js, licence MIT).

> English: [README.en.md](README.en.md)

## Ce que ça fait

| Fonction | Rôle | Où |
|---|---|---|
| `getPlayer(pseudoOuUuid)` | UUID, pseudo, lien du skin, bras fins/épais, cape | partout* |
| `getSkin(joueur)` / `getCape(joueur)` | skin / cape prêts à afficher | partout* |
| `loadSkin(png, {model})` | vérifie et prépare un fichier de skin (64×64 ou 64×32 → 64×64) | partout |
| `loadCape(png)` | vérifie une cape (64×32) | partout |
| `renderHead(skin, {size, hat})` | image de la tête, avec ou sans chapeau | partout |
| `renderFront(skin, {scale, layers, view})` | vue fixe de face, corps entier ou buste | partout |
| `renderCape(cape, {scale})` | face extérieure de la cape | partout |
| `createViewer(zone, {skin, cape, animation})` | visualiseur 3D qu'on fait tourner (`lanterne-skins/viewer`) | navigateur, Electron |
| `account.getProfile / setSkin / resetSkin / setCape / hideCape` | modifier **son propre** compte | launcher |
| `createFileCache(dossier)` / `createWardrobe(dossier)` | cache sur le PC, garde-robe locale (`lanterne-skins/node`) | Node, Electron |

\* Les serveurs de Mojang n'autorisent pas l'appel direct depuis une page web (CORS) : sur le site, appeler `getPlayer` côté serveur (route du site), et dans le launcher depuis le processus principal.

## Exemples

```js
import { getPlayer, getSkin, getCape, renderHead, renderFront } from 'lanterne-skins';

const joueur = await getPlayer('Notch');          // ou un UUID
const skin = await getSkin(joueur);
const tete = renderHead(skin, { size: 64, hat: true });
const png = await tete.toPNG();                   // octets PNG (Uint8Array)
const url = await tete.toDataURL();               // pour <img src>
const face = renderFront(skin, { scale: 8, layers: true, view: 'full' }); // ou view: 'bust'
const cape = await getCape(joueur);               // null si pas de cape
```

Visualiseur 3D (chargé seulement quand on l'affiche, ~520 Ko) :

```js
import { loadSkin } from 'lanterne-skins';
const { createViewer } = await import('lanterne-skins/viewer');
const v = await createViewer(document.querySelector('#zone'), { skin, cape, animation: 'walk', autoRotate: true });
v.setLayers({ hat: false });      // couches activables
v.setAnimation('wave');           // 'none', 'idle', 'walk', 'run', 'wave', 'fly', 'crouch'
await v.setSkin(autreSkin);       // aperçu avant d'appliquer
v.dispose();
```

Changer son skin (launcher). La connexion Microsoft est faite par le launcher **avec son propre client ID** ; la bibliothèque reçoit seulement le jeton Minecraft et ne le garde jamais :

```js
import { account } from 'lanterne-skins';
const moi = await account.getProfile(jeton);                  // mes skins et capes
await account.setSkin(jeton, fichierPng, { model: 'slim' });  // 'classic' = bras épais
await account.resetSkin(jeton);                                // skin par défaut
await account.setCape(jeton, moi.capes[0].id);                 // seulement une cape possédée
await account.hideCape(jeton);
```

Cache et garde-robe (Node / Electron) :

```js
import { createClient } from 'lanterne-skins';
import { createFileCache, createWardrobe } from 'lanterne-skins/node';
const client = createClient({ cache: createFileCache('<dossier du launcher>/cache/skins') });
const garde = createWardrobe('<dossier du launcher>/garde-robe');
await garde.add(fichierPng, { name: 'Mon skin d’été' });
```

## Erreurs

Chaque erreur est une `SkinError` avec un **code fixe**, un message anglais par défaut et le français fourni :
`err.code`, `err.message` (anglais), `err.localized('fr')`, ou `getMessage(code, 'fr')`.

| Code | Anglais (par défaut) |
|---|---|
| PLAYER_NOT_FOUND | No Minecraft player with this name. |
| SKIN_INVALID_FORMAT | The skin must be a PNG image. |
| SKIN_INVALID_SIZE | The skin must be 64×64 or 64×32 pixels. |
| CAPE_NOT_OWNED | You don't own this cape. |
| AUTH_REQUIRED | Sign in with Microsoft to change your skin. |
| RATE_LIMITED | Too many requests. Try again in a minute. (`err.retryAfter` en secondes) |
| MOJANG_UNAVAILABLE | Minecraft services are not responding. |

Autres codes : INVALID_NAME, SKIN_TOO_LARGE, CAPE_INVALID_FORMAT, CAPE_INVALID_SIZE, NO_MINECRAFT, MOJANG_REJECTED, HOST_NOT_ALLOWED, INSECURE_URL, CANCELLED, INVALID_OPTION, STORAGE_FAILED, DISK_FULL, NOT_SUPPORTED, INTERNAL.

## Cache

- Images de `textures.minecraft.net` : gardées **pour toujours** (un même lien ne change jamais).
- Profil (quel skin porte le joueur) : **10 minutes** (`profileTtl`). « Joueur inexistant » : 1 minute.
- Rendus (têtes déjà dessinées) : gardés en mémoire tant que le skin existe.
- Par défaut en mémoire ; `createFileCache()` pour le PC ; sur le site, `cacheHeaders('texture' | 'profile')` donne les en-têtes pour le cache de Cloudflare ou Vercel.
- Limite de requêtes intégrée (300 par 10 s par client, sous la limite Mojang d'environ 400) et demandes identiques simultanées regroupées.

## Ce qui n'est pas possible (volontairement)

Capes OptiFine (service tiers), historique des pseudos (supprimé par Mojang), changer le skin de quelqu'un d'autre, donner une cape, skins HD 128×128 (refusés par Mojang), skins Bedrock. Aucun historique des skins des autres joueurs n'est gardé.

## Tests

```
npm test               # tests automatiques (faux serveur local, aucun accès Internet)
npm run test:browser   # vrai navigateur : rendus 2D + visualiseur 3D (Playwright si présent)
npm run test:live      # vrais essais contre Mojang (Internet)
```

Licence MIT. Code tiers embarqué : voir [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Sécurité : [SECURITY.md](SECURITY.md).
Projet indépendant, non affilié à Mojang ni Microsoft. « Minecraft » est une marque de Mojang/Microsoft.
