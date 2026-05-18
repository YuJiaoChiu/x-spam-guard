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

export function normalizeText(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[０-９]/g, (m) => String.fromCharCode(m.charCodeAt(0) - 65248))
    .replace(/[\u200b-\u200f\uFEFF]/g, "")
    .replace(/\s+/g, "");
}

function normalizeTerm(term) {
  return normalizeText(term);
}

function fieldMap(candidate) {
  return {
    commentText: normalizeText(candidate.commentText),
    displayName: normalizeText(candidate.displayName),
    profileBio: normalizeText(candidate.profileBio),
    screenName: normalizeText(candidate.screenName)
  };
}

function concatFields(fields) {
  return [fields.commentText, fields.displayName, fields.profileBio, fields.screenName].filter(Boolean).join(" ");
}

function findTermHits(terms, fields) {
  const normalizedTerms = terms.map((term) => ({ term, normalized: normalizeTerm(term) })).filter((x) => x.normalized);
  const hits = [];
  for (const [field, text] of Object.entries(fields)) {
    if (!text) continue;
    for (const item of normalizedTerms) {
      if (text.includes(item.normalized)) {
        hits.push({
          field,
          term: item.term,
          normalizedTerm: item.normalized,
          value: text
        });
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
      hits.push({
        field,
        term,
        value: text
      });
    }
  }
  return hits;
}

function fieldsOf(hits) {
  return [...new Set(hits.map((hit) => hit.field))];
}

function termsOf(hits) {
  return [...new Set(hits.map((hit) => hit.term))];
}

function hasHighIntentContact(hits) {
  const highIntent = new Set(["附近的dd", "附近dd", "线下", "同城", "私信", "加我"]);
  return hits.some((hit) => highIntent.has(normalizeTerm(hit.term)));
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

function pushDetail(matchDetails, { rule, fields, hits, reason, evidence }) {
  matchDetails.push({
    rule,
    fields: [...new Set(fields || [])],
    hits: Array.isArray(hits)
      ? hits.map((hit) => ({
          field: hit.field,
          term: hit.term,
          value: hit.value
        }))
      : [],
    evidence: Array.isArray(evidence) ? evidence : [],
    reason
  });
}

function buildReadableReasons(matchDetails) {
  return matchDetails.map((m) => {
    const fieldLabel = m.fields && m.fields.length ? m.fields.join(",") : "unknown";
    const terms = Array.isArray(m.hits) && m.hits.length ? ` => ${termsOf(m.hits).join(", ")}` : "";
    const evidence = Array.isArray(m.evidence) && m.evidence.length ? ` => ${m.evidence.join(", ")}` : "";
    return `${m.rule} [${fieldLabel}]${terms || evidence}`;
  });
}

function getDynamicRuleHits(dynamicRules = [], fields) {
  const hits = [];
  const allowedFields = new Set(["commentText", "displayName", "profileBio", "screenName"]);
  for (const rule of dynamicRules) {
    if (!rule || rule.status === "disabled") continue;
    const pattern = normalizeTerm(rule.pattern || rule.value || "");
    if (!pattern || pattern.length < 4 || pattern.length > 80) continue;
    const ruleFields = Array.isArray(rule.fields) && rule.fields.length ? rule.fields : ["displayName", "commentText", "profileBio"];
    for (const field of ruleFields) {
      if (!allowedFields.has(field)) continue;
      const text = fields[field] || "";
      if (text && text.includes(pattern)) {
        hits.push({
          rule,
          field,
          term: rule.pattern || rule.value || pattern,
          value: text
        });
      }
    }
  }
  return hits;
}

export function scoreCandidate(candidate, options = {}) {
  const fields = fieldMap(candidate);
  const all = concatFields(fields);

  let score = 0;
  const matchedRules = [];
  const matchDetails = [];
  const dynamicRules = Array.isArray(options.dynamicRules) ? options.dynamicRules : [];

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
  const emojiTotal = emojiCount(fields.commentText || "");
  const shortBotCodeComment = isShortBotCodeComment(fields.commentText || "");
  const softLureBotMarkerCount = [
    randomHandle,
    shortCodeHits.length > 0,
    peachNameHits.length > 0,
    emojiTotal >= 2
  ].filter(Boolean).length;
  const urlCommentHit = URL_RE.test(fields.commentText || "");
  const quarkPanHits = [];
  for (const [field, text] of Object.entries(fields)) {
    if (QUARK_PAN_RE.test(text || "")) {
      quarkPanHits.push({ field, term: "pan.quark.cn/", value: text });
    }
  }

  if (quarkPanHits.length) {
    score += 6;
    matchedRules.push("quark_pan_direct_link");
    pushDetail(matchDetails, {
      rule: "quark_pan_direct_link",
      fields: fieldsOf(quarkPanHits),
      hits: quarkPanHits,
      reason: "Direct Quark pan share link"
    });
  }

  if (tgHits.length && contactHits.length) {
    score += 5;
    matchedRules.push("tg_contact_combo");
    pushDetail(matchDetails, {
      rule: "tg_contact_combo",
      fields: [...fieldsOf(tgHits), ...fieldsOf(contactHits)],
      hits: [...tgHits, ...contactHits],
      reason: "Telegram/contact lure combination"
    });
  }

  if (quarkHits.length && (contactHits.length || URL_RE.test(all))) {
    score += 5;
    matchedRules.push("quark_lure_combo");
    pushDetail(matchDetails, {
      rule: "quark_lure_combo",
      fields: [...fieldsOf(quarkHits), ...fieldsOf(contactHits)],
      hits: [...quarkHits, ...contactHits],
      reason: "Quark/netdisk lure with contact or URL"
    });
  }

  if (adultHits.length && contactHits.length) {
    score += 4;
    matchedRules.push("adult_lure_combo");
    pushDetail(matchDetails, {
      rule: "adult_lure_combo",
      fields: [...fieldsOf(adultHits), ...fieldsOf(contactHits)],
      hits: [...adultHits, ...contactHits],
      reason: "Adult lure terms with contact CTA"
    });
  }

  if (marketingHits.length && (adultHits.length || quarkHits.length)) {
    score += 3;
    matchedRules.push("marketing_combo");
    pushDetail(matchDetails, {
      rule: "marketing_combo",
      fields: [...fieldsOf(marketingHits), ...fieldsOf(adultHits), ...fieldsOf(quarkHits)],
      hits: [...marketingHits, ...adultHits, ...quarkHits],
      reason: "Marketing terms with spam context"
    });
  }

  if (adultPlatformBioHits.length) {
    score += 8;
    matchedRules.push("adult_platform_bio");
    pushDetail(matchDetails, {
      rule: "adult_platform_bio",
      fields: ["profileBio"],
      hits: adultPlatformBioHits,
      reason: "Profile bio contains adult platform onboarding phrase"
    });
  }

  if (resourceLureHits.length) {
    score += 6;
    matchedRules.push("resource_lure_combo");
    pushDetail(matchDetails, {
      rule: "resource_lure_combo",
      fields: fieldsOf(resourceLureHits),
      hits: resourceLureHits,
      reason: "Offline resource/group/person-selection lure phrase"
    });
  }

  if (explicitAdultNameHits.length && randomHandle && shortBotCodeComment) {
    score += 7;
    matchedRules.push("adult_name_bot_comment_combo");
    pushDetail(matchDetails, {
      rule: "adult_name_bot_comment_combo",
      fields: ["displayName", "commentText", "screenName"],
      hits: explicitAdultNameHits,
      evidence: [`comment=${fields.commentText}`, `random_handle=${fields.screenName}`],
      reason: "Explicit adult display name with random handle and bot-like short code/emoji comment"
    });
  }

  if (obfuscatedDdHits.length && contactHits.some((hit) => hit.field === "commentText")) {
    score += 3;
    matchedRules.push("obfuscated_dd_contact_combo");
    pushDetail(matchDetails, {
      rule: "obfuscated_dd_contact_combo",
      fields: ["commentText"],
      hits: [...obfuscatedDdHits, ...contactHits.filter((hit) => hit.field === "commentText")],
      reason: "Obfuscated DD token with offline/contact lure"
    });
  }

  if (softLureHits.length && softLureBotMarkerCount >= 2) {
    score += 4;
    matchedRules.push("soft_lure_bot_combo");
    pushDetail(matchDetails, {
      rule: "soft_lure_bot_combo",
      fields: [...fieldsOf([...softLureHits, ...shortCodeHits, ...peachNameHits]), ...(randomHandle ? ["screenName"] : [])],
      hits: [...softLureHits, ...shortCodeHits, ...peachNameHits],
      evidence: [
        ...(randomHandle ? [`random_handle=${fields.screenName}`] : []),
        ...(emojiTotal >= 2 ? [`emoji_count=${emojiTotal}`] : [])
      ],
      reason: "Soft relationship lure combined with bot-like account markers"
    });
  }

  if (shortCodeHits.length && (softLureHits.length || obfuscatedDdHits.length || contactHits.length)) {
    score += 1;
    matchedRules.push("mixed_short_code_lure");
    pushDetail(matchDetails, {
      rule: "mixed_short_code_lure",
      fields: ["commentText"],
      hits: shortCodeHits,
      reason: "Comment contains mixed digit-letter code next to lure text"
    });
  }

  if (peachNameHits.length && (softLureHits.length || contactHits.length || adultHits.length)) {
    score += 1;
    matchedRules.push("peach_display_lure");
    pushDetail(matchDetails, {
      rule: "peach_display_lure",
      fields: ["displayName"],
      hits: peachNameHits,
      reason: "Peach display marker paired with lure wording"
    });
  }

  const dynamicHits = getDynamicRuleHits(dynamicRules, fields);
  if (dynamicHits.length) {
    const grouped = new Map();
    for (const hit of dynamicHits) {
      const key = hit.rule.id || hit.rule.pattern || hit.term;
      const current = grouped.get(key) || { rule: hit.rule, hits: [] };
      current.hits.push(hit);
      grouped.set(key, current);
    }
    for (const group of grouped.values()) {
      const ruleScore = Math.max(1, Math.min(8, Number(group.rule.score || 3)));
      const ruleName = `dynamic_${String(group.rule.kind || "pattern").replace(/[^a-z0-9_:-]/gi, "_")}`;
      score += ruleScore;
      matchedRules.push(ruleName);
      pushDetail(matchDetails, {
        rule: ruleName,
        fields: fieldsOf(group.hits),
        hits: group.hits,
        reason: group.rule.reason || "Admin/AI learned dynamic rule"
      });
    }
  }

  if (contactHits.length && hasHighIntentContact(contactHits) && !matchedRules.includes("adult_lure_combo") && !matchedRules.includes("tg_contact_combo")) {
    score += 1;
    matchedRules.push("contact_lure_signal");
    pushDetail(matchDetails, {
      rule: "contact_lure_signal",
      fields: fieldsOf(contactHits),
      hits: contactHits,
      reason: "High-intent contact lure terms"
    });
  }

  if (urlCommentHit && (findTermHits(CONTACT_TERMS, { commentText: fields.commentText }).length || findTermHits(TG_TERMS, { commentText: fields.commentText }).length)) {
    score += 2;
    matchedRules.push("link_drop");
    pushDetail(matchDetails, {
      rule: "link_drop",
      fields: ["commentText"],
      hits: [],
      evidence: [fields.commentText],
      reason: "Comment includes URL plus contact/TG terms"
    });
  }

  if (randomHandle) {
    score += 2;
    matchedRules.push("random_handle");
    pushDetail(matchDetails, {
      rule: "random_handle",
      fields: ["screenName"],
      hits: [],
      evidence: [fields.screenName],
      reason: "Screen name looks machine-generated or digit-heavy"
    });
  }

  if (emojiTotal >= 4) {
    score += 1;
    matchedRules.push("emoji_flood");
    pushDetail(matchDetails, {
      rule: "emoji_flood",
      fields: ["commentText"],
      hits: [],
      evidence: [`emoji_count=${emojiTotal}`],
      reason: "Comment has emoji flood pattern"
    });
  }

  if (roleplayHits.length && (contactHits.some((hit) => hit.field === "commentText") || tgHits.some((hit) => hit.field === "commentText"))) {
    score += 2;
    matchedRules.push("roleplay_name_lure");
    pushDetail(matchDetails, {
      rule: "roleplay_name_lure",
      fields: ["displayName", "commentText"],
      hits: [...roleplayHits, ...contactHits.filter((hit) => hit.field === "commentText"), ...tgHits.filter((hit) => hit.field === "commentText")],
      reason: "Roleplay display name with lure comment"
    });
  }

  return {
    score,
    matchedRules,
    matchDetails,
    humanReasons: buildReadableReasons(matchDetails),
    normalized: fields
  };
}

function buildFeedbackHit(candidate, feedbackSamples = []) {
  if (!Array.isArray(feedbackSamples) || !feedbackSamples.length) return null;
  const fields = fieldMap(candidate);
  const text = concatFields(fields);
  if (!text) return null;

  for (const sample of feedbackSamples) {
    if (String(sample.label || "spam") !== "spam") continue;
    const patterns = Array.isArray(sample.patternCandidates) && sample.patternCandidates.length ? sample.patternCandidates : sample.fragments || [];
    for (const pattern of patterns) {
      const raw = typeof pattern === "string" ? pattern : pattern.value;
      const normalizedPattern = normalizeText(raw);
      if (!normalizedPattern || normalizedPattern.length < 4) continue;
      if (text.includes(normalizedPattern)) {
        return {
          sampleId: sample.id,
          fragment: normalizedPattern,
          source: sample.source || "admin"
        };
      }
    }
  }
  return null;
}

export function mockAiJudge(candidate, ruleResult, options = {}) {
  const score = ruleResult.score;
  const all = concatFields(fieldMap(candidate));
  const feedbackHit = buildFeedbackHit(candidate, options.feedbackSamples || []);

  if (feedbackHit && score >= 2) {
    return {
      provider: "feedback-memory",
      isSpam: true,
      confidence: 0.94,
      reason: "reported_spam_pattern",
      tags: ["feedback_memory", ...ruleResult.matchedRules],
      details: {
        feedbackHit,
        ruleDetails: ruleResult.matchDetails
      }
    };
  }

  const hasHardSignal =
    (findTermHits(TG_TERMS, { all }).length && findTermHits(CONTACT_TERMS, { all }).length) ||
    (findTermHits(QUARK_TERMS, { all }).length && findTermHits(CONTACT_TERMS, { all }).length) ||
    /(来个男大|线下dd|看我主页|主页私信|私信领福利|点击领取1t空间|已入驻曰泡平台|已入驻日泡平台|曰泡平台|日泡平台|资源入口|进群选人|同城约p|1-5线|真实约见|同城资源自取)/i.test(all);

  if (hasHardSignal && score >= 5) {
    return {
      provider: "mock-ai",
      isSpam: true,
      confidence: 0.9,
      reason: "hard_signal_match",
      tags: ["hard_signal", ...ruleResult.matchedRules],
      details: {
        ruleDetails: ruleResult.matchDetails
      }
    };
  }

  if (score >= 6) {
    return {
      provider: "mock-ai",
      isSpam: true,
      confidence: 0.82,
      reason: "high_rule_score",
      tags: [...ruleResult.matchedRules],
      details: {
        ruleDetails: ruleResult.matchDetails
      }
    };
  }

  if (score >= 4) {
    return {
      provider: "mock-ai",
      isSpam: false,
      confidence: 0.45,
      reason: "needs_human_or_real_ai",
      tags: [...ruleResult.matchedRules],
      details: {
        ruleDetails: ruleResult.matchDetails
      }
    };
  }

  return {
    provider: "mock-ai",
    isSpam: false,
    confidence: 0.15,
    reason: "weak_signal",
    tags: [...ruleResult.matchedRules],
    details: {
      ruleDetails: ruleResult.matchDetails
    }
  };
}
