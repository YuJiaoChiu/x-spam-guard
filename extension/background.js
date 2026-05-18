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
const SYNC_BLACKLIST_PAGE_SIZE = 1000;
const DYNAMIC_RULES_LIMIT = 500;
const SYNC_BLACKLIST_ALARM = "sync-blacklist";
const BLOCK_QUEUE_ALARM = "process-block-queue";
const NO_ACTIVE_X_TAB_RETRY_MS = 60 * 1000;
const COOLDOWN_RETRY_BASE_MS = 5 * 60 * 1000;

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
  blockAttemptCache: new Map(),
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
    syncBlockPending: 0,
    syncedBlockQueued: 0,
    syncedBlockSkipped: 0,
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

function nowIso() {
  return new Date().toISOString();
}

function getRetryDelayMs(task, fallbackMs) {
  const retries = Math.max(1, Number(task?.retries || 1));
  const jitter = randomDelay(5000, 20000);
  return Math.max(1000, Number(fallbackMs || 0)) * retries + jitter;
}

function scheduleQueueProcessing(delayMs = 0) {
  const when = Date.now() + Math.max(1000, Number(delayMs || 1000));
  chrome.alarms.create(BLOCK_QUEUE_ALARM, { when });
}

function scheduleNextQueueItem() {
  if (!state.settings.running || !state.settings.autoBlockEnabled || state.queue.length === 0) return;
  sortQueueBySchedule();
  const nextAt = new Date(state.queue[0]?.scheduledAt || 0).getTime();
  const delayMs = Number.isFinite(nextAt) && nextAt > Date.now() ? nextAt - Date.now() : 1000;
  scheduleQueueProcessing(delayMs);
}

function sortQueueBySchedule() {
  state.queue.sort((a, b) => {
    const left = new Date(a.scheduledAt || 0).getTime();
    const right = new Date(b.scheduledAt || 0).getTime();
    return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
  });
}

function isSyncedBlacklistEntry(entry) {
  return entry && entry.source === "sync" && keyOfHandle(entry.screenName || entry.userId);
}

function updateSyncBlockPending() {
  let pending = 0;
  for (const [key, item] of state.localBlacklist.entries()) {
    if (!isSyncedBlacklistEntry(item)) continue;
    if (state.localWhitelist.has(key)) continue;
    const attempt = state.blockAttemptCache.get(key);
    if (attempt && ["queued", "running", "success", "failed", "cooldown"].includes(String(attempt.status || ""))) continue;
    pending += 1;
  }
  state.stats.syncBlockPending = pending;
}

async function purgeQueueAfterSync() {
  const before = state.queue.length;
  state.queue = state.queue.filter((task) => {
    const key = keyOfHandle(task.screenName);
    if (!key) return false;
    if (state.localWhitelist.has(key)) return false;
    if (task.source === "synced_blacklist" && !state.localBlacklist.has(key)) return false;
    return true;
  });
  state.queueKeys = new Set(state.queue.map((task) => keyOfHandle(task.screenName)).filter(Boolean));
  sortQueueBySchedule();
  state.stats.queuedCount = state.queue.length;
  if (state.queue.length !== before) {
    await persistQueue();
  }
}

async function persistBlockAttemptCache() {
  const entries = Array.from(state.blockAttemptCache.entries())
    .sort((a, b) => String(b[1]?.updatedAt || "").localeCompare(String(a[1]?.updatedAt || "")))
    .slice(0, 100000);
  await chrome.storage.local.set({ syncedBlockAttemptCache: Object.fromEntries(entries) });
}

async function setBlockAttemptStatus(screenName, status, patch = {}) {
  const key = keyOfHandle(screenName);
  if (!key || !state.blockAttemptCache.has(key)) return;
  state.blockAttemptCache.set(key, {
    ...state.blockAttemptCache.get(key),
    ...patch,
    status,
    updatedAt: nowIso()
  });
  await persistBlockAttemptCache();
  updateSyncBlockPending();
}

