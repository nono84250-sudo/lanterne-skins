# lanterne-skins

Minecraft heads, skins and capes with **no third-party service**: only the official Mojang/Microsoft API and our own code.
Runs in Node.js (≥ 20), Electron and the browser. Zero dependencies (the 3D viewer bundles skinview3d and three.js, MIT).

## Why this project

Showing a player's head or skin, or letting someone change their skin from a launcher, almost always relies on
third-party sites (Crafatar, mc-heads, NameMC…). Those services can go down, rate-limit you, disappear,
or see the usernames of all your players.

lanterne-skins does it all itself:

- **No third-party service.** Only the official Mojang/Microsoft API; 2D renders are drawn by our own code.
- **Secure.** Images are checked then redrawn (no hidden data), only 4 official hosts are allowed,
  the player's token is never stored or logged.
- **Zero dependencies**, and the same code runs in Node.js, Electron and the browser.
- **Fair to Mojang**: built-in cache and a request limit below Mojang's threshold.

## API

| Function | Purpose |
|---|---|
| `getPlayer(nameOrUuid)` | UUID, name, skin URL, arm model (classic/slim), cape |
| `getSkin(player)` / `getCape(player)` | ready-to-draw skin / cape (or `null`) |
| `loadSkin(png, {model, maxBytes})` | validate a skin file (64×64, or 64×32 converted to 64×64) |
| `loadCape(png)` | validate a cape (64×32) |
| `renderHead(skin, {size, hat})` | head image, with or without the hat layer |
| `renderFront(skin, {scale, layers, view})` | fixed front view, full body or `'bust'` |
| `renderCape(cape, {scale})` | outer face of the cape |
| `createViewer(el, {skin, cape, animation, layers, autoRotate})` | interactive 3D viewer (`lanterne-skins/viewer`, lazy-loaded) |
| `account.getProfile/setSkin/resetSkin/setCape/hideCape(token, …)` | change **your own** account |
| `createFileCache(dir)`, `createWardrobe(dir)` | disk cache and local wardrobe (`lanterne-skins/node`) |
| `createClient({cache, timeout, rateLimit, profileTtl, fetch})` | client with its own cache |
| `cacheHeaders('texture'|'render-by-hash'|'profile'|'render')` | suggested HTTP cache headers for a website route (forever / 10 minutes) |

Rendered images are `RgbaImage` objects (`width`, `height`, `data` RGBA) with `toPNG()`, `toDataURL()` and `toImageData()`.

Mojang servers do not allow direct calls from a web page (CORS): call `getPlayer` server-side on a website, and from the main process in Electron.

The library does not sign in with Microsoft and ships **no client ID**: your launcher signs in with its own client ID and passes the Minecraft access token, which is never stored or logged.

## All commands

### Players (read-only, no sign-in)

| Function | Purpose |
|---|---|
| `getPlayer(nameOrUuid)` | UUID, username, skin (URL, hash, slim or classic arms), cape |
| `getSkin(player)` | player's skin, ready to display (default skin if none) |
| `getCape(player)` | player's cape, or `null` |
| `getTexture(hash)` | raw image from `textures.minecraft.net` |
| `createClient({ cache, profileTtl })` | separate client with its own cache; same functions + `invalidate(player)` |
| `defaultClient()` | the shared client used by the functions above |
| `parsePlayerQuery(text)` / `textureUrl(hash)` | helpers: detect name or UUID, build an official texture URL |
| `DEFAULT_SKINS`, `defaultSkinFor(uuid)` | Minecraft default skins (Steve, Alex…) |

### Skin and cape files

| Function | Purpose |
|---|---|
| `loadSkin(png, { model })` | checks and prepares a skin (64×32 converted to 64×64) |
| `loadCape(png)` | checks a cape (64×32) |
| `detectModel(skin)` | guesses slim or classic arms |
| `convertLegacy(image)` | converts an old 64×32 skin to 64×64 |
| `skin.toPNG()` | clean PNG with no hidden data |

### 2D renders

| Function | Purpose |
|---|---|
| `renderHead(skin, { size, hat })` | head, with or without hat |
| `renderFront(skin, { scale, layers, view })` | front view: `view: 'full'` (whole body) or `'bust'` |
| `renderCape(cape, { scale })` | outer side of the cape |
| `render.toPNG()` / `render.toDataURL()` | PNG bytes, or a URL for `<img src>` |

### 3D viewer (`lanterne-skins/viewer`, browser and Electron)

