---
agent: safety-planner
generated: 2026-04-26T00:00:00Z
task_id: feature-15
perspective: safety
---

# Safety Plan: Lucide Icons Across the UI

> Hope is not a strategy. Plan for failure, celebrate success.

This is a **visual replacement** task masquerading as a low-risk swap. The risk
profile is dominated by silent regressions: visual breaks that typecheck and
unit tests will not catch, accessibility regressions hidden behind a passing
test suite, a third-party dependency entering a project that previously had a
single runtime dep (`fflate`), and a `withLoadingState` save/restore cycle
specifically designed around the previous icon shape (text in a `.btn-icon`
span). Several call sites still mutate `.btn-icon` via `textContent` (the
pause/resume swap at lines 966-976) — a Lucide SVG node will be silently
clobbered there if the swap path is not reworked.

The plan favours a **bisectable commit sequence** so any single bad icon swap
can be reverted in isolation, a **bundle-size guardrail** that fails loud, and
an explicit **manual demo verification gate** before merge — visual
correctness cannot be delegated to automation here.

---

## Architecture Impact

**Components affected:**
- `src/sidepanel/sidepanel.ts` — `iconBtn` helper signature, 9 call sites, dynamic pause/resume swap (lines 966-976)
- `src/sidepanel/sidepanel.css` — drop the `.btn-icon::before` mask-image stack (lines 503-571), replace with SVG sizing
- `package.json` / `package-lock` — new `lucide` runtime dependency
- `dist/` bundle output — size will increase by some KB (must measure)
- Tests under `tests/` that currently assert on Unicode glyphs or the `.btn-icon::before` mask path

**New patterns or abstractions introduced:**
- A small `icons.ts` shim module that re-exports the named Lucide icons we use, so the import surface is centralised. Justification: keeps individual-icon imports tree-shakeable while making the version-pinning surface a single file (mitigates the "lucide import surface differs across versions" risk).

**Dependencies added or modified:**
- `lucide` (runtime) — pinned to a specific minor (`~0.x.y` not `^`) and recorded with bundle-size delta in PR description. Document the chosen version in `icons.ts` header so a future bump is a deliberate review.

**Breaking changes to existing interfaces:**
- `iconBtn(id, cls, icon, label)` — `icon` parameter type changes from `string` to `SVGElement | string`. Internal helper only (not exported); breaking change scoped to this file.

**Risk points in architecture this task touches:**
- `withLoadingState` (lines 825-856) reads `.btn-label` `textContent` to save/restore — this works with SVG icons because it deliberately scopes to `.btn-label`, but the contract is implicit and a tempting future "simplification" could break it. Add a regression test that locks this in.
- Dynamic pause/resume swap (lines 966-976) currently does `pauseIcon.textContent = "..."`. With SVG nodes, `textContent =` will *destroy* the SVG. This must be rewritten to swap the SVG node itself.
- 4 of 9 call sites use Unicode glyphs that don't have an exact Lucide equivalent (e.g., `↵` "Attach" / return-arrow → `CornerDownLeft` or `Link`; `⌖` crosshair → `Crosshair` or `MousePointerSquareDashed`). Picking the wrong one is a UX regression invisible to tests.

---

## Risk Assessment

### Identified Risks

