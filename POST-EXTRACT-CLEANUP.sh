#!/usr/bin/env bash
# Run this ONCE after extracting the archive over your repo, before
# `git add .`. A tar archive can only add/overwrite files — it can't
# delete the old pdf.js 4.10.38 files, which have different filenames
# (.js) than the new 6.2.108 ones (.mjs), so both would otherwise sit
# side by side in your repo.
set -euo pipefail
cd "$(dirname "$0")"

old_files=(
  "app/js/vendor/pdfjs/pdf.min.js"
  "app/js/vendor/pdfjs/pdf.worker.min.js"
)

for f in "${old_files[@]}"; do
  if [ -f "$f" ]; then
    rm -v "$f"
  fi
done

echo ""
echo "Done. Old pdf.js 4.10.38 files removed."
echo "New files in place: app/js/vendor/pdfjs/pdf.min.mjs, pdf.worker.min.mjs (6.2.108)"
echo ""
echo "Next steps:"
echo "  rm -rf node_modules                     # old node_modules pinned electron@30"
echo "  npm ci                                   # installs exactly what's pinned in the shipped package-lock.json (electron 43.3.0 + electron-builder 26.x)"
echo "  npm run verify:server && npm run verify:viewer && npm run verify:part2"
echo "  npm run dev                              # sanity-check locally before packaging"
