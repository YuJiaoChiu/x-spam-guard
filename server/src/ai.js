import { mockAiJudge, scoreCandidate } from "./rules.js";

function clampConfidence(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callExternalClassifier(url, payload) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function callOpenAIClassifier(candidate, ruleResult, env, options = {}) {
  if (!env.OPENAI_API_KEY) return null;

  const apiBase = env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = env.CHEAP_AI_MODEL || "gpt-4o-mini";
  const url = `${apiBase.replace(/\/$/, "")}/chat/completions`;

  const systemPrompt =
    "You classify whether a social reply account is spam lure. " +
    "Output strict JSON only: {\"isSpam\":boolean,\"confidence\":0..1,\"reason\":string,\"tags\":string[]}." +
    "Be conservative: if uncertain, set isSpam=false.";

  const feedbackSamples = Array.isArray(options.feedbackSamples) ? options.feedbackSamples.slice(0, 20) : [];
  const userPayload = {
    candidate,
    ruleScore: ruleResult.score,
    matchedRules: ruleResult.matchedRules,
    matchDetails: ruleResult.matchDetails,
    reportedSpamSamples: feedbackSamples.map((row) => ({
      label: row.label,
      screenName: row.screenName,
      fragments: Array.isArray(row.fragments) ? row.fragments.slice(0, 8) : [],
      patternCandidates: Array.isArray(row.patternCandidates) ? row.patternCandidates.slice(0, 12) : [],
      rawText: String(row.rawText || "").slice(0, 320)
    }))
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userPayload) }
        ]
      })
    });

    if (!response.ok) return null;
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = parseJsonSafe(content);
    if (!parsed || typeof parsed.isSpam !== "boolean") return null;
    return {
      provider: `openai:${model}`,
      isSpam: parsed.isSpam,
      confidence: clampConfidence(parsed.confidence),
      reason: String(parsed.reason || "ai_reason_missing"),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
      details: parsed.details && typeof parsed.details === "object" ? parsed.details : {}
    };
  } catch {
    return null;
  }
}

function aggregatePatternCandidates(feedbackSamples = []) {
  const counts = new Map();
  function fallbackKind(value) {
    if (/https?:\/\/|www\.|\.com|\.cn|t\.me/i.test(value)) return "url";
    if (/(telegram|tg|电报|飞机|t\.me)/i.test(value)) return "tg";
    if (/(夸克|网盘|提取码|资源|全集|下载)/i.test(value)) return "netdisk";
    if (/(dd|线下|同城|附近|私信|主页|联系|加我)/i.test(value)) return "contact_lure";
    if (/(免费破处|破处|男大|骚|sao|福利|裸舞|绿帽)/i.test(value)) return "adult_lure";
    if (/^[a-z0-9_]{8,}$/i.test(value) && /\d/.test(value)) return "handle_like";
    return "phrase";
  }
  function isNoisyFallback(value) {
    const text = String(value || "").trim();
    if (text.length < 4 || text.length > 80) return true;
    if (/^\d+$/.test(text)) return true;
    const lettersOrCjk = text.match(/[a-z\u4e00-\u9fff]/gi) || [];
    if (lettersOrCjk.length < 2) return true;
    const stripped = text.replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\ufe0f\s.,，。!！?？:：;；'"“”‘’^_~\-—·♥♡🌸]+/gu, "");
    return stripped.length === 0;
  }
  for (const sample of feedbackSamples) {
    if (String(sample.label || "spam") !== "spam") continue;
    const patterns = Array.isArray(sample.patternCandidates) && sample.patternCandidates.length
      ? sample.patternCandidates
      : (Array.isArray(sample.fragments) ? sample.fragments.map((value) => ({ value, kind: fallbackKind(value), score: 1, source: "legacy_fragment" })) : []);
    for (const pattern of patterns) {
      const value = String(pattern?.value || pattern || "").trim();
      if (!value || isNoisyFallback(value)) continue;
      const key = `${pattern?.kind || "phrase"}:${value}`;
      const current = counts.get(key) || {
        value,
        kind: pattern?.kind || "phrase",
        score: 0,
        count: 0,
        examples: []
      };
      current.count += 1;
      current.score += Number(pattern?.score || 1);
      if (current.examples.length < 3) {
        current.examples.push(String(sample.rawText || "").slice(0, 180));
      }
      counts.set(key, current);
    }
  }
  return [...counts.values()].sort((a, b) => b.score - a.score || b.count - a.count).slice(0, 60);
}

function heuristicRuleSuggestions(feedbackSamples = []) {
  const candidates = aggregatePatternCandidates(feedbackSamples);
  return candidates.slice(0, 20).map((item) => ({
    type: item.kind === "handle_like" ? "handle_pattern" : "phrase_pattern",
    pattern: item.value,
    kind: item.kind,
    confidence: Math.min(0.95, 0.45 + item.score * 0.06 + item.count * 0.04),
    reason: `seen ${item.count} time(s), kind=${item.kind}, aggregateScore=${item.score}`,
    action: ["adult_lure", "contact_lure", "netdisk", "tg", "handle_like"].includes(item.kind) ? "candidate_rule" : "review_first",
    examples: item.examples
  }));
}

