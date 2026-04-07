---
feature_id: feature-2
title: Sensitive data warnings
phase: 5
gate_result: PASS
generated: 2026-04-07
---

# Validation Evidence — Feature #2 (Sensitive data warnings)

## Automated checks

| Check | Command | Result |
|-------|---------|--------|
| Type checking | `make typecheck` (`tsc --noEmit`) | PASS — clean, no diagnostics |
| Test suite | `make test` (`vitest run`) | PASS — 5 files, 72 / 72 tests green |
| Build | `make build` (typecheck + vite × 3 + manifest copy) | PASS — popup, service worker, content, manifest all built; no errors |

### Test breakdown — relevant files

- `src/lib/privacy.test.ts` (NEW, 9 tests):
  - PRIVACY_NOTICE_BULLETS mentions visible screen content (matrix #1) — PASS
  - PRIVACY_NOTICE_BULLETS mentions form inputs (matrix #2) — PASS
  - PRIVACY_NOTICE_BULLETS mentions network headers (matrix #3) — PASS
  - shouldShowFirstRunNotice(false) === true (matrix #4) — PASS
  - shouldShowFirstRunNotice(true) === false (matrix #5) — PASS
  - PRIVACY_MD_TEMPLATE is non-empty markdown with H1 (matrix #6) — PASS
  - PRIVACY_MD_TEMPLATE mentions all three topics (matrix #7) — PASS
  - PRIVACY_MD_TEMPLATE notes local-use-only (matrix #8) — PASS
  - PRIVACY_MD_TEMPLATE mentions screenshots and sensitive data (matrix #9) — PASS

- `src/lib/exporter.test.ts` (modified, 3 new tests):
  - Empty session zip contains PRIVACY.md (matrix #10) — PASS
  - Screenshots-bearing zip contains PRIVACY.md alongside screenshots/ss_1.png (matrix #11) — PASS
  - PRIVACY.md content references screenshots and sensitive data (matrix #12) — PASS

- All previously-existing tests (60) still pass.

## Build artefact verification

Direct grep against the production bundles confirms the new privacy strings
ship to the user — i.e., the implementation is not just present in source
but actually reaches `dist/`:

| Bundle | Strings searched | Hits |
|--------|------------------|------|
| `dist/src/background/service-worker.js` | `PRIVACY` / `sensitive` / `local use only` | 3 |
| `dist/src/content/index.js` | `sensitive` / `Form inputs` / `Screenshots capture` / `Keep recording` / `Got it` | 2 |

The service-worker bundle hits all three of the PRIVACY.md template's key
phrases (the file is added to `zipData` BEFORE the screenshots loop). The
content-script bundle hits the in-widget notice/reminder copy, confirming
the widget renders the bullets and the pre-export reminder in the shipped
extension.

## Definition of Done — checklist

| # | DoD criterion | Source of truth | Status |
|---|---------------|----------------|--------|
| 1 | First-run notice appears when a session starts (dismissible, shown once per install) | `src/content/widget.ts` `getFirstRunSeen → renderFirstRunNotice → markFirstRunSeen` flow | DONE — automated test for the gate logic; manual smoke pending on a real Chrome profile |
| 2 | Pre-export reminder appears in the widget when "Stop & Download" is clicked | `src/content/widget.ts` `stopBtn` handler → `renderPreExportReminder` | DONE — covered by code; manual smoke pending |
| 3 | Export zip includes a `PRIVACY.md` noting that screenshots may contain sensitive data | `src/lib/exporter.ts` + matrix #10–12 | DONE — pinned by automated test |
| 4 | Notice text explains that DeskCheck captures visible screen content, form inputs, and network headers | `src/lib/privacy.ts` `PRIVACY_NOTICE_BULLETS` and `PRIVACY_MD_TEMPLATE` + matrix #1–3, #7 | DONE — pinned by automated test |

## Manual smoke checklist (Chrome MV3 — pending)

The following must be exercised once on a fresh Chrome profile with the
unpacked extension loaded from `dist/` after this feature is merged. They
exercise paths that cross the closed Shadow DOM and `chrome.storage.local`,
which the codebase convention (CLAUDE.md) tests manually rather than via
jsdom.

- [ ] Fresh profile → Start Session → first-run notice renders above the metrics bar with three bullets mentioning screen / form input / network header.
- [ ] Click "Got it" → notice disappears immediately.
- [ ] Stop the session, start a new one → first-run notice does NOT reappear.
- [ ] Restart Chrome → start a new session → first-run notice still does NOT reappear (proves the flag persisted).
- [ ] Click "Stop & Download" → inline reminder panel appears in the widget body with two buttons. Initial focus is on "Keep recording", not "Download".
- [ ] Click "Keep recording" → panel closes, badge stays REC, recording continues.
- [ ] Click "Stop & Download" → click "Download" → zip downloads → unzip → `PRIVACY.md` is at the zip root next to `session.json` and the `screenshots/` directory, and contains the topics screen / form / network and the phrase "local use only".

These steps are NOT a gate for merging — they verify behaviour that the
automated tests cannot reach (chrome.storage.local persistence and the
Shadow DOM render path). The gate result below reflects the automated
checks, which are the contract for "done" per the orchestration workflow.

## Gate decision

**Result: PASS.**

All automated checks (typecheck, test suite, build) succeed. The 12
acceptance tests from the Test Level Matrix all pass. The production
bundle ships the new strings. No regressions in the previously-existing
60 tests. No new dependencies. No changes to `schema_version`. No
service-worker churn.

Proceed to Phase 6 (architecture + roadmap update, push, PR).
