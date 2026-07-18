'use strict';

/**
 * Central place for every filesystem path the app cares about.
 * Nothing else in the codebase should hardcode a path with app.getPath()
 * or __dirname — always go through here so packaged vs dev behavior
 * stays consistent in exactly one place.
 */

const path = require('path');
const { app } = require('electron');

const isPackaged = app.isPackaged;

/** Read-only application resources (bundled inside the asar / resources dir). */
function getResourcesPath() {
  return isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
}

/**
 * The directory the application is actually installed/running from — i.e. the
 * folder that contains the .exe. This is resolved dynamically at runtime and
 * NEVER hardcoded, so the app works identically whether it lives on C:, D:,
 * a USB stick, or any other path.
 *
 * - NSIS (installed) build: process.resourcesPath is "<installDir>\resources",
 *   so its parent is the install directory the user picked (which is exactly
 *   where the .exe sits, since allowToChangeInstallationDirectory is on and
 *   electron-builder's NSIS template installs the exe directly in $INSTDIR).
 * - Portable build: electron-builder sets PORTABLE_EXECUTABLE_DIR to the
 *   folder holding the portable .exe itself (not the temp extraction dir),
 *   which is what we want here.
 * - Dev (unpackaged): fall back to the project root so `npm run dev` still
 *   works predictably.
 */
function getInstallDir() {
  // Test-only escape hatch: never set by the shipped app, only by
  // scripts/smoke-test.js so automated runs use a throwaway tmp folder
  // instead of littering the repo with a real evidence tree.
  if (process.env.SCHOOL_APP_TEST_INSTALL_DIR) {
    return process.env.SCHOOL_APP_TEST_INSTALL_DIR;
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  if (isPackaged) {
    return path.dirname(process.resourcesPath);
  }
  return path.join(__dirname, '..', '..');
}

/** Renderer (app/) directory — read-only, ships inside the asar. */
function getAppDir() {
  return path.join(__dirname, '..', '..', 'app');
}

/** Per-user writable data directory (settings, database file, logs, backups). */
function getUserDataDir() {
  return app.getPath('userData');
}

function getStoreFile() {
  return path.join(getUserDataDir(), 'store.json');
}

function getLogsDir() {
  return path.join(getUserDataDir(), 'logs');
}

function getBackupsDir() {
  return path.join(getUserDataDir(), 'backups');
}

function getUploadsTmpDir() {
  return path.join(getUserDataDir(), 'tmp');
}

/** Folder name for the live evidence tree — must match resources/evidence-template exactly. */
const EVIDENCE_FOLDER_NAME = 'معايير التقويم والاعتماد المدرسي';

/**
 * Default evidence repository root.
 *
 * Lives as a SIBLING of the application's install directory (next to the
 * .exe) — never inside AppData, ProgramData, Documents, or any other Windows
 * special folder, and never on a hardcoded drive letter. This is resolved
 * from getInstallDir(), so if the customer installs on D:, E:, a portable
 * drive, etc., the evidence folder automatically follows it:
 *
 *   D:\School Accreditation\
 *   ├── School Accreditation.exe
 *   └── معايير التقويم والاعتماد المدرسي\
 *       └── مجال الإدارة المدرسية\...
 *
 * School staff can still open it directly in Explorer, add/rename/delete
 * files, and see everything reflected instantly in the app (see
 * server/services/evidenceWatcher.js) — the only thing that changed from
 * the previous Documents-based layout is *where* that live folder sits.
 */
function getDefaultEvidenceRoot() {
  return path.join(getInstallDir(), EVIDENCE_FOLDER_NAME);
}

/** Bundled template used to seed the evidence root on first run. */
function getEvidenceTemplatePath() {
  return path.join(getResourcesPath(), 'evidence-template');
}

module.exports = {
  isPackaged,
  getResourcesPath,
  getInstallDir,
  getAppDir,
  getUserDataDir,
  getStoreFile,
  getLogsDir,
  getBackupsDir,
  getUploadsTmpDir,
  getDefaultEvidenceRoot,
  getEvidenceTemplatePath,
  EVIDENCE_FOLDER_NAME,
};
