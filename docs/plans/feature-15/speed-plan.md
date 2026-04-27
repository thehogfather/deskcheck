---
agent: speed-planner
generated: 2026-04-26T00:00:00Z
task_id: feature-15
perspective: speed
---

# Speed Plan: Lucide icons across the UI

## Architecture Impact

**Components affected:**
- `src/sidepanel/sidepanel.ts`: `iconBtn` helper signature widened; 9 call sites updated to import + pass Lucide icon nodes; pause/resume dynamic swap now swaps a child node instead of `textContent`.
- `src/sidepanel/sidepanel.css`: delete the `.btn-icon::before` mask block + 7 per-id mask rules; add a tiny SVG sizing rule.
- `package.json` / lockfile: `lucide` added as a runtime dep.

**New patterns or abstractions introduced:**
- None. We reuse `iconBtn` with a slightly broadened parameter type (`string | Node`).

**Dependencies added or modified:**
- `lucide` (runtime). Tree-shakeable individual icon imports.

**Breaking changes to existing interfaces:**
- None — `iconBtn` is module-private; call sites are updated in lockstep.

## Approach
Add `lucide` as a dep, replace the 8 button glyphs (Start/Pause/Resume/Stop/Discard/Reset/Pick/Add + handoff Attach/Detach) with `createElement(IconName)` nodes from `lucide`, and broaden `iconBtn` to take `string | Node`. Delete the entire data-URL mask CSS block (lines 503-571) and replace with a single ~5-line `.btn-icon svg` sizing rule. Touch only assertions in tests that referenced the literal Unicode glyphs.

## Files to Modify (Minimal)
| File | Change Type | Estimated Lines | Rationale |
|------|-------------|-----------------|-----------|
| `package.json` | Modify | +1 | Add `lucide` dep |
| `src/sidepanel/sidepanel.ts` | Modify | ~40 | Import icons, widen `iconBtn` sig, swap 9 call sites + pause-swap helper |
| `src/sidepanel/sidepanel.css` | Modify | -65/+8 | Delete mask block, add `.btn-icon svg` sizing |
| `tests/*.test.ts` | Modify | ~10 | Update assertions that hard-coded Unicode glyphs (likely 1-3 tests) |

**Total files**: 4 (plus lockfile auto-update)
**Total estimated lines**: ~+60 / -75 net change ≈ small negative diff

## Implementation Steps
1. `npm install lucide` (no `--save-dev`; runtime).
2. In `sidepanel.ts`, add a single import line at the top:
   ```ts
   import { createElement, Play, Pause, Download, X, RotateCcw, Crosshair, Plus, CornerDownLeft } from "lucide";
   ```
3. Widen `iconBtn` signature: `icon: string | Node` and append via `appendChild` if `Node`, else as text (keeps backwards compat for any string callers).
4. Add a tiny local helper: `const lucideNode = (icon: IconNode) => { const n = createElement(icon); n.setAttribute("aria-hidden", "true"); return n; };` (inline in the same closure, no new module).
5. Replace each `iconBtn(..., "\uXXXX", ...)` call with `iconBtn(..., lucideNode(IconName), ...)` for all 9 sites:
   - `handoff-attach-btn` → `CornerDownLeft`
   - `handoff-detach-btn` → `X`
   - `start-btn` → `Play`
   - `pause-btn` → `Pause`
   - `stop-btn` → `Download`
   - `discard-btn` → `X`
   - `reset-btn` → `RotateCcw`
   - `pick-element-btn` → `Crosshair`
   - `add-note-btn` → `Plus`
6. Update the pause/resume dynamic swap (lines 966-976): instead of `pauseIcon.textContent = "..."`, do `clearChildren(pauseIcon); pauseIcon.appendChild(lucideNode(status === "paused" ? Play : Pause));`.
7. In `sidepanel.css`, delete the mask `::before` block and all 7 per-id mask rules (lines 503-571). Replace with:
   ```css
   .btn-icon { margin-right: 4px; display: inline-flex; align-items: center; flex-shrink: 0; line-height: 1; }
   .btn-icon svg { width: 14px; height: 14px; stroke: currentColor; }
   #pick-element-btn .btn-icon svg { width: 16px; height: 16px; }
   ```
8. Run `make test`. Update any test asserting on `▶`, `❚`, `⤓`, `✕`, `↺`, `⌖`, `➕`, `↵` to assert on presence of an `svg` child inside `.btn-icon` instead.
9. Run `make build` to confirm typecheck and bundle. Record bundle delta in PR body.
10. Sweep first-run notice + pre-export reminder text for any stray glyphs (`grep -nE "\\\\u[0-9A-F]{4}" src/`); replace any survivors using the same pattern.

