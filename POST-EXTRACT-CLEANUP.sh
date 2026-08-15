#!/usr/bin/env bash
# Run this ONCE after extracting the archive over your repo, before
# `git add .`.
set -euo pipefail
cd "$(dirname "$0")"

# A tar archive can only add/overwrite files, not delete them. If your
# repo predates the Electron 43 / pdf.js 6.2.108 migration, remove the
# old pdf.js 4.10.38 files (different filenames — .js, not .mjs).
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
echo "PPTX real-rendering presentation mode requires LibreOffice to be"
echo "installed on the machine running the app for full-fidelity preview"
echo "(the app detects it automatically at common install paths, or via"
echo "the SCHOOL_APP_SOFFICE_PATH environment variable). Without it,"
echo "PPTX files fall back to the older text/image extraction preview"
echo "with a clear on-screen notice — never a broken page."
echo ""
echo "This archive ships the full current state of every file it touches"
echo "(including ones the two prior delivery passes also modified), so"
echo "extracting it is safe whether your repo already has those passes"
echo "applied, or is the original pristine repo."
echo ""
echo "Next steps:"
echo "  rm -rf node_modules"
echo "  npm ci"
echo "  npm run verify:server"
echo "  npm run verify:viewer"
echo "  npm run verify:part2"
echo "  npm run verify:pdf-render-order"
echo "  npm run verify:file-support-policy"
echo "  npm run verify:pptx-conversion   # new — requires LibreOffice installed"
echo "  node scripts/part2-remaining-test.js"
echo "  node scripts/completion-engine-test.js"
echo "  npm run dev"
