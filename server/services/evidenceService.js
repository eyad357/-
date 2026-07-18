'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const log = require('../../electron/utils/logger');

const MANIFEST = require('../data/evidence-manifest.json'); // code -> { relPath, domainId, standardId, priv, text }
const TREE = require('../data/evidence-tree.json');

const CODES = Object.keys(MANIFEST);
const CODE_IN_FOLDER_NAME = /\((\d+-\d+-\d+-\d+)\)/; // e.g. "مؤشر (1-2-1-1) تعزز المدرسة ..."

const CATEGORY_BY_EXT = {
  pdf: 'pdf',
  doc: 'word', docx: 'word', rtf: 'word', odt: 'word',
  xls: 'excel', xlsx: 'excel', csv: 'excel', ods: 'excel',
  ppt: 'powerpoint', pptx: 'powerpoint', odp: 'powerpoint',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
  txt: 'text', md: 'text', log: 'text',
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', bmp: 'image', svg: 'image',
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio',
};

function categoryForExt(ext) {
  return CATEGORY_BY_EXT[ext.replace('.', '').toLowerCase()] || 'file';
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(val >= 10 ? 0 : 1)} ${units[i]}`;
}

/** All 52 indicator codes, or only the 49 non-private ones for government schools. */
function applicableCodes(schoolType) {
  if (schoolType === 'gov') return CODES.filter((c) => !MANIFEST[c].priv);
  return CODES.slice();
}

function folderForCode(evidenceRoot, code) {
  const entry = MANIFEST[code];
  if (!entry) return null;
  return path.join(evidenceRoot, ...entry.relPath.split('/'));
}

/**
 * Given an absolute file path somewhere under the evidence root, walk up
 * the directory chain until a segment's folder name contains a known
 * indicator code in parentheses, e.g. "مؤشر (1-2-1-1) تعزز المدرسة ...".
 * This keeps file detection working even if a user creates subfolders
 * inside an indicator folder, or the watcher fires on a nested path.
 */
function codeFromPath(evidenceRoot, filePath) {
  let dir = path.dirname(path.resolve(filePath));
  const root = path.resolve(evidenceRoot);
  let guard = 0;
  while (dir.startsWith(root) && dir !== path.dirname(root) && guard < 20) {
    const base = path.basename(dir);
    const match = base.match(CODE_IN_FOLDER_NAME);
    if (match && MANIFEST[match[1]]) return match[1];
    if (dir === root) break;
    dir = path.dirname(dir);
    guard++;
  }
  return null;
}

/** Create every indicator folder that doesn't already exist. Never deletes or touches existing content. */
async function ensureAllFolders(evidenceRoot) {
  await fsp.mkdir(evidenceRoot, { recursive: true });
  for (const code of CODES) {
    const dir = folderForCode(evidenceRoot, code);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (err) {
      log.warn(`Could not create indicator folder for ${code}:`, err.message);
    }
  }
}

/** Copy the bundled template (if any files ship with the installer) without overwriting existing files. */
async function seedFromTemplate(templateRoot, evidenceRoot) {
  if (!fs.existsSync(templateRoot)) return;
  await copyMerge(templateRoot, evidenceRoot);
}

async function copyMerge(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyMerge(s, d);
    } else if (!fs.existsSync(d)) {
      await fsp.copyFile(s, d);
    }
  }
}

async function folderExists(dir) {
  try {
    const st = await fsp.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function listFiles(evidenceRoot, code) {
  const dir = folderForCode(evidenceRoot, code);
  if (!dir) return { folderExists: false, files: [] };
  const exists = await folderExists(dir);
  if (!exists) return { folderExists: false, files: [] };

  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue; // ignore stray subfolders at this level
    const full = path.join(dir, entry.name);
    try {
      const st = await fsp.stat(full);
      const ext = path.extname(entry.name);
      files.push({
        name: entry.name,
        ext,
        category: categoryForExt(ext),
        size: formatSize(st.size),
        bytes: st.size,
        modified: st.mtime.toISOString(),
        created: st.birthtime.toISOString(),
        path: full,
      });
    } catch (err) {
      log.warn(`Skipping unreadable file ${full}:`, err.message);
    }
  }
  files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  return { folderExists: true, files };
}

async function getFilePath(evidenceRoot, code, name) {
  const dir = folderForCode(evidenceRoot, code);
  if (!dir) return null;
  const safeName = path.basename(name); // prevent path traversal
  const full = path.join(dir, safeName);
  if (!full.startsWith(path.resolve(dir))) return null;
  return full;
}

async function integrityCheck(evidenceRoot, schoolType) {
  const issues = [];
  const missingFolders = [];

  const rootOk = await folderExists(evidenceRoot);
  if (!rootOk) {
    issues.push({ message: 'مجلد الشواهد الرئيسي غير موجود، سيتم إنشاؤه تلقائيًا.' });
    return { issues, missingFolders };
  }

  for (const code of applicableCodes(schoolType)) {
    const dir = folderForCode(evidenceRoot, code);
    if (!(await folderExists(dir))) missingFolders.push(code);
  }
  return { issues, missingFolders };
}

async function stats(evidenceRoot, schoolType) {
  const codes = applicableCodes(schoolType);
  let indicatorsWithFiles = 0;
  let totalFiles = 0;
  const recent = [];

  for (const code of codes) {
    const { files } = await listFiles(evidenceRoot, code);
    if (files.length > 0) indicatorsWithFiles++;
    totalFiles += files.length;
    for (const f of files) recent.push({ code, name: f.name, modified: f.modified });
  }

  recent.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  const completionPct = codes.length ? Math.round((indicatorsWithFiles / codes.length) * 100) : 0;

  return {
    indicatorsWithFiles,
    totalFiles,
    completionPct,
    recentFiles: recent.slice(0, 10),
  };
}

function indicatorMap(evidenceRoot) {
  // { code: true } for every indicator whose folder currently exists — mirrors what
  // the frontend expects from GET /api/structure (indicatorMap / total).
  const map = {};
  let total = 0;
  for (const code of CODES) {
    const dir = folderForCode(evidenceRoot, code);
    if (fs.existsSync(dir)) {
      map[code] = true;
      total++;
    }
  }
  return { map, total };
}

module.exports = {
  MANIFEST,
  TREE,
  CODES,
  applicableCodes,
  folderForCode,
  codeFromPath,
  ensureAllFolders,
  seedFromTemplate,
  folderExists,
  listFiles,
  getFilePath,
  integrityCheck,
  stats,
  indicatorMap,
  formatSize,
  categoryForExt,
};
