import { selectRules } from "./selectors.js";
import { evaluateDeterministicDecision } from "./deterministic.js";
import { callSupervisor } from "./supervisor-client.js";
import { redactText, truncateText } from "./redact.js";

const DECISION_WEIGHT = { allow: 0, revise: 1, confirm: 2, block: 3 };
const ALLOWED_ACTIONS = new Set(["allow", "revise", "confirm", "block"]);

export function summarizeRules(rules) {
  return rules.map((rule) => ({
    id: rule.id,
    action: rule.action,
    severity: rule.severity,
    description: rule.description,
  }));
}

function normalizeAction(value, fallback = "allow") {
  return ALLOWED_ACTIONS.has(value) ? value : fallback;
}

export function normalizeDecisionForTool(decision) {
  if (!decision) return null;
  if (decision.decision === "revise") {
    return { ...decision, decision: "confirm" };
  }
  return decision;
}

function moreRestrictiveDecision(a, b) {
  const left = a?.decision || "allow";
  const right = b?.decision || "allow";
  return DECISION_WEIGHT[right] > DECISION_WEIGHT[left] ? b : a;
}

function safeText(value, cfg, maxChars = cfg.maxSupervisorPayloadChars ?? 8000) {
  const asString = typeof value === "string" ? value : JSON.stringify(value);
  const maybeRedacted = cfg.redactSecrets ? redactText(asString) : asString;
  return truncateText(maybeRedacted, maxChars);
}

function sanitizeSupervisorPayload(payload, cfg) {
  if (!payload || typeof payload !== "object") return payload;
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      out[key] = value.map((item) => safeText(item, cfg));
    } else if (value && typeof value === "object") {
      out[key] = safeText(value, cfg);
    } else if (typeof value === "string") {
      out[key] = safeText(value, cfg);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function stageFamily(stage) {
  if (stage === "before_tool_call") return "tool";
  if (stage === "message_sending") return "outbound";
  if (stage === "llm_output") return "output";
  return "generic";
}

function buildDeterministicEvent(input) {
  if (input.stage === "before_tool_call") {
    return { toolName: input.toolName, params: input.params || {} };
  }
  if (input.stage === "message_sending") {
    return { content: input.content || "" };
  }
  return input;
}

function timeoutDecision(stage, cfg, errorMessage) {
  const family = stageFamily(stage);
  const rawAction = cfg.onTimeout?.[family] || "allow";
  let action = normalizeAction(rawAction, "allow");
  if (family === "tool" && action === "revise") {
    action = "confirm";
  }
  return {
    decision: action,
    violatedRules: [],
    reason: `supervisor error (${family}): ${errorMessage}`,
    safeUserMessage: "",
    timeoutApplied: true,
  };
}

export function resolveEffectivePolicyConfig(cfg, rulesDefaults = {}) {
  const defaultMode = rulesDefaults?.mode === "enforce" ? "enforce" : "audit";
  const effectiveMode = cfg.modeExplicit ? cfg.mode : defaultMode;
  const onTimeoutDefaults = rulesDefaults?.onTimeout && typeof rulesDefaults.onTimeout === "object"
    ? rulesDefaults.onTimeout
    : {};

  return {
    ...cfg,
    effectiveMode,
    onTimeout: {
      tool: normalizeAction(onTimeoutDefaults.tool, "allow"),
      outbound: normalizeAction(onTimeoutDefaults.outbound, "allow"),
      output: normalizeAction(onTimeoutDefaults.output, "allow"),
      generic: normalizeAction(onTimeoutDefaults.generic, "allow"),
    },
    maxSupervisorPayloadChars: Number.isFinite(cfg.maxSupervisorPayloadChars)
      ? Number(cfg.maxSupervisorPayloadChars)
      : 8000,
  };
}

export async function evaluatePolicyDecision({
  cfg,
  rules,
  input,
  callSupervisorImpl = callSupervisor,
}) {
  const effectiveCfg = resolveEffectivePolicyConfig(cfg, input.rulesDefaults || {});
  const selectedRules = selectRules(rules, { stage: input.stage, toolName: input.toolName });
  const llmRules = selectRules(selectedRules, { mode: "llm" });
  const deterministicDecision = evaluateDeterministicDecision({
    stage: input.stage,
    event: buildDeterministicEvent(input),
    rules: selectedRules,
  });

  let supervisorDecision = null;
  let supervisorError = null;
  const enforceCapable = input.enforceCapable ?? !["llm_input", "llm_output"].includes(input.stage);

  if (deterministicDecision.decision === "allow" && llmRules.length > 0 && effectiveCfg.supervisor?.enabled && input.supervisorPayload) {
    try {
      supervisorDecision = await callSupervisorImpl({
        config: {
          ...effectiveCfg.supervisor,
          enabled: true,
          timeoutMs: effectiveCfg.supervisor.timeoutMs ?? effectiveCfg.timeoutMs,
        },
        stage: input.stage,
        payload: sanitizeSupervisorPayload(input.supervisorPayload, effectiveCfg),
      });
      if (input.stage === "before_tool_call") {
        supervisorDecision = normalizeDecisionForTool(supervisorDecision);
      }
    } catch (error) {
      supervisorError = error;
      supervisorDecision = timeoutDecision(input.stage, effectiveCfg, error.message);
      if (input.stage === "before_tool_call") {
        supervisorDecision = normalizeDecisionForTool(supervisorDecision);
      }
    }
  }

  const finalDecisionObject = moreRestrictiveDecision(deterministicDecision, supervisorDecision) || {
    decision: "allow",
    reasons: [],
    matchedRuleIds: [],
  };
  const finalDecision = finalDecisionObject.decision || "allow";
  const matchedRuleIds = [
    ...(deterministicDecision?.matchedRuleIds || []),
    ...(supervisorDecision?.violatedRules || []),
  ].filter(Boolean);
  const wouldEnforce = effectiveCfg.effectiveMode === "enforce" && enforceCapable && finalDecision !== "allow";

  return {
    effectiveMode: effectiveCfg.effectiveMode,
    enforceCapable,
    wouldEnforce,
    wouldExecute: !wouldEnforce,
    selectedRules,
    llmRules,
    deterministicDecision,
    supervisorDecision,
    supervisorError: supervisorError?.message,
    finalDecision,
    finalDecisionObject,
    matchedRuleIds,
    onTimeout: effectiveCfg.onTimeout,
  };
}
