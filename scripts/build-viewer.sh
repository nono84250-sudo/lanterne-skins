#!/bin/sh
# Reconstruit src/viewer/vendor/skinview3d.esm.js (outil de développement seulement :
# rien de tout ça n'est une dépendance de la bibliothèque). À lancer dans un dossier vide.
set -e
npm init -y >/dev/null
npm install --ignore-scripts skinview3d@3.4.2 three@0.156.1 esbuild@0.28.2
echo "export { SkinViewer, IdleAnimation, WalkingAnimation, RunningAnimation, WaveAnimation, FlyingAnimation, CrouchAnimation } from 'skinview3d';" > entry.js
npx esbuild entry.js --bundle --format=esm --minify --legal-comments=inline --target=es2020 --outfile=skinview3d.esm.js \
  --banner:js="/*! Code embarqué sous licence MIT : skinview3d 3.4.2, skinview-utils 0.7.1, three.js 0.156.1. Auteurs et textes de licence complets : THIRD-PARTY-NOTICES.md */"