| # | Risk | Likelihood | Impact | Severity | Mitigation |
|---|------|-----------|--------|----------|------------|
| R1 | Dynamic pause/resume `textContent =` clobbers SVG node | **High** | High (visual + functional regression on a core lifecycle control) | **Critical** | Rewrite swap to replace the SVG child node directly, not via `textContent`; add a unit test that asserts the icon `<svg>` element is still present after a pause→resume→pause cycle |
| R2 | `withLoadingState` save/restore destroys icons | Low (already scoped to `.btn-label`) | High | Medium | Add explicit test: load → resolve → assert icon SVG still in DOM. Lock the contract |
| R3 | Bundle size blowup (accidental barrel import or unused icons) | Medium | Medium | Medium | Pre/post `wc -c` on `dist/sidepanel.js` (or similar bundled output). Hard fail if delta > 30 KB gzipped. Centralise icon imports through `src/sidepanel/icons.ts` so a barrel import would be visible in code review |
| R4 | Visual regression — wrong Lucide icon picked for ambiguous Unicode (e.g., return-arrow `↵`, crosshair `⌖`) | Medium | Medium (UX, not functional) | Medium | Manual `make demo` verification before merge. Document chosen Lucide name + rationale in commit message per icon |
| R5 | Lucide CSP issue: package may rely on dynamic `<script>` injection or eval | Low | High (extension fails to load) | Medium | Use the static-import API (`createElement(IconNode)`-style or stringified SVG), never the runtime DOM-rewriter (`lucide.createIcons()`). Verify no inline `<script>` or `eval` after build |
| R6 | Test brittleness — existing tests assert on Unicode glyph strings (e.g., `▶`) | High (the brief mentions it) | Low (failing tests are loud, not silent) | Low | Pre-flight: grep tests for hardcoded Unicode escapes; update in lockstep with icon swap |
| R7 | Accessibility regression — `aria-hidden` missing on SVG, or icon picks up an accessible name from `<title>` and competes with the button label | Medium | Medium (screen-reader users) | Medium | Add `aria-hidden="true"` and strip `<title>` from the inserted SVG. Add a test asserting the button's accessible name is the label text only |
| R8 | Lucide minor-version API drift (rename, export-shape change) | Medium | Medium | Medium | Pin `lucide` to a tilde-minor range (`~X.Y.Z`), import through `src/sidepanel/icons.ts` shim, document version in header comment |
| R9 | First-run notice / pre-export reminder / event-list badges have undiscovered Unicode glyphs | Medium | Low | Low | Pre-flight grep: `grep -nE '\\u2[0-9A-F]{3}\|\\u3[0-9A-F]{3}' src/` to enumerate. Sweep in dedicated commit |
| R10 | `chrome-extension://` CSP rejects SVG inline `xmlns` or `data:` URIs | Low | Critical (extension breaks) | Medium | Smoke test: load unpacked extension, click toolbar action, confirm side panel paints. Required pre-merge |
| R11 | Demo mode (`make demo`) divergence — works in extension but breaks in standalone | Low | Low (dev-only) | Low | Run `make demo` and visually inspect — already part of DoD |
| R12 | Pause icon swap regression after a `withLoadingState` interaction sequence (e.g., pause during an in-flight save) | Low | Medium | Low | Test: simulate save-in-progress + paused state transition, assert icon node integrity |

### Failure Modes Analysis

1. **Pause/Resume button shows blank or broken icon after first toggle**
   - Cause: dynamic icon swap uses `textContent =` which discards SVG children
   - Detection: visual on demo mode; unit test asserting `pauseBtn.querySelector("svg")` truthy after toggle
   - Recovery: revert the icon swap in `applyControlsModel`; restore `textContent` Unicode path; revisit with proper node-replacement helper

2. **Bundle size doubles (lucide barrel import slipped in)**
   - Cause: `import lucide from "lucide"` instead of `import { Play } from "lucide"`, or `import * as Lucide`
   - Detection: pre/post `du -k dist/` and compare; CI guard if added
   - Recovery: revert to last known-good commit; re-do the swap with named imports only

3. **Screen reader announces "Play, Start session" (icon and label)**
   - Cause: SVG has `<title>` element or missing `aria-hidden`
   - Detection: jsdom + a11y assertion test (`getByRole("button", { name: "Start session" })` should match exactly, not contain icon name)
   - Recovery: post-process the SVG to strip `<title>` and force `aria-hidden="true"`

4. **Side panel blank on extension load (CSP rejection)**
   - Cause: Lucide injects via inline script or uses `eval`
   - Detection: manual `chrome://extensions` reload + open side panel; check service worker console for CSP violation
   - Recovery: revert dependency; switch to alternative (e.g., copy SVG strings into the repo as a static module)

5. **`withLoadingState` returns the button but icon is gone**
   - Cause: someone "simplifies" `withLoadingState` to use `btn.textContent` directly instead of `.btn-label`
   - Detection: regression test that asserts icon presence post-loading-cycle
   - Recovery: restore `.btn-label` scoping

### Blast Radius

