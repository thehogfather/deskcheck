---
agent: quality-planner
generated: 2026-04-26T00:00:00Z
task_id: feature-15
perspective: quality
---

# Quality Plan: Lucide icons across the side panel UI

## Architecture Impact

**Components affected:**
- `src/sidepanel/sidepanel.ts` — `iconBtn` helper signature change; 9 call sites pass icon nodes; pause/resume dynamic swap rewritten to replace SVG nodes (not `textContent`).
- `src/sidepanel/sidepanel.css` — drop the seven `#id .btn-icon::before` mask rules (lines 514-571) and replace them with one set of generic SVG sizing/colouring rules driven by `currentColor` and a class selector.
- `src/lib/sidepanel-icons.ts` *(new)* — single seam mapping semantic icon names → Lucide `IconNode` to `SVGElement` factory. Co-located helper (`makeIcon(name)`) returns ready-to-mount nodes with `aria-hidden="true"` and `class="btn-icon-svg"` baked in.
- `src/sidepanel/sidepanel-handoff-badge.ts` — sweep for any Unicode glyphs (none expected, but verify).
- `src/lib/sidepanel-render.ts` — sweep for badge glyphs in event-row rendering (Unicode used today for screenshot/console badges, if any).
- `src/lib/privacy-notice.ts` / first-run notice / pre-export reminder — sweep for residual Unicode.

**New patterns or abstractions introduced:**
- `Icon` type alias (`SVGElement`) and `IconName` string-literal union exported from `sidepanel-icons.ts`. This is the seam: future icon-set swaps only touch this one file.
- `iconBtn` accepts `Icon` (an `SVGElement`), not `string | Node`. Strict typing eliminates the `string`-glyph code path entirely.

**Dependencies added or modified:**
- `lucide` (runtime dependency, MIT). Tree-shaken via named ESM imports — `import { Play, Pause, Square, Download, Trash2, RotateCcw, Crosshair, Plus, CornerDownLeft, X } from "lucide"`. No barrel.
- `@types/lucide` not needed — `lucide` ships its own `.d.ts` with `IconNode` and `createElement` types.

**Breaking changes to existing interfaces:**
- `iconBtn(id, cls, icon: string, label)` → `iconBtn(id, cls, icon: Icon, label)`. Internal helper only — not exported. No external API change.
- Pause/resume swap mechanism changes from `pauseIcon.textContent = "..."` to `replaceChildren(makeIcon("play"|"pause"))`. Tests asserting on `textContent` of `.btn-icon` must be updated.

## Architectural Approach

The design introduces one small module (`sidepanel-icons.ts`) that owns Lucide as an implementation detail and exposes a semantic API (`makeIcon("play")`). This keeps `sidepanel.ts` decoupled from the icon library — replacing Lucide later (or returning to Unicode for any reason) is a single-file change. The CSS shifts from per-id mask rules to generic `.btn-icon-svg` styling that works for any inlined SVG, matching the codebase's preference for "design for change" (vendor-specific choices behind interfaces). The dynamic pause/resume icon swap moves from string mutation to node replacement, which is correct for SVG content and aligns with how `withLoadingState` already preserves icon nodes (it mutates only `.btn-label`).

## Files to Create/Modify

