---
name: formal-verification-gateway
description: Decision logic for when and how to invoke formal verification (TLA+ / Lean4) during orchestration. Referenced by the orchestrator when evaluating Phase 2.5 triggers.
---

# Formal Verification Gateway

Decision logic for when the orchestrator should invoke formal verification and which tool to use.

## Decision Tree

```
Feature received
    ↓
Check trigger signals (any one sufficient):
    ├─ Roadmap metadata: formal_verification = TLA+ | Both | Lean4?  → YES
    ├─ Judge recommendation: Phase 2.5 REQUIRED or RECOMMENDED?      → YES
    ├─ Safety planner flags concurrency/state machine/conservation?   → YES
    ├─ Risk assessment mentions race conditions or shared mutable state? → YES
    └─ None of the above?                                             → SKIP Phase 2.5
         ↓
If YES → determine verification type:
    ├─ Concurrency / shared state / parallel actors     → TLA+
    ├─ State machine with 3+ states                     → TLA+
    ├─ Financial / transactional / conservation laws     → TLA+ (+ Lean4 optional)
    ├─ Distributed coordination / replication            → TLA+
    ├─ Authorization model / access control rules        → Lean4
    ├─ Algorithm correctness / complex data structure    → Lean4
    └─ Multiple signals from different categories        → Both
         ↓
Route to appropriate phase:
    ├─ TLA+  → Phase 2.5 (design-time, before implementation)
    ├─ Lean4 → Phase 4 (implementation-time, during coding)
    └─ Both  → Phase 2.5 for TLA+, then Phase 4 for Lean4
```

## Skip Criteria

**Always skip formal verification for:**

| Category | Examples | Reason |
|----------|----------|--------|
| UI-only changes | New component, style update, layout fix | No state machine or concurrency |
| Documentation | README, ARCHITECTURE.md, comments | No executable behavior |
| Build tooling | CI config, linting rules, build scripts | No domain logic |
| Simple bug fixes | Typo fix, off-by-one, null check | Too localized for model checking |
| Pure refactoring | Rename, extract function, move file | Preserves existing behavior |
| Test-only changes | New tests, test fixes, test infrastructure | Tests verify, they don't need verification |
| Dependency updates | Package bumps, lock file changes | No logic changes |

**Skip even with trigger signals if:**
- The feature touches fewer than 2 concurrent actors AND has no state machine
- The "concurrency" is read-only (multiple readers, no writers)
- The state machine has exactly 2 states (on/off, enabled/disabled)

## Trigger Signal Detection

### From Roadmap Metadata

Look for these fields in the roadmap deliverable:

```markdown
- **Formal verification**: TLA+ | Lean4 | Both | None
- **Verification focus**: [what to check]
```

If `formal_verification` is `TLA+` or `Both`, Phase 2.5 fires automatically.

### From Planner Outputs

Each planner produces a Formal Verification Assessment. Look for:

```markdown
## Formal Verification Assessment
- Concurrency concerns: Yes
- Recommendation: Formal verification recommended
```

If the **safety planner** recommends verification, treat it as a strong signal (safety planner has the strongest verification bias).

If **2+ planners** recommend verification, treat it as REQUIRED.

If only the **speed planner** recommends it (unusual), treat it as a very strong signal since speed planners are biased against extra work.

### From Judge Output

The judge produces a Formal Verification Recommendation table:

```markdown
### Formal Verification Recommendation
Recommendation: Phase 2.5 REQUIRED | RECOMMENDED | SKIP
```

- **REQUIRED**: Phase 2.5 must run
- **RECOMMENDED**: Phase 2.5 should run unless time pressure is extreme
- **SKIP**: No formal verification needed

### From Risk Assessment Keywords

Scan the selected plan's Risk Assessment for these patterns:

| Pattern | Trigger? |
|---------|----------|
| "race condition" | Yes |
| "shared mutable state" | Yes |
| "concurrent access" | Yes |
| "deadlock" | Yes |
| "starvation" | Yes |
| "out of order" | Yes |
| "lost update" | Yes |
| "double spend" | Yes |
| "phantom read" | Yes |
| "eventual consistency" | Yes |
| "split brain" | Yes |

## Cost-Benefit Matrix

| Feature Complexity | TLA+ Value | Lean4 Value | Recommendation |
|-------------------|------------|-------------|----------------|
| Simple CRUD, no concurrency | None | None | Skip |
| Single state machine, 2-3 states | Low | None | Skip unless safety-critical |
| State machine with 4+ states | High | None | TLA+ recommended |
| 2+ actors sharing state | High | None | TLA+ required |
| Financial transactions | High | Medium | TLA+ required, Lean4 optional |
| Distributed coordination | Very High | None | TLA+ required |
| Complex algorithm (sort, search, optimize) | None | High | Lean4 in Phase 4 |
| Authorization model with inheritance | Low | High | Lean4 in Phase 4 |
| Cryptographic or security protocol | Medium | Very High | Both |

## TLA+ Route (Phase 2.5)

**When**: Design-time, after judge selects plan, before acceptance tests.

**What happens**:
1. Orchestrator invokes `/tla-formal-spec:verify-design` with the selected plan
2. TLA+ spec is generated automatically from the plan
3. TLC model checks the invariants
4. Results feed back as:
   - Verified invariants → additional acceptance criteria for Phase 3
   - Counterexamples → design risks documented in the plan
   - Design changes needed → plan gets updated before implementation

**Artifacts**: `.tla`, `.cfg`, `verification-report.md` in `docs/plans/[feature-id]/`

## Lean4 Route (Phase 4)

**When**: Implementation-time, only when flagged.

**Triggers for Lean4 during Phase 4**:
- Verification report flags "Lean4 Escalation" items
- Safety planner specifically recommended Lean4 for algorithm correctness
- Implementer creates a data structure with complex invariants
- Plan involves mathematical properties that need proof (not just model checking)

**What happens**:
1. Use existing `lean4-theorem-proving` skill (no new commands needed)
2. Focus on specific algorithm or property flagged for proof
3. Results feed back as:
   - Proved properties → confidence in algorithm correctness
   - Failed proofs → flag for manual review or algorithm redesign

**No new Lean4 commands are needed.** The orchestrator just needs awareness of when to suggest invoking the skill.

## Integration Points

| Orchestrator Phase | Verification Gateway Role |
|-------------------|--------------------------|
| Phase 1 (Planning) | Planners assess verification need in their output |
| Phase 2 (Judge) | Judge consolidates assessments, recommends Phase 2.5 |
| Phase 2.5 (Verification) | Gateway decides trigger/skip, routes to TLA+ |
| Phase 3 (Tests) | Verified invariants become acceptance criteria |
| Phase 4 (Implement) | Lean4 for flagged algorithms; mid-implementation re-check |
| Phase 5 (Validation) | Verification evidence required in gate checks |