## Definition of Done
- [ ] `lucide` in `dependencies` (not devDependencies); `npm install` clean.
- [ ] 9 button call sites render an `<svg>` child inside `.btn-icon` (no Unicode glyphs in `sidepanel.ts`).
- [ ] Pause→Resume swap replaces the SVG node, not `textContent`.
- [ ] Every icon SVG carries `aria-hidden="true"`.
- [ ] CSS mask block removed; new SVG sizing rule in place.
- [ ] `make test` passes; `make build` produces a working `dist/`.
- [ ] No type errors.

## Suggested Test Levels

| # | DoD Criterion | Suggested Level | Rationale |
|---|--------------|----------------|-----------|
| 1 | `lucide` installed, individual imports | Static (typecheck) | Build fails if missing |
| 2 | Each button has an `<svg>` child + `aria-hidden` | Unit (jsdom) | DOM assertion on `mountSidePanel` output |
| 3 | Pause→Resume swaps SVG node not text | Unit (jsdom) | Drive state transition, query `.btn-icon svg` |
| 4 | `withLoadingState` preserves icon node | Unit (jsdom) | Existing test, just re-verify with SVG child |
| 5 | No Unicode glyphs remain in panel UI | Unit / grep | Single regex test or grep in CI |

**Speed planner bias**: All unit. No integration or e2e needed — this is a pure DOM/styling refactor.

**Determinism rule**: All proposed tests are deterministic — no LLM, no network.

## Testing Strategy
- **Unit**: One new tiny test that asserts each lifecycle button has exactly one `svg` child with `aria-hidden="true"`. Reuse the existing `mountSidePanel` jsdom harness. Update any test that hard-coded a Unicode glyph (likely in `tests/sidepanel-*.test.ts`) to assert `querySelector(".btn-icon svg") !== null` instead.
- **Integration**: Skip.
- **E2E**: Skip — visual regression is covered by the manual `make demo` check called out in the roadmap DoD.

**E2E Test Impact**:
- **Existing e2e tests affected**: None expected — e2e specs (e.g., `sidepanel-debug.spec.ts`) assert on `document.visibilityState`, not glyph contents.
- **New e2e tests needed**: None — no new user-visible flows.
- **Cost note**: N/A.

**Test files to create/modify**:
- Modify: any of `tests/sidepanel-*.test.ts` that match `/[▶❚⤓✕↺⌖➕↵]/`.
- Create (optional): `tests/sidepanel-icons.test.ts` — single 30-line file asserting every named button id has an `svg` child with `aria-hidden`.

## Risk Assessment
**Risk Level**: Low

**Why this is safe**:
- Pure presentation change; no schema, no service-worker logic, no storage paths touched.
- `withLoadingState` already targets `.btn-label` only, so SVG children survive loading transitions for free (feature #12 set this up).
- Lucide is MIT-licensed, vanilla-JS, well-trodden.
- `iconBtn` widening from `string` to `string | Node` is purely additive.

**Tradeoffs accepted**:
- No icon-name-to-component mapping abstraction — each call site imports + passes the icon directly. If a future feature needs to render an icon by string key, that abstraction can be added then.
- Lockfile churn: bundle grows by a few KB (acceptable per roadmap; record exact delta in PR).
- Not introducing a generic "icon helper" module — the inline `lucideNode` closure helper is enough for 9 call sites.

## Estimated Effort
- Planning: Already done
- Implementation: ~25 minutes (1 install + 9 swaps + CSS prune + tiny helper)
- Testing: ~10 minutes (update glyph assertions + add the 1 new sanity test)
- **Total**: ~35 minutes

## Formal Verification Assessment
- Concurrency concerns: No — single-threaded DOM mutation in a side panel.
- State machine complexity: No — only the existing pause/resume binary swap, already covered by feature #11 tests.
- Conservation laws: No.
- Authorization model: No.
- Recommendation: Not needed.

## What This Plan Does NOT Include
- Does NOT introduce a generic `Icon` component module or icon-by-name registry — defer until 2+ surfaces need it.
- Does NOT refactor `iconBtn` beyond widening its parameter type.
- Does NOT migrate any non-side-panel surface (popup is gone; content-script picker overlay uses its own styling and has no Unicode glyph).
- Does NOT add visual regression snapshots — manual `make demo` check is in the DoD.
- Does NOT bump `schema_version` — this is a pure UI change, export format unchanged.
- Does NOT touch service worker, storage, or exporter code.
