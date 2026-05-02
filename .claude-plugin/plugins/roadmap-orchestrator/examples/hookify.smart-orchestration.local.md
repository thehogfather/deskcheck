---
name: smart-orchestration-detector
enabled: true
event: prompt
action: warn
conditions:
  - field: user_prompt
    operator: regex_match
    pattern: (implement|build|create|add|develop|fix|refactor|enhance|optimize|improve|migrate|update|extend|integrate)\s+.{0,50}(feature|component|module|system|service|endpoint|page|function|api|functionality|capability|workflow|process)
---

## Implementation Task Detected

This prompt appears to be an **implementation task** that would benefit from orchestrated planning.

### Suggested Action

Consider using the full orchestration workflow:

```
/roadmap work
```

This will:
1. Generate 3 competing plans (Speed, Quality, Safety)
2. Have a judge select the optimal approach
3. Require your approval before implementation
4. Collect evidence and verify Definition of Done
5. Require your approval of evidence before completion

### Why Use Orchestration?

- **Better planning**: Multiple perspectives surface tradeoffs
- **Quality assurance**: Mandatory checkpoints prevent mistakes
- **Evidence**: Screenshots and test results prove completion
- **Learning**: Session summaries improve future workflows

### To Skip Orchestration

If this is a simple task, you can:
- Prefix your prompt with `quick:` to bypass this warning
- Just proceed - this is only a suggestion

### Keywords Detected

The following pattern triggered this suggestion:
- Implementation verb + feature/component noun
