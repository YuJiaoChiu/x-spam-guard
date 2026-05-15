function normalizeText(value) {
  return String(value || "").trim();
}

function increment(map, key, amount = 1) {
  const value = normalizeText(key);
  if (!value) return;
  map.set(value, (map.get(value) || 0) + amount);
}

function topEntries(map, limit = 20) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function isValidPublicHandle(value) {
  return /^[A-Za-z0-9_]{1,15}$/.test(String(value || ""));
}

function publicReasonDetails(details = {}) {
  const ruleMatches = Array.isArray(details.ruleMatchDetails) ? details.ruleMatchDetails : [];
  return {
    ruleScore: Number(details.ruleScore || 0),
    ruleHumanReasons: Array.isArray(details.ruleHumanReasons) ? details.ruleHumanReasons.slice(0, 8).map(String) : [],
    aiProvider: normalizeText(details.aiProvider || ""),
    aiReason: normalizeText(details.aiReason || ""),
    ruleMatchDetails: ruleMatches.slice(0, 12).map((item) => ({
      rule: normalizeText(item.rule || ""),
      fields: Array.isArray(item.fields) ? item.fields.slice(0, 8).map(String) : [],
      hits: Array.isArray(item.hits)
        ? item.hits.slice(0, 12).map((hit) => ({
            field: normalizeText(hit.field || ""),
            term: normalizeText(hit.term || "")
          }))
        : [],
      evidence: Array.isArray(item.evidence) && item.evidence.length ? ["redacted"] : [],
      reason: normalizeText(item.reason || "")
    }))
  };
}

function aggregateFromBlacklist(items = []) {
  const tags = new Map();
  const rules = new Map();
  const reasons = new Map();
  const fields = new Map();

  for (const item of items) {
    increment(reasons, item.reason || "unknown");
    for (const tag of item.tags || []) increment(tags, tag);

    const details = item.reasonDetails || {};
    for (const match of details.ruleMatchDetails || []) {
      increment(rules, match.rule || "");
      for (const field of match.fields || []) increment(fields, field);
    }
  }

  return {
    topReasons: topEntries(reasons, 16),
    topTags: topEntries(tags, 24),
    topRules: topEntries(rules, 24),
    topFields: topEntries(fields, 12)
  };
}

function aggregatePatterns(feedbackSamples = [], approvedReports = []) {
  const patterns = new Map();
  const kinds = new Map();

  function addPattern(item, weight = 1) {
    if (!item) return;
    if (typeof item === "string") {
      increment(patterns, item, weight);
      return;
    }
    const value = normalizeText(item.value || item.pattern || "");
    if (!value) return;
    increment(patterns, value, weight);
    increment(kinds, item.kind || "phrase", weight);
  }

  for (const sample of feedbackSamples) {
    for (const pattern of sample.patternCandidates || []) addPattern(pattern, 2);
    for (const fragment of sample.fragments || []) addPattern(fragment, 1);
  }

  for (const report of approvedReports) {
    const patternsFromReport = report.payload?.verdict?.details?.patternCandidates || [];
    for (const pattern of patternsFromReport) addPattern(pattern, 1);
  }

  return {
    topPatterns: topEntries(patterns, 40),
    patternKinds: topEntries(kinds, 16)
  };
}

export async function buildPublicExport(store) {
  const [stats, blacklistResult, feedbackResult, approvedResult, pendingResult] = await Promise.all([
    store.getStats(),
    store.listBlacklist({ status: "confirmed", limit: 5000, offset: 0 }),
    store.listFeedbackSamples({ label: "spam", limit: 1000, offset: 0 }),
    store.listContributions({ decision: "approve", limit: 1000, offset: 0 }),
    store.listContributions({ decision: "pending", limit: 1, offset: 0 })
  ]);

  const blacklist = (blacklistResult.items || blacklistResult || [])
    .filter((item) => isValidPublicHandle(item.screenName || ""))
    .map((item) => ({
      screenName: item.screenName || "",
      displayName: item.displayName || "",
      reason: item.reason || "spam",
      confidence: Number(item.confidence || 0),
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 12).map(String) : [],
      source: item.source || "",
      updatedAt: item.updatedAt || item.createdAt || "",
      reasonDetails: publicReasonDetails(item.reasonDetails || {})
    }));

  const feedbackSamples = feedbackResult.items || feedbackResult || [];
  const approvedReports = approvedResult.items || approvedResult || [];
  const analysis = {
    ...aggregateFromBlacklist(blacklist),
    ...aggregatePatterns(feedbackSamples, approvedReports),
    totals: {
      confirmedBlacklist: blacklist.length,
      spamSamples: feedbackSamples.length,
      approvedReports: approvedReports.length,
      pendingReports: pendingResult.total || 0
    }
  };

  return {
    generatedAt: new Date().toISOString(),
    project: "X Spam Guard",
    stats,
    blacklist,
    analysis
  };
}
