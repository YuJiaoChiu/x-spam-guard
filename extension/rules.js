(function initSpamRules(globalThisLike) {
  const CONTACT_TERMS = ["私信", "主页", "置顶", "联系", "联系方式", "加我", "dd", "d1", "d2", "线下", "同城", "附近的dd", "附近dd", "互相认识", "互相倾诉"];
  const TG_TERMS = ["telegram", "tg", "电报", "飞机", "t.me", "✈"];
  const QUARK_TERMS = ["夸克", "quark", "网盘", "1t空间", "提取码", "资源合集", "全集", "无删减", "下载"];
  const ADULT_TERMS = ["来个男大", "男大", "没他sao", "没他骚", "sao", "骚", "约炮", "福利", "反差", "裸舞", "pmv", "绿帽", "成人视频", "色图", "免费破处", "破处"];
  const MARKETING_TERMS = ["投稿", "推广", "互推", "代理", "拉新"];
  const ROLEPLAY_TERMS = ["老师", "女王", "少妇", "人妻"];
  const URL_RE = /(https?:\/\/|www\.|\.cn\/|\.com\/)/i;
  const QUARK_PAN_RE = /(?:https?:\/\/)?pan\.quark\.cn\//i;

  function normalizeText(input) {
    return String(input || "")
      .toLowerCase()
      .replace(/[０-９]/g, (m) => String.fromCharCode(m.charCodeAt(0) - 65248))
      .replace(/[\u200b-\u200f\uFEFF]/g, "")
      .replace(/\s+/g, "");
  }

  function fieldMap(candidate) {
    return {
      commentText: normalizeText(candidate.commentText),
      displayName: normalizeText(candidate.displayName),
      profileBio: normalizeText(candidate.profileBio),
      screenName: normalizeText(candidate.screenName)
    };
  }

  function findTermHits(terms, fields) {
    const hits = [];
    for (const [field, text] of Object.entries(fields)) {
      if (!text) continue;
      for (const term of terms) {
        const normalized = normalizeText(term);
        if (normalized && text.includes(normalized)) {
          hits.push({ field, term, value: text });
        }
      }
    }
    return hits;
  }

  function fieldsOf(hits) {
    return [...new Set(hits.map((hit) => hit.field))];
  }

  function hasHighIntentContact(hits) {
    const highIntent = new Set(["附近的dd", "附近dd", "线下", "同城", "私信", "加我"]);
    return hits.some((hit) => highIntent.has(normalizeText(hit.term)));
  }

  function isLikelyRandomHandle(handle) {
    const value = String(handle || "").replace(/^@/, "");
    if (!value) return false;
    const tooManyDigits = /\d{4,}/.test(value);
    const mixedRandom = /^[a-z0-9_]{10,}$/i.test(value) && /[a-z]/i.test(value) && /\d/.test(value);
    return tooManyDigits || mixedRandom;
  }

  function emojiCount(text) {
    const match = String(text || "").match(/[\u{1F300}-\u{1FAFF}]/gu);
    return Array.isArray(match) ? match.length : 0;
  }

  function scoreCandidate(candidate) {
    const fields = fieldMap(candidate);
    const all = [fields.commentText, fields.displayName, fields.profileBio, fields.screenName].filter(Boolean).join(" ");

    let score = 0;
    const matchedRules = [];
    const matchDetails = [];

    const contactHits = findTermHits(CONTACT_TERMS, fields);
    const tgHits = findTermHits(TG_TERMS, fields);
    const quarkHits = findTermHits(QUARK_TERMS, fields);
    const adultHits = findTermHits(ADULT_TERMS, fields);
    const marketingHits = findTermHits(MARKETING_TERMS, fields);
    const roleplayHits = findTermHits(ROLEPLAY_TERMS, fields);

    function add(rule, points, hits, fieldsOverride) {
      score += points;
      matchedRules.push(rule);
      matchDetails.push({
        rule,
        fields: fieldsOverride || fieldsOf(hits),
        hits
      });
    }

    const quarkPanHits = [];
    for (const [field, text] of Object.entries(fields)) {
      if (QUARK_PAN_RE.test(text || "")) {
        quarkPanHits.push({ field, term: "pan.quark.cn/", value: text });
      }
    }

    if (quarkPanHits.length) add("quark_pan_direct_link", 6, quarkPanHits);
    if (tgHits.length && contactHits.length) add("tg_contact_combo", 5, [...tgHits, ...contactHits]);
    if (quarkHits.length && (contactHits.length || URL_RE.test(all))) add("quark_lure_combo", 5, [...quarkHits, ...contactHits]);
    if (adultHits.length && contactHits.length) add("adult_lure_combo", 4, [...adultHits, ...contactHits]);
    if (marketingHits.length && (adultHits.length || quarkHits.length)) add("marketing_combo", 3, [...marketingHits, ...adultHits, ...quarkHits]);
    if (contactHits.length && hasHighIntentContact(contactHits) && !matchedRules.includes("adult_lure_combo") && !matchedRules.includes("tg_contact_combo")) add("contact_lure_signal", 1, contactHits);
    if (URL_RE.test(fields.commentText || "") && (findTermHits(CONTACT_TERMS, { commentText: fields.commentText }).length || findTermHits(TG_TERMS, { commentText: fields.commentText }).length)) add("link_drop", 2, [], ["commentText"]);

    if (isLikelyRandomHandle(fields.screenName)) {
      score += 2;
      matchedRules.push("random_handle");
      matchDetails.push({ rule: "random_handle", fields: ["screenName"], evidence: [fields.screenName] });
    }

    const emojiTotal = emojiCount(fields.commentText);
    if (emojiTotal >= 4) {
      score += 1;
      matchedRules.push("emoji_flood");
      matchDetails.push({ rule: "emoji_flood", fields: ["commentText"], evidence: [`emoji_count=${emojiTotal}`] });
    }

    if (roleplayHits.length && (contactHits.some((hit) => hit.field === "commentText") || tgHits.some((hit) => hit.field === "commentText"))) {
      add("roleplay_name_lure", 2, [...roleplayHits, ...contactHits, ...tgHits], ["displayName", "commentText"]);
    }

    return {
      score,
      matchedRules,
      matchDetails,
      normalized: fields
    };
  }

  globalThisLike.SpamRules = {
    normalizeText,
    scoreCandidate
  };
})(typeof self !== "undefined" ? self : window);
