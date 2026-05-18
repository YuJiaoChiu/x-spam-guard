import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { renderAdminPage } from "./admin-page.js";
import { classifyCandidate, suggestRulesFromFeedback } from "./ai.js";
import { buildPublicExport } from "./public-export.js";
import { scoreCandidate } from "./rules.js";
import { createStore } from "./store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");

const config = {
  strongRuleThreshold: Number(process.env.STRONG_RULE_THRESHOLD || 4),
  aiReviewRuleThreshold: Number(process.env.AI_REVIEW_RULE_THRESHOLD || 2),
  autoBlockConfidence: Number(process.env.AUTO_BLOCK_CONFIDENCE || 0.8),
  classifyRatePerMinute: Number(process.env.CLASSIFY_RATE_PER_MINUTE || 30),
  adminToken: process.env.ADMIN_TOKEN || "",
  clientToken: process.env.CLIENT_TOKEN || ""
};

const BLACKLIST_STATUSES = new Set(["confirmed", "suspected", "reported", "whitelist"]);
const BLOCK_TASK_STATUSES = new Set(["pending", "running", "success", "failed", "cooldown", "skipped"]);

const app = express();
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

const store = await createStore(dataDir);
await store.init();

function getIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function createRateLimiter({ keyPrefix, windowMs, max }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const ip = getIp(req);
    const key = `${keyPrefix}:${ip}`;
    const current = buckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > current.resetAt) {
      current.count = 0;
      current.resetAt = now + windowMs;
    }
    current.count += 1;
    buckets.set(key, current);

    if (current.count > max) {
      res.status(429).json({
        error: "rate_limited",
        message: "Too many requests",
        retryAfterMs: Math.max(1000, current.resetAt - now)
      });
      return;
    }
    next();
  };
}

function parsePagination(query, defaults = {}) {
  const limit = Math.max(1, Math.min(1000, Number(query.limit || defaults.limit || 200)));
  const offset = Math.max(0, Number(query.offset || defaults.offset || 0));
  return { limit, offset };
}

function normalizeScreenName(value) {
  const v = String(value || "").replace(/^@/, "").trim().toLowerCase();
  if (!v) return "";
  return v;
}

function isValidScreenName(value) {
  return /^[a-z0-9_]{1,15}$/i.test(String(value || "").replace(/^@/, "").trim());
}

function normalizeString(value, maxLen = 5000) {
  return String(value || "").trim().slice(0, maxLen);
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((tag) => normalizeString(tag, 50)).filter(Boolean))];
}

function normalizeBlacklistStatus(value) {
  const status = String(value || "confirmed").toLowerCase().trim();
  return BLACKLIST_STATUSES.has(status) ? status : "confirmed";
}

function normalizeBlockTaskStatus(value) {
  const status = String(value || "pending").toLowerCase().trim();
  return BLOCK_TASK_STATUSES.has(status) ? status : "pending";
}

function sanitizeCandidate(raw) {
  if (!raw || typeof raw !== "object") return null;
  const screenName = normalizeScreenName(raw.screenName);
  if (!screenName) return null;
  return {
    userId: raw.userId ? normalizeString(raw.userId, 60) : null,
    screenName,
    displayName: normalizeString(raw.displayName, 120),
    profileBio: normalizeString(raw.profileBio, 500),
    commentText: normalizeString(raw.commentText, 1200),
    sourceUrl: normalizeString(raw.sourceUrl, 2000),
    ruleScore: normalizeNumber(raw.ruleScore, 0),
    matchedRules: normalizeTags(raw.matchedRules)
  };
}

function sanitizeBlockTask(raw) {
  const task = raw && typeof raw === "object" ? raw : {};
  const screenName = normalizeScreenName(task.screenName || "");
  if (!screenName) return null;
  return {
    id: task.id ? normalizeString(task.id, 80) : undefined,
    userId: task.userId ? normalizeString(task.userId, 80) : null,
    screenName,
    displayName: normalizeString(task.displayName || "", 120),
    reason: normalizeString(task.reason || "", 180),
    confidence: normalizeNumber(task.confidence, 0),
    status: normalizeBlockTaskStatus(task.status),
    scheduledAt: task.scheduledAt ? normalizeString(task.scheduledAt, 80) : undefined,
    startedAt: task.startedAt ? normalizeString(task.startedAt, 80) : undefined,
    finishedAt: task.finishedAt ? normalizeString(task.finishedAt, 80) : undefined,
    retries: Math.max(0, Math.trunc(normalizeNumber(task.retries, 0))),
    maxRetries: Math.max(0, Math.trunc(normalizeNumber(task.maxRetries, 2))),
    lastError: normalizeString(task.lastError || "", 600),
    xStatusCode: Math.max(0, Math.trunc(normalizeNumber(task.xStatusCode, 0))),
    source: normalizeString(task.source || "extension", 50),
    metadata: task.metadata && typeof task.metadata === "object" ? task.metadata : {}
  };
}

function requireToken(expectedToken, headerName) {
  return (req, res, next) => {
    if (!expectedToken) {
      next();
      return;
    }
    const value = String(req.headers[headerName] || "");
    if (value !== expectedToken) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

function sanitizeRuntimeConfigInput(input = {}) {
  const providerRaw = String(input.aiProvider || "").toLowerCase().trim();
  const aiProvider = ["auto", "external", "openai", "mock"].includes(providerRaw) ? providerRaw : "auto";
  const cheapAiUrl = normalizeString(input.cheapAiUrl || "", 300);
  const openaiBaseUrl = normalizeString(input.openaiBaseUrl || "https://api.openai.com/v1", 300);
  const cheapAiModel = normalizeString(input.cheapAiModel || "gpt-4o-mini", 120);
  let openaiApiKey = "__KEEP__";
  if (Object.prototype.hasOwnProperty.call(input, "openaiApiKey")) {
    openaiApiKey = normalizeString(input.openaiApiKey || "", 300);
  }
  return {
    aiProvider,
    cheapAiUrl,
    openaiBaseUrl,
    cheapAiModel,
    openaiApiKey
  };
}

function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[０-９]/g, (m) => String.fromCharCode(m.charCodeAt(0) - 65248))
    .replace(/[\u200b-\u200f\uFEFF]/g, "")
    .replace(/\s+/g, "");
}

function isEmojiOnly(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  const stripped = value.replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\ufe0f\s.,，。!！?？:：;；'"“”‘’^_~\-—·♥♡🌸]+/gu, "");
  return stripped.length === 0;
}

function patternKind(value) {
  if (/https?:\/\/|www\.|\.com|\.cn|t\.me/i.test(value)) return "url";
  if (/(telegram|tg|电报|飞机|t\.me)/i.test(value)) return "tg";
  if (/(资源入口|进群选人|同城约p|约p|1-5线|真实对接|真实约见|同城资源|看我置顶|看我简介|点我头像)/i.test(value)) return "resource_lure";
  if (/(夸克|网盘|提取码|资源|全集|下载)/i.test(value)) return "netdisk";
  if (/(dd|线下|同城|附近|私信|主页|联系|加我)/i.test(value)) return "contact_lure";
  if (/(免费破处|破处|男大|骚|sao|福利|裸舞|绿帽)/i.test(value)) return "adult_lure";
  if (/^[a-z0-9_]{8,}$/i.test(value) && /\d/.test(value)) return "handle_like";
  return "phrase";
}

function scorePattern(value, kind) {
  let score = 1;
  if (["adult_lure", "contact_lure", "netdisk", "tg"].includes(kind)) score += 3;
  if (kind === "handle_like") score += 1;
  if (value.length >= 4 && value.length <= 20) score += 1;
  if (/[\u4e00-\u9fff]/.test(value)) score += 1;
  return score;
}

function extractPatternCandidates(rawText) {
  const text = String(rawText || "");
  const compact = normalizeForMatch(text);
  const pieces = text
    .split(/\r?\n|[|,，。！？!?:：;；]+/)
    .map((x) => normalizeForMatch(x))
    .filter(Boolean);
  const candidates = new Map();

  function add(value, source) {
    const normalized = normalizeForMatch(value);
    if (!normalized) return;
    if (normalized.length < 4 || normalized.length > 80) return;
    if (/^\d+$/.test(normalized)) return;
    if (isEmojiOnly(normalized)) return;
    const lettersOrCjk = normalized.match(/[a-z\u4e00-\u9fff]/gi) || [];
    if (lettersOrCjk.length < 2) return;
    const kind = patternKind(normalized);
    const current = candidates.get(normalized);
    const row = {
      value: normalized,
      kind,
      score: scorePattern(normalized, kind),
      source
    };
    if (!current || row.score > current.score) {
      candidates.set(normalized, row);
    }
  }

  for (const p of pieces) {
    add(p, "line");
  }

  const knownPatternMatches = compact.match(/(?:1-5线(?:真实对接|覆盖)|同城约p|真实可靠约见|真实约见|同城资源自取|线下资源入口|点我头像进群选人|进群选人)/gi) || [];
  for (const item of knownPatternMatches) {
    add(item, "known_pattern");
  }

  const tokenMatches = compact.match(/[\u4e00-\u9fff]{2,12}|[a-z0-9_]{3,20}/g) || [];
  for (const token of tokenMatches) {
    add(token, "token");
  }

  if (compact.length >= 6 && compact.length <= 200) {
    add(compact, "full");
  }

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.value.length - b.value.length)
    .slice(0, 80);
}

