# Local + Phased-Roadmap Mode

Guide for running the orchestrator against a phased roadmap (e.g. Fabrick) with no remote, no PRs, and parallel sessions.

## Activation

Drop a `.orchestrator/config.yaml` at the repo root of the target repo:

```yaml
LOCAL_ONLY: true
CREATE_PRS: false
CLAIM_BACKEND: local-flock
ROADMAP_FORMAT: phased
SPEC_DRIVEN_DOD: true
FITNESS_GATE: true
PORT_BOUNDARY_CHECK: true
```

The orchestrator reads this file during Phase 0 and overrides its defaults (see the Configuration resolution section in `agents/orchestrator.md`).

## What changes in each phase

| Phase | Standard mode | Local + phased mode |
| ----- | ------------- | ------------------- |
| 0 — Claim | `roadmap_ops.py claim-feature` + `git push origin main` | `local_claim_ops.py claim` (flock, local commit only) |
| 0 — List claims | `roadmap_ops.py list-claims` | `local_claim_ops.py list --repo .` |
| 1 — Plans | Pass architecture.md to planners | Also pass `phased_roadmap_parser.py` output (spec FRs + port list) and `technical-choices.md` |
| 3 — Acceptance tests | Extract DoD checkboxes from roadmap | Extract FRs from spec + spec DoD; roadmap DoD is tertiary |
| 5 — Validation | `$VALIDATION_OPS full-check` | Also `make fitness` (architecture + bench + alerts); fail-closed on any |
| 6c — PR | `git push -u origin HEAD` + `gh pr create` | `git -C $MAIN merge --no-ff $FEATURE_BRANCH` + `git worktree remove` + `git branch -d` |
| 6d — Release | `release-claim` + `git push origin main` | `local_claim_ops.py release` (flock, local commit only) |

Both scripts read and write the same flat-dict schema in `.claude/roadmap-claims.json`. Pick the one matching the active mode; do not mix within a single repo.

## Inspecting claim state

```bash
# Local mode — works regardless of which script wrote the claim:
python3 ~/.claude/plugins/roadmap-orchestrator/scripts/local_claim_ops.py list --repo .

# Filter by status:
python3 ~/.claude/plugins/roadmap-orchestrator/scripts/local_claim_ops.py list --repo . --status active
```

Output is a JSON array, one record per feature — same shape `roadmap_ops.py list-claims` returns, so downstream `jq` pipelines work either way.

## Backfilling completed phases from roadmap markers

If you finished a phase manually (outside the orchestrator), autopilot won't know unless `.claude/roadmap-claims.json` records it as `status: "completed"`. Mark the heading in `docs/roadmap.md` with `**[Implemented — YYYY-MM-DD]**` and run:

```bash
python3 ~/.claude/plugins/roadmap-orchestrator/scripts/local_claim_ops.py sync-from-roadmap --repo .
```

This promotes every marker to a completed claim under the same `fcntl` lock that `claim`/`release` use, commits the change to local main, and is idempotent (no second commit when nothing changed). Active claims are left alone — sync refuses to clobber them.

To run the sync automatically before each autopilot dispatch, pass `--sync-roadmap-markers`:

```bash
python3 ~/.claude/plugins/roadmap-orchestrator/scripts/autopilot.py --sync-roadmap-markers
```

## Autopilot — hands-off continuous dispatch

The heaviest piece of ergonomics. A loop that orchestrates the orchestrator so you don't monitor phases one at a time.

### What autopilot does

Each fire of `/roadmap autopilot` (or the underlying `scripts/autopilot.py`):

1. Reads `.orchestrator/config.yaml` for `MAX_PARALLEL_SESSIONS` (default 2) and `MAX_PHASE_FAILURES` (default 3).
2. Reads `.claude/roadmap-claims.json` to count active, non-stale claims.
3. Walks `docs/roadmap.md`, identifying eligible phases by filtering out: completed, actively-claimed, dependency-blocked, and failure-quarantined phases.
4. Applies the **major-phase-ordering rule**: a phase `N.x` with `N > 0` implicitly requires all `M.y` phases where `M < N` to be completed. This keeps Phase 1 from jumping ahead of Phase 0 even if sub-phase dependencies aren't declared inline in the roadmap.
5. For up to `(MAX_PARALLEL_SESSIONS - active_count)` eligible phases in roadmap order, launches a detached `claude -p "Run /roadmap work <phase>"` session.
6. Logs to `.orchestrator/autopilot.log` and exits.

Each spawned session runs the full `/roadmap work` flow in its own worktree: three-plan competition, judge, acceptance tests, implementation, fitness gate, local merge. When it completes, it releases its claim. Next autopilot fire picks up the next eligible phase.

### Three ways to run it

**Manual (ad-hoc dispatch):**
```
> /roadmap autopilot
```
One-shot. Fills up to the cap, reports what's running, exits.

**Claude self-driving loop:**
```
> /loop 15m /roadmap autopilot
```
Fires every 15 minutes while claude is open. Good for a session you're leaving running. Exit the loop with Ctrl-C or let the session close.

**Cron (truly unattended):**
```cron
*/10 * * * * cd /path/to/fabrick && python3 /path/to/autopilot.py >> .orchestrator/autopilot.log 2>&1
```
Runs every 10 minutes regardless of whether a claude session is open. Each spawned `claude -p` completes independently. This is the most robust mode.

### Failure quarantine

