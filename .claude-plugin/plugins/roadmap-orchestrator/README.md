# Roadmap Orchestrator v3.3.0

A multi-agent orchestration plugin for Claude Code that implements repeatable, consistent workflows across any repository.

## Features

- **Three-Plan Competition**: Speed, Quality, and Safety planners generate competing approaches
- **Plan Judge**: Evaluates all plans with a weighted scoring matrix and synthesizes the best approach
- **Worktree Isolation**: Each feature runs in its own git worktree — concurrent sessions can't collide
- **Agent Teams Mode** (opt-in): Parallel implementation with file-ownership splitting
- **Automated Validation Gate**: Tests define "done" — no human checkpoints needed
- **OTEL Observability**: Pushes events to your OTEL collector (optional, graceful fallback)
- **Feature Detection Hook**: `UserPromptSubmit` hook nudges toward `/roadmap work` when feature prompts are detected
- **Evaluation Harness**: Compare vanilla vs orchestrated implementations empirically
- **Multi-Session Coordination**: Git-based claims prevent concurrent sessions picking the same feature

## Quick Start

```bash
# Start full orchestrated workflow
/roadmap work

# Check status (includes active claims)
/roadmap status

# Initialize workspace in a new project
/roadmap init

# View collected evidence
/roadmap evidence

# View/manage feature claims across sessions
/roadmap claims
```

## Workflow Phases

```
Phase 0: Claim Feature + Create Worktree             → commit: claim
    ↓
Phase 1: Generate 3 Competing Plans (parallel)
    ↓
Phase 2: Judge Selects Best Plan + Test Levels        → commit: plans
    ↓
Phase 2.5: TLA+ Design Verification (conditional)    → commit: .tla
    ↓
Phase 3: Generate Acceptance Tests (failing)          → commit: tests
    ↓
Phase 4: Implement (until acceptance tests pass)      → commit: implementation
    ↓
Phase 5: Automated Validation Gate                    → commit: evidence
    ↓
Phase 6: Architecture Update + Completion             → commit: docs
```

All phases from 1 onward run inside the worktree. The workspace (`.orchestrator/`) is created inside the worktree so each feature has isolated plans, evidence, and session state.

## Workspace Structure

Each worktree gets its own `.orchestrator/` directory (not under `.claude/` to avoid sensitive-path permission prompts):

```
<worktree>/.orchestrator/
├── current-task.md          # Active task context (gitignored)
├── orchestration.log        # Fallback event log (gitignored)
├── session-summary.md       # End-of-session report (gitignored)
├── plans/
│   └── [feature-id]/        # Feature-specific plans
│       ├── speed-plan.md
│       ├── quality-plan.md
│       ├── safety-plan.md
│       └── selected-plan.md
└── evidence/
    └── [feature-id]/        # Feature-specific evidence (committed)
        ├── test-results.md
        ├── validation.md
        └── screenshots/
```

Plans are copied to `docs/plans/[feature-id]/` when committed to git. Phase tracking uses native `TaskCreate`/`TaskUpdate`.

### What stays under `.claude/`

Only coordination state that must be shared across sessions:
- `.claude/roadmap-claims.json` — feature claims (committed to main)
- `.claude/worktrees/` — managed by `EnterWorktree`

## Agents

| Agent | Model | Focus | Output |
|-------|-------|-------|--------|
| `speed-planner` | sonnet | Fast delivery, minimal changes | `.orchestrator/plans/[id]/speed-plan.md` |
| `quality-planner` | sonnet | Code quality, maintainability | `.orchestrator/plans/[id]/quality-plan.md` |
| `safety-planner` | sonnet | Risk mitigation, rollback | `.orchestrator/plans/[id]/safety-plan.md` |
| `plan-judge` | opus | Evaluate and synthesize best approach | `.orchestrator/plans/[id]/selected-plan.md` |
| `orchestrator` | opus | Coordinate full workflow | Phase tracking via TaskCreate/TaskUpdate |

## Scoring Matrix (Plan Judge)

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Time to Delivery | 20% | How quickly can this be shipped? |
| Code Quality | 25% | Maintainability, patterns, clarity |
| Risk Level | 25% | Failure modes, rollback, safety |
| Maintainability | 15% | Long-term code health |
| Testing Strategy | 15% | Coverage, validation approach |

## Skills

| Skill | Purpose |
|-------|---------|
| `observability` | OTEL event patterns and Grafana integration |
| `automated-validation-gate` | Automated pass/fail validation gate |
| `agent-teams-implementation` | Agent Teams patterns for Phase 4 |
| `test-validation` | Automated testing integration |
| `roadmap-alignment` | Persona and duplication checking |
| `frontend-detection` | UI work detection and Playwright evidence |
| `roadmap-utilities` (shared) | Parse and update roadmap files |

## Feature Detection Hook

A `UserPromptSubmit` hook detects feature implementation prompts and suggests `/roadmap work`. Two-stage detection:

1. **Fast rejection** (<10ms): Filters out questions, bug fixes, refactors, docs, housekeeping, slash commands, and `quick:` prefixed prompts
2. **Positive signal**: Triggers on feature ID references (`feature-5`), roadmap mentions, or implementation verbs with substantial scope
3. **Roadmap correlation** (optional): Matches prompt text against current Priority:Now features by word overlap

The hook script lives at `hooks/roadmap-feature-detector.sh` and is registered in `settings.json` via a portable glob pattern. Prefix any prompt with `quick:` to bypass.

## Evaluation Harness

Compare vanilla Claude Code vs orchestrated implementations of the same roadmap feature:

