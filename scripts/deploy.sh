#!/usr/bin/env bash
# Builds the site and publishes dist/ as a production deploy to the linked Netlify site.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
npx netlify deploy --prod --no-build --dir dist --message "OrbitPad $(git rev-parse --short HEAD)"