| File | Purpose | Quality Considerations |
|------|---------|----------------------|
| `src/lib/sidepanel-icons.ts` *(new)* | Semantic-name → SVGElement factory; encapsulates `lucide` import surface | Single seam; named exports; aria-hidden baked in; class-based styling hook |
| `src/lib/sidepanel-icons.test.ts` *(new)* | Pure-function tests for `makeIcon` factory | jsdom env; verifies SVGElement returned, aria-hidden present, class applied |
| `src/sidepanel/sidepanel.ts` | Update `iconBtn` signature; update 9 call sites; rewrite pause/resume swap to node replacement | Type-safe `Icon` parameter; co-located icon imports near call sites |
| `src/sidepanel/sidepanel.css` | Drop 7 per-id mask rules; add generic `.btn-icon-svg` rules using `currentColor` stroke and 14×14 sizing | Semantic styling, not per-element; future icons need no CSS changes |
| `tests/sidepanel-icon-buttons.test.ts` *(new)* | Semantic + a11y regression tests for buttons | Asserts svg presence, aria-hidden, accessible name from `.btn-label`, withLoadingState round-trip |
| `tests/sidepanel-pause-resume-swap.test.ts` *(new or extend existing)* | Verify the dynamic swap replaces the SVG node, not mutates text | Asserts node identity changes between paused/running |
| `package.json` | Add `lucide` to `dependencies` | Pinned minor version; documented why (tree-shakeable) |
| `src/lib/sidepanel-render.ts` *(audit + minimal edit)* | Replace any badge/event-row Unicode glyphs with Lucide nodes via `makeIcon` | Same factory used everywhere |
| `src/sidepanel/sidepanel-handoff-badge.ts` *(audit)* | No glyphs expected; verify | Sweep |

**Total files**: ~7 (3 new, 4 modified, 2 audited).

## Implementation Steps

1. **Add `lucide` dependency.** `npm install lucide` — pin to current minor. Record bundle delta after step 7. *Rationale: small explicit step, traceable in git.*

2. **Create `src/lib/sidepanel-icons.ts`.** Define `IconName` literal union (`"play" | "pause" | "stop" | "download" | "discard" | "reset" | "pick" | "add" | "attach" | "detach"`), import the matching individual Lucide `IconNode`s, expose `makeIcon(name: IconName): SVGElement`. The helper calls `lucide.createElement(IconNode)`, then sets `aria-hidden="true"`, `class="btn-icon-svg"`, `width=14`, `height=14`. *Rationale: single seam; future icon swaps don't touch any call site.*

3. **Write `sidepanel-icons.test.ts`.** Test (jsdom env): `makeIcon("play")` returns an `SVGElement`, has `aria-hidden="true"`, has `class="btn-icon-svg"`, has `<path>` children (sanity that an icon was actually rendered). One test per icon name to lock the union exhaustively. *Rationale: tests are written alongside the abstraction, not after.*

4. **Update `iconBtn` signature in `sidepanel.ts`.** Change parameter from `icon: string` to `icon: SVGElement` (or `Icon` re-exported alias). Replace `el("span", { class: "btn-icon" }, [icon])` with `el("span", { class: "btn-icon" }, [icon])` where `icon` is an SVG node. The `el` helper already accepts `Node` children — verify. *Rationale: type-safety eliminates the legacy string-glyph path.*

5. **Update all 9 call sites in `sidepanel.ts`** to pass `makeIcon("name")`:
   - `startBtn` → `makeIcon("play")`
   - `pauseBtn` → `makeIcon("pause")` (initial state)
   - `stopBtn` → `makeIcon("download")`
   - `discardBtn` → `makeIcon("discard")` (Lucide `Trash2`)
   - `resetBtn` → `makeIcon("reset")` (Lucide `RotateCcw`)
   - `pickElementBtn` → `makeIcon("pick")` (Lucide `Crosshair`)
   - `addNoteBtn` → `makeIcon("add")` (Lucide `Plus`)
   - `handoffAttachBtn` → `makeIcon("attach")` (Lucide `CornerDownLeft`)
   - `handoffDetachBtn` → `makeIcon("detach")` (Lucide `X`)
   *Rationale: centralised mapping; semantic names at call sites.*

6. **Rewrite the pause/resume dynamic swap (lines 966-976).** Replace the `pauseIcon.textContent = "..."` mutation with:
   ```ts
   const pauseIconSpan = pauseBtn.querySelector(".btn-icon") as HTMLElement;
   pauseIconSpan.replaceChildren(makeIcon(status === "paused" ? "play" : "pause"));
   ```
   *Rationale: `textContent` cannot represent SVG; correct semantic is node replacement. `replaceChildren` is a single atomic DOM operation.*

