import { readFile } from "node:fs/promises";

const RULES_BLOCK_RE = /```json\s+supervisor-rules\s*\n([\s\S]*?)```/i;

function normalizeRule(rule) {
  const normalized = {
    id: typeof rule?.id === "string" ? rule.id.trim() : "",
    enabled: rule?.enabled !== false,
    scope: typeof rule?.scope === "string" ? rule.scope.trim() : "",
    stage: typeof rule?.stage === "string" ? rule.stage.trim() : "",
    mode: typeof rule?.mode === "string" ? rule.mode.trim() : "deterministic",
    action: typeof rule?.action === "string" ? rule.action.trim() : "allow",
    severity: typeof rule?.severity === "string" ? rule.severity.trim() : "medium",
    description: typeof rule?.description === "string" ? rule.description.trim() : "",
    tools: Array.isArray(rule?.tools)
      ? rule.tools.map((value) => String(value).trim()).filter(Boolean)
      : [],
  };

  if (!normalized.id) {
    throw new Error("Rule is missing a non-empty id");
  }
  if (!normalized.stage) {
    throw new Error(`Rule ${normalized.id} is missing a stage`);
  }

  return normalized;
}

export function extractRulesBlock(markdown) {
  const match = RULES_BLOCK_RE.exec(markdown);
  if (!match) {
    throw new Error("Could not find ```json supervisor-rules``` block in rules file");
  }
  return match[1].trim();
}

export function parseRulesMarkdown(markdown) {
  const rawBlock = extractRulesBlock(markdown);
  let parsed;
  try {
    parsed = JSON.parse(rawBlock);
  } catch (error) {
    throw new Error(`Invalid supervisor rules JSON: ${error.message}`);
  }

  const rules = Array.isArray(parsed?.rules) ? parsed.rules.map(normalizeRule) : [];
  return {
    version: Number.isFinite(parsed?.version) ? Number(parsed.version) : 1,
    defaults: parsed?.defaults && typeof parsed.defaults === "object" ? parsed.defaults : {},
    rules,
  };
}

export async function loadRules(rulesPath) {
  const markdown = await readFile(rulesPath, "utf8");
  return parseRulesMarkdown(markdown);
}
