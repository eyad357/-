#!/usr/bin/env node
'use strict';

/**
 * Vendor-side license key generator.
 *
 * Usage:
 *   node scripts/generate-license.js <machineId> <licenseKey> [expiresAt]
 *
 * Example:
 *   node scripts/generate-license.js A1B2C3D4E5F6... ACC-2026-XXXX-XXXX
 *   node scripts/generate-license.js A1B2C3D4E5F6... ACC-2026-XXXX-XXXX 2027-12-31
 *
 * The customer gets their machineId from the license screen in the app
 * (or Settings → License). Send back the printed activation code — they
 * paste it into the license box exactly as printed.
 *
 * IMPORTANT: this script must use the exact same LICENSE_SECRET as the
 * shipped app (server/services/licenseService.js). Set it via the
 * LICENSE_SECRET environment variable, matching your production build.
 */

const licenseService = require('../server/services/licenseService');

const [, , machineId, licenseKey, expiresAt = ''] = process.argv;

if (!machineId || !licenseKey) {
  console.error('Usage: node scripts/generate-license.js <machineId> <licenseKey> [expiresAt YYYY-MM-DD]');
  process.exit(1);
}

const checksum = licenseService.computeChecksum(licenseKey, machineId, expiresAt);
const activationCode = [licenseKey, checksum, expiresAt].join('|');

console.log('\nActivation code (send this exact string to the customer):\n');
console.log(activationCode);
console.log('\nDetails:');
console.log('  machineId :', machineId);
console.log('  licenseKey:', licenseKey);
console.log('  expiresAt :', expiresAt || '(perpetual — never expires)');