7. **Replace per-id CSS rules in `sidepanel.css` (lines 503-571)** with:
   ```css
   .btn-icon { margin-right: 4px; display: inline-flex; align-items: center; flex-shrink: 0; line-height: 1; }
   .btn-icon-svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
   ```
   Drop all `#start-btn .btn-icon::before` etc. mask blocks. *Rationale: one rule for any SVG icon; new icons require no CSS changes; uses `currentColor` so theme/state colours just work.*

8. **Audit and sweep remaining Unicode glyphs.** `grep -nE "\\\\u[0-9A-F]{4}" src/sidepanel/ src/lib/sidepanel-*` to find any holdouts in event-row badges, first-run notice, pre-export reminder, handoff badge. Replace with `makeIcon` where appropriate, keep textual content where it is content (not a glyph icon). *Rationale: DoD requires "no mixed Unicode/Lucide state".*

9. **Add `tests/sidepanel-icon-buttons.test.ts`.** Mount the side panel with mock deps, assert each button:
   - Contains exactly one `<svg>` inside `.btn-icon`.
   - The svg has `aria-hidden="true"`.
   - The accessible name (button's `textContent` from `.btn-label`) matches the expected label.
   - After `withLoadingState` runs and resolves, the svg node is still present (not destroyed).
   *Rationale: locks the accessibility contract and the loading-state regression.*

10. **Add or extend `tests/sidepanel-pause-resume-swap.test.ts`.** Assert that toggling between `paused` and `running` replaces the SVG node (different node identity, presence of `<svg>` after each transition), and that the label text follows. *Rationale: the swap mechanism changed; test pins the new semantics.*

11. **Measure bundle delta.** `make build`; record `dist/` size before vs after; expected a few KB given tree-shaken imports. Note in PR description. *Rationale: DoD requirement.*

12. **Run `make demo` and visually verify.** All 9 buttons render, pause/resume toggle works, panel readable at narrow width. *Rationale: DoD requirement; cheap visual regression check.*

## Definition of Done

- [ ] `lucide` is a runtime dependency, individual icons imported (no barrel)
- [ ] `iconBtn` typed as `(id, cls, icon: SVGElement, label)`
- [ ] Single `sidepanel-icons.ts` seam owns the Lucide import surface
- [ ] All 9 buttons render Lucide icons; no Unicode glyphs in any side panel surface
- [ ] All icon nodes carry `aria-hidden="true"`
- [ ] Pause/Resume swap replaces the SVG node, not `textContent`
- [ ] `withLoadingState` continues to preserve icon nodes (regression-tested)
- [ ] Per-id `mask-image` CSS rules removed; replaced with generic `.btn-icon-svg` rule
- [ ] Bundle delta measured and recorded in PR description
- [ ] `make demo` visually checked; all icons readable at narrow panel width
- [ ] All existing tests pass; tests asserting on Unicode characters updated
- [ ] No type errors (`make typecheck`)
- [ ] No linting warnings

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | `makeIcon` returns SVGElement with `aria-hidden="true"` and class | Unit | Pure factory; jsdom-isolated |
| 2 | All 9 buttons render exactly one `<svg>` inside `.btn-icon` | Unit (jsdom) | DOM structure; no Chrome APIs needed |
| 3 | Buttons' accessible name equals their text label | Unit (jsdom) | A11y contract; deterministic DOM assertion |
| 4 | `withLoadingState` round-trip preserves SVG icon node | Unit (jsdom) | Pure DOM mutation logic |
| 5 | Pause/Resume swap replaces SVG node (not textContent) | Unit (jsdom) | State-machine + DOM mutation |
| 6 | No Unicode glyphs remain in side panel sources | Unit (grep test) | Static-source assertion, fast and pinning |
| 7 | `make demo` renders icons at narrow width | Manual | Visual-only; not test-pyramid material |
| 8 | Bundle delta is measured | Manual | Build-time observation, recorded in PR |

**Quality planner bias**: 6 unit tests cover the new logic comprehensively; manual checks cover only what cannot be deterministically tested (visual rendering, bundle size). No integration or e2e tests required — this is a pure UI rendering change with a clear seam, fully testable in jsdom.

**Determinism rule**: All tests are deterministic. No live LLM, no Chrome runtime, no network. The grep test reads source files at vitest startup.

## Testing Strategy

- **Unit**:
  - `sidepanel-icons.test.ts`: factory contract (one test per `IconName`).
  - `sidepanel-icon-buttons.test.ts`: each button has one svg with aria-hidden; accessible name from label; withLoadingState preserves the node.
  - `sidepanel-pause-resume-swap.test.ts`: swap replaces the SVG node identity.
  - `sidepanel-no-unicode-glyphs.test.ts` *(new pin test)*: regex grep across `src/sidepanel/` and `src/lib/sidepanel-*.ts` confirming no Unicode-glyph escape sequences remain in icon-bearing files. Mirrors the project's existing pin-test pattern (`sidepanel-no-handoff-write.test.ts`, `sidepanel-no-direct-capture.test.ts`).

- **Integration**: not needed — this change is local to side panel rendering with a clean seam. No service-worker boundary moves.

- **E2E**: not needed for this feature.

**E2E Test Impact**:
- **Existing e2e tests affected**: `e2e/sidepanel-debug.spec.ts` may select buttons by text — if any selector matched on Unicode glyph it must update. Likely no impact since labels are text, not glyphs.
- **New e2e tests needed**: None.
- **Cost note**: No new e2e tests — this is intentional. UI icon rendering is fully testable in jsdom.

**Test files to create/modify**:
- `src/lib/sidepanel-icons.test.ts` (new)
- `tests/sidepanel-icon-buttons.test.ts` (new)
- `tests/sidepanel-pause-resume-swap.test.ts` (new or extend)
- `tests/sidepanel-no-unicode-glyphs.test.ts` (new pin)
- Audit `tests/sidepanel-render.test.ts` and any test asserting on `❚` / `▶` / etc.

**Coverage target**: 100% of new code in `sidepanel-icons.ts`; full a11y assertions on all 9 buttons.

## Code Quality Checklist

- [ ] SOLID: single responsibility — `sidepanel-icons.ts` only knows about icons; `sidepanel.ts` only knows about layout.
- [ ] DRY: one `makeIcon` factory; no inline `createElement` calls at call sites; one `.btn-icon-svg` CSS rule replaces seven.
- [ ] Clear naming: `IconName` (semantic), `makeIcon` (factory verb), `Icon` type alias for clarity in `iconBtn` signature.
- [ ] Appropriate abstraction: a single thin module — not a class hierarchy, not a registry, not a plugin system. Just a function.
- [ ] Error handling: not applicable — `makeIcon` takes a string-literal type; invalid names fail at compile time.
- [ ] Types: no `any`. `IconName` is a string-literal union; `Icon = SVGElement`.
- [ ] Edge cases: pause→resume mid-loading-state — verified by withLoadingState test that icon node survives.
- [ ] Logging/monitoring: none needed — this is a UI rendering change.

## Patterns to Apply

| Pattern | Where | Why |
|---------|-------|-----|
| Façade / single seam | `sidepanel-icons.ts` | Decouples `sidepanel.ts` from `lucide` package; future swap is one-file change |
| Type-safe enum (literal union) | `IconName` | Compile-time exhaustiveness; no string typos |
| Pin test via grep | `sidepanel-no-unicode-glyphs.test.ts` | Mirrors existing project pattern; locks the "no mixed state" DoD |
| Node replacement over text mutation | Pause/resume swap | Correct semantic for SVG content |
| Currentcolor styling | `.btn-icon-svg` CSS | Theme-aware, state-aware (primary, danger, dim) without per-button rules |

## Impact Assessment

**Positive Impacts**:
- Removes ~70 lines of CSS (seven per-id `mask-image` blocks) and replaces with two generic rules.
- Future icon additions cost: one entry in `IconName` + one named import in `sidepanel-icons.ts`. No CSS, no call-site type churn.
- Visual consistency improves (single 24px-grid stroke aesthetic).
- Strict typing eliminates an entire class of `string | Node` ambiguity in `iconBtn`.

**Neutral** (what stays the same):
- Button labels, ids, and classes — accessibility contract is preserved.
- `withLoadingState` behaviour — already targets `.btn-label` correctly.
- Service-worker / messaging surface — untouched.
- Export schema — untouched.

**Risks**:
- *Bundle size growth* — tree-shaking should keep this to a few KB; mitigated by individual named imports and bundle-delta measurement gate.
- *Pause/resume swap regression* — explicitly tested; node-replacement mechanism is simpler than the previous textContent path.
- *jsdom svg quirks* — jsdom supports `SVGElement` and `replaceChildren`; the existing tests already use jsdom for DOM assertions.

## Estimated Effort

- Planning: Already done
- Implementation: 60 min (new module 10, sidepanel.ts edits 15, CSS sweep 10, sweep audit 10, demo verify 15)
- Testing: 50 min (4 test files, comprehensive)
- Review prep: 20 min (bundle measurement, PR description, demo screenshots)
- **Total**: ~130 minutes

## Technical Debt Addressed

- Eliminates ~70 lines of duplicated `mask-image` CSS — each icon currently has two near-identical rules (vendor-prefixed and unprefixed).
- Removes per-id CSS coupling — adding a new icon-bearing button no longer requires both a new `iconBtn` call AND a new `#new-btn .btn-icon::before` block.
- Replaces the brittle `textContent`-based pause/resume icon swap (which would silently fail for any non-text icon) with explicit node replacement.
- Introduces a seam that the codebase lacked: the icon library is now an implementation detail, not a cross-cutting concern.

**Debt avoided**: by introducing `sidepanel-icons.ts` now, we don't end up with `lucide` imports scattered across `sidepanel.ts`, `sidepanel-render.ts`, and `sidepanel-handoff-badge.ts` — which would each have to change if we ever swap icon libraries.

## Formal Verification Assessment

- Concurrency concerns: No — pure synchronous DOM rendering.
- State machine complexity: No — pause/resume swap is a one-bit toggle, already covered by `SessionStatus` machinery.
- Conservation laws: No.
- Authorization model: No.
- Recommendation: Not needed.
- Key invariants (covered by tests, not formal methods):
  - Every button has exactly one icon node + one label node.
  - Every icon node has `aria-hidden="true"`.
  - Accessible name comes from `.btn-label` text, never from the icon.
  - The dynamic swap preserves these invariants across status transitions.

## Future Extensibility

- **Adding a new icon**: extend `IconName` union, add a named import + mapping entry in `sidepanel-icons.ts`. Zero CSS changes, zero call-site signature changes.
- **Swapping icon libraries**: rewrite `sidepanel-icons.ts` only. The `Icon = SVGElement` contract holds for any SVG-based library (Phosphor, Heroicons, custom).
- **Theming**: `.btn-icon-svg` already uses `currentColor` — adding a new button variant (e.g., `.sp-btn.warning`) just changes the button's text colour and the icon follows.
- **Sizing variants**: if a future surface needs 18px icons, add `.btn-icon-svg--lg` and pass a class — no new mask images, no new factory variants.
- **Icon-only buttons** (if ever needed for compact toolbars): `iconBtn` already supports an empty-label variant by passing `aria-label` on the button; the icon's `aria-hidden="true"` keeps the accessible name honest.