| Command | Purpose |
|---|---|
| `createViewer(element, { skin, cape, animation, autoRotate })` | creates the viewer inside a page element |
| `v.setSkin(skin)` / `v.setCape(cape)` | change the displayed skin or cape |
| `v.setElytra(true)` | show an elytra instead of the cape |
| `v.setAnimation(name, speed)` | `'none'`, `'idle'`, `'walk'`, `'run'`, `'wave'`, `'fly'`, `'crouch'` (list: `ANIMATIONS`) |
| `v.setLayers({ hat, jacket, ... })` | show or hide layers |
| `v.setAutoRotate(true)` / `v.setZoom(1.5)` / `v.resetCamera()` | auto-rotate, zoom, reset camera |
| `v.setSize(width, height)` / `v.setPaused(true)` | size, pause animation |
| `v.dispose()` | frees the viewer |

### Your own account (launcher, with the Minecraft token)

| Function | Purpose |
|---|---|
| `account.getProfile(token)` | my skins and capes |
| `account.setSkin(token, png, { model })` | change my skin (`'classic'` or `'slim'`) |
| `account.resetSkin(token)` | back to the default skin |
| `account.setCape(token, capeId)` | wear a cape I own |
| `account.hideCape(token)` | stop wearing a cape |

### Cache and wardrobe (`lanterne-skins/node`, Node and Electron)

| Command | Purpose |
|---|---|
| `createFileCache(dir)` | disk cache: `get`, `set`, `delete`, `prune()`, `clear()`, `close()` |
| `createMemoryCache()` / `createNoCache()` | in-memory cache (default) or none |
| `cacheHeaders(type)` | cache headers for a website (`'texture'`, `'profile'`, `'render'`, `'render-by-hash'`) |
| `createWardrobe(dir)` | local wardrobe: `list()`, `add(png, { name })`, `get(id)`, `getBytes(id)`, `rename(id, name)`, `remove(id)` |

### Errors and helpers

| Function | Purpose |
|---|---|
| `SkinError`, `ERROR_CODES`, `MESSAGES`, `getMessage(code, 'fr')` | errors with a fixed code, English and French messages |
| `decodePng`, `encodePng`, `isPng`, `readHeader`, `RgbaImage` | safe PNG reading and writing |
| `ALLOWED_HOSTS`, `DEFAULT_MAX_BYTES` | allowed hosts, maximum file size |

### Terminal commands

```
npm test               # automated tests (local fake server, no Internet)
npm run test:browser   # real browser: 2D renders + 3D viewer
npm run test:live      # real runs against Mojang (Internet)
```

### Installation

Not published on npm yet. In the meantime:

```
npm install github:nono84250-sudo/lanterne-skins
```

Sister library: [lanterne](https://github.com/nono84250-sudo/lanterne), the engine that installs and launches Minecraft.

## Errors

| Code | Message |
|---|---|
| PLAYER_NOT_FOUND | No Minecraft player with this name. |
| SKIN_INVALID_FORMAT | The skin must be a PNG image. |
| SKIN_INVALID_SIZE | The skin must be 64×64 or 64×32 pixels. |
| CAPE_NOT_OWNED | You don't own this cape. |
| AUTH_REQUIRED | Sign in with Microsoft to change your skin. |
| RATE_LIMITED | Too many requests. Try again in a minute. |
| MOJANG_UNAVAILABLE | Minecraft services are not responding. |

Every error is a `SkinError` with a stable `code`, an English `message`, and `err.localized('fr')` for French.
Codes: PLAYER_NOT_FOUND, INVALID_NAME, SKIN_INVALID_FORMAT, SKIN_INVALID_SIZE, SKIN_TOO_LARGE, CAPE_INVALID_FORMAT, CAPE_INVALID_SIZE, CAPE_NOT_OWNED, AUTH_REQUIRED, NO_MINECRAFT, RATE_LIMITED, MOJANG_UNAVAILABLE, MOJANG_REJECTED, HOST_NOT_ALLOWED, INSECURE_URL, CANCELLED, INVALID_OPTION, STORAGE_FAILED, DISK_FULL, NOT_SUPPORTED, INTERNAL.

## Cache
Textures forever, profiles 10 minutes, "not found" 1 minute, rendered images memoised per skin. Built-in rate limit (300 requests / 10 s per client) and request de-duplication.

MIT licence. See [SECURITY.md](SECURITY.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Not affiliated with Mojang or Microsoft.