If a phase reaches `MAX_VALIDATION_RETRIES` (default 3) inside the orchestrator, the orchestrator releases its claim with `status=abandoned`. The autopilot's companion counter file `.claude/roadmap-failures.json` tracks how many times each phase has failed. Once a phase hits `MAX_PHASE_FAILURES` (default 3), autopilot stops retrying it. To re-enable:

```bash
# Clear all counters (nuclear option):
rm .claude/roadmap-failures.json

# Or edit the counter for a specific phase:
python3 -c "import json; c=json.load(open('.claude/roadmap-failures.json')); c.pop('0.4', None); open('.claude/roadmap-failures.json','w').write(json.dumps(c,indent=2))"
```

### Pause and resume

```bash
touch .orchestrator/autopilot.paused   # no more dispatches
rm .orchestrator/autopilot.paused      # resume
```
Already-running sessions are not affected — they finish their current phase. Pausing only blocks new dispatches.

### Typical user flow

1. Author the roadmap + specs in `docs/`.
2. Drop `.orchestrator/config.yaml` with local + phased mode.
3. Run `claude` and invoke `/roadmap autopilot` once — see 2 phases dispatched.
4. Either wrap in `/loop 15m /roadmap autopilot` or add a cron entry.
5. Walk away.
6. Come back in the morning. Check `.orchestrator/autopilot.log` for dispatch history, `git log main` for merged phases, `.claude/roadmap-claims.json` for current state.

---

## Parallel sessions

Safety is ensured by three locks:

1. **Worktree isolation** — each session's `.orchestrator/` is inside its own worktree, so plans, evidence, task files, and current-task.md never collide.
2. **Claim flock** — `local_claim_ops.py` holds `fcntl.LOCK_EX` on `$REPO/.git/fabric-claims.lock` around every read-modify-write of `.claude/roadmap-claims.json`. Serialises all claim reads and writes across sessions.
3. **Git index lock** — git itself serialises concurrent commits to main via `.git/index.lock`. Combined with the flock above, this guarantees no lost-update on the claims file.

### Launching parallel sessions

Three ways:

**Manual (one terminal per session):**
```bash
# Terminal 1
cd ~/code/fabrick && claude
> /roadmap work 0.1

# Terminal 2 (concurrent)
cd ~/code/fabrick && claude
> /roadmap work 0.4

# Terminal 3 — auto-pick next unclaimed
cd ~/code/fabrick && claude
> /roadmap work
```

**Scripted (launch N sessions at once):**
```bash
./scripts/launch-parallel.sh 0.1 0.4 0.5
```

Each session:
1. Reads `.orchestrator/config.yaml`
2. Claims its target phase (or the first unclaimed one, checking dependencies)
3. Enters a per-phase worktree
4. Runs the full orchestration loop
5. On completion: local-merges to main, releases claim

### Dependency-aware auto-selection

When `/roadmap work` is invoked without a phase argument, the orchestrator must:

1. Call `phased_roadmap_parser.py` for each unfinished phase to get its `depends_on` list.
2. Filter to phases whose dependencies are all `completed` in the claims file.
3. Among those, pick the first with status `active` (not claimed) and no existing worktree.

The orchestrator should NOT claim a phase whose dependencies aren't complete, even if nobody else has claimed it.

## Fitness gate integration

`FITNESS_GATE=true` adds three commands to Phase 5 validation:

```bash
make fitness/architecture   # importlinter — fails on port-boundary violations
make fitness/bench          # laptop-scale benches — fails on threshold breach
make fitness/alerts         # SLO alert-rule dry-run — fails on rule regression
```

When `PORT_BOUNDARY_CHECK=true`, `lint-imports` is expected to be wired into `make fitness/architecture`. (If the repo's Makefile isn't ready yet, the orchestrator should fall back to `python -m importlinter` directly.)

Any failure in these blocks the gate the same way a test failure does. Up to `MAX_VALIDATION_RETRIES` Phase 4↔5 cycles.

## When to use which mode

| Scenario | Config |
| -------- | ------ |
| Team repo, GitHub PRs, linear roadmap | defaults |
| Solo local prototyping on a phased roadmap | `LOCAL_ONLY: true, ROADMAP_FORMAT: phased` |
| Solo local, but want PRs for review | `CLAIM_BACKEND: local-flock, CREATE_PRS: true` |
| Team repo, phased roadmap, PRs | `ROADMAP_FORMAT: phased, SPEC_DRIVEN_DOD: true` (leave remote settings default) |

## Gotchas

- **No remote assumption**: do not set `LOCAL_ONLY: true` in a repo you actually push to — the orchestrator will stop pushing claim/release commits and your coordination state will only exist locally.
- **Worktree cleanup**: Phase 6c removes the worktree and feature branch. If Phase 5 fails with `MAX_VALIDATION_RETRIES` exhausted, the worktree stays (for debugging) and the claim is released with `abandoned`. Clean up with `git worktree remove <path>` + `git branch -D feature/<id>` when done investigating.
- **Spec FR drift**: if the FR list in a spec changes after Phase 3 (e.g. you refine it mid-implementation), existing acceptance tests don't auto-update. Re-run `/roadmap work <phase-id>` or manually add tests.
- **Schema convergence**: as of v3.4.0 both `roadmap_ops.py` and `local_claim_ops.py` read and write the same flat-dict schema (`{"<id>": {...}, ...}`). Earlier versioned files (`{"version": 1, "claims": [...]}`) are auto-migrated on first write; no manual conversion needed.
