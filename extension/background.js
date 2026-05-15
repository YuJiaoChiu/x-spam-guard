importScripts("rules.js");

const DEFAULT_BACKEND_BASE_URL = "http://124.221.11.190/x-spam-guard";
const DEFAULT_CLIENT_TOKEN = "1112715f436e64d0f9fa38ce81989b6464bf32dfbb754f5a";
const LEGACY_DEFAULT_BACKENDS = new Set([
  "",
  "http://127.0.0.1:8787",
  "http://localhost:8787"
]);
const SETTINGS_VERSION = 2;
const DEFAULT_REVIEW_RULE_SCORE_THRESHOLD = 2;

const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  backendBaseUrl: DEFAULT_BACKEND_BASE_URL,
  clientToken: DEFAULT_CLIENT_TOKEN,
  syncEnabled: true,
  shareEnabled: true,
  autoBlockEnabled: true,
  running: false,
  ruleScoreThreshold: DEFAULT_REVIEW_RULE_SCORE_THRESHOLD,
  autoBlockConfidence: 0.8,
  minDelayMs: 8000,
  maxDelayMs: 45000
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  localBlacklist: new Map(),
  localSuspected: new Map(),
  localWhitelist: new Set(),
  dynamicRules: [],
  queue: [],
  queueKeys: new Set(),
  activeTasks: new Map(),
  processingQueue: false,
  recentSeen: new Map(),
  stats: {
    scannedArticles: 0,
    extractedCandidates: 0,
    localRuleHits: 0,
    lowScoreSkipped: 0,
    candidatesReceived: 0,
    skippedDuplicate: 0,
    skippedPaused: 0,
    skippedBelowThreshold: 0,
    skippedByAi: 0,
    hiddenSuspected: 0,
    blacklistHits: 0,
    remoteClassifyRequests: 0,
    remoteClassifyFailed: 0,
    sharedContributions: 0,
    queuedCount: 0,
    blockedSuccess: 0,
    blockedFailed: 0,
    decisions: 0,
    blacklistCount: 0,
    lastSyncAt: "",
    lastScannedAt: "",
    lastCandidateAt: "",
    lastDecisionAt: "",
    lastError: "",
    lastLocalRuleScore: 0,
    lastLocalRuleHitAt: ""
  }
};

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

function shouldUseBundledBackend(baseUrl) {
  return LEGACY_DEFAULT_BACKENDS.has(normalizeBaseUrl(baseUrl));
}

function hydrateSettings(storedSettings = {}) {
  const next = { ...DEFAULT_SETTINGS, ...storedSettings };
  const shouldMigrateBackend = shouldUseBundledBackend(storedSettings.backendBaseUrl);
  const storedVersion = Number(storedSettings.settingsVersion || 0);

  if (shouldMigrateBackend) {
    next.backendBaseUrl = DEFAULT_BACKEND_BASE_URL;
  } else {
    next.backendBaseUrl = normalizeBaseUrl(next.backendBaseUrl) || DEFAULT_BACKEND_BASE_URL;
  }

  const usingBundledBackend = normalizeBaseUrl(next.backendBaseUrl) === DEFAULT_BACKEND_BASE_URL;
  if ((shouldMigrateBackend || usingBundledBackend) && !String(next.clientToken || "").trim()) {
    next.clientToken = DEFAULT_CLIENT_TOKEN;
  }

  if (storedVersion < SETTINGS_VERSION && Number(storedSettings.ruleScoreThreshold || 4) === 4) {
    next.ruleScoreThreshold = DEFAULT_REVIEW_RULE_SCORE_THRESHOLD;
  }
  next.settingsVersion = SETTINGS_VERSION;

  return next;
}

