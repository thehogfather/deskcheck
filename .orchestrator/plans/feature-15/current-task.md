# Feature 15: Lucide icons across the UI

**Persona**: Bug Reporter
**Effort**: Small
**Impact**: Medium
**Branch**: feature/feature-15

## Goal
Replace ad-hoc Unicode/CSS-mask icons in the side panel with `lucide` SVG icons. Consistent stroke-based aesthetic, tree-shakeable.

## Surfaces
- `src/sidepanel/sidepanel.ts` — `iconBtn` helper (line 350) and 9 call sites
- `src/sidepanel/sidepanel.css` — drop the data-URL `mask-image` rules (lines 503-571), add SVG sizing
- Pause/Resume dynamic icon swap (lines 966-976)
- First-run notice + pre-export reminder + event list badges — sweep for any remaining glyphs

## Constraints (from roadmap)
- No framework churn — vanilla `lucide` package, not `lucide-react`
- Tree-shake imports — individual icons, no barrel
- Every Unicode icon goes
- Accessibility: aria-hidden="true" on icons, accessible name from text label
- `withLoadingState` `.btn-label`-scoped behaviour must continue to work

## Definition of Done (DoD)
- `lucide` installed; individual icon imports per call site
- `iconBtn` accepts SVG node (or string)
- Start, Pause, Resume, Stop, Discard, Reset, Pick element, Add note buttons render Lucide icons
- Other Unicode glyphs replaced (handoff Attach/Detach if applicable)
- aria-hidden="true" on icon nodes
- `withLoadingState` continues to work without destroying icons
- Bundle delta recorded in PR description
- All existing tests pass; tests asserting on Unicode updated
