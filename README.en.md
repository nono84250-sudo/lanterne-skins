# lanterne-skins

Minecraft heads, skins and capes with **no third-party service**: only the official Mojang/Microsoft API and our own code.
Runs in Node.js (≥ 20), Electron and the browser. Zero dependencies (the 3D viewer bundles skinview3d and three.js, MIT).

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
| `cacheHeaders('texture'|'profile')` | suggested HTTP cache headers for a website route |

Rendered images are `RgbaImage` objects (`width`, `height`, `data` RGBA) with `toPNG()`, `toDataURL()` and `toImageData()`.

Mojang servers do not allow direct calls from a web page (CORS): call `getPlayer` server-side on a website, and from the main process in Electron.

The library does not sign in with Microsoft and ships **no client ID**: your launcher signs in with its own client ID and passes the Minecraft access token, which is never stored or logged.

## Errors

Every error is a `SkinError` with a stable `code`, an English `message`, and `err.localized('fr')` for French.
Codes: PLAYER_NOT_FOUND, INVALID_NAME, SKIN_INVALID_FORMAT, SKIN_INVALID_SIZE, SKIN_TOO_LARGE, CAPE_INVALID_FORMAT, CAPE_INVALID_SIZE, CAPE_NOT_OWNED, AUTH_REQUIRED, NO_MINECRAFT, RATE_LIMITED, MOJANG_UNAVAILABLE, MOJANG_REJECTED, HOST_NOT_ALLOWED, INSECURE_URL, CANCELLED, INVALID_OPTION, STORAGE_FAILED, DISK_FULL, NOT_SUPPORTED, INTERNAL.

## Cache
Textures forever, profiles 10 minutes, "not found" 1 minute, rendered images memoised per skin. Built-in rate limit (300 requests / 10 s per client) and request de-duplication.

MIT licence. See [SECURITY.md](SECURITY.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Not affiliated with Mojang or Microsoft.
