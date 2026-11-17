#!/usr/bin/env bash
# Builds the site and force-pushes dist/ to the gh-pages branch (GitHub Pages source).
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
touch dist/.nojekyll
cd dist
rm -rf .git
git init -q -b gh-pages
git add -A
git commit -q -m "Deploy OrbitPad $(git -C .. rev-parse --short HEAD)"
git push -f "$(git -C .. remote get-url origin)" gh-pages