async function loadState() {
  const storage = await chrome.storage.local.get([
    "settings",
    "localBlacklistCache",
    "localSuspectedCache",
    "localWhitelistCache",
    "dynamicRulesCache",
    "syncedBlockAttemptCache",
    "blockQueueCache"
  ]);
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
  if (Array.isArray(storage.blockQueueCache)) {
    for (const task of storage.blockQueueCache) {
      const key = keyOfHandle(task?.screenName);
      if (!key || state.queueKeys.has(key)) continue;
      state.queue.push({ ...task, screenName: key });
      state.queueKeys.add(key);
    }
    sortQueueBySchedule();
  }
  for (const [key, value] of Object.entries(storage.syncedBlockAttemptCache || {})) {
    const normalized = keyOfHandle(key);
    if (normalized) {
      state.blockAttemptCache.set(normalized, value && typeof value === "object" ? value : { status: "attempted" });
    }
  }
  state.stats.blacklistCount = state.localBlacklist.size;
  state.stats.queuedCount = state.queue.length;
  updateSyncBlockPending();
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

async function persistQueue() {
  await chrome.storage.local.set({
    blockQueueCache: state.queue.slice(0, 100000)
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

async function fetchBlacklistLayer(base, status, headers) {
  const items = [];
  let offset = 0;
  for (let page = 0; page < 100; page += 1) {
    const url = `${base}/api/blacklist?status=${encodeURIComponent(status)}&limit=${SYNC_BLACKLIST_PAGE_SIZE}&offset=${offset}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`sync_${status}_failed_${response.status}`);
    }
    const data = await response.json();
    const pageItems = Array.isArray(data.items) ? data.items : [];
    items.push(...pageItems);
    const total = Number(data.total ?? data.count ?? 0);
    if (pageItems.length < SYNC_BLACKLIST_PAGE_SIZE) break;
    if (total > 0 && items.length >= total) break;
    offset += pageItems.length;
    if (pageItems.length === 0) break;
  }
  return items;
}

async function syncBlacklist() {
  if (!state.settings.syncEnabled) return;
  const base = sanitizeBaseUrl(state.settings.backendBaseUrl);
  const headers = {};
  if (state.settings.clientToken) {
    headers["x-client-token"] = state.settings.clientToken;
  }
  try {
    const [confirmedItems, suspectedItems, whitelistItems, dynamicRulesResponse] = await Promise.all([
      fetchBlacklistLayer(base, "confirmed", headers),
      fetchBlacklistLayer(base, "suspected", headers),
      fetchBlacklistLayer(base, "whitelist", headers),
      fetch(`${base}/api/rules/active?limit=${DYNAMIC_RULES_LIMIT}`, { headers })
    ]);
    const dynamicRulesData = dynamicRulesResponse.ok ? await dynamicRulesResponse.json() : { items: [] };
    state.dynamicRules = Array.isArray(dynamicRulesData.items) ? dynamicRulesData.items : [];

    state.localWhitelist = new Set();
    for (const item of whitelistItems) {
      const key = keyOfHandle(item.screenName || item.userId);
      if (key) state.localWhitelist.add(key);
    }

    for (const key of state.localWhitelist) {
      if (state.blockAttemptCache.has(key)) {
        state.blockAttemptCache.delete(key);
      }
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
    updateSyncBlockPending();
    state.stats.lastSyncAt = nowIso();
    state.stats.lastError = "";
    await persistLocalBlacklist();
    await persistBlockAttemptCache();
    await purgeQueueAfterSync();
    await notifyBlacklistSynced();
    if (state.settings.running && state.settings.autoBlockEnabled) {
      await enqueueSyncedBlacklistBlocks("sync");
    }
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

async function enqueueBlock(task, options = {}) {
  const key = keyOfHandle(task.screenName);
  if (!key) return null;
  if (state.queueKeys.has(key) || Array.from(state.activeTasks.values()).some((item) => keyOfHandle(item.screenName) === key)) return null;
  state.queueKeys.add(key);
  const now = Date.now();
  const scheduledMs = Number(options.scheduledAtMs || 0);
  const delay = Math.max(1000, scheduledMs > now ? scheduledMs - now : randomDelay(state.settings.minDelayMs, state.settings.maxDelayMs));
  const queuedTask = {
    ...task,
    screenName: key,
    taskId: task.taskId || `${key}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    scheduledAt: new Date(now + delay).toISOString(),
    delayMs: delay,
    retries: Number(task.retries || 0),
    maxRetries: Number(task.maxRetries || 2)
  };
  state.queue.push(queuedTask);
  sortQueueBySchedule();
  state.stats.queuedCount = state.queue.length;
  await persistQueue();
  reportBlockTask(queuedTask, "pending").catch(() => {});
  processQueue();
  return queuedTask;
}

async function enqueueSyncedBlacklistBlocks(trigger = "sync") {
  if (!state.settings.syncEnabled || !state.settings.running || !state.settings.autoBlockEnabled) {
    updateSyncBlockPending();
    return { queued: 0, skipped: 0 };
  }

  let queued = 0;
  let skipped = 0;
  const scheduledTimes = state.queue
    .map((task) => new Date(task.scheduledAt || 0).getTime())
    .filter((value) => Number.isFinite(value) && value > 0);
  let scheduledAtMs = Math.max(Date.now(), ...scheduledTimes);
  const activeHandles = new Set(Array.from(state.activeTasks.values()).map((task) => keyOfHandle(task.screenName)).filter(Boolean));

  for (const [key, item] of state.localBlacklist.entries()) {
    if (!isSyncedBlacklistEntry(item)) continue;
    if (state.localWhitelist.has(key)) {
      skipped += 1;
      continue;
    }
    const attempt = state.blockAttemptCache.get(key);
    if (
      attempt &&
      ["queued", "running", "success", "failed", "cooldown"].includes(String(attempt.status || ""))
    ) {
      skipped += 1;
      continue;
    }
    if (state.queueKeys.has(key) || activeHandles.has(key)) {
      skipped += 1;
      continue;
    }

    scheduledAtMs += randomDelay(state.settings.minDelayMs, state.settings.maxDelayMs);
    const task = await enqueueBlock({
      screenName: key,
      userId: item.userId || null,
      displayName: item.displayName || "",
      reason: item.reason || "synced_confirmed_blacklist",
      confidence: Number(item.confidence || 0.98),
      source: "synced_blacklist",
      sourceUrl: item.sourceUrl || "",
      metadata: {
        trigger,
        blacklistStatus: item.status || "confirmed",
        blacklistSource: item.source || "sync",
        blacklistReason: item.reason || "",
        tags: Array.isArray(item.tags) ? item.tags : []
      }
    }, {
      scheduledAtMs
    });

    if (!task) {
      skipped += 1;
      continue;
    }

    state.blockAttemptCache.set(key, {
      status: "queued",
      taskId: task.taskId,
      trigger,
      queuedAt: nowIso(),
      updatedAt: nowIso()
    });
    queued += 1;
  }

  if (queued > 0) {
    state.stats.syncedBlockQueued += queued;
    await persistBlockAttemptCache();
    await persistQueue();
  }
  state.stats.syncedBlockSkipped += skipped;
  updateSyncBlockPending();
  return { queued, skipped };
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
      await postJsonResult("/api/block-tasks", payload);
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

async function requeueTask(task, status, delayMs, error, patch = {}) {
  const key = keyOfHandle(task.screenName);
  const scheduledTimes = state.queue
    .map((item) => new Date(item.scheduledAt || 0).getTime())
    .filter((value) => Number.isFinite(value) && value > 0);
  const retryDelay = Math.max(getRetryDelayMs(task, delayMs), Math.max(0, ...scheduledTimes, Date.now()) - Date.now());
  task.scheduledAt = new Date(Date.now() + retryDelay).toISOString();
  state.queue.unshift(task);
  sortQueueBySchedule();
  if (key) {
    state.queueKeys.add(key);
  }
  state.stats.queuedCount = state.queue.length;
  await persistQueue();
  await updateBlockTaskStatus(task, status, {
    scheduledAt: task.scheduledAt,
    retries: task.retries,
    lastError: error || status,
    ...patch
  });
  await setBlockAttemptStatus(key, status, {
    lastError: error || status,
    scheduledAt: task.scheduledAt,
    taskId: task.taskId,
    ...patch
  });
  scheduleQueueProcessing(retryDelay);
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
    } catch (error) {
      if (/receiving end does not exist|could not establish connection|message port closed/i.test(String(error && error.message ? error.message : error))) {
        continue;
      }
      // try next tab
    }
  }
  return false;
}

async function processQueue() {
  if (state.processingQueue) return;
  if (!state.settings.running || !state.settings.autoBlockEnabled || state.queue.length === 0) return;
  state.processingQueue = true;
  try {
    while (state.queue.length > 0) {
      if (!state.settings.running || !state.settings.autoBlockEnabled) {
        break;
      }
      const task = state.queue.shift();
      state.queueKeys.delete(task.screenName);
      state.stats.queuedCount = state.queue.length;
      await persistQueue();

      const waitMs = Math.max(0, new Date(task.scheduledAt).getTime() - Date.now());
      if (waitMs > 0) {
        state.queue.unshift(task);
        sortQueueBySchedule();
        state.queueKeys.add(task.screenName);
        state.stats.queuedCount = state.queue.length;
        await persistQueue();
        scheduleQueueProcessing(waitMs);
        break;
      }
      task.retries = Number(task.retries || 0) + 1;
      await updateBlockTaskStatus(task, "running", {
        startedAt: nowIso(),
        retries: task.retries
      });
      await setBlockAttemptStatus(task.screenName, "running", {
        taskId: task.taskId,
        startedAt: nowIso(),
        retries: task.retries
      });
      state.activeTasks.set(task.taskId, task);
      const sent = await sendBlockCommand(task);
      if (!sent) {
        state.activeTasks.delete(task.taskId);
        await requeueTask(task, "cooldown", NO_ACTIVE_X_TAB_RETRY_MS, "waiting_for_x_tab");
        state.stats.lastError = "waiting_for_x_tab";
        await postJson("/api/events", {
          type: "block_waiting_for_x_tab",
          screenName: task.screenName,
          reason: task.reason || "no_tab",
          metadata: {
            nextRetryAt: task.scheduledAt
          }
        });
        break;
      }
      break;
    }
  } finally {
    state.processingQueue = false;
    if (state.activeTasks.size === 0) {
      scheduleNextQueueItem();
    }
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
    const attempt = state.blockAttemptCache.get(screenName);
    const shouldQueueExisting = !attempt || !["queued", "running", "success", "failed", "cooldown"].includes(String(attempt.status || ""));
    if (shouldQueueExisting) {
      const task = await enqueueBlock({
        screenName,
        reason: existing.reason || "blacklist_hit",
        confidence: Number(existing.confidence || 0.9),
        tabId: sender?.tab?.id || null,
        displayName: candidate.displayName || existing.displayName || "",
        userId: candidate.userId || existing.userId || null,
        sourceUrl: candidate.sourceUrl || "",
        metadata: {
          trigger: "browsed_blacklist_hit",
          blacklistSource: existing.source || "",
          blacklistStatus: existing.status || "confirmed"
        }
      });
      if (task) {
        state.stats.syncedBlockQueued += 1;
        state.blockAttemptCache.set(screenName, {
          status: "queued",
          taskId: task.taskId,
          trigger: "browsed_blacklist_hit",
          queuedAt: nowIso(),
          updatedAt: nowIso()
        });
        await persistBlockAttemptCache();
        updateSyncBlockPending();
      }
    }
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

  await enqueueBlock({
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
        finishedAt: nowIso(),
        xStatusCode: statusCode
      });
      await setBlockAttemptStatus(task.screenName, "success", {
        finishedAt: nowIso(),
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
    scheduleNextQueueItem();
  } else {
    state.stats.blockedFailed += 1;
    const isCooldown =
      statusCode === 429 ||
      statusCode === 403 ||
      /rate|limit|cooldown|csrf|auth|forbidden|too_many/i.test(error);
    if (task) {
      if (isCooldown && task.retries < Number(task.maxRetries || 2)) {
        await requeueTask(task, "cooldown", COOLDOWN_RETRY_BASE_MS, error || "block_cooldown", {
          xStatusCode: statusCode
        });
      } else {
        await updateBlockTaskStatus(task, isCooldown ? "cooldown" : "failed", {
          finishedAt: nowIso(),
          xStatusCode: statusCode,
          lastError: error || "block_failed"
        });
        await setBlockAttemptStatus(task.screenName, isCooldown ? "cooldown" : "failed", {
          finishedAt: nowIso(),
          xStatusCode: statusCode,
          lastError: error || "block_failed"
        });
      }
    }
    await postJson("/api/events", {
      type: "block_failed",
      screenName: keyOfHandle(message.screenName),
      reason: message.reason || "",
      confidence: Number(message.confidence || 0),
      status: statusCode,
      error
    });
    scheduleNextQueueItem();
  }
}

async function initialize() {
  await loadState();
  chrome.alarms.create(SYNC_BLACKLIST_ALARM, { periodInMinutes: 15 });
  await syncBlacklist();
  if (state.queue.length > 0) {
    processQueue();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initialize();
});

chrome.runtime.onStartup.addListener(() => {
  initialize();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_BLACKLIST_ALARM) {
    syncBlacklist();
  }
  if (alarm.name === BLOCK_QUEUE_ALARM) {
    processQueue();
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
      const wasRunning = Boolean(state.settings.running);
      state.settings = { ...state.settings, ...(message.settings || {}) };
      await persistSettings();
      const isRunning = Boolean(state.settings.running);
      if (state.settings.syncEnabled && isRunning) {
        await syncBlacklist();
      } else {
        updateSyncBlockPending();
      }
      if (!wasRunning && isRunning) {
        await enqueueSyncedBlacklistBlocks("start");
      } else if (isRunning && state.settings.autoBlockEnabled) {
        await enqueueSyncedBlacklistBlocks("settings");
      }
      if (isRunning && state.settings.autoBlockEnabled) {
        processQueue();
      }
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