function extractFeedbackFragments(rawText) {
  return extractPatternCandidates(rawText).map((pattern) => pattern.value);
}

function parsePastedXAccounts(rawText) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const accounts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const handleMatch = lines[i].match(/^@([A-Za-z0-9_]{1,15})$/);
    if (!handleMatch) continue;
    const displayName = lines[i - 1] && !lines[i - 1].startsWith("@") ? lines[i - 1] : "";
    const commentLines = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^@([A-Za-z0-9_]{1,15})$/.test(lines[j])) break;
      if (lines[j] === "·" || /^\d+\s*(分钟|小时|天)/.test(lines[j])) continue;
      if (j > i + 1 && lines[j + 1] && /^@([A-Za-z0-9_]{1,15})$/.test(lines[j + 1])) break;
      commentLines.push(lines[j]);
    }
    const candidate = sanitizeCandidate({
      screenName: handleMatch[1],
      displayName,
      commentText: commentLines.join("\n")
    });
    if (candidate) accounts.push(candidate);
  }
  return accounts;
}

function isSafeDynamicPattern(pattern, kind = "") {
  const normalized = normalizeForMatch(pattern);
  if (!normalized || normalized.length < 4 || normalized.length > 60) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (/^@[a-z0-9_]{1,15}$/i.test(normalized)) return false;
  if (["handle_like"].includes(String(kind))) return false;
  const emojiHits = normalized.match(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu) || [];
  if (emojiHits.length > 1) return false;
  const generic = new Set(["看我置顶", "看我简介", "真实可靠", "真实", "资源", "同城"]);
  if (generic.has(normalized)) return false;
  const lettersOrCjk = normalized.match(/[a-z\u4e00-\u9fff]/gi) || [];
  return lettersOrCjk.length >= 2 && !isEmojiOnly(normalized);
}

function dynamicRuleScoreForKind(kind, pattern) {
  const value = normalizeForMatch(pattern);
  if (kind === "resource_lure") return 5;
  if (kind === "adult_lure" || kind === "contact_lure") return 4;
  if (/(资源入口|进群选人|同城约p|约p|1-5线|真实对接|真实约见|同城资源)/i.test(value)) return 5;
  return 3;
}

function fieldsForDynamicRule(kind, pattern) {
  const value = normalizeForMatch(pattern);
  if (/(看我置顶|看我简介|点我头像)/i.test(value)) return ["displayName", "commentText", "profileBio"];
  if (kind === "resource_lure" || kind === "adult_lure" || kind === "contact_lure") return ["displayName", "commentText", "profileBio"];
  return ["displayName", "commentText", "profileBio"];
}

function candidateFromPublicReport(input = {}) {
  const screenName = input.screenName || input.handle || "";
  if (!isValidScreenName(screenName)) return null;
  const candidate = sanitizeCandidate({
    screenName,
    displayName: input.displayName || "",
    profileBio: input.profileBio || "",
    commentText: input.commentText || input.rawText || "",
    sourceUrl: input.sourceUrl || ""
  });
  return candidate;
}

function hasFeedbackHint(candidate, feedbackSamples = []) {
  if (!Array.isArray(feedbackSamples) || !feedbackSamples.length) return false;
  const joined = normalizeForMatch(
    `${candidate.screenName || ""} ${candidate.displayName || ""} ${candidate.profileBio || ""} ${candidate.commentText || ""}`
  );
  if (!joined) return false;
  for (const row of feedbackSamples) {
    if (String(row.label || "spam") !== "spam") continue;
    const patterns = Array.isArray(row.patternCandidates) && row.patternCandidates.length ? row.patternCandidates : row.fragments || [];
    for (const pattern of patterns) {
      const raw = typeof pattern === "string" ? pattern : pattern.value;
      const normalizedFrag = normalizeForMatch(raw);
      if (!normalizedFrag || normalizedFrag.length < 4) continue;
      if (joined.includes(normalizedFrag)) return true;
    }
  }
  return false;
}

async function getEffectiveClassifierEnv() {
  const runtime = await store.getRuntimeConfig({ withSecrets: true });
  return {
    ...process.env,
    AI_PROVIDER: runtime.aiProvider || process.env.AI_PROVIDER || "auto",
    CHEAP_AI_URL: runtime.cheapAiUrl || process.env.CHEAP_AI_URL || "",
    OPENAI_BASE_URL: runtime.openaiBaseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    CHEAP_AI_MODEL: runtime.cheapAiModel || process.env.CHEAP_AI_MODEL || "gpt-4o-mini",
    OPENAI_API_KEY: runtime.openaiApiKey || process.env.OPENAI_API_KEY || ""
  };
}

async function getActiveDynamicRules(limit = 500) {
  const result = await store.listDynamicRules({ status: "active", limit, offset: 0 });
  return result.items || result || [];
}

const requireClient = requireToken(config.clientToken, "x-client-token");
const requireAdmin = requireToken(config.adminToken, "x-admin-token");
const classifyRateLimiter = createRateLimiter({
  keyPrefix: "classify",
  windowMs: 60 * 1000,
  max: config.classifyRatePerMinute
});
const publicReportRateLimiter = createRateLimiter({
  keyPrefix: "public-report",
  windowMs: 60 * 1000,
  max: 30
});

async function classifyForReview(candidate) {
  const allFeedback = await store.listFeedbackSamples(400);
  const spamFeedback = allFeedback.filter((row) => row.label === "spam");
  const effectiveEnv = await getEffectiveClassifierEnv();
  const dynamicRules = await getActiveDynamicRules();
  return await classifyCandidate(candidate, {
    env: effectiveEnv,
    strongRuleThreshold: config.strongRuleThreshold,
    autoBlockConfidence: config.autoBlockConfidence,
    feedbackSamples: spamFeedback,
    dynamicRules
  });
}

async function confirmContributionFromDecision(contribution, result, reviewedBy = "auto_ai") {
  const candidate = contribution.payload?.candidate || result.candidate || {};
  const final = result.final || {};
  const row = await store.upsertBlacklistEntry({
    userId: candidate.userId || null,
    screenName: candidate.screenName || null,
    displayName: candidate.displayName || null,
    reason: final.reason || "auto_ai_approved_contribution",
    reasonDetails: final.details && typeof final.details === "object" ? final.details : {},
    confidence: normalizeNumber(final.confidence, config.autoBlockConfidence),
    tags: normalizeTags(["auto_ai_review", ...(final.tags || [])]),
    source: "auto_ai_contribution",
    status: "confirmed"
  });

  await store.upsertBlockTask({
    id: `auto_${candidate.screenName}_${Date.now()}`,
    userId: candidate.userId || null,
    screenName: candidate.screenName || "",
    displayName: candidate.displayName || "",
    reason: final.reason || "auto_ai_approved_contribution",
    confidence: normalizeNumber(final.confidence, config.autoBlockConfidence),
    status: "pending",
    scheduledAt: new Date().toISOString(),
    retries: 0,
    maxRetries: 2,
    source: "auto_ai_contribution",
    metadata: {
      contributionId: contribution.id,
      sourceUrl: candidate.sourceUrl || "",
      ruleScore: result.ruleResult?.score || 0,
      matchedRules: result.ruleResult?.matchedRules || []
    }
  });

  const reviewed = await store.reviewContribution(contribution.id, "approve", reviewedBy);
  await store.addEvent({
    type: "contribution_auto_approved",
    contributionId: contribution.id,
    screenName: candidate.screenName || "",
    reason: final.reason || "auto_ai_approved_contribution",
    confidence: normalizeNumber(final.confidence, 0),
    reviewedBy,
    metadata: {
      blacklistEntryId: row?.id || "",
      ruleScore: result.ruleResult?.score || 0,
      matchedRules: result.ruleResult?.matchedRules || [],
      aiProvider: result.aiResult?.provider || "unknown"
    }
  });

  return { reviewed, blacklistEntry: row };
}

