#!/usr/bin/env bash
# Run this ONCE after extracting the archive over your repo, before
# `git add .`.
set -euo pipefail
cd "$(dirname "$0")"

# A tar archive can only add/overwrite files, not delete them. If your
# repo predates the Electron 43 / pdf.js 6.2.108 migration, the old
# pdf.js 4.10.38 files (different filenames — .js, not .mjs) would
# otherwise sit alongside the new ones.
old_files=(
  "app/js/vendor/pdfjs/pdf.min.js"
  "app/js/vendor/pdfjs/pdf.worker.min.js"
)
for f in "${old_files[@]}"; do
  if [ -f "$f" ]; then rm -v "$f"; fi
done

echo ""
echo "Done."
echo ""
echo "This archive assumes your repo already has the Electron 43.3.0 /"
echo "pdf.js 6.2.108 migration and the PDF render-order fix from the prior"
echo "two delivery passes — it ships the full current state of every file"
echo "it touches (including ones those passes also modified), so extracting"
echo "it is safe either way: over an already-migrated repo, or directly"
echo "over the original pristine repo (in which case you get all three"
echo "passes' worth of changes in one shot)."
echo ""
echo "Next steps:"
echo "  rm -rf node_modules"
echo "  npm ci"
echo "  npm run verify:server"
echo "  npm run verify:viewer"
echo "  npm run verify:part2"
echo "  npm run verify:pdf-render-order"
echo "  npm run verify:file-support-policy   # new — covers this pass"
echo "  npm run dev"