- **Affected users**: All extension users — every side panel open after upgrade.
- **Affected systems**: Side panel UI only. Service worker, content script, export pipeline, and CLI are all untouched. Schema unchanged.
- **Data at risk**: None. No persisted data shape changes; no migration. Worst case is "icons broken, all functionality intact" or "extension fails to load" (both fully reversible by revert).

---

## Implementation with Safety Gates

Each step is a single commit. The commit boundary is the rollback boundary.

| Phase | Action | Safety Check | Rollback Point |
|-------|--------|--------------|----------------|
| **0** | Pre-flight: capture baseline `dist/` bundle size and full test pass; grep all Unicode escapes in `src/` | Numbers recorded; tests green | N/A — no code change |
| **1** | Add `lucide` dep at pinned minor; create `src/sidepanel/icons.ts` shim (named re-exports only); typecheck | `tsc --noEmit` green; `wc -c node_modules/lucide` reasonable; no test changes | `git revert` → drops dep, no other surface touched |
| **2** | Refactor `iconBtn` helper to accept `SVGElement \| string`; keep all call sites still passing strings (Unicode unchanged) | Tests green; visual unchanged | `git revert` — single-function change |
| **3** | Rewrite the dynamic pause/resume swap (lines 966-976) to use node replacement instead of `textContent =`. Still using Unicode strings at this point. | New unit test for pause→resume→pause node integrity passes | Revert single commit; old `textContent` swap restored |
| **4** | Swap `start-btn` (Play) icon to Lucide; remove its `.btn-icon::before` CSS rule | Demo mode visual check (one button); a11y test passes | Revert single commit — only Start button affected |
| **5** | Swap `pause-btn` to Lucide (Pause + Play icons for the toggle); update swap path to swap SVG nodes | Pause→Resume→Pause regression test; demo visual | Single revert — only pause button affected |
| **6** | Swap `stop-btn` (Download) | Demo visual; a11y | Single revert |
| **7** | Swap `discard-btn` (X / Trash2) | Demo visual; a11y; confirm not visually identical to `handoff-detach-btn` X (ambiguity check) | Single revert |
| **8** | Swap `reset-btn` (RotateCcw) | Demo visual; a11y | Single revert |
| **9** | Swap `pick-element-btn` (Crosshair or MousePointerSquareDashed — pick one and document) | Demo visual on narrow side panel width; a11y | Single revert |
| **10** | Swap `add-note-btn` (Plus) | Demo visual; a11y | Single revert |
| **11** | Swap `handoff-attach-btn` (Link or CornerDownLeft) and `handoff-detach-btn` (Unlink or X) | Demo visual; a11y; verify visually distinct from discard X | Single revert |
| **12** | Sweep first-run notice, pre-export reminder, event-list badges for any remaining glyphs | Pre-flight grep run again; should return only test fixtures | Single revert |
| **13** | Delete obsolete `.btn-icon::before` CSS rules (lines 503-571); add SVG sizing rules | Demo visual on narrow width; styles look right | Single revert — fall back to dead CSS rules (harmless) |
| **14** | Update tests asserting on Unicode glyphs | Full test suite green | Single revert — but tests would then fail; better to keep this commit |
| **15** | Final: re-record bundle size delta; update PR description | Delta < 30 KB gzipped guardrail | N/A — measurement only |

> A bad single-icon choice in any of phases 4-12 can be reverted in isolation
> without unwinding the rest. This is the bisectability requirement.

---

## Files to Create/Modify

| File | Purpose | Risk Notes |
|------|---------|------------|
| `package.json` / `package-lock.json` | Add `lucide` pinned to `~X.Y.Z` | Dependency surface — pin minor to prevent silent breaking changes |
| `src/sidepanel/icons.ts` (new) | Centralised named re-exports of Lucide icons used | Single source of truth for which icons we depend on; easier to audit bundle impact |
| `src/sidepanel/sidepanel.ts` | `iconBtn` signature, 9+ call sites, pause/resume swap | Highest-risk file; the dynamic swap is the trap |
| `src/sidepanel/sidepanel.css` | Drop mask-image rules; add `.btn-icon svg { width: 14px; height: 14px; ... }` | Watch for size mismatch (current is 14px stroke-based; Lucide default is 24px viewBox) |
| `tests/sidepanel-render.test.ts` (or wherever the icon assertions live) | Update Unicode glyph assertions to SVG presence/aria-hidden assertions | Move from text-string assertions to structural assertions |
| `tests/sidepanel-icons.test.ts` (new) | Regression: pause-toggle node integrity, withLoadingState icon survival, aria-hidden, accessible-name-from-label | Locks the contracts the task touches |
| `tests/bundle-size.test.ts` (optional, **recommended**) | Asserts `dist/` total size below threshold after build | Prevents future regressions; minor over-instrumentation |