async function autoReviewContribution(contribution, options = {}) {
  const candidate = sanitizeCandidate(contribution.payload?.candidate || {});
  if (!candidate) {
    return { action: "skipped", reason: "invalid_candidate" };
  }

  const lookup = await store.getBlacklistLookup();
  const existingLayer = lookup.get(candidate.screenName) || (candidate.userId ? lookup.get(String(candidate.userId).toLowerCase()) : null);
  if (existingLayer?.status === "whitelist") {
    await store.addEvent({
      type: "contribution_auto_review_skipped",
      contributionId: contribution.id,
      screenName: candidate.screenName,
      reason: "whitelist_hit"
    });
    return { action: "skipped", reason: "whitelist_hit" };
  }
  if (existingLayer?.status === "confirmed") {
    const reviewed = await store.reviewContribution(contribution.id, "approve", options.reviewedBy || "auto_ai_existing_confirmed");
    await store.addEvent({
      type: "contribution_auto_approved",
      contributionId: contribution.id,
      screenName: candidate.screenName,
      reason: "already_confirmed"
    });
    return { action: "approved", reviewed, reason: "already_confirmed" };
  }

  const result = await classifyForReview(candidate);
  await store.addDecision({
    type: "contribution_auto_review",
    screenName: candidate.screenName,
    ruleScore: result.ruleResult?.score || 0,
    matchedRules: result.ruleResult?.matchedRules || [],
    aiProvider: result.aiResult?.provider || "unknown",
    final: result.final
  });

  const final = result.final || {};
  const confidence = normalizeNumber(final.confidence, 0);
  if (final.shouldBlock && confidence >= config.autoBlockConfidence) {
    const confirmation = await confirmContributionFromDecision(contribution, result, options.reviewedBy || "auto_ai");
    return { action: "approved", result, ...confirmation };
  }

  await store.addEvent({
    type: "contribution_auto_review_kept_pending",
    contributionId: contribution.id,
    screenName: candidate.screenName,
    reason: final.reason || "not_confident",
    confidence,
    metadata: {
      shouldBlock: Boolean(final.shouldBlock),
      ruleScore: result.ruleResult?.score || 0,
      matchedRules: result.ruleResult?.matchedRules || [],
      aiProvider: result.aiResult?.provider || "unknown"
    }
  });

  return { action: "pending", result };
}

async function autoReviewPendingContributions(limit = 50) {
  const pending = await store.listContributions({ decision: "pending", limit, offset: 0 });
  const items = pending.items || pending || [];
  const summary = {
    scanned: items.length,
    approved: 0,
    pending: 0,
    skipped: 0,
    failed: 0,
    items: []
  };

  for (const contribution of items) {
    try {
      const reviewed = await autoReviewContribution(contribution, { reviewedBy: "auto_ai_batch" });
      summary[reviewed.action] = (summary[reviewed.action] || 0) + 1;
      summary.items.push({
        id: contribution.id,
        screenName: contribution.payload?.candidate?.screenName || "",
        action: reviewed.action,
        reason: reviewed.result?.final?.reason || reviewed.reason || "",
        confidence: reviewed.result?.final?.confidence || 0
      });
    } catch (error) {
      summary.failed += 1;
      summary.items.push({
        id: contribution.id,
        screenName: contribution.payload?.candidate?.screenName || "",
        action: "failed",
        reason: String(error?.message || error)
      });
    }
  }

  await store.addEvent({
    type: "contribution_auto_review_batch",
    reason: "admin_trigger",
    metadata: {
      scanned: summary.scanned,
      approved: summary.approved,
      pending: summary.pending,
      skipped: summary.skipped,
      failed: summary.failed
    }
  });

  return summary;
}

app.get("/health", async (req, res) => {
  const stats = await store.getStats();
  const runtime = await store.getRuntimeConfig({ withSecrets: false });
  res.json({
    ok: true,
    now: new Date().toISOString(),
    config: {
      strongRuleThreshold: config.strongRuleThreshold,
      aiReviewRuleThreshold: config.aiReviewRuleThreshold,
      autoBlockConfidence: config.autoBlockConfidence,
      classifyRatePerMinute: config.classifyRatePerMinute,
      aiProvider: runtime.aiProvider,
      cheapAiModel: runtime.cheapAiModel
    },
    stats
  });
});

app.get("/api/blacklist", async (req, res) => {
  const status = String(req.query.status || "confirmed");
  const query = normalizeString(req.query.query || "", 100);
  const { limit, offset } = parsePagination(req.query, { limit: 500, offset: 0 });
  const result = await store.listBlacklist({ status, query, limit, offset });
  res.json({ ...result, count: result.total });
});

app.get("/api/rules/active", async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { limit: 500, offset: 0 });
  const result = await store.listDynamicRules({ status: "active", limit, offset });
  const items = (result.items || []).map((rule) => ({
    id: rule.id,
    pattern: rule.pattern,
    kind: rule.kind,
    fields: rule.fields,
    score: rule.score,
    confidence: rule.confidence,
    reason: rule.reason,
    status: rule.status,
    updatedAt: rule.updatedAt
  }));
  res.json({ ...result, items });
});

app.get("/api/public/export", async (req, res) => {
  const data = await buildPublicExport(store);
  res.setHeader("cache-control", "public, max-age=60");
  res.json(data);
});

app.post("/api/public/reports", publicReportRateLimiter, async (req, res) => {
  const body = req.body || {};
  const candidate = candidateFromPublicReport(body);
  if (!candidate) {
    res.status(400).json({ error: "screenName and commentText/rawText are required" });
    return;
  }

  const rawText = normalizeString(body.rawText || body.commentText || "", 5000);
  const patterns = extractPatternCandidates(`${candidate.displayName}\n@${candidate.screenName}\n${rawText}`);
  const ruleResult = scoreCandidate(candidate);
  const row = await store.addContribution({
    candidate: {
      ...candidate,
      ruleScore: ruleResult.score,
      matchedRules: ruleResult.matchedRules
    },
    verdict: {
      isSpam: true,
      confidence: 0,
      shouldBlock: false,
      reason: "public_report_pending_review",
      tags: normalizeTags(["public_report", ...ruleResult.matchedRules]),
      details: {
        reporterNote: normalizeString(body.note || "", 500),
        ruleScore: ruleResult.score,
        ruleHumanReasons: ruleResult.humanReasons || [],
        ruleMatchDetails: ruleResult.matchDetails || [],
        patternCandidates: patterns.slice(0, 30)
      }
    },
    source: "public_report"
  });

  await store.addEvent({
    type: "public_report_add",
    contributionId: row.id,
    screenName: candidate.screenName,
    reason: "pending_review",
    metadata: {
      ruleScore: ruleResult.score,
      matchedRules: ruleResult.matchedRules || [],
      patternCandidates: patterns.slice(0, 12)
    }
  });

  res.json({
    ok: true,
    id: row.id,
    status: "pending_review",
    message: "Report submitted. An admin must approve it before it enters the public blacklist."
  });
});

app.post("/api/classify", requireClient, classifyRateLimiter, async (req, res) => {
  const candidate = sanitizeCandidate(req.body?.candidate);
  if (!candidate) {
    res.status(400).json({ error: "candidate.screenName is required" });
    return;
  }

  const lookup = await store.getBlacklistLookup();
  const layeredHit = lookup.get(candidate.screenName) || (candidate.userId ? lookup.get(String(candidate.userId).toLowerCase()) : null);
  if (layeredHit) {
    const layer = layeredHit.status || "confirmed";
    const layerResult = {
      candidate,
      ruleResult: {
        score: 0,
        matchedRules: [`blacklist_${layer}`],
        matchDetails: [
          {
            rule: `blacklist_${layer}`,
            fields: ["screenName"],
            hits: [{ field: "screenName", term: candidate.screenName, value: candidate.screenName }],
            reason: `Matched ${layer} blacklist layer`
          }
        ],
        humanReasons: [`blacklist_${layer} [screenName] => ${candidate.screenName}`]
      },
      aiResult: null,
      final: {
        isSpam: layer === "confirmed",
        confidence: Number(layeredHit.confidence || (layer === "confirmed" ? 0.98 : 0.1)),
        shouldBlock: layer === "confirmed",
        shouldHide: layer === "suspected",
        reviewOnly: layer === "reported",
        reason: `blacklist_${layer}_hit`,
        tags: [`blacklist:${layer}`, ...(Array.isArray(layeredHit.tags) ? layeredHit.tags : [])],
        details: {
          blacklistLayer: layer,
          blacklistEntryId: layeredHit.id,
          ruleScore: 0,
          ruleHumanReasons: [`${layer} layer hit: @${candidate.screenName}`],
          ruleMatchDetails: [
            {
              rule: `blacklist_${layer}`,
              fields: ["screenName"],
              hits: [{ field: "screenName", term: candidate.screenName, value: candidate.screenName }],
              reason: `Matched ${layer} blacklist layer`
            }
          ],
          aiProvider: "none",
          aiReason: "skipped_blacklist_layer",
          aiDetails: {}
        }
      }
    };
    if (layer === "whitelist") {
      layerResult.final.isSpam = false;
      layerResult.final.confidence = 0;
      layerResult.final.shouldBlock = false;
      layerResult.final.shouldHide = false;
      layerResult.final.reviewOnly = false;
    }
    await store.addDecision({
      type: "classify",
      screenName: candidate.screenName,
      ruleScore: 0,
      matchedRules: layerResult.ruleResult.matchedRules,
      final: layerResult.final
    });
    res.json(layerResult);
    return;
  }

  const allFeedback = await store.listFeedbackSamples(400);
  const spamFeedback = allFeedback.filter((row) => row.label === "spam");
  const feedbackHit = hasFeedbackHint(candidate, spamFeedback);
  const dynamicRules = await getActiveDynamicRules();
  const fastRule = scoreCandidate(candidate, { dynamicRules });
  if (fastRule.score < config.aiReviewRuleThreshold && !feedbackHit) {
    const fallback = {
      candidate,
      ruleResult: fastRule,
      aiResult: null,
      final: {
        isSpam: false,
        confidence: 0.05,
        shouldBlock: false,
        reason: "below_ai_review_threshold",
        tags: [...fastRule.matchedRules],
        details: {
          ruleScore: fastRule.score,
          ruleHumanReasons: fastRule.humanReasons || [],
          ruleMatchDetails: fastRule.matchDetails || [],
          aiProvider: "none",
          aiReason: "skipped_below_ai_review_threshold",
          aiDetails: {}
        }
      }
    };
    await store.addDecision({
      type: "classify",
      screenName: candidate.screenName,
      ruleScore: fastRule.score,
      matchedRules: fastRule.matchedRules,
      final: fallback.final
    });
    res.json(fallback);
    return;
  }

  const effectiveEnv = await getEffectiveClassifierEnv();
  const result = await classifyCandidate(candidate, {
    env: effectiveEnv,
    strongRuleThreshold: config.strongRuleThreshold,
    autoBlockConfidence: config.autoBlockConfidence,
    feedbackSamples: spamFeedback,
    dynamicRules
  });

  await store.addDecision({
    type: "classify",
    screenName: candidate.screenName,
    ruleScore: result.ruleResult?.score || 0,
    matchedRules: result.ruleResult?.matchedRules || [],
    aiProvider: result.aiResult?.provider || "unknown",
    final: result.final
  });

  res.json(result);
});

