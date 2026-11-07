# Sécurité

## Images
- Seulement du PNG : la **signature** est vérifiée, pas l'extension. Jamais de SVG, jamais d'adresse : `loadSkin`/`loadCape` n'acceptent que des octets.
- Skin 64×64 ou 64×32, cape 64×32, sinon refus. Fichier limité à 64 Ko (réglable avec `maxBytes`).
- Les **dimensions sont lues dans l'en-tête avant toute décompression** ; la décompression s'arrête dès qu'elle dépasse la taille attendue (anti « bombe »). CRC de chaque bloc vérifié, blocs critiques inconnus refusés.
- L'image est **redessinée** avant tout envoi ou rangement : le PNG produit ne contient que les pixels (aucune métadonnée cachée).
- Une image n'est jamais exécutée.

## Réseau
- Liste **fixe** de 4 sites officiels : `api.mojang.com`, `sessionserver.mojang.com`, `textures.minecraft.net`, `api.minecraftservices.com`. Aucun service tiers (Crafatar, mc-heads, NameMC, OptiFine…).
- HTTPS obligatoire, port standard, **même après une redirection** (chaque redirection est revérifiée, 3 au maximum).
- Les liens de textures fournis par Mojang (en `http://`) ne sont acceptés que s'ils pointent vers `textures.minecraft.net/texture/<empreinte>`, et sont passés en `https://`.
- Délai maximum (15 s par défaut), taille de réponse plafonnée, annulation possible (`signal`).

## Compte
- Le jeton Minecraft est donné par l'appelant à chaque appel ; la bibliothèque **ne le stocke jamais**, ne l'écrit dans aucune erreur ni journal, l'envoie seulement à `api.minecraftservices.com`, et **le retire après une redirection**.
- La bibliothèque ne fait pas la connexion Microsoft et ne contient **aucun client ID** : le launcher utilise le sien.
- Une cape n'est demandée que si elle figure dans les capes possédées du joueur.

## Disque (`lanterne-skins/node`)
- Écriture dans un fichier `.part` puis renommage (jamais de fichier à moitié écrit).
- Noms de fichiers calculés par la bibliothèque (empreintes, identifiants aléatoires) : aucun chemin fourni par l'extérieur n'est utilisé.
- Fichiers abîmés ignorés ; un cache en panne (disque plein) n'empêche jamais de fonctionner.

## Vie privée
Aucun historique des skins des autres joueurs n'est gardé (RGPD) : seulement un cache court du profil. La garde-robe ne contient que ce que le joueur range lui-même, sur son PC.

Signaler un problème de sécurité : en privé aux mainteneurs, pas dans un ticket public.
