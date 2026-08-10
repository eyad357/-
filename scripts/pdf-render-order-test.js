'use strict';
/*
 * Regression test for the "canvas attached before render" PDF corruption bug.
 *
 * ROOT CAUSE (see PDF-ARCHITECTURE-REVIEW.md for full A/B evidence):
 * Rendering a PDF page into a <canvas> that is ALREADY attached to the live
 * document makes Chromium take a different native-font rasterization path
 * than an off-DOM canvas. For PDFs with certain broken/unusual embedded
 * TrueType hinting tables (confirmed on a real school-uploaded PDF), that
 * path corrupts glyph advance widths — letters render with scattered extra
 * gaps mid-word. The exact same render into a detached canvas, attached only
 * after rendering completes, is always correct.
 *
 * This is NOT fixable via disableFontFace (verified: forcing pdf.js's own
 * glyph-path renderer avoids that bug but breaks Arabic ligature joining on
 * a different real PDF), so the only durable fix is architectural: never
 * attach a canvas to the document before PDFEngine has finished rendering
 * into it.
 *
 * This test doesn't spin up a browser (no new dependency) — it statically
 * verifies the invariant is preserved in source, so a future edit that
 * reorders "attach" before "render" fails CI immediately instead of
 * shipping a silent, hard-to-reproduce visual bug.
 */
const fs = require('fs');
const path = require('path');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, pass: true, detail });
  } catch (err) {
    results.push({ name, pass: false, detail: err.message });
  }
}

const pdfEngineSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'pdf-engine.js'), 'utf8');
const viewerSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'viewer.js'), 'utf8');

check('PDFEngine.renderPageToCanvas warns if canvas is already attached', () => {
  const fnMatch = pdfEngineSrc.match(/function renderPageToCanvas\([^)]*\)\s*{[\s\S]*?\n  }/);
  if (!fnMatch) throw new Error('renderPageToCanvas function not found');
  if (!/canvas\.isConnected/.test(fnMatch[0])) {
    throw new Error('missing canvas.isConnected guard — the dev-time warning for this exact bug class was removed');
  }
});

function assertRenderBeforeAttach(fnSource, fnName, renderPattern, attachPatterns) {
  const renderIdx = fnSource.search(renderPattern);
  if (renderIdx === -1) throw new Error(`${fnName}: could not find the render call (pattern: ${renderPattern})`);
  for (const attachPattern of attachPatterns) {
    const attachIdx = fnSource.search(attachPattern);
    if (attachIdx === -1) continue; // this particular attach call isn't present in this function; fine
    if (attachIdx < renderIdx) {
      throw new Error(
        `${fnName}: found a DOM-attach call (${attachPattern}) BEFORE the render call. ` +
        `This is exactly the bug this test guards against — the canvas must be rendered ` +
        `off-DOM and attached only after rendering completes.`
      );
    }
  }
}

check('viewer.js renderOne() renders before inserting the canvas into the DOM', () => {
  const fnMatch = viewerSrc.match(/async function renderOne\(entry\) {[\s\S]*?\n    }/);
  if (!fnMatch) throw new Error('renderOne function not found');
  assertRenderBeforeAttach(
    fnMatch[0],
    'renderOne',
    /await PDFEngine\.renderPageToCanvas/,
    [/wrap\.insertBefore\(canvas/, /wrap\.appendChild\(canvas/]
  );
});

check('viewer.js buildPdfThumbnails() renders before attaching each thumbnail canvas', () => {
  const fnMatch = viewerSrc.match(/function buildPdfThumbnails\(doc\) {[\s\S]*?\n  }/);
  if (!fnMatch) throw new Error('buildPdfThumbnails function not found');
  assertRenderBeforeAttach(
    fnMatch[0],
    'buildPdfThumbnails',
    /await PDFEngine\.renderPageToCanvas/,
    [/t\.appendChild\(c\)/]
  );
  // Also guard against the specific old pattern this bug shipped as:
  // building the canvas via innerHTML (which attaches it immediately) and
  // then querying it back out with querySelector to render into.
  if (/innerHTML[\s\S]{0,80}<canvas/.test(fnMatch[0])) {
    throw new Error('buildPdfThumbnails: canvas is created via innerHTML, which attaches it before render — regression of the original bug');
  }
});

check('thumbnails.js (file-manager thumbnails) never creates an attached canvas', () => {
  const thumbSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'thumbnails.js'), 'utf8');
  // This file is expected to just delegate to PDFEngine.renderThumbnailDataUrl,
  // which always creates its own detached canvas — flag it if that changes.
  if (!/PDFEngine\.renderThumbnailDataUrl/.test(thumbSrc)) {
    throw new Error('thumbnails.js no longer delegates to PDFEngine.renderThumbnailDataUrl — re-verify it never renders into an attached canvas');
  }
});

console.log('\n=== PDF RENDER-ORDER REGRESSION TEST RESULTS ===');
let failures = 0;
for (const r of results) {
  console.log((r.pass ? '✅ ' : '❌ ') + ' ' + r.name + (r.pass ? '' : `\n     ${r.detail}`));
  if (!r.pass) failures++;
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
