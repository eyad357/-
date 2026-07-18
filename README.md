# نظام التقويم والاعتماد المدرسي — Electron Desktop Edition

Professional Windows desktop packaging of the school accreditation & evaluation
system. The original single-file HTML/CSS/JS application is preserved **exactly
as-is** as the renderer (`app/index.html`) — nothing in its UI or business logic
was rewritten. What was added is a production-grade Electron shell, an embedded
Express backend that implements every API endpoint the frontend already expects,
and a real-time evidence-folder file management layer.

## Architecture

```
project/
├── electron/
│   ├── main/         # main.js (entry point), window.js (splash + main window), menu.js
│   ├── preload/       # preload.js — the only bridge into the renderer
│   ├── ipc/            # dialog + app IPC handlers
│   ├── security/       # webPreferences hardening, devtools/shortcut blocking
│   └── utils/           # paths, logger, auto-backup scheduler
│
├── server/              # embedded Express backend (runs inside the main process)
│   ├── app.js            # app factory: wires store, evidence service, watcher, routes
│   ├── routes/            # one file per API resource (school, files, license, backup...)
│   ├── services/           # evidenceService, evidenceWatcher, licenseService, backupService
│   ├── store/               # JSON-file persistence (school info, settings, license, audit log)
│   └── data/                  # evidence-manifest.json / evidence-tree.json (generated once from
│                                the app's own DOMAINS data — see "Evidence folder system" below)
│
├── app/                # the renderer — original index.html, byte-for-byte, served statically
├── splash/              # splash screen shown while the embedded server boots
├── build/                 # installer icon (icon.ico / icon.png) — replace with your real artwork
├── resources/
│   └── evidence-template/  # your real evidence folder structure (مجال/معيار/مؤشر), bundled
│                              read-only in the installer, copied to the writable evidence root
│                              on first run — see "Evidence folder system" below
└── scripts/
    ├── smoke-test.js        # headless test of every API route (see "Verifying the build")
    └── generate-license.js  # vendor CLI to generate customer activation codes
```

## Running in development

```bash
npm install
npm run dev
```

This launches Electron with DevTools available and the embedded server on
`http://127.0.0.1:3000`.

## Verifying the server logic without a display

The container/CI environment used to build this project has no display, so the
Express layer was verified headlessly by mocking the `electron` module and
hitting every route with real HTTP requests, including a live filesystem-watcher
test (drop a file on disk with no API call → assert it shows up via `/api/files`):

```bash
npm run verify:server
```

All 15 checks pass (school CRUD, structure, integrity, stats, upload/list/delete,
license status/activate, settings, audit, backup create/list, static serving, and
the real-time watcher). Run this after any server-side change.

## Building the Windows installer

```bash
npm install
npm run build          # → release/*.exe (NSIS installer) + portable .exe
```

`electron-builder` reads the `build` block in `package.json`: app id, product
name, publisher metadata, installer icon, and `extraResources` (the evidence
template). No native/compiled dependencies are used anywhere in this project
(SQLite was intentionally replaced with an atomic JSON store, and file
compression uses pure-JS `archiver`), so the build requires no native rebuild
step and will succeed on a clean machine without Visual Studio Build Tools.

### Replacing the placeholder icon

`build/icon.ico` and `build/icon.png` are placeholders generated for this
delivery. Replace them with your real artwork (same filenames) before shipping
— electron-builder automatically uses them for the installer icon, the
executable icon, the taskbar icon, and the window icon.

## The evidence folder system

This is the core of the "live evidence repository" requirement.

**How the folder tree is derived.** You provided the school's real evidence
folder structure as a zip (domain folders named `مجال ...`, standard folders
named `معيار ...`, indicator folders named `مؤشر (code) <indicator text>`).
That exact structure — folder names, wording, and all — now ships as
`resources/evidence-template/` and was parsed once into
`server/data/evidence-manifest.json` (indicator code → exact relative folder
path) and `evidence-tree.json`. All 52 indicator codes in your folder
structure match the 52 indicators already defined in `index.html`'s own
`DOMAINS` data one-to-one, so `priv` flags (private-school-only indicators)
and indicator text were carried over automatically — nothing was invented.

**Where it lives.** Directly beside the application's install directory —
e.g. if the app is installed at `D:\School Accreditation\`, the live evidence
tree is `D:\School Accreditation\معايير التقويم والاعتماد المدرسي\`, a
sibling of the `.exe`. It is **never** placed in AppData, ProgramData,
Documents, or any other Windows special folder, and the path is never
hardcoded to a drive letter. `electron/utils/paths.js#getInstallDir()`
resolves the real install directory at runtime — from `process.resourcesPath`
for the installed (NSIS) build, or from electron-builder's
`PORTABLE_EXECUTABLE_DIR` for the portable build — so moving the whole
`School Accreditation` folder to a different drive, or installing on D:, E:,
or a USB stick, works automatically with zero configuration. School staff can
still open the folder directly in Explorer, add/rename/delete files, or (as
an optional, non-required override) point the app at a completely different
folder via Settings → مجلد الشواهد → native folder picker.

