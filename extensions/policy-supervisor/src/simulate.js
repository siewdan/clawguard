import { selectRules } from "./selectors.js";
import { evaluateDeterministicDecision } from "./deterministic.js";
import { callSupervisor } from "./supervisor-client.js";

function summarizeRules(rules) {
  return rules.map((rule) => ({
    id: rule.id,
    action: rule.action,
    severity: rule.severity,
    description: rule.description,
  }));
}

function normalizeDecisionForTool(decision) {
  if (!decision) return null;
  if (decision.decision === "revise") {
    return { ...decision, decision: "confirm" };
  }
  return decision;
}

function mergeDecisions(deterministicDecision, supervisorDecision) {
  const order = { allow: 0, revise: 1, confirm: 2, block: 3 };
  const a = deterministicDecision?.decision || "allow";
  const b = supervisorDecision?.decision || "allow";
  return order[b] > order[a] ? supervisorDecision : deterministicDecision;
}

export async function simulatePolicyDecision({
  cfg,
  rules,
  input,
  callSupervisorImpl = callSupervisor,
}) {
  const stage = input.stage || "before_tool_call";
  const toolName = input.toolName || "exec";
  const params = input.params || {};
  const runContext = {
    prompt: input.prompt || "",
    historyMessages: input.historyMessages || "",
    sessionId: input.sessionId || "simulation",
    provider: input.provider || "simulation",
    model: input.model || "simulation",
  };

  const selectedRules = selectRules(rules, { stage, toolName });
  const deterministicDecision = evaluateDeterministicDecision({
    stage,
    event: stage === "before_tool_call"
      ? { toolName, params }
      : stage === "message_sending"
        ? { content: input.content || "" }
        : input,
    rules: selectedRules,
  });

  const llmRules = selectRules(selectedRules, { mode: "llm" });
  let supervisorDecision = null;

  if (llmRules.length > 0 && cfg.supervisor?.enabled) {
    supervisorDecision = await callSupervisorImpl({
      config: {
        ...cfg.supervisor,
        enabled: true,
        timeoutMs: cfg.supervisor.timeoutMs ?? cfg.timeoutMs,
      },
      stage,
      payload: {
        toolName,
        params: JSON.stringify(params),
        content: input.content || "",
        runContext,
        rules: summarizeRules(llmRules),
      },
    });

    if (stage === "before_tool_call") {
      supervisorDecision = normalizeDecisionForTool(supervisorDecision);
    }
  }

  const finalDecision = mergeDecisions(deterministicDecision, supervisorDecision) || {
    decision: "allow",
    reasons: [],
    matchedRuleIds: [],
  };

  const matchedRuleIds = [
    ...(deterministicDecision?.matchedRuleIds || []),
    ...(supervisorDecision?.violatedRules || []),
  ].filter(Boolean);

  const finalDecisionValue = finalDecision.decision || "allow";
  const wouldEnforce = cfg.mode === "enforce" && finalDecisionValue !== "allow";

  return {
    mode: cfg.mode,
    stage,
    enforced: cfg.mode === "enforce",
    wouldEnforce,
    wouldExecute: !wouldEnforce,
    input: {
      toolName,
      params,
      content: input.content || "",
      prompt: input.prompt || "",
    },
    rulesChecked: summarizeRules(selectedRules),
    deterministicDecision,
    supervisorDecision,
    finalDecision: finalDecisionValue,
    matchedRuleIds,
  };
}