async function callOpenAIRuleSuggestions(feedbackSamples, env) {
  if (!env.OPENAI_API_KEY) return null;

  const apiBase = env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = env.CHEAP_AI_MODEL || "gpt-4o-mini";
  const url = `${apiBase.replace(/\/$/, "")}/chat/completions`;
  const patterns = aggregatePatternCandidates(feedbackSamples).slice(0, 40);
  if (!patterns.length) return { provider: "openai:none", suggestions: [] };

  const systemPrompt =
    "You summarize spam pattern candidates into conservative detection rule suggestions. " +
    "Output strict JSON only: {\"suggestions\":[{\"type\":string,\"pattern\":string,\"kind\":string,\"confidence\":0..1,\"reason\":string,\"action\":\"candidate_rule\"|\"review_first\"}]}." +
    "Avoid generic normal words, pure emoji, and too-short fragments. Prefer precise phrases.";

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify({ patterns }) }
        ]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const parsed = parseJsonSafe(data?.choices?.[0]?.message?.content || "");
    if (!parsed || !Array.isArray(parsed.suggestions)) return null;
    return {
      provider: `openai:${model}`,
      suggestions: parsed.suggestions.slice(0, 30).map((item) => ({
        type: String(item.type || "phrase_pattern"),
        pattern: String(item.pattern || ""),
        kind: String(item.kind || "phrase"),
        confidence: clampConfidence(item.confidence),
        reason: String(item.reason || ""),
        action: item.action === "candidate_rule" ? "candidate_rule" : "review_first"
      })).filter((item) => item.pattern)
    };
  } catch {
    return null;
  }
}

export async function suggestRulesFromFeedback(feedbackSamples = [], options = {}) {
  const env = options.env || process.env;
  const providerMode = String(env.AI_PROVIDER || "auto").toLowerCase();
  let ai = null;
  if (providerMode === "auto" || providerMode === "openai") {
    ai = await callOpenAIRuleSuggestions(feedbackSamples, env);
  }
  if (ai) return ai;
  return {
    provider: "heuristic",
    suggestions: heuristicRuleSuggestions(feedbackSamples)
  };
}

export async function classifyCandidate(candidate, options = {}) {
  const env = options.env || process.env;
  const strongRuleThreshold = Number(options.strongRuleThreshold || 4);
  const autoBlockConfidence = Number(options.autoBlockConfidence || 0.8);
  const providerMode = String(env.AI_PROVIDER || "auto").toLowerCase();
  const feedbackSamples = Array.isArray(options.feedbackSamples) ? options.feedbackSamples : [];

  const ruleResult = scoreCandidate(candidate);
  const ruleSpam = ruleResult.score >= strongRuleThreshold;
  const ruleConfidence = Math.min(0.96, Math.max(0.1, ruleResult.score * 0.14));

  let aiResult = null;
  if ((providerMode === "auto" || providerMode === "external") && env.CHEAP_AI_URL) {
    aiResult = await callExternalClassifier(env.CHEAP_AI_URL, { candidate, ruleResult });
    if (aiResult && typeof aiResult.isSpam === "boolean") {
      aiResult = {
        provider: "external-ai",
        isSpam: aiResult.isSpam,
        confidence: clampConfidence(aiResult.confidence),
        reason: String(aiResult.reason || "external_ai"),
        tags: Array.isArray(aiResult.tags) ? aiResult.tags.map(String) : []
      };
    } else {
      aiResult = null;
    }
  }

  if (!aiResult && (providerMode === "auto" || providerMode === "openai")) {
    aiResult = await callOpenAIClassifier(candidate, ruleResult, env, { feedbackSamples });
  }

  if (!aiResult) {
    const mock = mockAiJudge(candidate, ruleResult, { feedbackSamples });
    aiResult = {
      ...mock,
      provider: providerMode === "mock" ? "mock-ai" : `${mock.provider || "mock-ai"}(fallback)`
    };
  }

  const feedbackOverride = aiResult.reason === "reported_spam_pattern" && ruleResult.score >= 2;
  const finalIsSpam = feedbackOverride ? true : Boolean(ruleSpam && aiResult.isSpam);
  const baseConfidence = clampConfidence(ruleConfidence * 0.35 + aiResult.confidence * 0.65);
  const finalConfidence = feedbackOverride ? Math.max(baseConfidence, 0.88) : baseConfidence;
  const shouldBlock = finalIsSpam && finalConfidence >= autoBlockConfidence;

  return {
    candidate,
    ruleResult,
    aiResult,
    final: {
      isSpam: finalIsSpam,
      confidence: finalConfidence,
      shouldBlock,
      reason: aiResult.reason || "final_decision",
      tags: [...new Set([...(ruleResult.matchedRules || []), ...(aiResult.tags || [])])],
      details: {
        ruleScore: ruleResult.score,
        ruleHumanReasons: ruleResult.humanReasons || [],
        ruleMatchDetails: ruleResult.matchDetails || [],
        aiProvider: aiResult.provider || "unknown",
        aiReason: aiResult.reason || "",
        aiDetails: aiResult.details && typeof aiResult.details === "object" ? aiResult.details : {}
      }
    }
  };
}
