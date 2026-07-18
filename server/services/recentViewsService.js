'use strict';

/**
 * Tracks "recently viewed" evidence files per indicator, purely in memory.
 *
 * This is intentionally NOT persisted to store.json: recording a view happens
 * every time a user opens a file in the Document Viewer, which can happen very
 * frequently while browsing evidence. Writing to disk on every view (like the
 * audit log does for real audit events) would add avoidable I/O to the most
 * common user action in the app. "Recently viewed" is a browsing convenience,
 * not compliance data, so it resets when the app restarts — that tradeoff is
 * deliberate and keeps file-open actions fast regardless of how much a user
 * has been clicking around.
 */

const MAX_PER_INDICATOR = 15;

// code -> [{ name, viewedAt }, ...] most-recent-first, deduped by name
const recentByCode = new Map();

function recordView(code, name) {
  if (!code || !name) return;
  const list = recentByCode.get(code) || [];
  const filtered = list.filter((entry) => entry.name !== name);
  filtered.unshift({ name, viewedAt: new Date().toISOString() });
  if (filtered.length > MAX_PER_INDICATOR) filtered.length = MAX_PER_INDICATOR;
  recentByCode.set(code, filtered);
}

function getRecent(code, limit = 5) {
  const list = recentByCode.get(code) || [];
  return list.slice(0, limit);
}

module.exports = { recordView, getRecent };
