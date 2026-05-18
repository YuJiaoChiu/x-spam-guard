(function initSpamRules(globalThisLike) {
  const CONTACT_TERMS = ["私信", "主页", "置顶", "联系", "联系方式", "加我", "dd", "d1", "d2", "线下", "同城", "附近的dd", "附近dd", "互相认识", "互相倾诉"];
  const TG_TERMS = ["telegram", "tg", "电报", "飞机", "t.me", "✈"];
  const QUARK_TERMS = ["夸克", "quark", "网盘", "1t空间", "提取码", "资源合集", "全集", "无删减", "下载"];
  const ADULT_TERMS = ["来个男大", "男大", "没他sao", "没他骚", "sao", "骚", "约炮", "福利", "反差", "裸舞", "pmv", "绿帽", "成人视频", "色图", "免费破处", "破处"];
  const MARKETING_TERMS = ["投稿", "推广", "互推", "代理", "拉新"];
  const ROLEPLAY_TERMS = ["老师", "女王", "少妇", "人妻"];
  const SOFT_LURE_TERMS = ["有弟弟想认识吗", "弟弟想认识", "想认识吗", "刚分手想被爱", "小狗求抱抱", "求抱抱", "线下的哥哥", "线下哥哥"];
  const EXPLICIT_ADULT_NAME_TERMS = ["哥哥我要", "母狗待调", "想被扇巴掌", "大胸妹", "听主人话", "爱吃肉棒", "肉棒", "待调", "母狗", "大胸"];
  const ADULT_PLATFORM_BIO_TERMS = ["已入驻曰泡平台", "已入驻日泡平台", "曰泡平台", "日泡平台"];
  const RESOURCE_LURE_TERMS = [
    "线下资源入口",
    "资源入口",
    "点我头像进群选人",
    "进群选人",
    "同城约p",
    "同城约P",
    "1-5线真实对接",
    "1-5线覆盖",
    "真实可靠约见",
    "真实约见",
    "同城资源自取",
    "看我置顶",
    "看我简介"
  ];
  const URL_RE = /(https?:\/\/|www\.|\.cn\/|\.com\/)/i;
  const QUARK_PAN_RE = /(?:https?:\/\/)?pan\.quark\.cn\//i;
  const OBFUSCATED_DD_RE = /d[\W_]{0,3}d/i;
  const SHORT_CODE_RE = /(?:^|[^a-z0-9\u4e00-\u9fff])\d{1,3}[a-z]{1,3}(?=$|[^a-z0-9\u4e00-\u9fff])/i;
  const PEACH_NAME_RE = /🍑/u;

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

  function findRegexHits(regex, fields, term) {
    const hits = [];
    for (const [field, text] of Object.entries(fields)) {
      if (!text) continue;
      const match = String(text).match(regex);
      if (match) {
        hits.push({ field, term, value: text });
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

  function isShortBotCodeComment(text) {
    const value = normalizeText(text);
    if (!value) return false;
    const lettersDigits = value.match(/[a-z0-9]/gi) || [];
    const cjk = value.match(/[\u4e00-\u9fff]/g) || [];
    return cjk.length === 0 && lettersDigits.length >= 1 && lettersDigits.length <= 3 && Array.from(value).length <= 12;
  }

  function dynamicRuleHits(dynamicRules, fields) {
    const allowedFields = new Set(["commentText", "displayName", "profileBio", "screenName"]);
    const hits = [];
    for (const rule of Array.isArray(dynamicRules) ? dynamicRules : []) {
      if (!rule || rule.status === "disabled") continue;
      const pattern = normalizeText(rule.pattern || rule.value || "");
      if (!pattern || pattern.length < 4 || pattern.length > 80) continue;
      const ruleFields = Array.isArray(rule.fields) && rule.fields.length ? rule.fields : ["displayName", "commentText", "profileBio"];
      for (const field of ruleFields) {
        if (!allowedFields.has(field)) continue;
        const text = fields[field] || "";
        if (text && text.includes(pattern)) {
          hits.push({ rule, field, term: rule.pattern || rule.value || pattern, value: text });
        }
      }
    }
    return hits;
  }

  function scoreCandidate(candidate, options = {}) {
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
    const explicitAdultNameHits = findTermHits(EXPLICIT_ADULT_NAME_TERMS, { displayName: fields.displayName });
    const adultPlatformBioHits = findTermHits(ADULT_PLATFORM_BIO_TERMS, { profileBio: fields.profileBio });
    const resourceLureHits = findTermHits(RESOURCE_LURE_TERMS, {
      displayName: fields.displayName,
      commentText: fields.commentText,
      profileBio: fields.profileBio
    });
    const softLureHits = findTermHits(SOFT_LURE_TERMS, {
      commentText: fields.commentText,
      displayName: fields.displayName,
      profileBio: fields.profileBio
    });
    const obfuscatedDdHits = findRegexHits(OBFUSCATED_DD_RE, { commentText: fields.commentText }, "D.D / obfuscated dd");
    const shortCodeHits = findRegexHits(SHORT_CODE_RE, { commentText: fields.commentText }, "mixed short code");
    const peachNameHits = PEACH_NAME_RE.test(fields.displayName || "") ? [{ field: "displayName", term: "🍑", value: fields.displayName }] : [];
    const randomHandle = isLikelyRandomHandle(fields.screenName);
    const emojiTotal = emojiCount(fields.commentText);
    const shortBotCodeComment = isShortBotCodeComment(fields.commentText);
    const softLureBotMarkerCount = [
      randomHandle,
      shortCodeHits.length > 0,
      peachNameHits.length > 0,
      emojiTotal >= 2
    ].filter(Boolean).length;

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
    if (adultPlatformBioHits.length) add("adult_platform_bio", 8, adultPlatformBioHits, ["profileBio"]);
    if (resourceLureHits.length) add("resource_lure_combo", 6, resourceLureHits, fieldsOf(resourceLureHits));
    if (explicitAdultNameHits.length && randomHandle && shortBotCodeComment) {
      add("adult_name_bot_comment_combo", 7, explicitAdultNameHits, ["displayName", "commentText", "screenName"]);
    }

    if (obfuscatedDdHits.length && contactHits.some((hit) => hit.field === "commentText")) {
      add("obfuscated_dd_contact_combo", 3, [...obfuscatedDdHits, ...contactHits.filter((hit) => hit.field === "commentText")], ["commentText"]);
    }
    if (softLureHits.length && softLureBotMarkerCount >= 2) {
      add(
        "soft_lure_bot_combo",
        4,
        [...softLureHits, ...shortCodeHits, ...peachNameHits],
        [...fieldsOf([...softLureHits, ...shortCodeHits, ...peachNameHits]), ...(randomHandle ? ["screenName"] : [])]
      );
    }
    if (shortCodeHits.length && (softLureHits.length || obfuscatedDdHits.length || contactHits.length)) {
      add("mixed_short_code_lure", 1, shortCodeHits, ["commentText"]);
    }
    if (peachNameHits.length && (softLureHits.length || contactHits.length || adultHits.length)) {
      add("peach_display_lure", 1, peachNameHits, ["displayName"]);
    }

    const groupedDynamicHits = new Map();
    for (const hit of dynamicRuleHits(options.dynamicRules, fields)) {
      const key = hit.rule.id || hit.rule.pattern || hit.term;
      const current = groupedDynamicHits.get(key) || { rule: hit.rule, hits: [] };
      current.hits.push(hit);
      groupedDynamicHits.set(key, current);
    }
    for (const group of groupedDynamicHits.values()) {
      const ruleScore = Math.max(1, Math.min(8, Number(group.rule.score || 3)));
      const ruleName = "dynamic_" + String(group.rule.kind || "pattern").replace(/[^a-z0-9_:-]/gi, "_");
      add(ruleName, ruleScore, group.hits, fieldsOf(group.hits));
    }

    if (contactHits.length && hasHighIntentContact(contactHits) && !matchedRules.includes("adult_lure_combo") && !matchedRules.includes("tg_contact_combo")) add("contact_lure_signal", 1, contactHits);
    if (URL_RE.test(fields.commentText || "") && (findTermHits(CONTACT_TERMS, { commentText: fields.commentText }).length || findTermHits(TG_TERMS, { commentText: fields.commentText }).length)) add("link_drop", 2, [], ["commentText"]);

    if (randomHandle) {
      score += 2;
      matchedRules.push("random_handle");
      matchDetails.push({ rule: "random_handle", fields: ["screenName"], evidence: [fields.screenName] });
    }

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