---

## Definition of Done

- [ ] `lucide` installed at pinned minor; bundle size delta recorded (< 30 KB gzipped)
- [ ] Each icon imported as a named import (no barrel, no `import *`); enforced by central `icons.ts` shim
- [ ] All 9 buttons render Lucide SVGs (Start, Pause, Resume, Stop, Discard, Reset, Pick element, Add note, plus handoff Attach/Detach)
- [ ] All Unicode glyphs swept from side panel UI (first-run notice, pre-export reminder, event list badges)
- [ ] All icons carry `aria-hidden="true"`; no `<title>` inside SVG
- [ ] Button accessible name comes from `.btn-label` only (asserted by test)
- [ ] `withLoadingState` icon-survival test passes
- [ ] Pause/Resume toggle icon-integrity test passes (pause→resume→pause→resume)
- [ ] All existing tests green
- [ ] CSS mask-image rules removed
- [ ] Demo mode (`make demo`) visually inspected at narrow side panel width — every icon is recognisable; **manual sign-off recorded in PR description with screenshot**
- [ ] Smoke test: load unpacked extension, open side panel, no CSP violations in service worker console
- [ ] Bisectable commit sequence preserved (one icon per commit in phases 4-12)
- [ ] No type errors

---

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | `lucide` named imports only, no barrel | Static (lint/grep in CI or code review) | Cheap and deterministic; runtime check would only catch one instance |
| 2 | Each button renders an `<svg>` icon | Unit (jsdom) | Pure DOM-shape assertion |
| 3 | All icons carry `aria-hidden="true"` | Unit (jsdom) | DOM attribute check |
| 4 | Button accessible name is the label only | Unit (jsdom) | `getByRole("button", { name: ... })` assertion |
| 5 | Pause→Resume→Pause toggle preserves `<svg>` node | Unit (jsdom) | Logic + DOM mutation, isolated. The single most important regression test |
| 6 | `withLoadingState` does not destroy icons | Unit (jsdom) | Logic, isolated. Locks the implicit contract |
| 7 | Bundle size delta < threshold | Integration / build-time | Requires real build output; not pure logic |
| 8 | Demo mode renders correctly | Manual (visual) | Visual correctness is not deterministic-testable; manual is honest |
| 9 | Extension loads without CSP violation | Manual (smoke) | Requires real Chrome runtime; unit/integration cannot reach |
| 10 | First-run notice + pre-export reminder + badges have no remaining Unicode glyphs | Static (grep test) | Deterministic and cheap |

**Safety planner bias**: Where the task's failure modes are visual or
runtime-environment-specific (CSP, real Chrome rendering), I am explicit that
manual verification is the test level, not unit. False confidence from "all
tests green" on a visual task is the failure mode I am most worried about.

**Determinism rule**: All automated tests are deterministic — no live LLM,
no network, no real timing. Pause/resume regression test should advance state
synchronously, not via `setTimeout`. Bundle-size test reads a built artifact,
which is deterministic given the same source.

---

## Testing Strategy (Comprehensive)

### Unit Tests (jsdom)