function sanitizeBaseUrl(baseUrl) {
  return normalizeBaseUrl(baseUrl || DEFAULT_SETTINGS.backendBaseUrl);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  const min = Math.max(1000, Number(minMs || 8000));
  const max = Math.max(min, Number(maxMs || 45000));
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function keyOfHandle(screenName) {
  return String(screenName || "").replace(/^@/, "").toLowerCase().trim();
}

function markError(error) {
  state.stats.lastError = String(error && error.message ? error.message : error || "");
}

async function loadState() {
  const storage = await chrome.storage.local.get(["settings", "localBlacklistCache", "localSuspectedCache", "localWhitelistCache", "dynamicRulesCache"]);
  state.settings = hydrateSettings(storage.settings || {});
  if (
    !storage.settings ||
    state.settings.backendBaseUrl !== storage.settings.backendBaseUrl ||
    state.settings.clientToken !== storage.settings.clientToken
  ) {
    await persistSettings();
  }

  const cache = storage.localBlacklistCache || {};
  for (const [key, row] of Object.entries(cache)) {
    state.localBlacklist.set(key, row);
  }
  const suspectedCache = storage.localSuspectedCache || {};
  for (const [key, row] of Object.entries(suspectedCache)) {
    state.localSuspected.set(key, row);
  }
  const whitelistCache = Array.isArray(storage.localWhitelistCache) ? storage.localWhitelistCache : [];
  for (const key of whitelistCache) {
    const normalized = keyOfHandle(key);
    if (normalized) state.localWhitelist.add(normalized);
  }
  state.dynamicRules = Array.isArray(storage.dynamicRulesCache) ? storage.dynamicRulesCache : [];
  state.stats.blacklistCount = state.localBlacklist.size;
}

async function persistSettings() {
  await chrome.storage.local.set({ settings: state.settings });
}

async function persistLocalBlacklist() {
  const obj = {};
  for (const [key, value] of state.localBlacklist.entries()) {
    obj[key] = value;
  }
  const suspected = {};
  for (const [key, value] of state.localSuspected.entries()) {
    suspected[key] = value;
  }
  await chrome.storage.local.set({
    localBlacklistCache: obj,
    localSuspectedCache: suspected,
    localWhitelistCache: Array.from(state.localWhitelist),
    dynamicRulesCache: state.dynamicRules
  });
}

async function postJson(path, payload) {
  const base = sanitizeBaseUrl(state.settings.backendBaseUrl);
  const url = `${base}${path}`;
  const headers = { "content-type": "application/json" };
  if (state.settings.clientToken) {
    headers["x-client-token"] = state.settings.clientToken;
  }
  try {
    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload || {})
    });
  } catch {
    // best effort
  }
}

async function postJsonResult(path, payload) {
  const base = sanitizeBaseUrl(state.settings.backendBaseUrl);
  const url = `${base}${path}`;
  const headers = { "content-type": "application/json" };
  if (state.settings.clientToken) {
    headers["x-client-token"] = state.settings.clientToken;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload || {})
  });
  if (!response.ok) {
    throw new Error(`post_failed_${response.status}`);
  }
  return await response.json();
}

async function syncBlacklist() {
  if (!state.settings.syncEnabled) return;
  const base = sanitizeBaseUrl(state.settings.backendBaseUrl);
  const headers = {};
  if (state.settings.clientToken) {
    headers["x-client-token"] = state.settings.clientToken;
  }
  try {
    const [confirmedResponse, suspectedResponse, whitelistResponse, dynamicRulesResponse] = await Promise.all([
      fetch(`${base}/api/blacklist?status=confirmed&limit=1000`, { headers }),
      fetch(`${base}/api/blacklist?status=suspected&limit=1000`, { headers }),
      fetch(`${base}/api/blacklist?status=whitelist&limit=1000`, { headers }),
      fetch(`${base}/api/rules/active?limit=500`, { headers })
    ]);
    if (!confirmedResponse.ok) return;
    const confirmedData = await confirmedResponse.json();
    const suspectedData = suspectedResponse.ok ? await suspectedResponse.json() : { items: [] };
    const whitelistData = whitelistResponse.ok ? await whitelistResponse.json() : { items: [] };
    const dynamicRulesData = dynamicRulesResponse.ok ? await dynamicRulesResponse.json() : { items: [] };
    const confirmedItems = Array.isArray(confirmedData.items) ? confirmedData.items : [];
    const suspectedItems = Array.isArray(suspectedData.items) ? suspectedData.items : [];
    const whitelistItems = Array.isArray(whitelistData.items) ? whitelistData.items : [];
    state.dynamicRules = Array.isArray(dynamicRulesData.items) ? dynamicRulesData.items : [];

    state.localWhitelist = new Set();
    for (const item of whitelistItems) {
      const key = keyOfHandle(item.screenName || item.userId);
      if (key) state.localWhitelist.add(key);
    }

    for (const [key, item] of [...state.localBlacklist.entries()]) {
      if (item.source === "sync" || state.localWhitelist.has(key)) {
        state.localBlacklist.delete(key);
      }
    }
    state.localSuspected.clear();

    for (const item of confirmedItems) {
      const key = keyOfHandle(item.screenName || item.userId);
      if (!key || state.localWhitelist.has(key)) continue;
      state.localBlacklist.set(key, {
        ...item,
        source: "sync",
        syncedAt: new Date().toISOString()
      });
    }
    for (const item of suspectedItems) {
      const key = keyOfHandle(item.screenName || item.userId);
      if (!key || state.localWhitelist.has(key)) continue;
      state.localSuspected.set(key, {
        ...item,
        source: "sync",
        syncedAt: new Date().toISOString()
      });
    }
    state.stats.blacklistCount = state.localBlacklist.size;
    state.stats.lastSyncAt = new Date().toISOString();
    state.stats.lastError = "";
    await persistLocalBlacklist();
    await notifyBlacklistSynced();
  } catch (error) {
    markError(`sync_failed:${String(error && error.message ? error.message : error)}`);
  }
}

