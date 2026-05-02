---
name: roadmap
description: Orchestrate autonomous multi-agent workflows with three-plan competition and automated validation
arguments:
  - name: action
    description: "Action: status, plan, work, autopilot, init, migrate, evidence, or claims"
    required: false
    default: "work"
---

# Roadmap Orchestration v2.0

You are starting a roadmap orchestration session with the enhanced orchestrator.

## Action: $ARGUMENTS.action

{{#if (eq $ARGUMENTS.action "status")}}
## Status Check

Analyze the project roadmap and workspace status:

### 1. Roadmap Progress
Find the roadmap file (typically `*roadmap*.md`) and report:
- Overall progress (completed vs total tasks)
- Features in "Priority: Now" status
- Features ready to start (dependencies met)
- Blocked features (waiting on dependencies)

### 2. Orchestration Status
Check native task tracking (via `TaskList`/`TaskGet`):
- Current phase (which phase task is `in_progress`)
- Active orchestration task (if any)
- Last session summary

### 3. Orchestration Health
- Check if workspace is initialized
- Verify architecture exists at `docs/ARCHITECTURE.md`
- Report any stale evidence

### 4. Feature Claims
Check `.claude/roadmap-claims.json` for active claims across sessions:
```bash
ROADMAP_OPS="python3 ~/.claude/plugins/local/shared-utilities/scripts/roadmap_ops.py"
$ROADMAP_OPS list-claims --claims-file .claude/roadmap-claims.json --status=active
```

Report:
- Active claims (feature, session, claimed_at)
- Stale claims (past TTL with no branch activity)
- Recently completed/abandoned claims

Do NOT start any implementation work - just analyze and report.

{{else if (eq $ARGUMENTS.action "plan")}}
## Planning Mode

Analyze the roadmap and create an execution plan:

1. **Parse roadmap** - Extract all features and dependencies
2. **Identify critical path** - Determine minimum time to completion
3. **Find parallelizable work** - What can be done simultaneously
4. **Estimate effort** - Based on feature complexity
5. **Present plan** - Show proposed sequence and timing

This mode does NOT trigger the three-plan competition.
Use `/roadmap work` to start full orchestration with competing plans.

{{else if (eq $ARGUMENTS.action "init")}}
## Initialize Workspace

Set up the orchestration workspace for this project:

### 1. Create Directory Structure
```bash
~/.claude/plugins/local/roadmap-orchestrator/scripts/setup-workspace.sh
```

### 2. Generate Architecture Documentation

**Create architecture at `docs/ARCHITECTURE.md`** (git-tracked location):
- Project overview
- Key components and their relationships
- Directory structure explanation
- Patterns and conventions used
- **Changelog section** for tracking architectural changes per feature

```bash
mkdir -p docs
```

### 3. Configure Evidence Folder
Ensure `.orchestrator/evidence/` is gitignored:
```
# In .gitignore
.orchestrator/evidence/screenshots/*
.orchestrator/orchestration.log
.orchestrator/session-summary.md
```

### 4. Auto-Migrate Legacy Architecture
If `.claude/workspace/architecture.md` exists but `docs/ARCHITECTURE.md` does not:
```bash
mkdir -p docs
cp .claude/workspace/architecture.md docs/ARCHITECTURE.md
echo "Migrated architecture to docs/ARCHITECTURE.md"
```

### 5. Verify Setup
Report what was created and any issues found.

{{else if (eq $ARGUMENTS.action "migrate")}}
## Migrate Architecture Documentation

Migrate architecture from legacy `.claude/workspace/architecture.md` to `docs/ARCHITECTURE.md`.

### Steps to Perform

1. **Check current state**:
   - Does `.claude/workspace/architecture.md` exist? (legacy)
   - Does `docs/ARCHITECTURE.md` exist? (current)

2. **Perform migration** (if legacy exists but new doesn't):
   ```bash
   mkdir -p docs
   cp .claude/workspace/architecture.md docs/ARCHITECTURE.md
   ```
   - Add a Changelog section if not present
   - Remove the legacy file

3. **Verify migration**:
   - Read `docs/ARCHITECTURE.md` to confirm content
   - Report results

{{else if (eq $ARGUMENTS.action "evidence")}}
## View Evidence

Display collected evidence from the current or most recent task:

### 1. Test Results
Show contents of `.orchestrator/evidence/test-results.md`

### 2. Screenshots
List files in `.orchestrator/evidence/screenshots/`

### 3. Validation Status
Show contents of `.orchestrator/evidence/validation.md`

### 4. Session Summary
Show contents of `.orchestrator/session-summary.md` if exists

{{else if (eq $ARGUMENTS.action "autopilot")}}
## Autopilot — dispatch the next eligible phases

Autopilot is an idempotent dispatcher. It reads `.orchestrator/config.yaml` for `MAX_PARALLEL_SESSIONS` (default 2) and `MAX_PHASE_FAILURES` (default 3), counts active non-stale claims, and launches detached `claude -p` sessions for up to the remaining slot count across eligible phases in roadmap order. Completed phases are skipped. Phases whose dependencies are not yet complete are skipped. Phases exceeding the failure ceiling are skipped.

**Run once, or wrap in a loop** — this command is designed to be called repeatedly. Each fire is short (seconds), and the spawned `claude -p` sessions run independently in the background.

### Your steps

1. **Locate the autopilot script**:
   ```bash
   AUTOPILOT="$(ls ~/.claude/plugins/cache/*/roadmap-orchestrator/*/scripts/autopilot.py 2>/dev/null | tail -1)"
   if [ -z "$AUTOPILOT" ]; then
     AUTOPILOT="$HOME/Documents/claude-config/plugins/roadmap-orchestrator/scripts/autopilot.py"
   fi
   ```

2. **Check for pause sentinel**. If `.orchestrator/autopilot.paused` exists, report "autopilot is paused" and stop. To resume, the user runs `rm .orchestrator/autopilot.paused`.

3. **Run the dispatcher**:
   ```bash
   python3 "$AUTOPILOT" --repo-root "$(pwd)"
   ```
   Capture the output; it will indicate either `dispatched N` or `at cap` or `no eligible phases`.

4. **Report to the user**:
   - Which phases were dispatched (if any)
   - Which phases are currently running (active, non-stale claims)
   - Which phases are blocked by dependencies, listing the blockers
   - Which phases are skipped due to the failure ceiling
   - Total roadmap progress: `X/N phases completed`

5. **If no eligible phases remain and no active claims**: report "roadmap complete" — the project is done.

6. **Do NOT invoke `/roadmap work` yourself** — autopilot spawns its own headless sessions. Your job is dispatch + report, not execution.

### Continuous mode

For hands-off operation, the user should wrap this command in `/loop`:
- `/loop 10m /roadmap autopilot` — fires every 10 minutes, dispatching up to the parallel cap each time.
- `/loop /roadmap autopilot` — self-paced; you decide when to re-fire via `ScheduleWakeup` based on expected phase duration (typical: 20–40 minutes per phase, so 15-minute cadence is reasonable).

Alternative: add a cron entry outside of claude:
```
*/10 * * * * cd /path/to/fabrick && python3 /path/to/autopilot.py >> .orchestrator/autopilot.log 2>&1
```

### Safety model

- Claims file coordination is race-free (fcntl flock via `local_claim_ops.py`).
- Each spawned session works in its own worktree — no file collisions.
- A phase that exhausts `MAX_VALIDATION_RETRIES` in the orchestrator gets a failure counter bump from autopilot on next fire; after `MAX_PHASE_FAILURES` (default 3), it's quarantined. Clear with `rm .claude/roadmap-failures.json` or edit the counter.
- Pause with `touch .orchestrator/autopilot.paused`; resume with `rm`.

{{else if (eq $ARGUMENTS.action "claims")}}
## Feature Claims

View and manage feature claims across concurrent sessions.

```bash
ROADMAP_OPS="python3 ~/.claude/plugins/local/shared-utilities/scripts/roadmap_ops.py"
```

### 1. Active Claims
```bash
$ROADMAP_OPS list-claims --claims-file .claude/roadmap-claims.json --status=active
```

Display each active claim: feature ID, title, session ID, claimed_at, branch, and whether it appears stale (past TTL).

### 2. Stale Claim Detection
For each claim marked `is_stale: true`:
- Check if the remote branch exists and has recent commits:
  ```bash
  git fetch origin
  git log --oneline -1 --since="24 hours ago" origin/feature/[feature-id] 2>/dev/null
  ```
- If branch has recent activity: claim is NOT truly stale (session is still working)
- If no recent activity or branch doesn't exist: claim can be safely released

### 3. Manual Release (if requested)
To release an abandoned claim:
```bash
$ROADMAP_OPS release-claim [feature-id] [session-id] \
  --claims-file .claude/roadmap-claims.json --status=abandoned
git add .claude/roadmap-claims.json
git commit -m "chore: release claim on [feature-id] (abandoned)"
git push origin main
```

### 4. All Claims History
```bash
$ROADMAP_OPS list-claims --claims-file .claude/roadmap-claims.json --status=completed
$ROADMAP_OPS list-claims --claims-file .claude/roadmap-claims.json --status=abandoned
```

{{else}}
## Work Mode - Full Autonomous Orchestration

You are starting the **full orchestrated workflow** with:
- Three competing plans (Speed, Quality, Safety)
- Automated plan selection by the judge (no human checkpoint)
- Acceptance tests as the definition of "done"
- Automated validation gate (no human checkpoint)
- Comprehensive observability via OTEL + git commits

### Headless operation rules (MUST READ)

This command runs in `claude -p` whenever invoked by autopilot. There is no human attached. Two behaviours that feel safe in interactive mode are bugs here, and they have caused autopilot to silently lose entire phases. Obey throughout every step:

1. **Never ask a question.** Do not call `AskUserQuestion`. Do not end a turn with "Options 1/2/3 — which do you want?" or any prompt expecting a reply. Headless sees no further input and exits with the question as its final output, leaving the feature half-claimed and autopilot to retry the same trap on the next cycle. When ambiguity arises, pick the safer default and write a one-line note about the choice into the parent task description (`TaskUpdate`). If truly blocking with no safe default, abort via the standard path (release the claim, mark the task `completed` with a failure summary). Do not leave a question dangling. **This rule overrides any contrary instinct elsewhere in this prompt — including the "Ask for clarification if unclear" sub-bullet below; treat that sub-bullet as deleted.**

2. **Coordination is file-based, not process-based.** The only authority for "is feature X already being worked on" is (a) an entry in `.claude/roadmap-claims.json` with `status: "active"` and a non-stale `claimed_at`, plus (b) the existence of `feature/[feature-id]` on the remote (skipped when `LOCAL_ONLY=true`). Do not run `ps`, `pgrep`, `lsof`, or any process inspection to detect "competing" sessions. Autopilot routinely spawns multiple `claude -p` orchestrators in parallel; finding another `claude -p` process — including one running with the same feature ID — does **not** indicate a collision. **Your own process will appear in any `pgrep claude` output. Do not interpret your own PID as a competitor and exit.** If two sessions race to claim the same feature, the file-locked claim writer (fcntl) makes one of them lose at the commit/push step, and step 1b's retry logic handles it. The race is already handled — your job is to claim, not to police.

### Workflow Overview

```
Phase 0: Initialize Workspace + Worktree          → commit
    ↓
Phase 1: Generate 3 Competing Plans (parallel)
    ↓
Phase 2: Judge Selects Best Plan + Test Levels    → commit: plans
    ↓
Phase 3: Generate Acceptance Tests (failing)       → commit: tests
    ↓
Phase 4: Implement (until acceptance tests pass)   → commit: implementation
    ↓
Phase 5: Automated Validation Gate                 → commit: evidence
    ↓
Phase 6: Architecture + Roadmap Update + PR        → commit: docs + roadmap, push + PR
```

### Your Immediate Actions

1. **Find the task** (claim-aware selection)
   - If the invocation includes an explicit feature id (e.g. `Run /roadmap work 0.4`): that is your feature. Proceed to step 1b — do **not** re-derive it, do **not** second-guess it, do **not** check whether other processes are working on it.
   - Otherwise (no explicit id): identify the next "Priority: Now" item that is:
     - Not yet complete (has unchecked tasks)
     - Not claimed by another session — `status: "active"` and non-stale in `.claude/roadmap-claims.json`
     - Does not already have a remote branch (`git branch -r --list "origin/feature/[feature-id]"`; skip in `LOCAL_ONLY` mode)
   - **Do not pgrep / ps / lsof for competitors.** See the *Headless operation rules* above. Other `claude -p` processes are expected, not collisions.

1b. **Claim the feature** (roadmap-sourced tasks only, FULLY AUTOMATED — no user approval needed)
   - Write claim via `$ROADMAP_OPS claim-feature`
   - Commit `.claude/roadmap-claims.json` to main and push immediately without asking for confirmation
   - On push failure (race): pull --rebase, re-check claims, pick next unclaimed feature
   - See orchestrator Phase 0 step 5 for full protocol

2. **Initialize workspace + worktree**
   - Create/verify architecture at `docs/ARCHITECTURE.md` (auto-migrates from legacy location if needed)
   - Create orchestration tasks via `TaskCreate` (parent + Phase 0)
   - Create worktree via the built-in `EnterWorktree` tool (non-interactive, no user prompts)
   - Run setup script **inside the worktree** (not the main repo)
   - Create `current-task.md` inside the worktree with task details

3. **Launch three planners IN PARALLEL**
   Use the Task tool to spawn all three simultaneously:
   - `speed-planner` → writes to `.orchestrator/plans/[feature-id]/speed-plan.md`
   - `quality-planner` → writes to `.orchestrator/plans/[feature-id]/quality-plan.md`
   - `safety-planner` → writes to `.orchestrator/plans/[feature-id]/safety-plan.md`

4. **Launch judge**
   After all three plans are complete:
   - Spawn `plan-judge` to evaluate, select, and produce Test Level Matrix
   - Judge writes to `.orchestrator/plans/[feature-id]/selected-plan.md`
   - Commit all plans to `docs/plans/[feature-id]/`

5. **Generate acceptance tests**
   - Extract criteria + test levels from judge's output
   - Generate failing test files at the correct levels
   - Commit acceptance tests

6. **Implement autonomously**
   - Coordinate appropriate agents
   - Run only acceptance tests for fast feedback
   - Make regular commits
   - Continue until all acceptance tests pass

7. **Automated validation gate**
   - Run full validation (`$VALIDATION_OPS full-check`)
   - Collect evidence
   - Automated pass/fail decision
   - Max 3 retries, then abort

8. **Complete**
   - Update architecture docs
   - Update roadmap checkboxes based on what was actually implemented
   - Push branch and create PR (includes implementation + roadmap updates)
   - Release claim, generate session summary
   - Present final report with PR URL and git audit trail

### Important Rules

- **No human checkpoints** - Judge decides, tests validate, gate passes/fails
- **Tests are the contract** - Acceptance tests define "done"
- **Auditable via git** - Every phase boundary produces a commit
- **Always collect evidence** - Tests, screenshots, validation
- **Track progress via native tasks** - Use TaskCreate/TaskUpdate for phase tracking
- **Emit OTEL events** - For observability
- **Fail fast** - After 3 validation retries, abort with committed evidence

### Cross-Plugin Integration

During implementation, use these as needed:
- `testing:test-writer` - Generate acceptance + additional tests
- `feature-dev:code-explorer` - Understand existing code
- `feature-dev:code-architect` - Design complex features
- `feature-dev:code-reviewer` - Review implementations
- `frontend-design` skill - UI implementation
- `product-roadmap-refiner` skill - Persona alignment

{{/if}}

---

Begin by analyzing the current state and proceeding with the appropriate workflow.