- **Icon presence**: For each of the 9 buttons, after `mountSidePanel`, the button contains an `<svg>` child inside `.btn-icon`
- **aria-hidden**: Every `<svg>` icon node has `aria-hidden="true"`
- **No `<title>` in icons**: Asserts SVG strips the descriptive `<title>` (which Lucide may insert)
- **Accessible name from label**: `pauseBtn.getAttribute("aria-label")` is null AND the rendered text content via `.btn-label` matches the expected user-visible label
- **withLoadingState icon survival**: Wrap a button with `withLoadingState`, resolve, assert `<svg>` still in DOM and `.btn-label` text restored
- **Pause-toggle icon integrity**: Drive `transitionTo("running") → "paused" → "running"` and assert each toggle leaves a valid `<svg>` child in `.btn-icon` (not a text node)
- **Pause-toggle label swap**: After toggle, label text alternates between "Pause" and "Resume"
- **No Unicode glyph escape characters in rendered DOM**: Querystring of `document.body.textContent` does not contain `▶`, `❚`, `⤓`, `✕`, `↺`, `⌖`, `➕`, `↵` (regression pin against drift)

### Edge cases

- Pause button toggled rapidly (pause→resume→pause within one tick) — node integrity preserved
- `withLoadingState` rejects with an error — icon and label restored
- Multiple `withLoadingState` calls on the same button concurrently — last-writer-wins on label, icon preserved
- Demo mode: `mountSidePanel` with mock deps renders identically (covered by feature #13's existing tests; verify they still pass)

### Integration Tests

- Build-time bundle size assertion (or Make-target script): post-`make build`, `gzip -c dist/sidepanel.js | wc -c` is below threshold (record exact threshold based on phase 0 baseline + 30 KB)

### E2E Tests

The project does have Playwright (`@playwright/test`) but the existing e2e
suite (`e2e/sidepanel-debug.spec.ts`) targets per-tab side panel binding, not
icon presence. **No new e2e is justified** for this feature — manual demo
inspection is the right test level for visual correctness, and adding e2e for
icon rendering would be expensive (full extension load + auth) for low marginal
value.

**E2E Test Impact**:
- **Existing e2e tests affected**: None expected — `sidepanel-debug.spec.ts` does not assert on icon glyphs. Verify by running locally before merge.
- **New e2e tests needed**: None
- **Cost note**: Each e2e does a full extension boot. Adding visual icon assertions there is high-cost / low-value vs. manual demo inspection.

### Regression Tests

- `tests/sidepanel-no-direct-capture.test.ts` — must still pass (icons don't touch capture path)
- `tests/sidepanel-no-handoff-write.test.ts` — must still pass (icons don't touch handoff token path)
- All controls-model tests — must still pass (visibility logic unchanged)
- `make demo` page — must still render and behave identically

### Load/Stress Tests

N/A — pure UI swap, no perf-sensitive code path.

**Test files to create/modify**:
- New: `tests/sidepanel-icons.test.ts` (regression suite for the 8 contracts above)
- New (optional but recommended): `tests/bundle-size.test.ts`
- Modify: any test that hard-codes Unicode glyph strings (run pre-flight grep in phase 0 to enumerate)

---

## Rollback Strategy

### Trigger Conditions

Rollback if any of the following occur post-merge:

- Extension fails to load on a clean profile (CSP violation or missing icon node)
- Visible regression in production: blank icon on any control after a state transition (especially pause/resume)
- Bundle size delta exceeds the recorded threshold by more than 50% (indicates a tree-shaking failure)
- Screen-reader users report duplicate label announcements (icon name + label name)

### Rollback Steps

Because the implementation is a bisectable commit sequence:

1. Identify the first bad commit via `git bisect` (commits are scoped one icon per commit in phases 4-12)
2. `git revert <commit-sha>` for the offending commit only — earlier and later icons stay swapped
3. If the entire feature must be rolled back: `git revert <feature-merge-commit> -m 1` to revert the merge
4. Reinstall: `npm install` to drop or restore the `lucide` dependency
5. `make clean && make build`
6. Reload unpacked extension; verify side panel paints

### Verification After Rollback

- [ ] `make test` green
- [ ] `make build` succeeds
- [ ] Extension loads on a clean profile
- [ ] Side panel renders with all controls visible
- [ ] Pause/Resume toggle works
- [ ] No CSP violations in service worker console

### Rollback Tested?

- [x] Yes — via local `git revert` simulation against intermediate commits before pushing
- [ ] No production rollback drill (acceptable for an extension with no
      auto-update channel — users are on `chrome://extensions` reload cadence)

---

## Monitoring & Alerting

This is a Chrome extension shipped via the unpacked-load workflow (no remote
auto-update channel) and has no telemetry. Monitoring is **manual and pre-merge**:

| Check | When | Threshold |
|-------|------|-----------|
| Bundle size (gzipped `dist/sidepanel.js`) | Pre-merge | Baseline + 30 KB hard fail |
| Test suite | Pre-merge | 100% pass |
| Demo mode visual | Pre-merge | Every icon recognisable at narrow width |
| Smoke load | Pre-merge | Side panel paints without CSP error |
| First-run flow | Pre-merge | Notice still readable; no garbled glyphs |

If telemetry is later added (out of scope here), watch for: side-panel-mount
errors, `chrome.runtime.lastError` from a panel that failed to render.

---

## Deployment Recommendations

- [x] **Feature flag**: Not needed — visual swap, no behaviour change. Rollback via git revert is sufficient.
- [x] **Gradual rollout**: Not applicable — extension is unpacked-loaded by developers.
- [x] **Staging verification**: Required — load unpacked extension and visually inspect side panel before merge.
- [x] **Off-hours deployment**: Not applicable.
- [x] **Demo mode pre-merge gate**: `make demo` and screenshot every control state. Attach screenshot to PR.
- [x] **Bisectable commits**: One icon per commit in phases 4-12 so a single bad swap is revertable in isolation.

---

## Estimated Effort

- Planning: Already done
- Implementation: ~70 minutes (15 small commits, mostly mechanical)
- Safety verification: ~25 minutes (regression tests, bundle size measurement, demo screenshots)
- Testing: ~30 minutes (write 8 new unit tests; run full suite)
- Manual demo verification: ~10 minutes
- **Total**: ~135 minutes

> Honest overhead acknowledgement: the speed plan would skip the
> bundle-size test, the icons.ts shim, the regression test for `withLoadingState`,
> and the per-icon commit boundary, and could probably finish in ~60 minutes.
> The extra 75 minutes here buys: pinned dependency surface, one-revert blast
> radius per icon, locked-in `withLoadingState` contract, and a guardrail that
> catches a future tree-shaking regression. For a *visual* task on a *core
> control surface*, that is a reasonable trade.

---

## Formal Verification Assessment

- Concurrency concerns: **No** — single-threaded UI mutation
- State machine complexity: **Low** — pause/resume is a 2-state toggle, already covered by `SessionStatus` state machine elsewhere
- Conservation laws: **No**
- Authorization model: **No**
- **Recommendation**: Not needed. Formal verification would be over-engineering for a visual swap. Targeted regression tests (pause-toggle integrity, `withLoadingState` icon survival) are the appropriate level.

---

## Security Considerations

- [x] No secrets in code — Lucide is MIT-licensed, no token surface
- [x] Input validation — N/A, icons are static
- [x] Output encoding — SVG inserted as DOM nodes (or stringified SVG via `innerHTML` only if Lucide forces it). **If `innerHTML` is used, the source must be the static Lucide library only — never user input.** Verify in code review.
- [x] Authentication/authorization — unchanged
- [x] OWASP top 10 — XSS via icon: the side panel is a `chrome-extension://` page with strict CSP. The Lucide package emits static SVG strings; no user-controlled content flows through the icon path. Confirmed safe.
- [x] CSP compliance — verified by smoke test (extension loads without violation)
- [x] No new permissions requested in `manifest.json`
- [x] `lucide` is MIT-licensed and a well-known package; no supply-chain red flags. Consider running `npm audit` after install.

---

## Risk-First Summary

The single highest-risk surface is the **dynamic pause/resume icon swap**
(`sidepanel.ts:966-976`), which currently uses `textContent =` and will
silently destroy any SVG child node. Phase 3 of this plan rewrites that swap
*before* introducing any SVG, with a regression test, so the bisectable
sequence cannot land a half-broken state. The next-highest risks are bundle
size (mitigated by guardrail), accessibility regression (mitigated by jsdom
a11y tests), and visual incorrectness (mitigated only by manual demo
inspection — there is no automation that can catch "wrong but valid icon").
