import { callSupervisor } from "./supervisor-client.js";
import { evaluatePolicyDecision, summarizeRules } from "./policy-engine.js";

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

  const evaluation = await evaluatePolicyDecision({
    cfg,
    rules,
    input: {
      ...input,
      stage,
      toolName,
      params,
      supervisorPayload: {
        toolName,
        params,
        content: input.content || "",
        runContext,
        rules: summarizeRules(rules),
      },
    },
    callSupervisorImpl,
  });

  return {
    mode: evaluation.effectiveMode,
    stage,
    enforced: evaluation.effectiveMode === "enforce" && evaluation.enforceCapable,
    wouldEnforce: evaluation.wouldEnforce,
    wouldExecute: evaluation.wouldExecute,
    input: {
      toolName,
      params,
      content: input.content || "",
      prompt: input.prompt || "",
    },
    rulesChecked: summarizeRules(evaluation.selectedRules),
    deterministicDecision: evaluation.deterministicDecision,
    supervisorDecision: evaluation.supervisorDecision,
    finalDecision: evaluation.finalDecision,
    matchedRuleIds: evaluation.matchedRuleIds,
    supervisorError: evaluation.supervisorError,
    onTimeout: evaluation.onTimeout,
  };
}
