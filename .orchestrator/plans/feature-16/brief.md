# Planner brief: Feature #16 — Freeze PII capture mode at session start

## Context

DeskCheck is a Chrome MV3 extension. Side panel is the primary UI. Content script records DOM events. Service worker drives session lifecycle and persists to OPFS via `OpfsSessionStore`. Export is a zip with `session.json` + screenshots.

Today the side panel's PII mode selector (Full / Metadata / None) stays interactive during a running/paused session. The roadmap entry frames this as a privacy-metadata trust bug: a 160-second recording with three mid-flight switches recorded only the final value in `session.json`.

**Fact-check from a code read of `feature/feature-16` (worktree HEAD = main):**

- `session.pii_mode` is written ONCE at session creation in `service-worker.ts:334` (`buildSessionMetadata`), and never re-updated. `store.updateSession(...)` calls in service-worker.ts (lines 429, 445, 672, 977) only touch `status`, `end_time`, `duration_ms` — not `pii_mode`. So `session.json` already reflects start-time mode.
- The content-script recorder receives `piiMode` once via `SESSION_STARTED` (`content/index.ts:74-76`) and freezes it in a closure (`recorder.ts:13-18, 57-61`). Mid-session storage updates do NOT change recorder gating. The pii_mode is read from the closure inside `capturePayloadForMode` (recorder.ts:61).
- Side panel `selectedPiiMode` change handler (`sidepanel.ts:253-258`) only updates a local variable. It does NOT send a message to the service worker. So clicking a different radio mid-session has no effect on the persisted session or the recorder — but the user sees the radio change and is misled.

**Conclusion:** the underlying freeze semantics are already correct. This feature is primarily UX (hide the misleading interactive selector during recording, add a non-interactive indicator) plus regression-safety tests that pin the existing freeze invariants.

## Goal (one paragraph)

Make the export's PII guarantees unambiguous and visible. Hide the PII mode fieldset from the DOM during `running` and `paused` states (matching feature #11's hide-not-disable contract). Add a non-interactive `Capture: full | metadata | none` indicator pill in the toolbar styled to match the feature #15 connection-status pill. Tests must confirm: (a) `session.json pii_mode` equals the value at Start, even after radio changes / pause-resume / mid-session storage writes; (b) the recorder ignores storage updates to PII mode mid-session; (c) the indicator is visible only when status is `running` or `paused`; (d) E2E: a session started in `metadata` records input events with `value_metadata` populated and no raw value — closing the existing input-event coverage gap noted in the DoD.

## Definition of Done (lifted from roadmap, source of truth)