```bash
# Dry run — shows what would execute
EVAL_DIR="$(ls -d ~/.claude/plugins/cache/*/roadmap-orchestrator/*/scripts 2>/dev/null | tail -1)"
bash "$EVAL_DIR/eval-harness.sh" --feature feature-5 --roadmap ./roadmap.md --dry-run

# Full evaluation
bash "$EVAL_DIR/eval-harness.sh" --feature feature-5 --roadmap ./roadmap.md
```

The harness:
1. Parses feature description and DoD from the roadmap
2. Runs a vanilla session (plugins disabled, hooks cleared)
3. Runs an orchestrated session (`/roadmap work`)
4. Collects metrics from both worktrees (LOC, commits, validation, evidence)
5. Creates PRs for both implementations
6. Runs an evaluator session that scores both across 7 dimensions
7. Writes a report to `.orchestrator/eval-reports/`

## OTEL Integration

Events are pushed to your OTEL collector at `localhost:4317`.

**OTEL is optional.** If the SDK isn't installed, events are written to `.orchestrator/orchestration.log` as JSON lines. The orchestrator works fully without OTEL.

### Prerequisites (Optional)

```bash
pip install opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp-proto-grpc
```

### Event Types

| Event | Description |
|-------|-------------|
| `orchestration.task.start` | Task begins |
| `orchestration.task.end` | Task completes |
| `orchestration.agent.spawn` | Sub-agent launched |
| `orchestration.agent.complete` | Sub-agent finished |
| `orchestration.plan.selected` | Judge selected plan |
| `orchestration.validation_gate` | Validation gate result |
| `orchestration.evidence.collected` | Evidence artifact saved |
| `orchestration.feature.claimed` | Feature claimed |
| `orchestration.feature.claim_released` | Claim released |

## Multi-Session Coordination

When multiple sessions run `/roadmap work` simultaneously, claims prevent duplicate work using git push atomicity:

1. Session writes a claim to `.claude/roadmap-claims.json` on main
2. Commits and pushes — `git push` is the atomic serialization point
3. On push failure, pulls and picks the next unclaimed feature
4. On completion or abort, releases the claim automatically

Claims have a configurable TTL (default 24h). Stale claims are reaped during the next `claim-feature` operation.

## Plugin Structure

```
roadmap-orchestrator/
├── plugin.json
├── README.md
├── agents/
│   ├── orchestrator.md       # Main workflow coordinator
│   ├── speed-planner.md
│   ├── quality-planner.md
│   ├── safety-planner.md
│   └── plan-judge.md
├── commands/
│   └── roadmap.md            # /roadmap slash command
├── hooks/
│   ├── roadmap-feature-detector.sh  # UserPromptSubmit hook
│   ├── block-commit-on-*.json       # Pre-commit quality gates
│   └── verify-after-subagent.json
├── scripts/
│   ├── setup-workspace.sh    # Initialize .orchestrator/
│   ├── emit_otel.py          # OTEL event emission
│   ├── eval-harness.sh       # Vanilla vs orchestrated comparison
│   ├── collect-metrics.sh    # Gather metrics from worktrees
│   └── evaluator-prompt.md   # Structured evaluator template
├── shared-utilities/
│   ├── scripts/              # roadmap_ops.py, validation_ops.py, evidence_ops.py
│   ├── skills/               # Utility skills for roadmap/validation/evidence
│   └── hooks/                # Enforcement hooks
├── skills/
│   ├── automated-validation-gate.md
│   ├── agent-teams-implementation.md
│   ├── frontend-detection.md
│   ├── observability.md
│   ├── roadmap-alignment.md
│   ├── test-validation.md
│   ├── type-change-protocol.md
│   └── formal-verification-gateway.md
└── examples/
    └── hookify.smart-orchestration.local.md
```

## Agent Teams Mode (Experimental)

Phase 4 supports opt-in parallel implementation via Agent Teams. Enable with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in env and `USE_AGENT_TEAMS=true` in orchestrator config.

Best for features touching 5+ files across distinct modules with clean ownership boundaries. Not recommended for small features or tightly coupled code.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_VALIDATION_RETRIES` | 3 | Max Phase 4/5 cycles before abort |
| `MAX_PLANNER_RETRIES` | 1 | Max retries per planner if file missing |
| `MIN_PLANS_REQUIRED` | 2 | Minimum plans needed to proceed |
| `COMMIT_EVIDENCE` | true | Whether to git commit evidence artifacts |
| `CLAIM_TTL_HOURS` | 24 | Hours before an inactive claim is stale |
| `CLAIM_MAX_RETRIES` | 3 | Max push retries on claim race condition |
| `USE_AGENT_TEAMS` | false | Enable Agent Teams for Phase 4 |
| `MAX_IMPLEMENTATION_TEAMMATES` | 3 | Max parallel teammates |
| `TEAMMATE_MODEL` | sonnet | Model for implementation teammates |

## Version History

- **v3.3.0** - Multi-session claims, `.orchestrator/` workspace (moved from `.claude/workspace/`), feature detection hook, evaluation harness, worktree-isolated workspace
- **v3.2.0** - Agent Teams mode for Phase 4 (opt-in, experimental)
- **v3.1.0** - Native TaskCreate/TaskUpdate, consolidated skills, OTEL phase conventions
- **v3.0.0** - Autonomous orchestration: removed human checkpoints, Test Level Matrix, automated validation gate
- **v2.0.0** - Three-plan competition, checkpoints, OTEL, session summaries
- **v1.0.0** - Basic orchestrator with roadmap parsing
