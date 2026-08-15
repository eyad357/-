'use strict';
/*
 * OFFICE CONVERSION SERVICE
 * ─────────────────────────
 * Converts PPTX (and, by the same mechanism, any format LibreOffice can
 * read) to PDF using a locally-installed, headless LibreOffice — then the
 * existing, already-hardened PDF.js pipeline (PDFEngine) renders it. This
 * is the "real rendering engine" architecture chosen for PPTX visual
 * fidelity: see FILE-SUPPORT-ARCHITECTURE-REPORT-PPTX.md for the full
 * rationale (why the previous JSZip/DOMParser text-extraction approach
 * can't preserve layout, and why this was chosen over OnlyOffice/a
 * from-scratch PPTX layout renderer/etc).
 *
 * This does NOT bundle LibreOffice. It looks for an existing installation
 * on the machine (common install paths per OS, or an admin-configurable
 * override) and uses it if found. If not found, callers get
 * { available: false } and must fall back to something else (the
 * viewer's existing text/image extraction, or a professional
 * "install LibreOffice for full preview" message) — see
 * app/js/viewer.js's renderPptx() for how the fallback is wired up.
 *
 * SECURITY
 * - Invoked via execFile with an argument ARRAY, never a shell string —
 *   no shell interpolation of the filename is possible.
 * - Runs with an isolated, per-conversion `-env:UserInstallation=` profile
 *   directory so concurrent conversions never share/lock LibreOffice's
 *   user profile (a real, common failure mode of headless LibreOffice
 *   otherwise), and so a malicious document can't tamper with a shared
 *   profile across conversions.
 * - Hard timeout — a malformed/hostile document that hangs the converter
 *   is killed rather than left running indefinitely.
 * - Macros are never enabled: --headless implies no macro execution by
 *   default, and we never pass any flag that would change that.
 * - The source path is validated by the caller (server/routes/files.js)
 *   to be inside the evidence root before this module ever sees it —
 *   this module itself does not re-derive paths from user input beyond
 *   the single sourcePath argument it's given.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const log = require('../../electron/utils/logger');

const CONVERT_TIMEOUT_MS = 90 * 1000;

let cachedSofficePath = undefined; // undefined = not checked yet, null = checked and not found

function candidatePaths() {
  const plat = process.platform;
  const candidates = [];
  if (process.env.SCHOOL_APP_SOFFICE_PATH) candidates.push(process.env.SCHOOL_APP_SOFFICE_PATH);
  if (plat === 'win32') {
    candidates.push(
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
    );
  } else if (plat === 'darwin') {
    candidates.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  } else {
    candidates.push('/usr/bin/soffice', '/usr/bin/libreoffice', '/opt/libreoffice/program/soffice');
  }
  return candidates;
}

/** Resolves and caches the soffice binary path, or null if none found. */
async function findSofficeBinary() {
  if (cachedSofficePath !== undefined) return cachedSofficePath;
  for (const candidate of candidatePaths()) {
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      cachedSofficePath = candidate;
      return cachedSofficePath;
    } catch { /* not at this path, try the next */ }
  }
  // Last resort: rely on PATH (covers Linux distros that don't use the
  // fixed paths above, and any Windows install where the user added it
  // to PATH themselves).
  const onPathBinary = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
  const found = await new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [onPathBinary], (err, stdout) => {
      resolve(err ? null : stdout.split(/\r?\n/)[0].trim() || null);
    });
  });
  cachedSofficePath = found || null;
  return cachedSofficePath;
}

async function isAvailable() {
  return (await findSofficeBinary()) !== null;
}

function hashSourceFile(stat, sourcePath) {
  return crypto.createHash('sha1').update(`${sourcePath}|${stat.size}|${stat.mtimeMs}`).digest('hex');
}

/**
 * Converts sourcePath (a PPTX, or any LibreOffice-readable document) to
 * PDF, caching the result under cacheDir keyed by content fingerprint
 * (path + size + mtime) so re-opening an unchanged file is instant on
 * subsequent opens instead of re-running LibreOffice every time.
 *
 * Returns { ok: true, pdfPath } or { ok: false, reason, detail }.
 */
async function convertToPdf(sourcePath, cacheDir) {
  const soffice = await findSofficeBinary();
  if (!soffice) return { ok: false, reason: 'ENGINE_UNAVAILABLE', detail: 'LibreOffice not found on this machine.' };

  let stat;
  try {
    stat = await fsp.stat(sourcePath);
  } catch {
    return { ok: false, reason: 'SOURCE_MISSING', detail: 'Source file no longer exists.' };
  }

  const key = hashSourceFile(stat, sourcePath);
  await fsp.mkdir(cacheDir, { recursive: true });
  const cachedPdfPath = path.join(cacheDir, `${key}.pdf`);

  try {
    await fsp.access(cachedPdfPath, fs.constants.R_OK);
    return { ok: true, pdfPath: cachedPdfPath, cached: true };
  } catch { /* not cached yet, convert below */ }

  // Isolated scratch dir for this one conversion: LibreOffice's own output
  // dir (it names the PDF after the source, so we control the final name
  // by moving it ourselves) AND an isolated profile dir so concurrent
  // conversions never contend for the same LibreOffice user profile lock.
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pptx-convert-'));
  const profileDir = path.join(workDir, 'profile');
  await fsp.mkdir(profileDir, { recursive: true });

  const profileUrl = 'file://' + profileDir.replace(/\\/g, '/');
  const args = [
    '--headless', '--invisible', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard',
    `-env:UserInstallation=${profileUrl}`,
    '--convert-to', 'pdf',
    '--outdir', workDir,
    sourcePath,
  ];

  try {
    await new Promise((resolve, reject) => {
      const child = execFile(soffice, args, { timeout: CONVERT_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error(`soffice exited with error: ${err.message}${stderr ? ' | ' + stderr : ''}`));
        else resolve();
      });
      child.on('error', reject);
    });

    const producedName = path.basename(sourcePath).replace(/\.[^.]+$/, '') + '.pdf';
    const producedPath = path.join(workDir, producedName);
    const producedStat = await fsp.stat(producedPath).catch(() => null);
    if (!producedStat || producedStat.size === 0) {
      return { ok: false, reason: 'CONVERSION_FAILED', detail: 'LibreOffice did not produce an output file.' };
    }

    await fsp.copyFile(producedPath, cachedPdfPath);
    return { ok: true, pdfPath: cachedPdfPath, cached: false };
  } catch (err) {
    log.warn(`[officeConversionService] conversion failed for ${sourcePath}: ${err.message}`);
    return { ok: false, reason: 'CONVERSION_FAILED', detail: err.message };
  } finally {
    // Best-effort cleanup of the scratch dir (profile + LibreOffice's own
    // output copy) — never leave a temp copy of a school document behind.
    fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Evicts cache entries not accessed in `maxAgeMs` — call occasionally
 *  (e.g. on app startup) so the cache doesn't grow unbounded over years
 *  of use. Not invoked automatically by convertToPdf(). */
async function pruneCache(cacheDir, maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
  let entries;
  try { entries = await fsp.readdir(cacheDir); } catch { return; }
  const now = Date.now();
  for (const entry of entries) {
    const p = path.join(cacheDir, entry);
    try {
      const st = await fsp.stat(p);
      if (now - st.atimeMs > maxAgeMs) await fsp.unlink(p);
    } catch { /* ignore races/permission issues, not worth failing startup over */ }
  }
}

module.exports = { isAvailable, findSofficeBinary, convertToPdf, pruneCache };