async function classifyCandidateRemote(candidate) {
  const base = sanitizeBaseUrl(state.settings.backendBaseUrl);
  const headers = { "content-type": "application/json" };
  if (state.settings.clientToken) {
    headers["x-client-token"] = state.settings.clientToken;
  }
  const response = await fetch(`${base}/api/classify`, {
    method: "POST",
    headers,
    body: JSON.stringify({ candidate })
  });
  if (!response.ok) {
    state.stats.remoteClassifyFailed += 1;
    throw new Error(`classify_failed_${response.status}`);
  }
  return await response.json();
}

async function addToLocalBlacklist(candidate, verdict, source) {
  const key = keyOfHandle(candidate.screenName);
  if (!key) return;
  state.localBlacklist.set(key, {
    screenName: key,
    displayName: candidate.displayName || "",
    reason: verdict.reason || "spam",
    confidence: Number(verdict.confidence || 0),
    tags: verdict.tags || [],
    source: source || "local_ai",
    addedAt: new Date().toISOString()
  });
  state.stats.blacklistCount = state.localBlacklist.size;
  await persistLocalBlacklist();
}

async function notifyHide(screenName) {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  await Promise.all(
    tabs.map((tab) =>
      chrome.tabs.sendMessage(tab.id, {
        type: "HIDE_USER",
        screenName
      }).catch(() => {})
    )
  );
}

async function notifyBlacklistSynced() {
  const handles = Array.from(state.localBlacklist.keys()).slice(0, 1000);
  const suspected = Array.from(state.localSuspected.keys()).slice(0, 1000);
  const dynamicRules = state.dynamicRules.slice(0, 500);
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  await Promise.all(
    tabs.map((tab) =>
      chrome.tabs.sendMessage(tab.id, {
        type: "BLACKLIST_SYNCED",
        handles,
        suspected,
        dynamicRules
      }).catch(() => {})
    )
  );
}

