---
name: agent-teams-implementation
description: |
  Agent Teams patterns for parallel implementation in Phase 4. Covers file-ownership splitting, teammate spawning, interface change messaging, delegate mode, and quality gate hooks. Requires CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1.
---

# Agent Teams Implementation

## Overview

This skill documents the patterns for using Claude Code's Agent Teams feature during Phase 4 (Implementation) of the orchestrated workflow. Agent Teams mode spawns parallel teammates that each own distinct files, communicate about interface changes, and work toward passing their acceptance tests.

**When to use**: `USE_AGENT_TEAMS=true` in the orchestrator Configuration.

**When NOT to use**: Tasks where most files depend on each other sequentially, single-file changes, or tasks where coordination overhead exceeds the parallelism benefit.

---

## Prerequisites

Enable Agent Teams in settings.json or environment:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

---

## File-Ownership Splitting Strategy

The key to Agent Teams mode is ensuring **no two teammates edit the same file**. File conflicts cause overwrites and wasted work.

### Splitting Algorithm

1. **List all files** from the selected plan's implementation steps
2. **Build a dependency graph** — which files import from which
3. **Cluster by imports** — files that import each other form a group
4. **Cap groups** at `MAX_IMPLEMENTATION_TEAMMATES` — merge the smallest groups if over the limit
5. **Identify interface boundaries** — for each group, list exports that other groups consume

### Example Split

For a feature adding user authentication:

```markdown
### Group 1: Auth Core (teammate-auth)
- **Files**: src/auth/service.ts, src/auth/types.ts, src/auth/utils.ts
- **Exports**: `AuthService`, `AuthToken`, `validateToken()`
- **Consumers**: Group 2 (API routes), Group 3 (UI components)
- **Acceptance tests**: #1 (token validation), #2 (session creation)

### Group 2: API Layer (teammate-api)
- **Files**: src/api/auth-routes.ts, src/api/auth-middleware.ts
- **Exports**: `/api/login`, `/api/logout` endpoints
- **Consumers**: Group 3 (UI form submission)
- **Acceptance tests**: #3 (login endpoint), #4 (middleware rejection)

### Group 3: Frontend (teammate-ui)
- **Files**: src/components/LoginForm.tsx, src/components/AuthProvider.tsx
- **Exports**: `<LoginForm>`, `<AuthProvider>`
- **Consumers**: none (leaf)
- **Acceptance tests**: #5 (form renders), #6 (auth flow e2e)
```

### Edge Cases

| Situation | Resolution |
|-----------|-----------|
| Shared config file (e.g., `config.ts`) | Assign to the group that defines it; others import read-only |
| Test helper used by multiple groups | Assign to the first group that creates it; others import |
| Single file that's too large to split | Assign to one teammate; other groups work against planned interface |
| Only 1-2 files total | Don't use Agent Teams — fall back to Subagent Mode |

---

## Teammate Spawn Prompt Template

Each teammate receives a detailed prompt at spawn time:

```
You are implementing part of feature [feature-id] as a member of an agent team.

## Your File Ownership
You own ONLY these files (create or modify):
- [file1.ts]
- [file2.ts]

Do NOT modify any files outside this list. If you need a change in another
file, message the teammate who owns it.

## Your Acceptance Tests
Run these after each change to verify your work:
[test command for your specific test files]

Your criteria: [list the DoD items this teammate is responsible for]

## Interface Contract

### You EXPORT (other teammates depend on these):
- `functionName()` → used by teammate-api
- `TypeName` → used by teammate-api, teammate-ui

### You IMPORT (provided by other teammates):
- `otherFunction()` from teammate-auth (file: src/auth/service.ts)

If you change any EXPORT signature, you MUST message affected teammates
immediately with the exact change.

## Context
- Selected plan: docs/plans/[feature-id]/selected-plan.md
- Architecture: docs/ARCHITECTURE.md
- Your implementation steps: [relevant steps from selected plan]

## Rules
1. Plan first (plan approval required) — explain your approach before coding
2. Only modify YOUR files
3. Commit regularly: feat/fix/refactor: [description]
4. Run your acceptance tests after each change
5. Message teammates about interface changes
6. Do NOT run full-check — only your acceptance tests
```

---

## Interface Change Messaging Protocol

When a teammate changes an exported function signature, type, or API endpoint:

### Teammate sends:
```
Message [affected-teammate]: "Interface change: `createSession()` return type
changed from `string` to `SessionToken` (defined in src/auth/types.ts).
Update your imports. The new type has fields: { token: string, expiresAt: Date }"
```

### Affected teammate responds:
```
Message [original-teammate]: "Acknowledged. Updated my usage of createSession()
in src/api/auth-routes.ts. Tests passing."
```