- [ ] PII mode fieldset is hidden from the DOM during running/paused states (matches feature #11 hide-not-disable contract)
- [ ] Toolbar shows a non-interactive "Capture: full | metadata | none" indicator while a session is active, styled to match the feature #15 connection-status pill
- [ ] `session.json` `pii_mode` field reflects the mode at Start time and never changes for the lifetime of the session
- [ ] Recorder gates input events on a session-scoped frozen mode value, not on a live read of storage
- [ ] Existing pre-session selector behaviour (Full / Metadata / None) is unchanged
- [ ] Unit tests cover: indicator visibility per status, frozen-mode persistence across pause/resume cycles, recorder gate behaviour after a mid-session storage update
- [ ] E2E test: start a session in `metadata` mode, type into an input on a fixture page, confirm the captured `interaction.subtype === "input"` event has `value_metadata` populated and no raw value (closes the existing input-event e2e coverage gap)

## Binding constraints

1. **Hide-not-disable.** PII mode fieldset must be ABSENT from the DOM during `running`/`paused`, not merely visually disabled. Update `buildControlsModel()` in `src/lib/sidepanel-controls.ts` and the rendering in `sidepanel.ts:1076` (`if (model.piiMode) controls.appendChild(piiFieldset)`).
2. **Schema unchanged.** `pii_mode` stays a single string field on `session.session`. **No `schema_version` bump.**
3. **Indicator is decorative.** Reads the current mode but offers no interaction. No "(locked)" copy. Match the feature #15 connection-status pill aesthetic — see `sidepanel.css:564-625` (`.handoff-status`, `.handoff-status-icon`, `.handoff-status-text`).
4. **Recorder gate is closure-frozen.** Already true today (`recorder.ts:57-61`). Add a test that pins this: simulate a storage `pii_mode` change mid-session and assert recorder still uses the start-time mode.
5. **Pre-session selector unchanged.** Full / Metadata / None options behave identically before Start.
6. **No regressions in existing tests.** Several existing tests assert the fieldset is always present (`sidepanel.test.ts:239, 273, 1177` and `sidepanel-controls.test.ts:106-107`). These need to be updated to reflect status-conditional visibility — but the pre-session presence and ID stability must remain.

## Key files (verified by code read)

- `src/lib/pii-modes.ts` — `PiiCaptureMode` type, `parsePiiMode`, `capturePayloadForMode`, `DEFAULT_PII_MODE`. No changes needed.
- `src/sidepanel/sidepanel.ts:1303-1327` — `buildPiiFieldset()` factory.
- `src/sidepanel/sidepanel.ts:252-258` — fieldset construction + change handler (local-only mutation).
- `src/sidepanel/sidepanel.ts:1076` — appends fieldset based on `model.piiMode`.
- `src/lib/sidepanel-controls.ts:22-72` — `ControlsModel.piiMode` field; `buildControlsModel()` returns `piiMode: true` unconditionally today (line 72). **Change here is the lever.**
- `src/lib/sidepanel-controls.test.ts:106-107` — pins current behaviour. Update to status-conditional.
- `src/lib/sidepanel-render.ts` — controls panel rendering (verify whether new indicator pill goes here or in sidepanel.ts).
- `src/sidepanel/sidepanel.css:564-625` — connection-status pill styling, source for indicator pill aesthetic.
- `src/content/recorder.ts:13-18, 57-61` — recorder closure already frozen; add tests confirming.
- `src/content/index.ts:74-76, 90-99, 103-115` — content-script entry; `SESSION_STARTED` is the freeze point. **Important: storage `onChanged` listener (line 103) currently watches for end_time/null only — it does NOT touch piiMode. Confirm tests that no other path can re-trigger `startSession` mid-session.**
- `src/background/service-worker.ts:334, 415, 587-595, 639` — write/read points for `session.pii_mode`. Read-only for this feature; tests should pin no other write path mutates it.
- `src/types.ts:15, 189, 195` — `pii_mode` field, `START_SESSION` and `SESSION_STARTED` message shapes. No changes.
- `src/lib/exporter.ts:92-98` — exports `session.pii_mode` into `session.json`. No changes; existing `exporter.golden.test.ts` and `exporter.test.ts:140-153` already pin the round-trip.

## Test inventory (current state)

- `src/lib/exporter.test.ts:140-153` — `pii_mode` round-trip in export. **Keep green.**
- `src/lib/exporter.golden.test.ts` — golden session pinning. **Keep green.**
- `src/sidepanel/sidepanel.test.ts:239, 273, 1177` — assertions about `#pii-mode-fieldset` presence. **Update to be status-conditional.**
- `src/lib/sidepanel-controls.test.ts:106-107` — `piiMode: true` for all statuses. **Update to: idle/stopped → true; running/paused → false.**
- `src/content/recorder.test.ts` — verify there's no test today that simulates mid-session mode change; add one.

## E2E gap to close

The DoD calls out "the existing input-event e2e coverage gap." Locate the e2e directory (`e2e/`) and add a Playwright (?) test that:
1. Starts a session in `metadata` mode.
2. Navigates to a fixture page with an input.
3. Types into the input.
4. Stops + downloads.
5. Asserts the exported `session.json` has at least one event with `interaction.subtype === "input"` and a populated `value_metadata` and NO raw `value` field.

## Out of scope

- Feature #17 (Pause-first lifecycle) — separate cycle.
- New PII modes — Full / Metadata / None remain the only three.
- Schema changes — `pii_mode` field shape unchanged, no `schema_version` bump.
- Service-worker → content-script protocol changes — the `SESSION_STARTED.piiMode` payload already carries the frozen value.

## Acceptance test outline (the contract)

The judge will produce a Test Level Matrix from this. Likely test levels:

- **Unit** — `buildControlsModel()` status-conditional `piiMode` flag.
- **Unit** — Pii indicator pill render: visible only on `running`/`paused`, shows the right label per mode.
- **Unit (jsdom)** — `sidepanel.ts` integration: fieldset absent from DOM after `transitionTo("running")`, indicator pill present; on `transitionTo("idle")` (or "stopped"), fieldset present, indicator absent.
- **Unit** — Recorder ignores storage `pii_mode` change mid-session: start with `full`, simulate `chrome.storage.onChanged` for the session record with a different `pii_mode`, assert recorder still uses the original mode. (May be moot — the storage listener doesn't watch `pii_mode` today — but worth pinning so a future refactor can't introduce the bug.)
- **Integration** — Round-trip: start session in `metadata` mode → record an input event in jsdom → flush via exporter → assert `session.pii_mode === "metadata"` and `interaction.subtype === "input"` event has `value_metadata` only, no `value`.
- **E2E (Playwright)** — As outlined above.
