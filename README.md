# lanterne-skins

Têtes, skins et capes Minecraft, **sans aucun service tiers** : seulement l'API officielle de Mojang/Microsoft et notre propre code.
Marche dans Node.js (≥ 20), Electron et le navigateur. Zéro dépendance (le visualiseur 3D embarque skinview3d et three.js, licence MIT).

> English: [README.en.md](README.en.md)

## Pourquoi ce projet

Afficher la tête ou le skin d'un joueur, ou laisser quelqu'un changer son skin depuis un launcher, passe presque toujours
par des sites tiers (Crafatar, mc-heads, NameMC…). Ces services peuvent tomber en panne, limiter les requêtes,
disparaître, ou voir passer les pseudos de tous vos joueurs.

lanterne-skins fait tout lui-même :

- **Aucun service tiers.** Seulement l'API officielle de Mojang/Microsoft ; les rendus 2D sont dessinés par notre propre code.
- **Sûr.** Les images sont vérifiées puis redessinées (aucune donnée cachée), seuls 4 sites officiels sont autorisés,
  le jeton du joueur n'est jamais gardé ni journalisé.
- **Zéro dépendance**, et le même code marche dans Node.js, Electron et le navigateur.
- **Respectueux de Mojang** : cache intégré et limite de requêtes sous le seuil de Mojang.

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

`v.raw` donne accès direct à skinview3d (usages avancés) : ses fonctions acceptent des adresses web, ne jamais lui en donner une qui ne soit pas officielle.

Tailles : `renderHead` prend `size` (taille finale en pixels), `renderFront` et `renderCape` prennent `scale` (pixels par pixel du skin), pour garder des pixels nets.

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

## Toutes les commandes

### Joueurs (lecture, sans connexion)

| Fonction | Rôle |
|---|---|
| `getPlayer(pseudoOuUuid)` | UUID, pseudo, skin (lien, empreinte, bras fins ou épais), cape |
| `getSkin(joueur)` | skin du joueur, prêt à afficher (skin par défaut s'il n'en a pas) |
| `getCape(joueur)` | cape du joueur, ou `null` |
| `getTexture(empreinte)` | image brute de `textures.minecraft.net` |
| `createClient({ cache, profileTtl })` | client à part, avec son propre cache ; mêmes fonctions + `invalidate(joueur)` |
| `defaultClient()` | le client partagé utilisé par les fonctions ci-dessus |
| `parsePlayerQuery(texte)` / `textureUrl(empreinte)` | outils : reconnaître pseudo ou UUID, construire un lien de texture officiel |
| `DEFAULT_SKINS`, `defaultSkinFor(uuid)` | skins par défaut de Minecraft (Steve, Alex…) |

### Fichiers de skin et de cape

| Fonction | Rôle |
|---|---|
| `loadSkin(png, { model })` | vérifie un skin et le prépare (64×32 converti en 64×64) |
| `loadCape(png)` | vérifie une cape (64×32) |
| `detectModel(skin)` | devine bras fins (`slim`) ou épais (`classic`) |
| `convertLegacy(image)` | convertit un ancien skin 64×32 en 64×64 |
| `skin.toPNG()` | PNG propre, sans aucune donnée cachée |

### Rendus 2D

| Fonction | Rôle |
|---|---|
| `renderHead(skin, { size, hat })` | tête, avec ou sans chapeau |
| `renderFront(skin, { scale, layers, view })` | vue de face : `view: 'full'` (corps entier) ou `'bust'` (buste) |
| `renderCape(cape, { scale })` | face extérieure de la cape |
| `rendu.toPNG()` / `rendu.toDataURL()` | octets PNG, ou lien pour `<img src>` |

### Visualiseur 3D (`lanterne-skins/viewer`, navigateur et Electron)

| Commande | Rôle |
|---|---|
| `createViewer(zone, { skin, cape, animation, autoRotate })` | crée le visualiseur dans un élément de la page |
| `v.setSkin(skin)` / `v.setCape(cape)` | changer le skin ou la cape affichés |
| `v.setElytra(true)` | afficher des élytres à la place de la cape |
| `v.setAnimation(nom, vitesse)` | `'none'`, `'idle'`, `'walk'`, `'run'`, `'wave'`, `'fly'`, `'crouch'` (liste : `ANIMATIONS`) |
| `v.setLayers({ hat, jacket, ... })` | afficher ou cacher les couches |
| `v.setAutoRotate(true)` / `v.setZoom(1.5)` / `v.resetCamera()` | rotation automatique, zoom, caméra d'origine |
| `v.setSize(largeur, hauteur)` / `v.setPaused(true)` | taille, pause de l'animation |
| `v.dispose()` | libère le visualiseur |

