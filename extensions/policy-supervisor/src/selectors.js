export function selectRules(rules, criteria = {}) {
  if (!Array.isArray(rules)) {
    return [];
  }

  const stage = criteria.stage ? String(criteria.stage) : undefined;
  const scope = criteria.scope ? String(criteria.scope) : undefined;
  const toolName = criteria.toolName ? String(criteria.toolName) : undefined;
  const mode = criteria.mode ? String(criteria.mode) : undefined;

  return rules.filter((rule) => {
    if (!rule || rule.enabled === false) return false;
    if (stage && rule.stage !== stage) return false;
    if (scope && rule.scope !== scope) return false;
    if (mode && rule.mode !== mode) return false;
    if (toolName && Array.isArray(rule.tools) && rule.tools.length > 0 && !rule.tools.includes(toolName)) {
      return false;
    }
    return true;
  });
}
