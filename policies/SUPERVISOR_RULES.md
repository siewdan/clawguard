# Supervisor Rules

```json supervisor-rules
{
  "version": 1,
  "defaults": {
    "mode": "enforce",
    "onTimeout": {
      "tool": "confirm",
      "outbound": "revise"
    }
  },
  "rules": [
    {
      "id": "no-delete-without-confirm",
      "enabled": true,
      "scope": "tool",
      "stage": "before_tool_call",
      "tools": ["exec", "write", "edit"],
      "mode": "deterministic",
      "action": "confirm",
      "severity": "high",
      "description": "Lösche oder überschreibe nie Dateien ohne explizite Bestätigung."
    },
    {
      "id": "no-external-send-without-explicit-request",
      "enabled": true,
      "scope": "tool",
      "stage": "before_tool_call",
      "tools": ["exec", "sessions_send"],
      "mode": "deterministic",
      "action": "confirm",
      "severity": "high",
      "description": "Führe keine externen Sende- oder Exfiltrationsaktionen ohne explizite Bestätigung aus."
    },
    {
      "id": "protect-private-context",
      "enabled": true,
      "scope": "outbound",
      "stage": "message_sending",
      "mode": "deterministic",
      "action": "revise",
      "severity": "high",
      "description": "Sende keine offensichtlichen Secrets oder privaten Workspace-Pfade nach außen."
    },
    {
      "id": "ask-when-ambiguous",
      "enabled": true,
      "scope": "tool",
      "stage": "before_tool_call",
      "tools": ["exec", "write", "edit"],
      "mode": "llm",
      "action": "confirm",
      "severity": "medium",
      "description": "Wenn ein riskanter Eingriff nicht klar beauftragt wurde, nachfragen."
    },
    {
      "id": "review-assistant-output",
      "enabled": true,
      "scope": "output",
      "stage": "llm_output",
      "mode": "llm",
      "action": "revise",
      "severity": "medium",
      "description": "Prüfe Antworten nachgelagert auf Regelverletzungen."
    }
  ]
}
```

## Notes

- Dieses MVP nutzt absichtlich einen JSON-Codeblock in der Markdown-Datei statt YAML-Frontmatter.
- Grund: Der Parser bleibt damit dependency-free und testbar.
- Wenn das Gerüst sitzt, kann man später problemlos auf YAML-Frontmatter umstellen.