function enqueueBlock(task) {
  const key = keyOfHandle(task.screenName);
  if (!key) return;
  if (state.queueKeys.has(key)) return;
  state.queueKeys.add(key);
  const delay = randomDelay(state.settings.minDelayMs, state.settings.maxDelayMs);
  const queuedTask = {
    ...task,
    screenName: key,
    taskId: task.taskId || `${key}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    scheduledAt: new Date(Date.now() + delay).toISOString(),
    delayMs: delay,
    retries: Number(task.retries || 0),
    maxRetries: Number(task.maxRetries || 2)
  };
  state.queue.push(queuedTask);
  state.stats.queuedCount = state.queue.length;
  reportBlockTask(queuedTask, "pending").catch(() => {});
  processQueue();
}

async function reportBlockTask(task, status, patch = {}) {
  const payload = {
    id: task.taskId || task.id,
    screenName: task.screenName,
    userId: task.userId || null,
    displayName: task.displayName || "",
    reason: task.reason || "spam",
    confidence: Number(task.confidence || 0),
    status,
    scheduledAt: task.scheduledAt || new Date().toISOString(),
    retries: Number(task.retries || 0),
    maxRetries: Number(task.maxRetries || 2),
    source: "extension",
    metadata: {
      delayMs: Number(task.delayMs || 0),
      sourceUrl: task.sourceUrl || "",
      ...((task.metadata && typeof task.metadata === "object") ? task.metadata : {})
    },
    ...patch
  };
  try {
    if (payload.id) {
      const created = await postJsonResult("/api/block-tasks", payload);
      if (created?.row?.id) {
        task.taskId = created.row.id;
      }
    }
  } catch {
    // local queue should continue even if telemetry fails
  }
}

async function updateBlockTaskStatus(task, status, patch = {}) {
  if (!task?.taskId) {
    await reportBlockTask(task, status, patch);
    return;
  }
  try {
    await postJsonResult(`/api/block-tasks/${encodeURIComponent(task.taskId)}/status`, {
      status,
      ...patch
    });
  } catch {
    await reportBlockTask(task, status, patch);
  }
}

async function sendBlockCommand(task) {
  const candidateTabs = [];
  if (task.tabId) {
    candidateTabs.push(task.tabId);
  } else {
    const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
    for (const tab of tabs) {
      candidateTabs.push(tab.id);
    }
  }

  if (!candidateTabs.length) {
    return false;
  }

  for (const tabId of candidateTabs) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "BLOCK_USER",
        taskId: task.taskId || "",
        screenName: task.screenName,
        reason: task.reason || "spam",
        confidence: Number(task.confidence || 0)
      });
      return true;
    } catch {
      // try next tab
    }
  }
  return false;
}

async function processQueue() {
  if (state.processingQueue) return;
  state.processingQueue = true;
  try {
    while (state.queue.length > 0) {
      if (!state.settings.running || !state.settings.autoBlockEnabled) {
        break;
      }
      const task = state.queue.shift();
      state.queueKeys.delete(task.screenName);
      state.stats.queuedCount = state.queue.length;

      const waitMs = Math.max(0, new Date(task.scheduledAt).getTime() - Date.now());
      await sleep(waitMs || Number(task.delayMs || 0));
      task.retries = Number(task.retries || 0) + 1;
      await updateBlockTaskStatus(task, "running", {
        startedAt: new Date().toISOString(),
        retries: task.retries
      });
      state.activeTasks.set(task.taskId, task);
      const sent = await sendBlockCommand(task);
      if (!sent) {
        state.activeTasks.delete(task.taskId);
        await updateBlockTaskStatus(task, "skipped", {
          finishedAt: new Date().toISOString(),
          lastError: "no_active_x_tab"
        });
        await postJson("/api/events", {
          type: "block_skipped_no_active_tab",
          screenName: task.screenName,
          reason: task.reason || "no_tab"
        });
      }
    }
  } finally {
    state.processingQueue = false;
  }
}

async function processCandidate(candidate, sender) {
  const screenName = keyOfHandle(candidate.screenName);
  if (!screenName) return;
  const now = Date.now();
  state.stats.candidatesReceived += 1;
  state.stats.lastCandidateAt = new Date(now).toISOString();
  state.stats.lastLocalRuleScore = Number(candidate.ruleScore || 0);

  const prevSeen = state.recentSeen.get(screenName) || 0;
  if (now - prevSeen < 10 * 60 * 1000) {
    state.stats.skippedDuplicate += 1;
    return;
  }
  state.recentSeen.set(screenName, now);

  if (state.localWhitelist.has(screenName)) {
    state.stats.lastError = `skip_whitelist:@${screenName}`;
    return;
  }

  const suspected = state.localSuspected.get(screenName);
  if (suspected) {
    state.stats.hiddenSuspected += 1;
    await notifyHide(screenName);
    return;
  }

  const existing = state.localBlacklist.get(screenName);
  if (existing) {
    state.stats.blacklistHits += 1;
    enqueueBlock({
      screenName,
      reason: existing.reason || "blacklist_hit",
      confidence: Number(existing.confidence || 0.9),
      tabId: sender?.tab?.id || null,
      displayName: candidate.displayName || existing.displayName || "",
      userId: candidate.userId || null,
      sourceUrl: candidate.sourceUrl || ""
    });
    return;
  }

  if (!state.settings.running || !state.settings.autoBlockEnabled) {
    state.stats.skippedPaused += 1;
    state.stats.lastError = state.settings.running ? "skip_auto_block_disabled" : "skip_not_started";
    return;
  }

  if (Number(candidate.ruleScore || 0) < Number(state.settings.ruleScoreThreshold)) {
    state.stats.skippedBelowThreshold += 1;
    return;
  }

  state.stats.remoteClassifyRequests += 1;
  const verdictResult = await classifyCandidateRemote(candidate);
  const verdict = verdictResult?.final || {};
  const ruleResult = verdictResult?.ruleResult || {};
  state.stats.decisions += 1;
  state.stats.lastDecisionAt = new Date().toISOString();
  state.stats.lastError = "";

  await postJson("/api/events", {
    type: "ai_decision",
    screenName,
    reason: verdict.reason || "",
    confidence: Number(verdict.confidence || 0),
    shouldBlock: Boolean(verdict.shouldBlock),
    metadata: {
      ruleScore: Number(ruleResult.score || 0),
      matchedRules: Array.isArray(ruleResult.matchedRules) ? ruleResult.matchedRules : [],
      details: verdict.details || {}
    }
  });

  if (!verdict.shouldBlock) {
    state.stats.skippedByAi += 1;
    if (verdict.shouldHide) {
      await notifyHide(screenName);
    }
    return;
  }

  await addToLocalBlacklist(candidate, verdict, "local_ai");

  if (state.settings.shareEnabled) {
    await postJson("/api/contributions", {
      candidate,
      verdict: {
        ...verdict,
        details: verdict.details || {}
      }
    });
    state.stats.sharedContributions += 1;
  }

  enqueueBlock({
    screenName,
    reason: verdict.reason || "ai_spam",
    confidence: Number(verdict.confidence || 0),
    tabId: sender?.tab?.id || null,
    displayName: candidate.displayName || "",
    userId: candidate.userId || null,
    sourceUrl: candidate.sourceUrl || "",
    metadata: {
      tags: Array.isArray(verdict.tags) ? verdict.tags : [],
      details: verdict.details || {}
    }
  });
  await notifyHide(screenName);
}

async function handleBlockResult(message) {
  const taskId = message.taskId || "";
  const task = taskId ? state.activeTasks.get(taskId) : null;
  if (taskId) {
    state.activeTasks.delete(taskId);
  }
  const statusCode = Number(message.status || 0);
  const error = String(message.error || "");
  if (message.ok) {
    state.stats.blockedSuccess += 1;
    if (task) {
      await updateBlockTaskStatus(task, "success", {
        finishedAt: new Date().toISOString(),
        xStatusCode: statusCode
      });
    }
    await postJson("/api/events", {
      type: "blocked",
      screenName: keyOfHandle(message.screenName),
      reason: message.reason || "",
      confidence: Number(message.confidence || 0),
      status: statusCode
    });
  } else {
    state.stats.blockedFailed += 1;
    const isCooldown =
      statusCode === 429 ||
      statusCode === 403 ||
      /rate|limit|cooldown|csrf|auth|forbidden|too_many/i.test(error);
    if (task) {
      await updateBlockTaskStatus(task, isCooldown ? "cooldown" : "failed", {
        finishedAt: new Date().toISOString(),
        xStatusCode: statusCode,
        lastError: error || "block_failed"
      });
    }
    await postJson("/api/events", {
      type: "block_failed",
      screenName: keyOfHandle(message.screenName),
      reason: message.reason || "",
      confidence: Number(message.confidence || 0),
      status: statusCode,
      error
    });
  }
}

async function initialize() {
  await loadState();
  chrome.alarms.create("sync-blacklist", { periodInMinutes: 15 });
  await syncBlacklist();
}

chrome.runtime.onInstalled.addListener(() => {
  initialize();
});

chrome.runtime.onStartup.addListener(() => {
  initialize();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sync-blacklist") {
    syncBlacklist();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "GET_STATE") {
    sendResponse({
      settings: state.settings,
      stats: state.stats
    });
    return;
  }

  if (message.type === "GET_DYNAMIC_RULES") {
    sendResponse({ dynamicRules: state.dynamicRules.slice(0, 500) });
    return;
  }

  if (message.type === "SAVE_SETTINGS") {
    (async () => {
      state.settings = { ...state.settings, ...(message.settings || {}) };
      await persistSettings();
      sendResponse({ ok: true, settings: state.settings });
    })();
    return true;
  }

  if (message.type === "MANUAL_SYNC") {
    (async () => {
      await syncBlacklist();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "CANDIDATE_DETECTED") {
    (async () => {
      try {
        await processCandidate(message.candidate || {}, sender);
        sendResponse({ ok: true });
      } catch (error) {
        markError(`candidate_failed:${String(error && error.message ? error.message : error)}`);
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
      }
    })();
    return true;
  }

  if (message.type === "SCAN_STATS") {
    const scanned = Number(message.scanned || 0);
    const extracted = Number(message.extracted || 0);
    const localRuleHits = Number(message.localRuleHits || 0);
    const lowScoreSkipped = Number(message.lowScoreSkipped || 0);
    state.stats.scannedArticles += scanned;
    state.stats.extractedCandidates += extracted;
    state.stats.localRuleHits += localRuleHits;
    state.stats.lowScoreSkipped += lowScoreSkipped;
    state.stats.lastScannedAt = new Date().toISOString();
    if (Number(message.lastRuleScore || 0) > 0) {
      state.stats.lastLocalRuleScore = Number(message.lastRuleScore || 0);
    }
    if (localRuleHits > 0) {
      state.stats.lastLocalRuleHitAt = state.stats.lastScannedAt;
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "BLOCK_RESULT") {
    (async () => {
      await handleBlockResult(message);
      sendResponse({ ok: true });
    })();
    return true;
  }
});

initialize();