app.post("/api/contributions", requireClient, async (req, res) => {
  const payload = req.body || {};
  const candidate = sanitizeCandidate(payload.candidate || {});
  const verdict = payload.verdict || {};
  const normalizedPayload = {
    candidate,
    verdict: {
      isSpam: Boolean(verdict.isSpam),
      confidence: normalizeNumber(verdict.confidence, 0),
      shouldBlock: Boolean(verdict.shouldBlock),
      reason: normalizeString(verdict.reason, 120),
      tags: normalizeTags(verdict.tags),
      details: verdict.details && typeof verdict.details === "object" ? verdict.details : {}
    },
    source: normalizeString(payload.source || "extension", 40)
  };

  const row = await store.addContribution(normalizedPayload);
  let autoReview = null;
  try {
    autoReview = await autoReviewContribution(row);
  } catch (error) {
    autoReview = { action: "failed", reason: String(error?.message || error) };
    await store.addEvent({
      type: "contribution_auto_review_failed",
      contributionId: row.id,
      screenName: candidate?.screenName || "",
      reason: autoReview.reason
    });
  }
  res.json({ ok: true, row, autoReview });
});

app.get("/api/contributions", async (req, res) => {
  const decision = String(req.query.decision || "all");
  const query = normalizeString(req.query.query || "", 100);
  const { limit, offset } = parsePagination(req.query, { limit: 200, offset: 0 });
  const result = await store.listContributions({ decision, query, limit, offset });
  res.json({ ...result, count: result.total });
});

app.post("/api/contributions/:id/review", requireAdmin, async (req, res) => {
  const id = normalizeString(req.params.id, 80);
  const decision = String(req.body?.decision || "reject");
  if (!["approve", "reject"].includes(decision)) {
    res.status(400).json({ error: "decision must be approve or reject" });
    return;
  }

  const reviewedBy = normalizeString(req.headers["x-admin-user"] || "admin", 60);
  const reviewed = await store.reviewContribution(id, decision, reviewedBy);
  if (!reviewed) {
    res.status(404).json({ error: "contribution not found" });
    return;
  }

  if (decision === "approve") {
    const verdict = reviewed.payload?.verdict || {};
    const candidate = reviewed.payload?.candidate || {};
    const isPublicReport = reviewed.payload?.source === "public_report";
    const details = verdict.details && typeof verdict.details === "object" ? verdict.details : {};
    await store.upsertBlacklistEntry({
      userId: candidate.userId || null,
      screenName: candidate.screenName || null,
      displayName: candidate.displayName || null,
      reason: isPublicReport ? "admin_approved_public_report" : (verdict.reason || "approved_contribution"),
      reasonDetails: {
        ...details,
        approvedBy: reviewedBy,
        approvedContributionId: reviewed.id,
        source: reviewed.payload?.source || "contribution"
      },
      confidence: isPublicReport ? Math.max(0.85, normalizeNumber(verdict.confidence, 0)) : normalizeNumber(verdict.confidence, 0.7),
      tags: normalizeTags([...(verdict.tags || []), ...(isPublicReport ? ["public_report", "admin_approved"] : [])]),
      source: isPublicReport ? "public_report_admin_approved" : "contribution",
      status: "confirmed"
    });
  }

  await store.addEvent({
    type: "contribution_review",
    contributionId: reviewed.id,
    decision,
    screenName: reviewed.payload?.candidate?.screenName || "",
    reviewedBy
  });

  res.json({ ok: true, reviewed });
});

app.post("/api/events", requireClient, async (req, res) => {
  const event = req.body || {};
  const row = await store.addEvent({
    type: normalizeString(event.type || "unknown", 60),
    screenName: normalizeScreenName(event.screenName || ""),
    reason: normalizeString(event.reason || "", 180),
    confidence: normalizeNumber(event.confidence, 0),
    status: normalizeNumber(event.status, 0),
    error: normalizeString(event.error || "", 500),
    metadata: event.metadata || {}
  });
  res.json({ ok: true, row });
});

app.get("/api/events", async (req, res) => {
  const type = String(req.query.type || "all");
  const query = normalizeString(req.query.query || "", 100);
  const { limit, offset } = parsePagination(req.query, { limit: 200, offset: 0 });
  const result = await store.listEvents({ type, query, limit, offset });
  res.json({ ...result, count: result.total });
});

app.post("/api/blacklist/upsert", requireAdmin, async (req, res) => {
  const entry = req.body || {};
  if (!entry.screenName && !entry.userId) {
    res.status(400).json({ error: "screenName or userId required" });
    return;
  }
  const row = await store.upsertBlacklistEntry({
    userId: entry.userId || null,
    screenName: entry.screenName || null,
    displayName: entry.displayName || null,
    reason: entry.reason || "manual_upsert",
    reasonDetails: entry.reasonDetails && typeof entry.reasonDetails === "object" ? entry.reasonDetails : {},
    confidence: normalizeNumber(entry.confidence, 0.8),
    tags: normalizeTags(entry.tags),
    source: entry.source || "manual",
    status: normalizeBlacklistStatus(entry.status || "confirmed")
  });
  res.json({ ok: true, row });
});

app.post("/api/block-tasks", requireClient, async (req, res) => {
  const task = sanitizeBlockTask(req.body || {});
  if (!task) {
    res.status(400).json({ error: "screenName required" });
    return;
  }
  const row = await store.upsertBlockTask(task);
  res.json({ ok: true, row });
});

app.post("/api/block-tasks/:id/status", requireClient, async (req, res) => {
  const id = normalizeString(req.params.id, 80);
  const patch = req.body && typeof req.body === "object" ? req.body : {};
  const status = normalizeBlockTaskStatus(patch.status);
  const row = await store.updateBlockTask(id, {
    status,
    scheduledAt: patch.scheduledAt ? normalizeString(patch.scheduledAt, 80) : undefined,
    startedAt: patch.startedAt ? normalizeString(patch.startedAt, 80) : undefined,
    finishedAt: patch.finishedAt ? normalizeString(patch.finishedAt, 80) : undefined,
    retries: patch.retries === undefined ? undefined : Math.max(0, Math.trunc(normalizeNumber(patch.retries, 0))),
    lastError: patch.lastError === undefined ? undefined : normalizeString(patch.lastError || "", 600),
    xStatusCode: patch.xStatusCode === undefined ? undefined : Math.max(0, Math.trunc(normalizeNumber(patch.xStatusCode, 0))),
    metadata: patch.metadata && typeof patch.metadata === "object" ? patch.metadata : undefined
  });
  if (!row) {
    res.status(404).json({ error: "task_not_found" });
    return;
  }
  res.json({ ok: true, row });
});

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  const stats = await store.getStats();
  res.json({ stats });
});

app.get("/api/admin/runtime-config", requireAdmin, async (req, res) => {
  const runtime = await store.getRuntimeConfig({ withSecrets: false });
  res.json({ runtime });
});

app.post("/api/admin/runtime-config", requireAdmin, async (req, res) => {
  const patch = sanitizeRuntimeConfigInput(req.body || {});
  const runtime = await store.updateRuntimeConfig(patch);
  await store.addEvent({ type: "runtime_config_update", reason: "admin_update", metadata: { aiProvider: runtime.aiProvider, cheapAiModel: runtime.cheapAiModel } });
  res.json({ ok: true, runtime });
});

app.post("/api/admin/runtime-config/test", requireAdmin, async (req, res) => {
  const sample =
    sanitizeCandidate(req.body?.candidate || {}) ||
    sanitizeCandidate({
      screenName: "sample_test_user",
      displayName: "04年男大",
      profileBio: "夸克网盘1T空间",
      commentText: "线下dd 看我主页 私信领福利 tg 电报",
      sourceUrl: "http://localhost/test"
    });

  const effectiveEnv = await getEffectiveClassifierEnv();
  const allFeedback = await store.listFeedbackSamples(400);
  const spamFeedback = allFeedback.filter((row) => row.label === "spam");
  const dynamicRules = await getActiveDynamicRules();
  const result = await classifyCandidate(sample, {
    env: effectiveEnv,
    strongRuleThreshold: config.strongRuleThreshold,
    autoBlockConfidence: config.autoBlockConfidence,
    feedbackSamples: spamFeedback,
    dynamicRules
  });
  res.json({ ok: true, result });
});

