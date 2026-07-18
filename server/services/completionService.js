'use strict';

const evidenceService = require('./evidenceService');

/**
 * Business rule: an indicator needs at least this many evidence files to be
 * considered "complete". Progress climbs in even steps up to that point and
 * caps at 100% — extra files beyond the requirement don't push it over 100%,
 * but they ARE still counted everywhere else (analytics, statistics, totals,
 * storage usage), just tracked separately as "additional" files.
 */
const REQUIRED_FILES = 6;

function indicatorPercent(fileCount) {
  if (fileCount >= REQUIRED_FILES) return 100;
  if (fileCount <= 0) return 0;
  return Math.round((fileCount / REQUIRED_FILES) * 100);
}

function latestOf(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(b) > new Date(a) ? b : a;
}

/**
 * Computes the full completion/progress rollup: per indicator, per standard,
 * per domain, and school-wide — all derived from the same graduated rule.
 * Standard/domain/school completion is the *fraction of indicators that are
 * complete* (>= REQUIRED_FILES files each), not an average of partial
 * indicator percentages — e.g. 12 of 14 complete indicators is 86%, matching
 * the product's own worked example, even though some of those 14 indicators
 * might individually be sitting at 17% or 50%.
 */
async function computeProgress(evidenceRoot, schoolType) {
  const codes = evidenceService.applicableCodes(schoolType);

  const indicators = {};
  const standardGroups = new Map(); // "domain|||standard" -> { domain, standard, codes: [] }
  const domainStandardSets = new Map(); // domain -> Set(standard names)

  for (const code of codes) {
    const meta = evidenceService.MANIFEST[code];
    const { files } = await evidenceService.listFiles(evidenceRoot, code);
    const totalFiles = files.length;
    const totalBytes = files.reduce((sum, f) => sum + (f.bytes || 0), 0);
    let lastModified = null;
    const distribution = {};
    for (const f of files) {
      lastModified = latestOf(lastModified, f.modified);
      distribution[f.category] = (distribution[f.category] || 0) + 1;
    }

    const percent = indicatorPercent(totalFiles);
    const completed = totalFiles >= REQUIRED_FILES;

    indicators[code] = {
      code,
      text: meta.text,
      domain: meta.domainFolder,
      standard: meta.standardFolder,
      totalFiles,
      requiredTotal: REQUIRED_FILES,
      requiredMet: Math.min(totalFiles, REQUIRED_FILES),
      additionalFiles: Math.max(0, totalFiles - REQUIRED_FILES),
      percent,
      completed,
      totalBytes,
      lastModified,
      distribution,
    };

    const key = `${meta.domainFolder}|||${meta.standardFolder}`;
    if (!standardGroups.has(key)) standardGroups.set(key, { domain: meta.domainFolder, standard: meta.standardFolder, codes: [] });
    standardGroups.get(key).codes.push(code);

    if (!domainStandardSets.has(meta.domainFolder)) domainStandardSets.set(meta.domainFolder, new Set());
    domainStandardSets.get(meta.domainFolder).add(meta.standardFolder);
  }

  const standards = [];
  for (const { domain, standard, codes: standardCodes } of standardGroups.values()) {
    const inds = standardCodes.map((c) => indicators[c]);
    const completedIndicators = inds.filter((i) => i.completed).length;
    const totalIndicators = inds.length;
    const totalFiles = inds.reduce((s, i) => s + i.totalFiles, 0);
    const totalBytes = inds.reduce((s, i) => s + i.totalBytes, 0);
    let lastUpdated = null;
    inds.forEach((i) => { lastUpdated = latestOf(lastUpdated, i.lastModified); });

    standards.push({
      domain,
      standard,
      totalIndicators,
      completedIndicators,
      remainingIndicators: totalIndicators - completedIndicators,
      percent: totalIndicators ? Math.round((completedIndicators / totalIndicators) * 100) : 0,
      totalFiles,
      totalBytes,
      lastUpdated,
    });
  }

  const domains = [];
  for (const [domain, standardSet] of domainStandardSets.entries()) {
    const relatedStandards = standards.filter((s) => s.domain === domain);
    const totalIndicators = relatedStandards.reduce((s, x) => s + x.totalIndicators, 0);
    const completedIndicators = relatedStandards.reduce((s, x) => s + x.completedIndicators, 0);
    const totalFiles = relatedStandards.reduce((s, x) => s + x.totalFiles, 0);
    const totalBytes = relatedStandards.reduce((s, x) => s + x.totalBytes, 0);
    let lastUpdated = null;
    relatedStandards.forEach((s) => { lastUpdated = latestOf(lastUpdated, s.lastUpdated); });

    domains.push({
      domain,
      standardsCount: standardSet.size,
      indicatorsCount: totalIndicators,
      percent: totalIndicators ? Math.round((completedIndicators / totalIndicators) * 100) : 0,
      totalFiles,
      totalBytes,
      lastUpdated,
    });
  }

  const allIndicators = Object.values(indicators);
  const totalIndicators = allIndicators.length;
  const completedIndicators = allIndicators.filter((i) => i.completed).length;
  const incompleteIndicators = totalIndicators - completedIndicators;
  const totalFiles = allIndicators.reduce((s, i) => s + i.totalFiles, 0);
  const totalBytes = allIndicators.reduce((s, i) => s + i.totalBytes, 0);

  const evidenceDistribution = {};
  allIndicators.forEach((i) => {
    Object.entries(i.distribution).forEach(([cat, n]) => {
      evidenceDistribution[cat] = (evidenceDistribution[cat] || 0) + n;
    });
  });

  const topCompletedStandards = [...standards].sort((a, b) => b.percent - a.percent).slice(0, 5);
  const standardsRequiringAttention = [...standards].sort((a, b) => a.percent - b.percent).slice(0, 5);

  const school = {
    percent: totalIndicators ? Math.round((completedIndicators / totalIndicators) * 100) : 0,
    completedIndicators,
    incompleteIndicators,
    totalIndicators,
    totalFiles,
    totalBytes,
    evidenceDistribution,
    topCompletedStandards,
    standardsRequiringAttention,
  };

  return { indicators, standards, domains, school };
}

module.exports = { REQUIRED_FILES, indicatorPercent, computeProgress };
