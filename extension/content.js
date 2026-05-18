(function initContent() {
  const previousRuntime = window.__xSpamGuardRuntime;
  if (previousRuntime && typeof previousRuntime.destroy === "function") {
    try {
      previousRuntime.destroy();
    } catch {
      // Old content-script closures can throw after an extension reload.
    }
  }

  const PROCESSED_KEY = "spamGuardSeen";
  const PROFILE_BIO_CACHE_TTL_MS = 30 * 60 * 1000;
  const PROFILE_BIO_FAILURE_CACHE_TTL_MS = 2 * 60 * 1000;
  const pendingBridgeRequests = new Map();
  const profileBioCache = new Map();
  const profileBioInFlight = new Map();
  const blockedHandles = new Set();
  let destroyed = false;
  let observer = null;
  let rescanTimer = null;
  let profileLookupTail = Promise.resolve();
  let dynamicRules = [];
  let scanPass = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const scanStats = {
    scanned: 0,
    extracted: 0,
    localRuleHits: 0,
    lowScoreSkipped: 0,
    lastRuleScore: 0
  };
  let scanStatsTimer = null;

  function safeRuntimeCall(task, fallback) {
    if (destroyed) return fallback;
    try {
      if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.id) return fallback;
      return task();
    } catch {
      return fallback;
    }
  }

  function safeSendMessage(message) {
    return safeRuntimeCall(() => chrome.runtime.sendMessage(message).catch(() => {}), Promise.resolve());
  }

  function safeRuntimeUrl(path) {
    return safeRuntimeCall(() => chrome.runtime.getURL(path), "");
  }

  function startNewScanPass() {
    scanPass = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function destroy() {
    destroyed = true;
    if (scanStatsTimer) {
      clearTimeout(scanStatsTimer);
      scanStatsTimer = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (rescanTimer) {
      clearInterval(rescanTimer);
      rescanTimer = null;
    }
    window.removeEventListener("message", handlePageMessage);
    safeRuntimeCall(() => chrome.runtime.onMessage.removeListener(handleRuntimeMessage), null);
    for (const resolve of pendingBridgeRequests.values()) {
      resolve({ ok: false, error: "content_destroyed" });
    }
    pendingBridgeRequests.clear();
    profileBioInFlight.clear();
  }

  window.__xSpamGuardRuntime = { destroy };

  function flushScanStatsSoon() {
    if (destroyed) return;
    if (scanStatsTimer) return;
    scanStatsTimer = setTimeout(() => {
      if (destroyed) return;
      scanStatsTimer = null;
      const payload = { ...scanStats };
      scanStats.scanned = 0;
      scanStats.extracted = 0;
      scanStats.localRuleHits = 0;
      scanStats.lowScoreSkipped = 0;
      safeSendMessage({ type: "SCAN_STATS", ...payload });
    }, 800);
  }

  function ensureStyles() {
    if (document.getElementById("spam-guard-style")) return;
    const style = document.createElement("style");
    style.id = "spam-guard-style";
    style.textContent = `
      article[data-spam-guard-hidden="1"] {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureBridgeInjected() {
    if (document.getElementById("spam-guard-bridge-script-v2")) return;
    const src = safeRuntimeUrl("page-bridge.js");
    if (!src) return;
    const script = document.createElement("script");
    script.id = "spam-guard-bridge-script-v2";
    script.src = `${src}?v=2`;
    script.async = false;
    document.documentElement.appendChild(script);
  }

  function parseHandleFromHref(href) {
    if (!href) return "";
    try {
      const url = new URL(href, location.origin);
      const path = url.pathname || "";
      if (!/^\/[A-Za-z0-9_]{1,15}$/.test(path)) return "";
      return path.slice(1).toLowerCase();
    } catch {
      return "";
    }
  }

  function extractCandidate(article) {
    const userNameNode = article.querySelector('div[data-testid="User-Name"]');
    if (!userNameNode) return null;

    const links = Array.from(userNameNode.querySelectorAll('a[href^="/"]'));
    const handleLink = links.find((link) => parseHandleFromHref(link.getAttribute("href")));
    if (!handleLink) return null;

    const screenName = parseHandleFromHref(handleLink.getAttribute("href"));
    if (!screenName) return null;

    const displayName = (userNameNode.querySelector("span")?.innerText || "").trim();
    const commentText = (article.querySelector('div[data-testid="tweetText"]')?.innerText || "").trim();
    if (!commentText && !displayName) return null;

    const candidate = {
      userId: null,
      screenName,
      displayName,
      profileBio: "",
      commentText,
      sourceUrl: location.href
    };

    const rule = SpamRules.scoreCandidate(candidate, { dynamicRules });
    return { candidate, rule };
  }

  function hideByHandle(screenName) {
    const key = String(screenName || "").toLowerCase();
    if (!key) return;
    blockedHandles.add(key);

    const articles = document.querySelectorAll("article");
    for (const article of articles) {
      const info = extractCandidate(article);
      if (!info) continue;
      if (info.candidate.screenName.toLowerCase() === key) {
        article.setAttribute("data-spam-guard-hidden", "1");
      }
    }
  }

  async function bridgeBlock(screenName, taskId) {
    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const payload = {
      source: "spam-guard-extension",
      type: "SPAM_GUARD_BLOCK_V2",
      requestId,
      taskId: taskId || "",
      screenName
    };

    const resultPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingBridgeRequests.delete(requestId);
        resolve({ ok: false, error: "bridge_timeout" });
      }, 20000);
      pendingBridgeRequests.set(requestId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });

    window.postMessage(payload, "*");
    return await resultPromise;
  }

  function randomDelay(minMs, maxMs) {
    const min = Math.max(0, Number(minMs || 0));
    const max = Math.max(min, Number(maxMs || min));
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function bridgeFetchProfileBio(screenName) {
    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const payload = {
      source: "spam-guard-extension",
      type: "SPAM_GUARD_PROFILE_BIO",
      requestId,
      screenName
    };

    const resultPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingBridgeRequests.delete(requestId);
        resolve({ ok: false, error: "profile_bio_timeout" });
      }, 12000);
      pendingBridgeRequests.set(requestId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });

    window.postMessage(payload, "*");
    return await resultPromise;
  }

  function shouldLookupProfileBio(candidate, rule) {
    if (!candidate || candidate.profileBio) return false;
    const score = Number(rule?.score || 0);
    if (score < 2) return false;
    const matched = new Set(Array.isArray(rule?.matchedRules) ? rule.matchedRules : []);
    if (matched.has("random_handle")) return true;
    if (matched.has("soft_lure_bot_combo")) return true;
    if (matched.has("peach_display_lure")) return true;
    return false;
  }

  async function getProfileBio(screenName) {
    const key = String(screenName || "").toLowerCase();
    if (!key) return "";

    const cached = profileBioCache.get(key);
    const cacheTtl = cached?.ok ? PROFILE_BIO_CACHE_TTL_MS : PROFILE_BIO_FAILURE_CACHE_TTL_MS;
    if (cached && Date.now() - cached.at < cacheTtl) {
      return cached.bio || "";
    }

    const existing = profileBioInFlight.get(key);
    if (existing) return await existing;

    const task = profileLookupTail
      .catch(() => {})
      .then(async () => {
        await sleep(randomDelay(700, 2200));
        const result = await bridgeFetchProfileBio(key);
        const bio = result && result.ok ? String(result.profileBio || "").trim() : "";
        profileBioCache.set(key, { bio, at: Date.now(), ok: Boolean(result?.ok), error: result?.error || "" });
        return bio;
      })
      .finally(() => {
        profileBioInFlight.delete(key);
      });

    profileLookupTail = task.catch(() => {});
    profileBioInFlight.set(key, task);
    return await task;
  }

  async function enrichCandidateWithProfileBio(candidate, rule) {
    if (!shouldLookupProfileBio(candidate, rule)) {
      return { candidate, rule };
    }

    try {
      const profileBio = await getProfileBio(candidate.screenName);
      if (!profileBio || destroyed) return { candidate, rule };
      const enriched = { ...candidate, profileBio };
      const enrichedRule = SpamRules.scoreCandidate(enriched, { dynamicRules });
      return { candidate: enriched, rule: enrichedRule };
    } catch {
      return { candidate, rule };
    }
  }

  async function blockAndReport(message) {
    const screenName = String(message.screenName || "").toLowerCase();
    if (!screenName) return;

    const result = await bridgeBlock(screenName, message.taskId || "");
    if (result.ok) {
      hideByHandle(screenName);
    }

    await safeSendMessage({
      type: "BLOCK_RESULT",
      taskId: message.taskId || result.taskId || "",
      screenName,
      reason: message.reason || "",
      confidence: Number(message.confidence || 0),
      ok: Boolean(result.ok),
      status: result.status || 0,
      error: result.error || ""
    });
  }

  async function processArticle(article) {
    if (destroyed) return;
    if (!(article instanceof HTMLElement)) return;
    if (article.dataset[PROCESSED_KEY] === scanPass) return;
    article.dataset[PROCESSED_KEY] = scanPass;
    scanStats.scanned += 1;

    const info = extractCandidate(article);
    if (!info) {
      flushScanStatsSoon();
      return;
    }
    scanStats.extracted += 1;

    const handle = info.candidate.screenName;
    if (blockedHandles.has(handle)) {
      article.setAttribute("data-spam-guard-hidden", "1");
      flushScanStatsSoon();
      return;
    }

    const enriched = await enrichCandidateWithProfileBio(info.candidate, info.rule);
    if (destroyed) return;
    scanStats.lastRuleScore = Number(enriched.rule.score || 0);

    if (enriched.rule.score >= 2) {
      scanStats.localRuleHits += 1;
      safeSendMessage({
        type: "CANDIDATE_DETECTED",
        candidate: {
          ...enriched.candidate,
          ruleScore: enriched.rule.score,
          matchedRules: enriched.rule.matchedRules
        }
      }).catch(() => {});
    } else {
      scanStats.lowScoreSkipped += 1;
    }
    flushScanStatsSoon();
  }

  function scanExistingArticles() {
    const articles = document.querySelectorAll("article");
    for (const article of articles) {
      processArticle(article);
    }
  }

  function observeDom() {
    observer = new MutationObserver((mutations) => {
      if (destroyed) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.tagName === "ARTICLE") {
            processArticle(node);
            continue;
          }
          const nested = node.querySelectorAll ? node.querySelectorAll("article") : [];
          for (const article of nested) {
            processArticle(article);
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function startPeriodicRescan() {
    if (rescanTimer) return;
    rescanTimer = setInterval(() => {
      if (destroyed) return;
      scanExistingArticles();
    }, 4000);
  }

  function handlePageMessage(event) {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== "spam-guard-page") return;
    if (data.type !== "SPAM_GUARD_BLOCK_RESULT" && data.type !== "SPAM_GUARD_PROFILE_BIO_RESULT") return;
    const resolver = pendingBridgeRequests.get(data.requestId);
    if (!resolver) return;
    pendingBridgeRequests.delete(data.requestId);
    resolver(data);
  }

  function handleRuntimeMessage(message) {
    if (destroyed) return;
    if (!message || !message.type) return;
    if (message.type === "HIDE_USER") {
      hideByHandle(message.screenName);
      return;
    }
    if (message.type === "BLACKLIST_SYNCED") {
      dynamicRules = Array.isArray(message.dynamicRules) ? message.dynamicRules : [];
      for (const handle of [...(message.handles || []), ...(message.suspected || [])]) {
        hideByHandle(handle);
      }
      startNewScanPass();
      scanExistingArticles();
      return;
    }
    if (message.type === "BLOCK_USER") {
      blockAndReport(message);
    }
  }

  window.addEventListener("message", handlePageMessage);
  safeRuntimeCall(() => chrome.runtime.onMessage.addListener(handleRuntimeMessage), null);

  ensureStyles();
  ensureBridgeInjected();
  safeRuntimeCall(() => chrome.runtime.sendMessage({ type: "GET_DYNAMIC_RULES" }), Promise.resolve(null)).then((response) => {
    dynamicRules = Array.isArray(response?.dynamicRules) ? response.dynamicRules : [];
    startNewScanPass();
    scanExistingArticles();
  }).catch(() => {});
  safeSendMessage({ type: "CONTENT_READY", href: location.href });
  scanExistingArticles();
  observeDom();
  startPeriodicRescan();
})();
