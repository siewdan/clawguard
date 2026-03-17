function extractCompletionText(responseJson) {
  const content = responseJson?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

function extractJsonFromText(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    throw new Error("Supervisor returned empty content");
  }

  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) {
    return JSON.parse(fenced[1].trim());
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  throw new Error("Supervisor response did not contain a JSON object");
}

function normalizeDecision(payload) {
  const allowed = new Set(["allow", "block", "confirm", "revise"]);
  const decision = allowed.has(payload?.decision) ? payload.decision : "allow";
  return {
    decision,
    violatedRules: Array.isArray(payload?.violatedRules)
      ? payload.violatedRules.map((value) => String(value))
      : [],
    reason: typeof payload?.reason === "string" ? payload.reason : "",
    safeUserMessage: typeof payload?.safeUserMessage === "string" ? payload.safeUserMessage : "",
    confidence: Number.isFinite(payload?.confidence) ? Number(payload.confidence) : undefined,
    raw: payload,
  };
}

export async function callSupervisor({ config, stage, payload, fetchImpl = globalThis.fetch }) {
  if (!config?.enabled || !config.baseUrl || !config.model) {
    return null;
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation available for supervisor call");
  }

  const headers = {
    "content-type": "application/json",
    ...(config.headers ?? {}),
  };
  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }

  const body = {
    model: config.model,
    temperature: 0,
    response_format: { type: "json_object" },
    ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
    messages: [
      {
        role: "system",
        content:
          "You are a strict policy supervisor. Return only JSON with keys decision, violatedRules, reason, safeUserMessage, confidence. Decisions: allow, block, confirm, revise.",
      },
      {
        role: "user",
        content: JSON.stringify({ stage, payload }),
      },
    ],
  };

  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs ?? 1500),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supervisor HTTP ${response.status}: ${text}`);
  }

  const json = await response.json();
  const content = extractCompletionText(json);
  const parsed = extractJsonFromText(content);
  return normalizeDecision(parsed);
}

export const __private__ = {
  extractCompletionText,
  extractJsonFromText,
  normalizeDecision,
};
