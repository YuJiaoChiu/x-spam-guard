import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const FILES = {
  blacklist: "blacklist.json",
  contributions: "contributions.json",
  events: "events.json",
  decisions: "decisions.json",
  runtimeConfig: "runtime-config.json",
  feedbackSamples: "feedback-samples.json",
  blockTasks: "block-tasks.json"
};

const MAX_EVENTS = 15000;
const MAX_DECISIONS = 50000;
const BLACKLIST_STATUSES = new Set(["confirmed", "suspected", "reported", "whitelist"]);
const BLOCK_TASK_STATUSES = new Set(["pending", "running", "success", "failed", "cooldown", "skipped"]);

function defaultRuntimeConfig() {
  return {
    aiProvider: "auto",
    cheapAiUrl: "",
    openaiBaseUrl: "https://api.openai.com/v1",
    cheapAiModel: "gpt-4o-mini",
    openaiApiKey: "",
    updatedAt: nowIso()
  };
}

function nowIso() {
  return new Date().toISOString();
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

function normalizeText(value) {
  return String(value || "").toLowerCase().trim();
}

function parseIntSafe(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}

function normalizeBlacklistStatus(value) {
  const status = String(value || "confirmed").toLowerCase().trim();
  return BLACKLIST_STATUSES.has(status) ? status : "confirmed";
}

function normalizeBlockTaskStatus(value) {
  const status = String(value || "pending").toLowerCase().trim();
  return BLOCK_TASK_STATUSES.has(status) ? status : "pending";
}

async function safeReadJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(tempPath, text, "utf8");
  await fs.rename(tempPath, filePath);
}

function sortByTimeDesc(items, timeField = "updatedAt") {
  return [...items].sort((a, b) => {
    const ta = new Date(a?.[timeField] || a?.createdAt || 0).getTime();
    const tb = new Date(b?.[timeField] || b?.createdAt || 0).getTime();
    return tb - ta;
  });
}

function paginate(items, options = {}) {
  const limit = Math.min(1000, Math.max(1, parseIntSafe(options.limit, 200)));
  const offset = parseIntSafe(options.offset, 0);
  const total = items.length;
  const page = items.slice(offset, offset + limit);
  return { items: page, total, limit, offset };
}

