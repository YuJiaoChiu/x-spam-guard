(function initPageBridge() {
  const BEARER_TOKEN =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

  function readCookie(name) {
    const parts = document.cookie.split(";").map((item) => item.trim());
    const match = parts.find((part) => part.startsWith(`${name}=`));
    if (!match) return "";
    return decodeURIComponent(match.slice(name.length + 1));
  }

  function authHeaders(extra = {}) {
    const csrf = readCookie("ct0");
    if (!csrf) {
      throw new Error("missing_ct0_cookie");
    }
    return {
      authorization: `Bearer ${BEARER_TOKEN}`,
      "x-csrf-token": csrf,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "zh-cn",
      ...extra
    };
  }

  async function blockByScreenName(screenName) {
    const body = new URLSearchParams({ screen_name: screenName }).toString();
    const response = await fetch(`${location.origin}/i/api/1.1/blocks/create.json`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders({
        "content-type": "application/x-www-form-urlencoded"
      }),
      body
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`block_failed_${response.status}:${text.slice(0, 300)}`);
    }

    return { ok: true, status: response.status };
  }

  async function getProfileBioByScreenName(screenName) {
    const params = new URLSearchParams({
      screen_name: screenName,
      include_profile_interstitial_type: "1",
      include_blocking: "1",
      include_blocked_by: "1",
      include_followed_by: "1",
      include_want_retweets: "0",
      include_mute_edge: "1",
      include_can_dm: "1",
      include_can_media_tag: "1",
      include_ext_has_nft_avatar: "1",
      skip_status: "1"
    });
    const response = await fetch(`${location.origin}/i/api/1.1/users/show.json?${params.toString()}`, {
      method: "GET",
      credentials: "include",
      headers: authHeaders()
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`profile_failed_${response.status}:${text.slice(0, 300)}`);
    }

    const payload = await response.json();
    return {
      ok: true,
      status: response.status,
      profileBio: String(payload.description || payload.legacy?.description || "").trim()
    };
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== "spam-guard-extension") return;

    if (data.type === "SPAM_GUARD_PROFILE_BIO") {
      try {
        const result = await getProfileBioByScreenName(data.screenName);
        window.postMessage(
          {
            source: "spam-guard-page",
            type: "SPAM_GUARD_PROFILE_BIO_RESULT",
            requestId: data.requestId,
            screenName: data.screenName,
            ok: true,
            status: result.status,
            profileBio: result.profileBio
          },
          "*"
        );
      } catch (error) {
        window.postMessage(
          {
            source: "spam-guard-page",
            type: "SPAM_GUARD_PROFILE_BIO_RESULT",
            requestId: data.requestId,
            screenName: data.screenName,
            ok: false,
            status: Number(String(error && error.message ? error.message : error).match(/profile_failed_(\d+)/)?.[1] || 0),
            error: String(error && error.message ? error.message : error)
          },
          "*"
        );
      }
      return;
    }

    if (data.type !== "SPAM_GUARD_BLOCK_V2") return;

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