app.post("/api/admin/feedback-samples", requireAdmin, async (req, res) => {
  const body = req.body || {};
  const rawText = normalizeString(body.rawText || "", 5000);
  if (!rawText) {
    res.status(400).json({ error: "rawText is required" });
    return;
  }
  const row = await store.addFeedbackSample({
    label: body.label === "ham" ? "ham" : "spam",
    screenName: normalizeScreenName(body.screenName || ""),
    displayName: normalizeString(body.displayName || "", 120),
    rawText,
    normalizedText: normalizeForMatch(rawText),
    fragments: extractFeedbackFragments(rawText),
    patternCandidates: extractPatternCandidates(rawText),
    note: normalizeString(body.note || "", 300),
    source: "admin"
  });
  await store.addEvent({
    type: "feedback_sample_add",
    screenName: row.screenName,
    reason: row.label,
    metadata: { fragments: row.fragments.slice(0, 12) }
  });
  res.json({ ok: true, row });
});

app.post("/api/admin/ai-rule-ingest", requireAdmin, async (req, res) => {
  const body = req.body || {};
  const rawText = normalizeString(body.rawText || "", 12000);
  if (!rawText) {
    res.status(400).json({ error: "rawText is required" });
    return;
  }

  const model = normalizeString(body.model || "gpt-5.4", 120);
  const label = body.label === "ham" ? "ham" : "spam";
  const autoApply = body.autoApply !== false;
  const confirmAccounts = body.confirmAccounts !== false && label === "spam";
  const patterns = extractPatternCandidates(rawText);
  const row = await store.addFeedbackSample({
    label,
    screenName: normalizeScreenName(body.screenName || ""),
    displayName: normalizeString(body.displayName || "", 120),
    rawText,
    normalizedText: normalizeForMatch(rawText),
    fragments: patterns.map((pattern) => pattern.value),
    patternCandidates: patterns,
    note: normalizeString(body.note || `ai_rule_ingest:${model}`, 300),
    source: "admin_ai_rule_ingest"
  });

  const effectiveEnv = await getEffectiveClassifierEnv();
  const result = await suggestRulesFromFeedback([row], {
    env: {
      ...effectiveEnv,
      AI_PROVIDER: "openai",
      CHEAP_AI_MODEL: model
    }
  });

  const suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
  const appliedRules = [];
  if (autoApply && label === "spam") {
    const candidates = [
      ...suggestions
        .filter((item) => item.action === "candidate_rule" || Number(item.confidence || 0) >= 0.7)
        .map((item) => ({
          pattern: item.pattern,
          kind: item.kind || "phrase",
          confidence: Number(item.confidence || 0.7),
          reason: item.reason || "ai_suggested_rule",
          examples: item.examples || []
        })),
      ...patterns
        .filter((item) => ["resource_lure", "adult_lure", "contact_lure", "netdisk", "tg"].includes(item.kind) || item.score >= 5)
        .map((item) => ({
          pattern: item.value,
          kind: item.kind,
          confidence: Math.min(0.92, 0.55 + Number(item.score || 1) * 0.06),
          reason: `pattern_candidate:${item.source || "sample"}`,
          examples: [rawText.slice(0, 240)]
        }))
    ];

    const seen = new Set();
    for (const item of candidates) {
      const pattern = normalizeForMatch(item.pattern);
      const key = `${item.kind}:${pattern}`;
      if (seen.has(key) || !isSafeDynamicPattern(pattern, item.kind)) continue;
      seen.add(key);
      const rule = await store.upsertDynamicRule({
        pattern,
        kind: item.kind || patternKind(pattern),
        fields: fieldsForDynamicRule(item.kind, pattern),
        score: dynamicRuleScoreForKind(item.kind, pattern),
        confidence: item.confidence,
        reason: item.reason,
        source: `admin_ai_ingest:${model}`,
        examples: item.examples,
        status: "active"
      });
      if (rule) appliedRules.push(rule);
      if (appliedRules.length >= 20) break;
    }
  }

  const parsedAccounts = parsePastedXAccounts(rawText);
  const confirmedAccounts = [];
  if (confirmAccounts) {
    for (const candidate of parsedAccounts.slice(0, 100)) {
      const blacklistRow = await store.upsertBlacklistEntry({
        screenName: candidate.screenName,
        displayName: candidate.displayName,
        reason: "admin_ai_ingest_confirmed_spam",
        confidence: 0.96,
        tags: normalizeTags(["admin_confirmed", "ai_rule_ingest", ...appliedRules.slice(0, 5).map((rule) => `rule:${rule.kind}`)]),
        reasonDetails: {
          ruleScore: 0,
          ruleHumanReasons: ["admin pasted spam sample"],
          aiProvider: result.provider || "",
          aiReason: `AI/model-assisted ingest via ${model}`,
          patternCandidates: patterns.slice(0, 12)
        },
        source: "admin_ai_rule_ingest",
        status: "confirmed"
      });
      if (blacklistRow) confirmedAccounts.push(blacklistRow);
    }
  }

  await store.addEvent({
    type: "ai_rule_ingest",
    reason: `model=${model}`,
    metadata: {
      provider: result.provider || "",
      sampleId: row.id,
      suggestions: suggestions.length,
      appliedRules: appliedRules.length,
      confirmedAccounts: confirmedAccounts.length
    }
  });

  res.json({
    ok: true,
    model,
    provider: result.provider || "",
    sample: row,
    suggestions,
    appliedRules,
    confirmedAccounts
  });
});

app.get("/api/admin/feedback-samples", requireAdmin, async (req, res) => {
  const label = String(req.query.label || "all");
  const query = normalizeString(req.query.query || "", 120);
  const { limit, offset } = parsePagination(req.query, { limit: 100, offset: 0 });
  const result = await store.listFeedbackSamples({ label, query, limit, offset });
  res.json(result);
});

app.get("/api/admin/dynamic-rules", requireAdmin, async (req, res) => {
  const status = String(req.query.status || "all");
  const query = normalizeString(req.query.query || "", 120);
  const { limit, offset } = parsePagination(req.query, { limit: 200, offset: 0 });
  const result = await store.listDynamicRules({ status, query, limit, offset });
  res.json(result);
});

app.get("/api/admin/rule-suggestions", requireAdmin, async (req, res) => {
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 300)));
  const samples = await store.listFeedbackSamples({ label: "spam", limit, offset: 0 });
  const effectiveEnv = await getEffectiveClassifierEnv();
  const result = await suggestRulesFromFeedback(samples.items || samples, { env: effectiveEnv });
  res.json({ ok: true, ...result });
});

app.get("/api/admin/block-tasks", requireAdmin, async (req, res) => {
  const status = String(req.query.status || "all");
  const query = normalizeString(req.query.query || "", 120);
  const { limit, offset } = parsePagination(req.query, { limit: 200, offset: 0 });
  const result = await store.listBlockTasks({ status, query, limit, offset });
  res.json(result);
});

app.get("/api/admin/blacklist", requireAdmin, async (req, res) => {
  const status = String(req.query.status || "all");
  const query = normalizeString(req.query.query || "", 120);
  const { limit, offset } = parsePagination(req.query, { limit: 200, offset: 0 });
  const result = await store.listBlacklist({ status, query, limit, offset });
  res.json(result);
});

app.delete("/api/admin/blacklist/:key", requireAdmin, async (req, res) => {
  const key = normalizeScreenName(req.params.key);
  const ok = await store.removeBlacklistEntry(key);
  if (!ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await store.addEvent({ type: "blacklist_remove", screenName: key, reason: "manual_remove" });
  res.json({ ok: true });
});

app.get("/api/admin/contributions", requireAdmin, async (req, res) => {
  const decision = String(req.query.decision || "all");
  const query = normalizeString(req.query.query || "", 120);
  const { limit, offset } = parsePagination(req.query, { limit: 200, offset: 0 });
  const result = await store.listContributions({ decision, query, limit, offset });
  res.json(result);
});

app.post("/api/admin/contributions/auto-review", requireAdmin, async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.body?.limit || 50)));
  const summary = await autoReviewPendingContributions(limit);
  res.json({ ok: true, summary });
});

app.get("/api/admin/events", requireAdmin, async (req, res) => {
  const type = String(req.query.type || "all");
  const query = normalizeString(req.query.query || "", 120);
  const { limit, offset } = parsePagination(req.query, { limit: 300, offset: 0 });
  const result = await store.listEvents({ type, query, limit, offset });
  res.json(result);
});

app.get("/api/admin/decisions", requireAdmin, async (req, res) => {
  const { limit, offset } = parsePagination(req.query, { limit: 300, offset: 0 });
  const result = await store.listDecisions({ limit, offset });
  res.json(result);
});

app.get("/admin", async (req, res) => {
  res.type("html").send(renderAdminPage());
});

