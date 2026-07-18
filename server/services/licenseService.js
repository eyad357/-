'use strict';

const os = require('os');
const crypto = require('crypto');

// NOTE: for a real commercial release, generate a unique secret per product
// build (e.g. injected at build time) rather than committing one to source.
// Keep it identical between this app and whatever tool the vendor uses to
// generate license keys for customers.
const LICENSE_SECRET = process.env.LICENSE_SECRET || 'CHANGE-ME-BUILD-TIME-SECRET-v1';

function computeMachineId() {
  const raw = [
    os.hostname(),
    os.platform(),
    os.arch(),
    (os.cpus()[0] || {}).model || 'unknown-cpu',
    os.totalmem(),
  ].join('|');
  return crypto.createHmac('sha256', LICENSE_SECRET).update(raw).digest('hex').slice(0, 32).toUpperCase();
}

function computeChecksum(licenseKey, machineId, expiresAt) {
  return crypto
    .createHmac('sha256', LICENSE_SECRET)
    .update(`${licenseKey}|${machineId}|${expiresAt || ''}`)
    .digest('hex');
}

function isExpired(expiresAt) {
  if (!expiresAt) return false; // empty = perpetual license
  const d = new Date(expiresAt);
  if (isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}

function status(store) {
  const machineId = computeMachineId();
  const lic = store.license;

  if (!lic.activated || !lic.key) {
    return { valid: false, reason: 'لم يتم تفعيل ترخيص بعد.', machineId };
  }

  const expectedChecksum = computeChecksum(lic.key, machineId, lic.expiresAt);
  if (expectedChecksum !== lic.checksum) {
    return { valid: false, reason: 'الترخيص غير مطابق لهذا الجهاز.', machineId };
  }

  if (isExpired(lic.expiresAt)) {
    return { valid: false, reason: 'انتهت صلاحية الترخيص.', machineId, key: lic.key, expires: lic.expiresAt };
  }

  return {
    valid: true,
    machineId,
    key: lic.key,
    expires: lic.expiresAt || null,
  };
}

function activate(store, { licenseKey, machineId, expiresAt, checksum }) {
  if (!licenseKey || !checksum) {
    return { success: false, error: 'صيغة مفتاح الترخيص غير صحيحة.' };
  }
  const currentMachineId = computeMachineId();
  if (machineId && machineId !== currentMachineId) {
    return { success: false, error: 'مفتاح الترخيص صادر لجهاز آخر.' };
  }

  const expected = computeChecksum(licenseKey, currentMachineId, expiresAt);
  if (expected !== checksum) {
    return { success: false, error: 'مفتاح الترخيص غير صالح.' };
  }
  if (isExpired(expiresAt)) {
    return { success: false, error: 'مفتاح الترخيص منتهي الصلاحية.' };
  }

  store.updateLicense({ key: licenseKey, checksum, expiresAt: expiresAt || '', activated: true });
  return { success: true };
}

module.exports = { computeMachineId, computeChecksum, status, activate };