### Lead monitors:
The lead (in delegate mode) watches for interface change messages. If a change isn't acknowledged within a reasonable time, the lead nudges the affected teammate.

---

## Delegate Mode

The orchestrator lead operates in **delegate mode** during Phase 4A:

### What the lead CAN do:
- Spawn and shut down teammates
- Message teammates (guidance, interface relay, nudges)
- Review and approve/reject teammate plans
- Monitor the shared task list
- Broadcast messages to all teammates

### What the lead CANNOT do:
- Edit files directly
- Run tests directly
- Make commits
- Use code-writing tools

### Entering delegate mode:
After spawning teammates, press Shift+Tab to cycle into delegate mode.

### Exiting delegate mode:
When all teammates are done and the team is cleaned up, the lead exits delegate mode to proceed with Phase 5.

---

## Quality Gate Hooks

### TaskCompleted Hook

Runs when a teammate marks a task as complete. Verifies acceptance tests pass before allowing completion.

```bash
# Hook checks that the teammate's acceptance tests pass
# Exit code 0: allow completion
# Exit code 2: reject completion with feedback

# Example hook logic (conceptual):
# 1. Identify which acceptance tests belong to this task
# 2. Run those tests
# 3. If any fail, exit 2 with "Tests failing: [details]"
# 4. If all pass, exit 0
```

Configure in your project's hooks:
```json
{
  "hooks": {
    "TaskCompleted": [
      {
        "matcher": ".*",
        "command": "echo 'Task completed - verify tests manually or via CI'"
      }
    ]
  }
}
```

### TeammateIdle Hook

Runs when a teammate finishes its current work and is about to go idle. Use to assign remaining tasks.

```json
{
  "hooks": {
    "TeammateIdle": [
      {
        "matcher": ".*",
        "command": "echo 'Check shared task list for unclaimed work'"
      }
    ]
  }
}
```

---

## When to Fall Back to Subagent Mode

Agent Teams mode should fall back to Subagent Mode (Phase 4B) when:

| Condition | Action |
|-----------|--------|
| Only 1-2 files to modify | Use subagents — team overhead not justified |
| Files are tightly coupled (every file imports every other) | Use subagents — can't split cleanly |
| Multiple teammates fail and can't recover | Switch to subagents for remaining work |
| Feature is mostly sequential (step B needs step A's output) | Use subagents — parallelism won't help |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` not enabled | Subagent mode is the only option |

---

## OTEL Events for Agent Teams

Additional events emitted during Agent Teams mode:

```bash
# Team created
python3 emit_otel.py team.created \
  --attr feature_id=[id] \
  --attr teammate_count=[N] \
  --attr teammate_model=[model]

# Teammate plan approved/rejected
python3 emit_otel.py teammate.plan_review \
  --attr teammate=[name] \
  --attr result=[approved|rejected] \
  --attr feature_id=[id]

# Interface change communicated
python3 emit_otel.py teammate.interface_change \
  --attr from_teammate=[name] \
  --attr to_teammate=[name] \
  --attr export_changed=[function/type name]

# Teammate completed its group
python3 emit_otel.py teammate.group_complete \
  --attr teammate=[name] \
  --attr tests_passed=[N] \
  --attr files_changed=[N]

# Team cleaned up
python3 emit_otel.py team.cleanup \
  --attr feature_id=[id] \
  --attr total_teammates=[N] \
  --attr successful_teammates=[N]
```

---

## Comparison: Agent Teams vs Subagent Mode

| Aspect | Subagent Mode (4B) | Agent Teams Mode (4A) |
|--------|-------------------|----------------------|
| **Parallelism** | Limited — subagents report back to lead | Full — teammates work independently |
| **Communication** | Results only flow back to lead | Teammates message each other directly |
| **File safety** | Lead coordinates all edits | File-ownership prevents conflicts |
| **Token cost** | Lower | Higher (each teammate is a separate instance) |
| **Best for** | Small-medium features, tightly coupled code | Large features with clean file boundaries |
| **Recovery** | Lead retries failed subagent | Lead spawns replacement teammate |
| **Lead role** | Active implementer + coordinator | Delegate mode — coordination only |

---

## Limitations

- **Experimental** — Agent Teams is behind a feature flag and has known issues
- **No session resumption** — if the lead crashes, teammates are lost
- **No nested teams** — teammates cannot spawn their own teams
- **One team per session** — can't run multiple features in parallel with teams
- **Split panes need tmux/iTerm2** — in-process mode works in any terminal
- **File conflicts** — if file-ownership splitting fails, teammates will overwrite each other
- **Higher token cost** — each teammate is a separate Claude instance with its own context window