app.get("/admin-legacy", async (req, res) => {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>Spam Guard 管理台</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #172033;
      --muted: #667085;
      --line: #d9e2ee;
      --panel: rgba(255,255,255,.92);
      --panel-strong: #ffffff;
      --brand: #0f766e;
      --brand-dark: #134e4a;
      --warn: #b45309;
      --danger: #b91c1c;
      --ok: #15803d;
      --shadow: 0 18px 45px rgba(15, 23, 42, .10);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: "Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 12% 8%, rgba(20,184,166,.22), transparent 28%),
        radial-gradient(circle at 88% 4%, rgba(245,158,11,.18), transparent 30%),
        linear-gradient(135deg, #f7fbf8 0%, #eef6f3 48%, #f6f1e8 100%);
      min-height: 100vh;
    }
    .shell { width: min(1480px, calc(100vw - 36px)); margin: 0 auto; padding: 26px 0 48px; }
    .hero {
      display: grid;
      grid-template-columns: minmax(280px, 1fr) minmax(340px, 560px);
      gap: 18px;
      align-items: stretch;
      margin-bottom: 18px;
    }
    .hero-main, .panel, .table-card {
      background: var(--panel);
      border: 1px solid rgba(255,255,255,.75);
      box-shadow: var(--shadow);
      backdrop-filter: blur(14px);
      border-radius: 22px;
    }
    .hero-main { padding: 24px; position: relative; overflow: hidden; }
    .hero-main::after {
      content: "";
      position: absolute;
      right: -80px;
      top: -90px;
      width: 240px;
      height: 240px;
      border-radius: 999px;
      background: rgba(15,118,110,.13);
    }
    h1 { margin: 0; font-size: 30px; letter-spacing: -.04em; }
    h2 { margin: 0; font-size: 18px; letter-spacing: -.02em; }
    .subtitle { margin-top: 10px; color: var(--muted); line-height: 1.65; max-width: 760px; }
    .token-box { padding: 18px; }
    .toolbar { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: end; }
    .section-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .section-title p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
    .cards { display: grid; grid-template-columns: repeat(6,minmax(132px,1fr)); gap: 12px; margin: 18px 0; }
    .card { background: var(--panel-strong); border: 1px solid var(--line); border-radius: 18px; padding: 14px; }
    .card .k { font-size: 12px; color: var(--muted); }
    .card .v { font-size: 26px; margin-top: 8px; font-weight: 800; letter-spacing: -.04em; }
    .panel { padding: 18px; margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: repeat(2,minmax(260px,1fr)); gap: 12px; }
    label { color: #344054; font-size: 12px; font-weight: 700; }
    .grid label, .inline label, .toolbar label { display: flex; flex-direction: column; gap: 7px; }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 12px;
      color: var(--ink);
      background: #fff;
      outline: none;
      font: inherit;
      font-size: 13px;
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    input, select { height: 38px; padding: 7px 11px; }
    textarea { min-height: 118px; padding: 10px 12px; resize: vertical; line-height: 1.55; }
    input:focus, select:focus, textarea:focus { border-color: rgba(15,118,110,.65); box-shadow: 0 0 0 4px rgba(20,184,166,.14); }
    button {
      height: 38px;
      border: 0;
      border-radius: 12px;
      padding: 0 14px;
      background: var(--brand);
      color: #fff;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 10px 22px rgba(15,118,110,.18);
    }
    button.secondary { background: #e8f3f1; color: var(--brand-dark); box-shadow: none; border: 1px solid #b7d8d3; }
    button:hover { filter: brightness(.96); }
    .actions { margin-top: 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .inline { display: flex; gap: 10px; flex-wrap: wrap; align-items: end; margin: 10px 0 12px; }
    .inline label { min-width: 180px; }
    .table-card { padding: 14px; margin-bottom: 18px; overflow: hidden; }
    .table-scroll { overflow: auto; max-height: 520px; border-radius: 16px; border: 1px solid var(--line); background: #fff; }
    table { width: 100%; border-collapse: separate; border-spacing: 0; min-width: 980px; }
    th, td { border-bottom: 1px solid #edf1f6; padding: 10px 12px; font-size: 12px; vertical-align: top; }
    th { position: sticky; top: 0; z-index: 1; background: #f5f8fb; text-align: left; color: #475467; font-weight: 800; }
    tr:hover td { background: #fbfdfc; }
    .muted { font-size: 12px; color: var(--muted); }
    .status-line { display: inline-flex; align-items: center; min-height: 28px; padding: 4px 10px; border-radius: 999px; background: #eef6f3; color: var(--brand-dark); font-size: 12px; font-weight: 700; }
    .status-line.error { background: #fef2f2; color: var(--danger); }
    .mono { font-family: "Cascadia Mono", "SFMono-Regular", Menlo, Consolas, monospace; font-size: 11px; white-space: pre-wrap; word-break: break-word; }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 8px; font-size: 11px; font-weight: 800; background: #e8f3f1; color: var(--brand-dark); }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 980px) {
      .shell { width: min(100vw - 20px, 1480px); padding-top: 12px; }
      .hero, .two-col, .grid { grid-template-columns: 1fr; }
      .toolbar { grid-template-columns: 1fr; }
      .cards { grid-template-columns: repeat(2,minmax(120px,1fr)); }
    }
  </style>
</head>
<body>
  <h1>Spam Guard Admin</h1>
  <div class="toolbar">
    <label>Admin Token <input id="adminToken" placeholder="optional" style="width:260px" /></label>
    <button id="saveToken">Save Token</button>
    <button id="refreshAll">Refresh</button>
    <span id="status"></span>
  </div>

  <div class="panel">
    <h2 style="margin-top:0">AI Runtime Config</h2>
    <div class="grid">
      <label>Provider
        <select id="aiProvider">
          <option value="auto">auto (external -> openai -> mock)</option>
          <option value="external">external only</option>
          <option value="openai">openai only</option>
          <option value="mock">mock only</option>
        </select>
      </label>
      <label>Model
        <input id="cheapAiModel" placeholder="gpt-4o-mini" />
      </label>
      <label>External Classifier URL
        <input id="cheapAiUrl" placeholder="http://host/classify" />
      </label>
      <label>OpenAI Base URL
        <input id="openaiBaseUrl" placeholder="https://api.openai.com/v1" />
      </label>
      <label>OpenAI API Key (leave blank to keep current)
        <input id="openaiApiKey" type="password" placeholder="sk-..." />
      </label>
      <label>Current Key Status
        <input id="openaiKeyStatus" disabled />
      </label>
    </div>
    <div class="actions">
      <button id="saveAiConfig">Save AI Config</button>
      <button id="testAiConfig">Test Classify</button>
      <span id="aiStatus" class="muted"></span>
    </div>
  </div>

  <div class="panel">
    <h2 style="margin-top:0">Report Spam Sample</h2>
    <div class="grid">
      <label>Label
        <select id="reportLabel">
          <option value="spam">spam</option>
          <option value="ham">ham</option>
        </select>
      </label>
      <label>Screen Name (optional)
        <input id="reportScreenName" placeholder="@user" />
      </label>
      <label>Display Name (optional)
        <input id="reportDisplayName" placeholder="昵称" />
      </label>
      <label>Note (optional)
        <input id="reportNote" placeholder="备注" />
      </label>
      <label style="grid-column: 1 / span 2;">Raw Comment/User Block
        <textarea id="reportRawText" placeholder="粘贴评论块，例如：司泽蔷...附近DD..."></textarea>
      </label>
    </div>
    <div class="actions">
      <button id="submitReport">Submit Sample</button>
      <span id="reportStatus" class="muted"></span>
    </div>
  </div>

  <div class="cards" id="stats"></div>
  <div class="panel">
    <h2 style="margin-top:0">Blacklist Layer Upsert</h2>
    <div class="inline">
      <label>Screen Name <input id="manualScreenName" placeholder="@user" /></label>
      <label>Display Name <input id="manualDisplayName" placeholder="optional" /></label>
      <label>Layer
        <select id="manualStatus">
          <option value="confirmed">confirmed: auto block</option>
          <option value="suspected">suspected: hide/review</option>
          <option value="reported">reported: report only</option>
          <option value="whitelist">whitelist: never process</option>
        </select>
      </label>
      <label>Reason <input id="manualReason" placeholder="manual_upsert" /></label>
      <button id="manualUpsert">Save Layer</button>
      <span id="manualStatusText" class="muted"></span>
    </div>
  </div>

  <h2>Blacklist Layers</h2>
  <div class="inline">
    <label>Layer
      <select id="blacklistStatus">
        <option value="all">all</option>
        <option value="confirmed">confirmed</option>
        <option value="suspected">suspected</option>
        <option value="reported">reported</option>
        <option value="whitelist">whitelist</option>
      </select>
    </label>
    <label>Search <input id="blacklistQuery" placeholder="@user / reason / tag" /></label>
  </div>
  <table id="blacklistTable"></table>
  <h2>Block Tasks</h2>
  <div class="inline">
    <label>Status
      <select id="taskStatus">
        <option value="all">all</option>
        <option value="pending">pending</option>
        <option value="running">running</option>
        <option value="success">success</option>
        <option value="failed">failed</option>
        <option value="cooldown">cooldown</option>
        <option value="skipped">skipped</option>
      </select>
    </label>
    <label>Search <input id="taskQuery" placeholder="@user / error / reason" /></label>
  </div>
  <table id="taskTable"></table>
  <h2>Reported Samples</h2>
  <div class="inline">
    <button id="loadRuleSuggestions">Summarize Rule Suggestions</button>
    <span id="ruleSuggestionStatus" class="muted"></span>
  </div>
  <table id="ruleSuggestionTable"></table>
  <table id="feedbackTable"></table>
  <h2>Pending Contributions</h2>
  <table id="contribTable"></table>
  <h2>Recent Events</h2>
  <table id="eventTable"></table>
  <h2>Recent Decisions</h2>
  <table id="decisionTable"></table>
  <script>
    function token() {
      return localStorage.getItem("spam_guard_admin_token") || "";
    }
    function headers() {
      const t = token();
      return t ? { "x-admin-token": t } : {};
    }
    function apiPath(url) {
      const prefix = window.location.pathname.startsWith("/x-spam-guard") ? "/x-spam-guard" : "";
      return prefix + url;
    }
    async function jget(url) {
      const r = await fetch(apiPath(url), { headers: headers() });
      if (!r.ok) throw new Error(url + " => " + r.status);
      return await r.json();
    }
    async function jpost(url, payload) {
      const r = await fetch(apiPath(url), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers() },
        body: JSON.stringify(payload || {})
      });
      if (!r.ok) throw new Error(url + " => " + r.status);
      return await r.json();
    }

    function setStatus(text) {
      document.getElementById("status").textContent = text || "";
    }
    function setAiStatus(text) {
      document.getElementById("aiStatus").textContent = text || "";
    }
    function setReportStatus(text) {
      document.getElementById("reportStatus").textContent = text || "";
    }
    function setManualStatus(text) {
      document.getElementById("manualStatusText").textContent = text || "";
    }
    function setRuleSuggestionStatus(text) {
      document.getElementById("ruleSuggestionStatus").textContent = text || "";
    }

    function escapeHtml(text) {
      return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function formatReasonDetails(details) {
      if (!details || typeof details !== "object") return "";
      const ruleReasons = Array.isArray(details.ruleHumanReasons) ? details.ruleHumanReasons : [];
      const ruleMatches = Array.isArray(details.ruleMatchDetails) ? details.ruleMatchDetails : [];
      const lines = [];
      if (details.blacklistLayer) {
        lines.push("layer: " + details.blacklistLayer);
      }
      if (ruleReasons.length) {
        lines.push("rules: " + ruleReasons.join(" | "));
      }
      if (ruleMatches.length) {
        const hitLines = [];
        ruleMatches.forEach(function(item){
          const hits = Array.isArray(item.hits) ? item.hits : [];
          if (hits.length) {
            hits.forEach(function(hit) {
              const field = hit.field || "unknown";
              const term = hit.term || "";
              const value = hit.value || "";
              hitLines.push(field + " hit: " + term + (value ? (" in " + value) : ""));
            });
          } else {
            const fs = Array.isArray(item.fields) ? item.fields.join(",") : "";
            const evidence = Array.isArray(item.evidence) ? item.evidence.join(", ") : "";
            hitLines.push(item.rule + (fs ? ("@" + fs) : "") + (evidence ? (" => " + evidence) : ""));
          }
        });
        lines.push("field hits: " + hitLines.join(" ; "));
      }
      if (details.aiReason) {
        lines.push("ai: " + details.aiReason);
      }
      return escapeHtml(lines.join("\\n"));
    }

    function renderStats(stats) {
      const entries = [
        ["blacklistTotal", stats.blacklistTotal],
        ["confirmed", stats.blacklistConfirmed],
        ["suspected", stats.blacklistSuspected],
        ["reported", stats.blacklistReported],
        ["whitelist", stats.blacklistWhitelist],
        ["blockTaskPending", stats.blockTaskPending],
        ["contributionPending", stats.contributionPending],
        ["blocked24h", stats.blocked24h],
        ["blockFailed24h", stats.blockFailed24h],
        ["decisions24h", stats.decisions24h],
        ["eventsTotal", stats.eventsTotal]
      ];
      const el = document.getElementById("stats");
      el.innerHTML = entries.map(function(pair){ return '<div class="card"><div class="k">' + pair[0] + '</div><div class="v">' + pair[1] + '</div></div>'; }).join("");
    }

    function renderContrib(items) {
      const el = document.getElementById("contribTable");
      el.innerHTML =
        '<tr><th>Created</th><th>User</th><th>Comment</th><th>Reason/Conf</th><th>Why (name/comment/bio)</th><th>Action</th></tr>' +
        items.map(function(row) {
          const c = row.payload && row.payload.candidate ? row.payload.candidate : {};
          const v = row.payload && row.payload.verdict ? row.payload.verdict : {};
          const detailText = formatReasonDetails(v.details || {});
          return '<tr>' +
            '<td>' + (row.createdAt || "") + '</td>' +
            '<td>@' + (c.screenName || "") + '<br>' + (c.displayName || "") + '</td>' +
            '<td>' + (c.commentText || "") + '</td>' +
            '<td>' + (v.reason || "") + '<br>' + ((v.confidence || 0).toFixed ? (v.confidence || 0).toFixed(2) : (v.confidence || 0)) + '</td>' +
            '<td class="mono">' + detailText + '</td>' +
            '<td class="actions"><button onclick="review(\\'' + row.id + '\\',\\'approve\\')">Approve</button><button onclick="review(\\'' + row.id + '\\',\\'reject\\')">Reject</button></td>' +
          '</tr>';
        }).join("");
    }

    function renderBlacklist(items) {
      const el = document.getElementById("blacklistTable");
      el.innerHTML =
        '<tr><th>Updated</th><th>Layer</th><th>User</th><th>Reason</th><th>Tags</th><th>Why (field hits)</th></tr>' +
        items.map(function(row) {
          const details = formatReasonDetails(row.reasonDetails || {});
          const tags = Array.isArray(row.tags) ? row.tags.join(", ") : "";
          return '<tr>' +
            '<td>' + (row.updatedAt || "") + '</td>' +
            '<td>' + escapeHtml(row.status || "") + '</td>' +
            '<td>@' + (row.screenName || "") + '<br>' + (row.displayName || "") + '</td>' +
            '<td>' + (row.reason || "") + '<br>' + ((row.confidence || 0).toFixed ? (row.confidence || 0).toFixed(2) : (row.confidence || 0)) + '</td>' +
            '<td>' + escapeHtml(tags) + '</td>' +
            '<td class="mono">' + details + '</td>' +
          '</tr>';
        }).join("");
    }

    function renderTasks(items) {
      const el = document.getElementById("taskTable");
      el.innerHTML =
        '<tr><th>Updated</th><th>Status</th><th>User</th><th>Schedule</th><th>Retries</th><th>X Code</th><th>Reason/Error</th></tr>' +
        items.map(function(row) {
          return '<tr>' +
            '<td>' + escapeHtml(row.updatedAt || "") + '</td>' +
            '<td>' + escapeHtml(row.status || "") + '</td>' +
            '<td>@' + escapeHtml(row.screenName || "") + '<br>' + escapeHtml(row.displayName || "") + '</td>' +
            '<td>plan: ' + escapeHtml(row.scheduledAt || "") + '<br>start: ' + escapeHtml(row.startedAt || "") + '<br>finish: ' + escapeHtml(row.finishedAt || "") + '</td>' +
            '<td>' + escapeHtml(String(row.retries || 0)) + ' / ' + escapeHtml(String(row.maxRetries || 0)) + '</td>' +
            '<td>' + escapeHtml(String(row.xStatusCode || "")) + '</td>' +
            '<td class="mono">' + escapeHtml((row.reason || "") + (row.lastError ? "\\n" + row.lastError : "")) + '</td>' +
          '</tr>';
        }).join("");
    }

    function renderFeedback(items) {
      const el = document.getElementById("feedbackTable");
      el.innerHTML =
        '<tr><th>Created</th><th>Label</th><th>User</th><th>Raw Text</th><th>Pattern Candidates</th></tr>' +
        items.map(function(row) {
          const patterns = Array.isArray(row.patternCandidates) && row.patternCandidates.length
            ? row.patternCandidates.slice(0, 16).map(function(item) {
                if (typeof item === "string") return item;
                return (item.value || "") + " [" + (item.kind || "phrase") + ":" + (item.score || 0) + "]";
              }).join(" | ")
            : (Array.isArray(row.fragments) ? row.fragments.slice(0, 12).join(" | ") : "");
          return '<tr>' +
            '<td>' + (row.createdAt || "") + '</td>' +
            '<td>' + (row.label || "") + '</td>' +
            '<td>@' + (row.screenName || "") + '<br>' + (row.displayName || "") + '</td>' +
            '<td class="mono">' + escapeHtml(row.rawText || "") + '</td>' +
            '<td class="mono">' + escapeHtml(patterns) + '</td>' +
          '</tr>';
        }).join("");
    }

    function renderRuleSuggestions(provider, items) {
      const el = document.getElementById("ruleSuggestionTable");
      el.innerHTML =
        '<tr><th>Provider</th><th>Action</th><th>Kind</th><th>Pattern</th><th>Confidence</th><th>Reason</th></tr>' +
        items.map(function(item) {
          return '<tr>' +
            '<td>' + escapeHtml(provider || "") + '</td>' +
            '<td>' + escapeHtml(item.action || "") + '</td>' +
            '<td>' + escapeHtml(item.kind || "") + '</td>' +
            '<td class="mono">' + escapeHtml(item.pattern || "") + '</td>' +
            '<td>' + escapeHtml(String(item.confidence || "")) + '</td>' +
            '<td class="mono">' + escapeHtml(item.reason || "") + '</td>' +
          '</tr>';
        }).join("");
    }

    function renderEvents(items) {
      const el = document.getElementById("eventTable");
      el.innerHTML =
        '<tr><th>At</th><th>Type</th><th>User</th><th>Reason</th><th>Status</th></tr>' +
        items.map(function(row) {
          return '<tr><td>' + (row.at || "") + '</td><td>' + (row.type || "") + '</td><td>@' + (row.screenName || "") + '</td><td>' + (row.reason || "") + '</td><td>' + (row.status || "") + '</td></tr>';
        }).join("");
    }

    function renderDecisions(items) {
      const el = document.getElementById("decisionTable");
      el.innerHTML =
        '<tr><th>At</th><th>User</th><th>RuleScore</th><th>AI</th><th>Final</th><th>Why (name/comment/bio)</th></tr>' +
        items.map(function(row) {
          const f = row.final || {};
          const c = ((f.confidence || 0).toFixed ? (f.confidence || 0).toFixed(2) : (f.confidence || 0));
          const detailText = formatReasonDetails(f.details || {});
          return '<tr><td>' + (row.at || "") + '</td><td>@' + (row.screenName || "") + '</td><td>' + (row.ruleScore || 0) + '</td><td>' + (row.aiProvider || "") + '</td><td>' + (f.shouldBlock ? 'block' : 'skip') + ' / ' + c + '</td><td class="mono">' + detailText + '</td></tr>';
        }).join("");
    }

    function fillRuntimeConfig(runtime) {
      document.getElementById('aiProvider').value = runtime.aiProvider || 'auto';
      document.getElementById('cheapAiUrl').value = runtime.cheapAiUrl || '';
      document.getElementById('openaiBaseUrl').value = runtime.openaiBaseUrl || 'https://api.openai.com/v1';
      document.getElementById('cheapAiModel').value = runtime.cheapAiModel || 'gpt-4o-mini';
      document.getElementById('openaiApiKey').value = '';
      document.getElementById('openaiKeyStatus').value = runtime.hasOpenaiApiKey ? 'stored' : 'empty';
    }

    async function loadRuntimeConfig() {
      const resp = await jget('/api/admin/runtime-config');
      fillRuntimeConfig(resp.runtime || {});
    }

    async function saveRuntimeConfig() {
      const keyInput = document.getElementById('openaiApiKey').value.trim();
      const payload = {
        aiProvider: document.getElementById('aiProvider').value,
        cheapAiUrl: document.getElementById('cheapAiUrl').value.trim(),
        openaiBaseUrl: document.getElementById('openaiBaseUrl').value.trim(),
        cheapAiModel: document.getElementById('cheapAiModel').value.trim(),
        openaiApiKey: keyInput ? keyInput : "__KEEP__"
      };
      await jpost('/api/admin/runtime-config', payload);
      await loadRuntimeConfig();
      setAiStatus('AI config saved');
    }

    async function testRuntimeConfig() {
      setAiStatus('Testing...');
      const resp = await jpost('/api/admin/runtime-config/test', {});
      const result = resp.result || {};
      const provider = result.aiResult && result.aiResult.provider ? result.aiResult.provider : 'unknown';
      const final = result.final || {};
      setAiStatus('Provider=' + provider + ' shouldBlock=' + Boolean(final.shouldBlock) + ' confidence=' + (final.confidence || 0));
    }

    async function submitReportSample() {
      const payload = {
        label: document.getElementById('reportLabel').value,
        screenName: document.getElementById('reportScreenName').value.trim(),
        displayName: document.getElementById('reportDisplayName').value.trim(),
        note: document.getElementById('reportNote').value.trim(),
        rawText: document.getElementById('reportRawText').value
      };
      if (!payload.rawText) {
        setReportStatus('raw text is required');
        return;
      }
      await jpost('/api/admin/feedback-samples', payload);
      setReportStatus('sample submitted');
      document.getElementById('reportRawText').value = '';
      await loadAll();
    }

    async function manualUpsertLayer() {
      const payload = {
        screenName: document.getElementById('manualScreenName').value.trim(),
        displayName: document.getElementById('manualDisplayName').value.trim(),
        status: document.getElementById('manualStatus').value,
        reason: document.getElementById('manualReason').value.trim() || 'manual_upsert',
        confidence: document.getElementById('manualStatus').value === 'whitelist' ? 1 : 0.9,
        source: 'manual'
      };
      if (!payload.screenName) {
        setManualStatus('screen name is required');
        return;
      }
      await jpost('/api/blacklist/upsert', payload);
      setManualStatus('saved');
      document.getElementById('manualScreenName').value = '';
      document.getElementById('manualDisplayName').value = '';
      await loadAll();
    }

    async function loadRuleSuggestions() {
      setRuleSuggestionStatus('Summarizing...');
      const resp = await jget('/api/admin/rule-suggestions?limit=300');
      renderRuleSuggestions(resp.provider || '', resp.suggestions || []);
      setRuleSuggestionStatus('Loaded ' + ((resp.suggestions || []).length) + ' suggestions');
    }

    async function review(id, decision) {
      await jpost('/api/contributions/' + id + '/review', { decision });
      await loadAll();
    }
    window.review = review;

    async function loadAll() {
      try {
        const blacklistStatus = document.getElementById('blacklistStatus') ? document.getElementById('blacklistStatus').value : 'all';
        const blacklistQuery = document.getElementById('blacklistQuery') ? document.getElementById('blacklistQuery').value.trim() : '';
        const taskStatus = document.getElementById('taskStatus') ? document.getElementById('taskStatus').value : 'all';
        const taskQuery = document.getElementById('taskQuery') ? document.getElementById('taskQuery').value.trim() : '';
        const responses = await Promise.all([
          jget('/api/admin/stats'),
          jget('/api/admin/blacklist?status=' + encodeURIComponent(blacklistStatus) + '&query=' + encodeURIComponent(blacklistQuery) + '&limit=120'),
          jget('/api/admin/block-tasks?status=' + encodeURIComponent(taskStatus) + '&query=' + encodeURIComponent(taskQuery) + '&limit=120'),
          jget('/api/admin/feedback-samples?label=all&limit=60'),
          jget('/api/admin/contributions?decision=pending&limit=50'),
          jget('/api/admin/events?limit=80'),
          jget('/api/admin/decisions?limit=80')
        ]);
        renderStats(responses[0].stats || {});
        renderBlacklist(responses[1].items || []);
        renderTasks(responses[2].items || []);
        renderFeedback(responses[3].items || []);
        renderContrib(responses[4].items || []);
        renderEvents(responses[5].items || []);
        renderDecisions(responses[6].items || []);
        setStatus('Refreshed: ' + new Date().toLocaleTimeString());
      } catch (e) {
        setStatus('Load failed: ' + e.message);
      }
    }

    const tokenInput = document.getElementById('adminToken');
    tokenInput.value = token();
    document.getElementById('saveToken').onclick = function () {
      localStorage.setItem('spam_guard_admin_token', tokenInput.value.trim());
      loadAll();
      loadRuntimeConfig();
    };
    document.getElementById('refreshAll').onclick = loadAll;
    document.getElementById('saveAiConfig').onclick = saveRuntimeConfig;
    document.getElementById('testAiConfig').onclick = testRuntimeConfig;
    document.getElementById('submitReport').onclick = submitReportSample;
    document.getElementById('manualUpsert').onclick = manualUpsertLayer;
    document.getElementById('loadRuleSuggestions').onclick = loadRuleSuggestions;
    document.getElementById('blacklistStatus').onchange = loadAll;
    document.getElementById('taskStatus').onchange = loadAll;
    document.getElementById('blacklistQuery').oninput = function () { clearTimeout(window.__blacklistQueryTimer); window.__blacklistQueryTimer = setTimeout(loadAll, 300); };
    document.getElementById('taskQuery').oninput = function () { clearTimeout(window.__taskQueryTimer); window.__taskQueryTimer = setTimeout(loadAll, 300); };

    loadAll();
    loadRuntimeConfig();
    setInterval(loadAll, 10000);
  </script>
</body>
</html>`;
  res.type("html").send(html);
});

app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.use((err, req, res, next) => {
  console.error("server_error", err);
  res.status(500).json({
    error: "internal_error",
    message: String(err?.message || err)
  });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`server listening at http://127.0.0.1:${port}`);
});