export async function createStore(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });

  const paths = {
    blacklist: path.join(dataDir, FILES.blacklist),
    contributions: path.join(dataDir, FILES.contributions),
    events: path.join(dataDir, FILES.events),
    decisions: path.join(dataDir, FILES.decisions),
    runtimeConfig: path.join(dataDir, FILES.runtimeConfig),
    feedbackSamples: path.join(dataDir, FILES.feedbackSamples),
    blockTasks: path.join(dataDir, FILES.blockTasks)
  };

  const state = {
    blacklist: [],
    contributions: [],
    events: [],
    decisions: [],
    runtimeConfig: defaultRuntimeConfig(),
    feedbackSamples: [],
    blockTasks: []
  };

  let lock = Promise.resolve();

  async function withWriteLock(task) {
    const next = lock.then(task, task);
    lock = next.then(() => undefined, () => undefined);
    return await next;
  }

  async function persistAll() {
    await Promise.all([
      atomicWriteJson(paths.blacklist, { updatedAt: nowIso(), items: state.blacklist }),
      atomicWriteJson(paths.contributions, { updatedAt: nowIso(), items: state.contributions }),
      atomicWriteJson(paths.events, { updatedAt: nowIso(), items: state.events }),
      atomicWriteJson(paths.decisions, { updatedAt: nowIso(), items: state.decisions }),
      atomicWriteJson(paths.runtimeConfig, state.runtimeConfig),
      atomicWriteJson(paths.feedbackSamples, { updatedAt: nowIso(), items: state.feedbackSamples }),
      atomicWriteJson(paths.blockTasks, { updatedAt: nowIso(), items: state.blockTasks })
    ]);
  }

  async function persistOne(key) {
    if (key === "blacklist") {
      await atomicWriteJson(paths.blacklist, { updatedAt: nowIso(), items: state.blacklist });
      return;
    }
    if (key === "contributions") {
      await atomicWriteJson(paths.contributions, { updatedAt: nowIso(), items: state.contributions });
      return;
    }
    if (key === "events") {
      await atomicWriteJson(paths.events, { updatedAt: nowIso(), items: state.events });
      return;
    }
    if (key === "decisions") {
      await atomicWriteJson(paths.decisions, { updatedAt: nowIso(), items: state.decisions });
      return;
    }
    if (key === "runtimeConfig") {
      await atomicWriteJson(paths.runtimeConfig, state.runtimeConfig);
      return;
    }
    if (key === "feedbackSamples") {
      await atomicWriteJson(paths.feedbackSamples, { updatedAt: nowIso(), items: state.feedbackSamples });
      return;
    }
    if (key === "blockTasks") {
      await atomicWriteJson(paths.blockTasks, { updatedAt: nowIso(), items: state.blockTasks });
    }
  }

  function normalizeRuntimeConfig(input = {}) {
    const providerRaw = String(input.aiProvider || "auto").toLowerCase().trim();
    const aiProvider = ["auto", "external", "openai", "mock"].includes(providerRaw) ? providerRaw : "auto";
    const cheapAiUrl = String(input.cheapAiUrl || "").trim();
    const openaiBaseUrl = String(input.openaiBaseUrl || "https://api.openai.com/v1").trim();
    const cheapAiModel = String(input.cheapAiModel || "gpt-4o-mini").trim();
    const openaiApiKey = String(input.openaiApiKey || "").trim();

    return {
      aiProvider,
      cheapAiUrl,
      openaiBaseUrl,
      cheapAiModel,
      openaiApiKey,
      updatedAt: nowIso()
    };
  }

  function normalizeBlacklistEntry(entry) {
    return {
      id: String(entry.id || crypto.randomUUID()),
      userId: entry.userId ? String(entry.userId) : null,
      screenName: entry.screenName ? String(entry.screenName).replace(/^@/, "").toLowerCase().trim() : null,
      displayName: entry.displayName ? String(entry.displayName).trim() : null,
      reason: String(entry.reason || "unknown"),
      tags: Array.isArray(entry.tags) ? [...new Set(entry.tags.map((x) => String(x)))] : [],
      reasonDetails: entry.reasonDetails && typeof entry.reasonDetails === "object" ? entry.reasonDetails : {},
      confidence: Number(entry.confidence || 0),
      source: String(entry.source || "local"),
      status: normalizeBlacklistStatus(entry.status),
      createdAt: String(entry.createdAt || nowIso()),
      updatedAt: nowIso()
    };
  }

  function buildBlacklistKey(entry) {
    return normalizeText(entry.screenName || entry.userId);
  }

  async function init() {
    const [blacklistRaw, contributionsRaw, eventsRaw, decisionsRaw, runtimeConfigRaw, feedbackSamplesRaw, blockTasksRaw] = await Promise.all([
      safeReadJson(paths.blacklist, { items: [] }),
      safeReadJson(paths.contributions, { items: [] }),
      safeReadJson(paths.events, { items: [] }),
      safeReadJson(paths.decisions, { items: [] }),
      safeReadJson(paths.runtimeConfig, defaultRuntimeConfig()),
      safeReadJson(paths.feedbackSamples, { items: [] }),
      safeReadJson(paths.blockTasks, { items: [] })
    ]);

    state.blacklist = asArray(blacklistRaw).map((row) => normalizeBlacklistEntry(row)).filter((row) => buildBlacklistKey(row));
    state.contributions = asArray(contributionsRaw).map((row) => ({
      id: String(row.id || crypto.randomUUID()),
      createdAt: String(row.createdAt || nowIso()),
      reviewedAt: row.reviewedAt ? String(row.reviewedAt) : null,
      reviewedBy: row.reviewedBy ? String(row.reviewedBy) : null,
      decision: String(row.decision || "pending"),
      payload: row.payload || {}
    }));
    state.events = asArray(eventsRaw).map((row) => ({
      id: String(row.id || crypto.randomUUID()),
      at: String(row.at || row.createdAt || nowIso()),
      ...row
    }));
    state.decisions = asArray(decisionsRaw).map((row) => ({
      id: String(row.id || crypto.randomUUID()),
      at: String(row.at || nowIso()),
      ...row
    }));

    state.events = sortByTimeDesc(state.events, "at").slice(0, MAX_EVENTS);
    state.decisions = sortByTimeDesc(state.decisions, "at").slice(0, MAX_DECISIONS);
    state.contributions = sortByTimeDesc(state.contributions, "createdAt");
    state.blacklist = sortByTimeDesc(state.blacklist, "updatedAt");
    state.runtimeConfig = normalizeRuntimeConfig(runtimeConfigRaw || defaultRuntimeConfig());
    state.feedbackSamples = asArray(feedbackSamplesRaw)
      .map((row) => ({
        id: String(row.id || crypto.randomUUID()),
        createdAt: String(row.createdAt || nowIso()),
        label: String(row.label || "spam"),
        screenName: row.screenName ? String(row.screenName).replace(/^@/, "").toLowerCase().trim() : "",
        displayName: String(row.displayName || ""),
        rawText: String(row.rawText || ""),
        normalizedText: String(row.normalizedText || ""),
        fragments: Array.isArray(row.fragments) ? row.fragments.map(String) : [],
        patternCandidates: Array.isArray(row.patternCandidates) ? row.patternCandidates : [],
        note: String(row.note || ""),
        source: String(row.source || "admin")
      }))
      .slice(0, 10000);
    state.blockTasks = asArray(blockTasksRaw)
      .map((row) => ({
        id: String(row.id || crypto.randomUUID()),
        createdAt: String(row.createdAt || nowIso()),
        updatedAt: String(row.updatedAt || row.createdAt || nowIso()),
        scheduledAt: String(row.scheduledAt || row.createdAt || nowIso()),
        startedAt: row.startedAt ? String(row.startedAt) : null,
        finishedAt: row.finishedAt ? String(row.finishedAt) : null,
        status: normalizeBlockTaskStatus(row.status),
        screenName: row.screenName ? String(row.screenName).replace(/^@/, "").toLowerCase().trim() : "",
        userId: row.userId ? String(row.userId) : null,
        displayName: String(row.displayName || ""),
        reason: String(row.reason || ""),
        confidence: Number(row.confidence || 0),
        retries: Number(row.retries || 0),
        maxRetries: Number(row.maxRetries || 2),
        lastError: String(row.lastError || ""),
        xStatusCode: Number(row.xStatusCode || 0),
        source: String(row.source || "extension"),
        metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {}
      }))
      .filter((row) => row.screenName)
      .slice(0, 50000);

    await persistAll();
  }

  async function listBlacklist(input = "confirmed") {
    const options = typeof input === "string" ? { status: input } : { ...(input || {}) };
    const status = String(options.status || "confirmed");
    const query = normalizeText(options.query);

    let rows = state.blacklist;
    if (status !== "all") {
      rows = rows.filter((row) => row.status === status);
    }
    if (query) {
      rows = rows.filter((row) => {
        const tagsJoined = Array.isArray(row.tags) ? row.tags.join(" ") : "";
        const haystack = normalizeText(`${row.screenName} ${row.displayName} ${row.reason} ${tagsJoined} ${row.userId}`);
        return haystack.includes(query);
      });
    }
    rows = sortByTimeDesc(rows, "updatedAt");

    if (typeof input === "string") {
      return rows;
    }
    return paginate(rows, options);
  }

  async function getBlacklistLookup() {
    const map = new Map();
    for (const row of state.blacklist) {
      const keys = [row.screenName, row.userId].map((value) => normalizeText(value)).filter(Boolean);
      for (const key of keys) {
        map.set(key, row);
      }
    }
    return map;
  }

  async function upsertBlacklistEntry(entry) {
    return await withWriteLock(async () => {
      const normalized = normalizeBlacklistEntry(entry || {});
      const key = buildBlacklistKey(normalized);
      if (!key) return null;

      const index = state.blacklist.findIndex((row) => buildBlacklistKey(row) === key);
      if (index >= 0) {
        normalized.id = state.blacklist[index].id || normalized.id;
        normalized.createdAt = state.blacklist[index].createdAt || normalized.createdAt;
        state.blacklist[index] = { ...state.blacklist[index], ...normalized, updatedAt: nowIso() };
      } else {
        state.blacklist.push(normalized);
      }

      state.blacklist = sortByTimeDesc(state.blacklist, "updatedAt");
      await persistOne("blacklist");
      return normalized;
    });
  }

  async function removeBlacklistEntry(screenNameOrUserId) {
    return await withWriteLock(async () => {
      const key = normalizeText(screenNameOrUserId);
      if (!key) return false;
      const before = state.blacklist.length;
      state.blacklist = state.blacklist.filter((row) => buildBlacklistKey(row) !== key);
      if (state.blacklist.length === before) return false;
      await persistOne("blacklist");
      return true;
    });
  }

  async function addContribution(payload) {
    return await withWriteLock(async () => {
      const contribution = {
        id: crypto.randomUUID(),
        createdAt: nowIso(),
        reviewedAt: null,
        reviewedBy: null,
        decision: "pending",
        payload: payload || {}
      };
      state.contributions.unshift(contribution);
      state.contributions = sortByTimeDesc(state.contributions, "createdAt").slice(0, 50000);
      await persistOne("contributions");
      return contribution;
    });
  }

  async function listContributions(input = {}) {
    const options = typeof input === "number" ? { limit: input } : { ...(input || {}) };
    const decision = String(options.decision || "all");
    const query = normalizeText(options.query);

    let rows = state.contributions;
    if (decision !== "all") {
      rows = rows.filter((row) => row.decision === decision);
    }
    if (query) {
      rows = rows.filter((row) => {
        const c = row.payload?.candidate || {};
        const v = row.payload?.verdict || {};
        const haystack = normalizeText(
          `${c.screenName} ${c.displayName} ${c.commentText} ${c.profileBio} ${v.reason} ${(v.tags || []).join(" ")}`
        );
        return haystack.includes(query);
      });
    }

    rows = sortByTimeDesc(rows, "createdAt");
    if (typeof input === "number" || Object.keys(options).length === 0) {
      return rows;
    }
    return paginate(rows, options);
  }

  async function reviewContribution(id, decision, reviewedBy = "admin") {
    return await withWriteLock(async () => {
      const item = state.contributions.find((row) => row.id === id);
      if (!item) return null;
      item.decision = decision;
      item.reviewedAt = nowIso();
      item.reviewedBy = reviewedBy;
      await persistOne("contributions");
      return item;
    });
  }

  async function addEvent(event) {
    return await withWriteLock(async () => {
      const row = {
        id: crypto.randomUUID(),
        at: nowIso(),
        ...event
      };
      state.events.unshift(row);
      state.events = sortByTimeDesc(state.events, "at").slice(0, MAX_EVENTS);
      await persistOne("events");
      return row;
    });
  }

  async function listEvents(input = 200) {
    const options = typeof input === "number" ? { limit: input } : { ...(input || {}) };
    const type = String(options.type || "all");
    const query = normalizeText(options.query);

    let rows = state.events;
    if (type !== "all") {
      rows = rows.filter((row) => String(row.type || "") === type);
    }
    if (query) {
      rows = rows.filter((row) => normalizeText(JSON.stringify(row)).includes(query));
    }
    rows = sortByTimeDesc(rows, "at");

    if (typeof input === "number") {
      return rows.slice(0, Math.max(1, Math.min(1000, input)));
    }
    return paginate(rows, options);
  }

  async function addDecision(decision) {
    return await withWriteLock(async () => {
      const row = {
        id: crypto.randomUUID(),
        at: nowIso(),
        ...decision
      };
      state.decisions.unshift(row);
      state.decisions = sortByTimeDesc(state.decisions, "at").slice(0, MAX_DECISIONS);
      await persistOne("decisions");
      return row;
    });
  }

  async function listDecisions(input = 200) {
    const options = typeof input === "number" ? { limit: input } : { ...(input || {}) };
    const rows = sortByTimeDesc(state.decisions, "at");
    if (typeof input === "number") {
      return rows.slice(0, Math.max(1, Math.min(2000, input)));
    }
    return paginate(rows, options);
  }

  async function getStats() {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const blocked24h = state.events.filter((row) => row.type === "blocked" && new Date(row.at).getTime() >= dayAgo).length;
    const failed24h = state.events.filter((row) => row.type === "block_failed" && new Date(row.at).getTime() >= dayAgo).length;
    const pendingContrib = state.contributions.filter((row) => row.decision === "pending").length;
    const recentDecisions = state.decisions.filter((row) => new Date(row.at).getTime() >= dayAgo).length;
    const pendingTasks = state.blockTasks.filter((row) => ["pending", "running", "cooldown"].includes(row.status)).length;

    return {
      blacklistTotal: state.blacklist.length,
      blacklistConfirmed: state.blacklist.filter((row) => row.status === "confirmed").length,
      blacklistSuspected: state.blacklist.filter((row) => row.status === "suspected").length,
      blacklistReported: state.blacklist.filter((row) => row.status === "reported").length,
      blacklistWhitelist: state.blacklist.filter((row) => row.status === "whitelist").length,
      contributionTotal: state.contributions.length,
      contributionPending: pendingContrib,
      eventsTotal: state.events.length,
      blocked24h,
      blockFailed24h: failed24h,
      decisions24h: recentDecisions,
      blockTaskPending: pendingTasks,
      generatedAt: nowIso()
    };
  }

  async function getRuntimeConfig({ withSecrets = false } = {}) {
    const cfg = { ...state.runtimeConfig };
    if (!withSecrets) {
      cfg.openaiApiKey = cfg.openaiApiKey ? "********" : "";
      cfg.hasOpenaiApiKey = Boolean(state.runtimeConfig.openaiApiKey);
    } else {
      cfg.hasOpenaiApiKey = Boolean(cfg.openaiApiKey);
    }
    return cfg;
  }

  async function updateRuntimeConfig(patch = {}) {
    return await withWriteLock(async () => {
      const current = state.runtimeConfig || defaultRuntimeConfig();
      const nextInput = { ...current, ...patch };
      if (patch.openaiApiKey === "__KEEP__") {
        nextInput.openaiApiKey = current.openaiApiKey || "";
      }
      const next = normalizeRuntimeConfig(nextInput);
      if (typeof patch.openaiApiKey === "string" && patch.openaiApiKey.trim() === "") {
        next.openaiApiKey = "";
      } else if (typeof patch.openaiApiKey !== "string" || patch.openaiApiKey === "__KEEP__") {
        next.openaiApiKey = current.openaiApiKey || "";
      }
      state.runtimeConfig = next;
      await persistOne("runtimeConfig");
      return await getRuntimeConfig({ withSecrets: false });
    });
  }

  async function addFeedbackSample(sample = {}) {
    return await withWriteLock(async () => {
      const row = {
        id: crypto.randomUUID(),
        createdAt: nowIso(),
        label: String(sample.label || "spam"),
        screenName: sample.screenName ? String(sample.screenName).replace(/^@/, "").toLowerCase().trim() : "",
        displayName: String(sample.displayName || ""),
        rawText: String(sample.rawText || ""),
        normalizedText: String(sample.normalizedText || ""),
        fragments: Array.isArray(sample.fragments) ? sample.fragments.map(String) : [],
        patternCandidates: Array.isArray(sample.patternCandidates) ? sample.patternCandidates : [],
        note: String(sample.note || ""),
        source: String(sample.source || "admin")
      };
      state.feedbackSamples.unshift(row);
      state.feedbackSamples = sortByTimeDesc(state.feedbackSamples, "createdAt").slice(0, 10000);
      await persistOne("feedbackSamples");
      return row;
    });
  }

  async function listFeedbackSamples(input = {}) {
    const options = typeof input === "number" ? { limit: input } : { ...(input || {}) };
    const label = String(options.label || "all");
    const query = normalizeText(options.query || "");

    let rows = state.feedbackSamples;
    if (label !== "all") {
      rows = rows.filter((row) => row.label === label);
    }
    if (query) {
      rows = rows.filter((row) =>
        normalizeText(
          `${row.screenName} ${row.displayName} ${row.rawText} ${row.note} ${(row.fragments || []).join(" ")} ${(row.patternCandidates || [])
            .map((item) => (typeof item === "string" ? item : item.value || ""))
            .join(" ")}`
        ).includes(query)
      );
    }
    rows = sortByTimeDesc(rows, "createdAt");

    if (typeof input === "number" || Object.keys(options).length === 0) {
      return rows;
    }
    return paginate(rows, options);
  }

  async function upsertBlockTask(task = {}) {
    return await withWriteLock(async () => {
      const screenName = task.screenName ? String(task.screenName).replace(/^@/, "").toLowerCase().trim() : "";
      if (!screenName) return null;
      const existing = state.blockTasks.find((row) => row.id === task.id || (row.screenName === screenName && ["pending", "running", "cooldown"].includes(row.status)));
      const now = nowIso();
      const row = {
        id: existing?.id || String(task.id || crypto.randomUUID()),
        createdAt: existing?.createdAt || String(task.createdAt || now),
        updatedAt: now,
        scheduledAt: String(task.scheduledAt || existing?.scheduledAt || now),
        startedAt: task.startedAt === undefined ? existing?.startedAt || null : task.startedAt,
        finishedAt: task.finishedAt === undefined ? existing?.finishedAt || null : task.finishedAt,
        status: normalizeBlockTaskStatus(task.status || existing?.status || "pending"),
        screenName,
        userId: task.userId ? String(task.userId) : existing?.userId || null,
        displayName: String(task.displayName || existing?.displayName || ""),
        reason: String(task.reason || existing?.reason || ""),
        confidence: Number(task.confidence ?? existing?.confidence ?? 0),
        retries: Number(task.retries ?? existing?.retries ?? 0),
        maxRetries: Number(task.maxRetries ?? existing?.maxRetries ?? 2),
        lastError: String(task.lastError || existing?.lastError || ""),
        xStatusCode: Number(task.xStatusCode ?? existing?.xStatusCode ?? 0),
        source: String(task.source || existing?.source || "extension"),
        metadata: task.metadata && typeof task.metadata === "object" ? task.metadata : existing?.metadata || {}
      };

      if (existing) {
        const index = state.blockTasks.findIndex((item) => item.id === existing.id);
        state.blockTasks[index] = row;
      } else {
        state.blockTasks.unshift(row);
      }
      state.blockTasks = sortByTimeDesc(state.blockTasks, "updatedAt").slice(0, 50000);
      await persistOne("blockTasks");
      return row;
    });
  }

  async function updateBlockTask(id, patch = {}) {
    return await withWriteLock(async () => {
      const index = state.blockTasks.findIndex((row) => row.id === id);
      if (index < 0) return null;
      const current = state.blockTasks[index];
      const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      const next = {
        ...current,
        ...cleanPatch,
        id: current.id,
        status: normalizeBlockTaskStatus(cleanPatch.status || current.status),
        updatedAt: nowIso()
      };
      state.blockTasks[index] = next;
      state.blockTasks = sortByTimeDesc(state.blockTasks, "updatedAt").slice(0, 50000);
      await persistOne("blockTasks");
      return next;
    });
  }

  async function listBlockTasks(input = {}) {
    const options = typeof input === "number" ? { limit: input } : { ...(input || {}) };
    const status = String(options.status || "all");
    const query = normalizeText(options.query || "");
    let rows = state.blockTasks;
    if (status !== "all") {
      rows = rows.filter((row) => row.status === status);
    }
    if (query) {
      rows = rows.filter((row) => normalizeText(`${row.screenName} ${row.displayName} ${row.reason} ${row.lastError}`).includes(query));
    }
    rows = sortByTimeDesc(rows, "updatedAt");
    if (typeof input === "number" || Object.keys(options).length === 0) {
      return rows;
    }
    return paginate(rows, options);
  }

  return {
    init,
    listBlacklist,
    getBlacklistLookup,
    upsertBlacklistEntry,
    removeBlacklistEntry,
    addContribution,
    listContributions,
    reviewContribution,
    addEvent,
    listEvents,
    addDecision,
    listDecisions,
    getStats,
    getRuntimeConfig,
    updateRuntimeConfig,
    addFeedbackSample,
    listFeedbackSamples,
    upsertBlockTask,
    updateBlockTask,
    listBlockTasks
  };
}
