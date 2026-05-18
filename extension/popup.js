const DEFAULT_BACKEND_BASE_URL = "http://124.221.11.190/x-spam-guard";
const DEFAULT_CLIENT_TOKEN = "1112715f436e64d0f9fa38ce81989b6464bf32dfbb754f5a";
const LEGACY_DEFAULT_BACKENDS = new Set([
  "",
  "http://127.0.0.1:8787",
  "http://localhost:8787"
]);

const formIds = [
  "backendBaseUrl",
  "clientToken",
  "syncEnabled",
  "shareEnabled",
  "autoBlockEnabled",
  "ruleScoreThreshold",
  "autoBlockConfidence",
  "minDelayMs",
  "maxDelayMs"
];

function $(id) {
  return document.getElementById(id);
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

function hydrateSettings(settings = {}) {
  const backendBaseUrl = normalizeBaseUrl(settings.backendBaseUrl);
  const shouldUseBundledBackend = LEGACY_DEFAULT_BACKENDS.has(backendBaseUrl);
  const resolvedBackendBaseUrl = shouldUseBundledBackend
    ? DEFAULT_BACKEND_BASE_URL
    : (backendBaseUrl || DEFAULT_BACKEND_BASE_URL);
  const usingBundledBackend = resolvedBackendBaseUrl === DEFAULT_BACKEND_BASE_URL;

  return {
    ...settings,
    backendBaseUrl: resolvedBackendBaseUrl,
    clientToken: String(settings.clientToken || "").trim() || (usingBundledBackend ? DEFAULT_CLIENT_TOKEN : "")
  };
}

function readForm() {
  const backendBaseUrl = normalizeBaseUrl($("backendBaseUrl").value) || DEFAULT_BACKEND_BASE_URL;
  const clientToken = $("clientToken").value.trim()
    || (backendBaseUrl === DEFAULT_BACKEND_BASE_URL ? DEFAULT_CLIENT_TOKEN : "");

  return {
    backendBaseUrl,
    clientToken,
    syncEnabled: $("syncEnabled").checked,
    shareEnabled: $("shareEnabled").checked,
    autoBlockEnabled: $("autoBlockEnabled").checked,
    ruleScoreThreshold: Number($("ruleScoreThreshold").value || 2),
    autoBlockConfidence: Number($("autoBlockConfidence").value || 0.8),
    minDelayMs: Number($("minDelayMs").value || 8000),
    maxDelayMs: Number($("maxDelayMs").value || 45000)
  };
}

function writeForm(settings) {
  const hydrated = hydrateSettings(settings);
  $("backendBaseUrl").value = hydrated.backendBaseUrl;
  $("clientToken").value = hydrated.clientToken;
  $("syncEnabled").checked = Boolean(settings.syncEnabled);
  $("shareEnabled").checked = Boolean(settings.shareEnabled);
  $("autoBlockEnabled").checked = Boolean(settings.autoBlockEnabled);
  $("ruleScoreThreshold").value = String(settings.ruleScoreThreshold ?? 2);
  $("autoBlockConfidence").value = String(settings.autoBlockConfidence ?? 0.8);
  $("minDelayMs").value = String(settings.minDelayMs ?? 8000);
  $("maxDelayMs").value = String(settings.maxDelayMs ?? 45000);
}

function formatTime(value) {
  if (!value) return "无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function renderStats(stats) {
  $("scannedArticles").textContent = String(stats.scannedArticles || 0);
  $("extractedCandidates").textContent = String(stats.extractedCandidates || 0);
  $("localRuleHits").textContent = String(stats.localRuleHits || 0);
  $("decisions").textContent = String(stats.decisions || 0);
  $("aiReviewQueueCount").textContent = String(stats.aiReviewQueueCount || 0);
  $("queuedCount").textContent = String(stats.queuedCount || 0);
  $("activeTaskCount").textContent = String(stats.activeTaskCount || 0);
  $("blacklistCount").textContent = String(stats.blacklistCount || 0);
  $("syncBlockPending").textContent = String(stats.syncBlockPending || 0);
  $("syncedBlockQueued").textContent = String(stats.syncedBlockQueued || 0);
  $("blockedSuccess").textContent = String(stats.blockedSuccess || 0);
  $("blockedFailed").textContent = String(stats.blockedFailed || 0);
  $("lastSyncAt").textContent = stats.lastSyncAt ? formatTime(stats.lastSyncAt) : "未同步";
  $("lastScannedAt").textContent = stats.lastScannedAt ? formatTime(stats.lastScannedAt) : "未扫描";
  $("lastContentReadyAt").textContent = stats.lastContentReadyAt ? formatTime(stats.lastContentReadyAt) : "未注入";
  $("lastCandidateAt").textContent = stats.lastCandidateAt ? `${formatTime(stats.lastCandidateAt)} / 分 ${stats.lastLocalRuleScore || 0}` : "无";
  $("lastBlockTarget").textContent = stats.lastBlockTarget
    ? `${stats.lastBlockTarget} / ${formatTime(stats.lastBlockAttemptAt)}`
    : "无";
  $("lastError").textContent = stats.lastError || "无";
}

function setStatus(text) {
  $("statusLine").textContent = text || "";
}

async function getState() {
  return await chrome.runtime.sendMessage({ type: "GET_STATE" });
}

async function saveSettings(settings) {
  return await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings
  });
}

async function init() {
  const state = await getState();
  writeForm(state.settings || {});
  renderStats(state.stats || {});
  updateRunningButton(Boolean(state.settings?.running));
}

function updateRunningButton(running) {
  $("toggleRunning").textContent = running ? "暂停" : "开始";
  $("runningStateText").textContent = running ? "正在自动处理" : "等待开始";
}

async function refresh() {
  const state = await getState();
  renderStats(state.stats || {});
  updateRunningButton(Boolean(state.settings?.running));
}

$("saveBtn").addEventListener("click", async () => {
  try {
    const settings = readForm();
    await saveSettings(settings);
    setStatus("已保存设置");
    await refresh();
  } catch (error) {
    setStatus(`保存失败: ${String(error)}`);
  }
});

$("syncBtn").addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "MANUAL_SYNC" });
    setStatus("已触发同步");
    await refresh();
  } catch (error) {
    setStatus(`同步失败: ${String(error)}`);
  }
});

$("toggleRunning").addEventListener("click", async () => {
  try {
    const state = await getState();
    const settings = {
      ...readForm(),
      running: !Boolean(state.settings?.running)
    };
    await saveSettings(settings);
    updateRunningButton(settings.running);
    setStatus(settings.running ? "已开始自动处理" : "已暂停自动处理");
    await refresh();
  } catch (error) {
    setStatus(`切换失败: ${String(error)}`);
  }
});

for (const id of formIds) {
  const element = $(id);
  element.addEventListener("change", () => {
    setStatus("");
  });
}

init();
setInterval(refresh, 3000);
