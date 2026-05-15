(function initPageBridge() {
  const BEARER_TOKEN =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

  function readCookie(name) {
    const parts = document.cookie.split(";").map((item) => item.trim());
    const match = parts.find((part) => part.startsWith(`${name}=`));
    if (!match) return "";
    return decodeURIComponent(match.slice(name.length + 1));
  }

  async function blockByScreenName(screenName) {
    const csrf = readCookie("ct0");
    if (!csrf) {
      throw new Error("missing_ct0_cookie");
    }

    const body = new URLSearchParams({ screen_name: screenName }).toString();
    const response = await fetch(`${location.origin}/i/api/1.1/blocks/create.json`, {
      method: "POST",
      credentials: "include",
      headers: {
        authorization: `Bearer ${BEARER_TOKEN}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-csrf-token": csrf,
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-active-user": "yes"
      },
      body
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`block_failed_${response.status}:${text.slice(0, 300)}`);
    }

    return { ok: true, status: response.status };
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.type !== "SPAM_GUARD_BLOCK") return;
    if (data.source !== "spam-guard-extension") return;

    try {
      const result = await blockByScreenName(data.screenName);
      window.postMessage(
        {
          source: "spam-guard-page",
          type: "SPAM_GUARD_BLOCK_RESULT",
          requestId: data.requestId,
          taskId: data.taskId || "",
          screenName: data.screenName,
          ok: true,
          status: result.status
        },
        "*"
      );
    } catch (error) {
      window.postMessage(
        {
          source: "spam-guard-page",
          type: "SPAM_GUARD_BLOCK_RESULT",
          requestId: data.requestId,
          taskId: data.taskId || "",
          screenName: data.screenName,
          ok: false,
          status: Number(String(error && error.message ? error.message : error).match(/block_failed_(\d+)/)?.[1] || 0),
          error: String(error && error.message ? error.message : error)
        },
        "*"
      );
    }
  });
})();