### Son propre compte (launcher, avec le jeton Minecraft)

| Fonction | Rôle |
|---|---|
| `account.getProfile(jeton)` | mes skins et mes capes |
| `account.setSkin(jeton, png, { model })` | changer mon skin (`'classic'` ou `'slim'`) |
| `account.resetSkin(jeton)` | revenir au skin par défaut |
| `account.setCape(jeton, idCape)` | porter une cape que je possède |
| `account.hideCape(jeton)` | ne plus porter de cape |

### Cache et garde-robe (`lanterne-skins/node`, Node et Electron)

| Commande | Rôle |
|---|---|
| `createFileCache(dossier)` | cache sur le disque : `get`, `set`, `delete`, `prune()` (nettoyage), `clear()`, `close()` |
| `createMemoryCache()` / `createNoCache()` | cache en mémoire (par défaut) ou aucun cache |
| `cacheHeaders(type)` | en-têtes de cache pour un site (`'texture'`, `'profile'`, `'render'`, `'render-by-hash'`) |
| `createWardrobe(dossier)` | garde-robe locale : `list()`, `add(png, { name })`, `get(id)`, `getBytes(id)`, `rename(id, nom)`, `remove(id)` |

### Erreurs et outils

| Fonction | Rôle |
|---|---|
| `SkinError`, `ERROR_CODES`, `MESSAGES`, `getMessage(code, 'fr')` | erreurs avec un code fixe, message anglais et français |
| `decodePng`, `encodePng`, `isPng`, `readHeader`, `RgbaImage` | lecture et écriture PNG sûres |
| `ALLOWED_HOSTS`, `DEFAULT_MAX_BYTES` | sites autorisés, taille maximale d'un fichier |

### Commandes du terminal

```
npm test               # tests automatiques (faux serveur local, aucun accès Internet)
npm run test:browser   # vrai navigateur : rendus 2D + visualiseur 3D
npm run test:live      # vrais essais contre Mojang (Internet)
```

### Installation

Pas encore publié sur npm. En attendant :

```
npm install github:nono84250-sudo/lanterne-skins
```

Bibliothèque sœur : [lanterne](https://github.com/nono84250-sudo/lanterne), le moteur qui installe et lance Minecraft.

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
- Par défaut en mémoire ; `createFileCache()` pour le PC (les données périmées sont effacées au démarrage, ou avec `prune()`) ; sur le site, `cacheHeaders(type)` donne les en-têtes pour le cache de Cloudflare ou Vercel : `'texture'` et `'render-by-hash'` (pour toujours), `'profile'` et `'render'` (10 minutes).
- Les caches sont toujours revérifiés à la lecture : un fichier de cache modifié par un autre programme ne peut pas faire afficher une adresse non officielle.
- Cache personnalisé (Redis, KV…) : un objet `{ get(clé), set(clé, valeur, duréeMs), delete(clé) }` ; `get` renvoie `undefined` ou `null` quand la clé manque.
- Après `account.setSkin/resetSkin/setCape/hideCape`, passer `{ client }` (le client utilisé pour l'affichage) pour que le nouveau skin s'affiche tout de suite ; le client partagé de `getPlayer` est vidé automatiquement.
- `createFileCache(...).close()` arrête le nettoyage automatique (utile sur un serveur).
- Limite de requêtes intégrée (300 par 10 s par client, sous la limite Mojang d'environ 400) et demandes identiques simultanées regroupées.

## Ce qui n'est pas possible (volontairement)

Capes OptiFine (service tiers), historique des pseudos (supprimé par Mojang), changer le skin de quelqu'un d'autre, donner une cape, skins HD 128×128 (refusés par Mojang), skins Bedrock. Aucun historique des skins des autres joueurs n'est gardé.

## Tests

```
npm test               # tests automatiques (faux serveur local, aucun accès Internet)
npm run test:browser   # vrai navigateur : rendus 2D + visualiseur 3D (Playwright si présent)
npm run test:live      # vrais essais contre Mojang (Internet)
```

Licence MIT. Code tiers embarqué : voir [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Sécurité : [SECURITY.md](SECURITY.md). Contribuer : [CONTRIBUTING.md](CONTRIBUTING.md).
Projet indépendant, non affilié à Mojang ni Microsoft. « Minecraft » est une marque de Mojang/Microsoft.