**Installed together.** electron-builder's `extraResources` bundles the
read-only template at `resources\evidence-template\` inside the installer.
A custom NSIS step (`build/installer.nsh`, wired in via `nsis.include`)
additionally mirrors that template into the live, writable sibling folder
*during setup itself* — so the evidence folder exists on disk the moment
installation finishes, not only after the app is first launched. The step is
safe on upgrades/repairs too: it only ever creates missing folders and never
overwrites a school's existing evidence files.

**First run / self-healing.** On every launch, `server/app.js` copies the
bundled template into the evidence root (merge-copy — never overwrites
anything already there) and `evidenceService.ensureAllFolders()` recreates
any of the 52 indicator folders that are missing. A lightweight background
check then re-runs that same non-destructive verification every 60 seconds
while the app is running, so if the entire evidence folder is ever deleted by
accident, it's transparently rebuilt (and the file watcher restarted) without
losing any evidence that happens to survive elsewhere in the tree.

**Real-time detection.** `server/services/evidenceWatcher.js` wraps `chokidar`
and watches the evidence root recursively. Any add/change/remove — whether from
the app's own upload button or a user dragging files into Explorer by hand,
straight into a folder like `...\معيار قيادة العملية التعليمية\مؤشر (1-2-1-1)
تعزز المدرسة القيم الإسلامية والهوية الوطنية\` — is matched back to its
indicator code by reading the `(code)` in parentheses out of the folder name
(walking up the path if the file was dropped a level or two deeper than
expected), then broadcast to the renderer over the SSE channel the frontend
was already listening on (`GET /api/events`, consumed by `setupSSE()` in
`index.html` — no frontend changes were needed here at all). The open indicator
panel refreshes immediately and an audit-log entry (`file_detected` /
`file_deleted`) is recorded.

**Changing the evidence root at runtime.** `POST /api/school` with
`evidence_root` restarts the watcher against the new path and re-runs the
folder-integrity bootstrap — handled in `app.locals.setEvidenceRoot()`.

**Supported file types.** Any file type can be uploaded/dropped; the UI's file
type badge is driven by `evidenceService.categoryForExt()`, which recognizes
PDF, Word, Excel, PowerPoint, archives, text, images, video, and audio, and
falls back to a generic file icon for anything else — nothing is rejected.

## Security

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` on every
  window (`electron/security/security.js`).
- A tiny, explicit `preload.js` bridge — only `openFileDialog` and
  `getAppVersion` are exposed to the renderer, nothing else.
- Production builds (`app.isPackaged`) block F12 / Ctrl+Shift+I/J/C, disable
  the right-click "Inspect" context menu, and close DevTools if opened by any
  other means. All of this is skipped in `npm run dev` so you can still debug.
- Renderer navigation is locked to `http://localhost` / `127.0.0.1`; any
  attempt to navigate elsewhere or open a new window is blocked.
- A `Content-Security-Policy` header is set on every response from the
  embedded server.
- Single-instance lock — launching the app twice focuses the existing window
  instead of starting a second server on the same port.

## License activation

The renderer's existing license UI (`#license-overlay`, `activateLicense()`)
is unchanged. The backend (`server/services/licenseService.js`) implements
offline HMAC-SHA256 machine-fingerprint activation:

1. The customer opens Settings → License, which shows their `machineId`
   (derived from hostname/platform/arch/CPU/memory, hashed — stable across
   reboots, unique per machine).
2. They send you that ID. You run:
   ```bash
   node scripts/generate-license.js <machineId> <licenseKey> [expiresAt]
   ```
3. You send back the printed activation code; they paste it into the license
   box exactly as printed.

**Before shipping**, set a real `LICENSE_SECRET` (an env var baked into your
build process) — the placeholder in `licenseService.js` is clearly marked and
must be replaced, and must be identical between the shipped app and whatever
machine you run `generate-license.js` on.

Note: `checkLicense()` in the current `index.html` always returns `true` (the
license gate is disabled at the UI level, as shipped in the source file you
provided) — the backend enforcement above is fully implemented and ready the
moment you flip that one function back to actually calling
`GET /api/license/status`.

## Logging & error handling

- `electron-log` writes rotating logs to `<userData>/logs/main.log`.
- Uncaught exceptions / unhandled rejections in the main process are caught
  and logged rather than crashing silently.
- Renderer crashes (`render-process-gone`) show a dialog and reload the window.
- Every Express route is wrapped by a final error-handling middleware that
  logs and returns a clean JSON error instead of an unhandled stack trace.

## Backups

- Manual: the existing "نسخة احتياطية الآن" button (`POST /api/backup`) zips
  the evidence root + app data store via `archiver`.
- Scheduled: Settings → "نسخ احتياطي تلقائي" (`none` / `daily` / `weekly`),
  implemented with `setInterval` in `electron/utils/autoBackup.js`.
- On exit: if "نسخ احتياطي عند الإغلاق" is enabled, `before-quit` is
  intercepted once to run a final backup before the app actually closes.

## What was intentionally left alone

Per the brief, `app/index.html` is untouched — same markup, same CSS, same
`<script>` block, same function names. It already anticipated Electron
(`window.electronAPI.openFileDialog`, SSE, a settable evidence root), so the
backend was built to match its expectations rather than the other way around.
