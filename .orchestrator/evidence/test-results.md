# Test results — feature-4 (PII capture modes)

Run: 2026-04-07 (phase 5 validation gate)

## make typecheck
Exit 0. Clean.

## make test
```
Test Files  6 passed (6)
     Tests  116 passed (116)
  Duration  ~630ms
```

Test files run:
- src/lib/dom-utils.test.ts
- src/lib/exporter.test.ts (modified — pii_mode + 1.1.0 round-trip)
- src/lib/session-metrics.test.ts
- src/lib/encoding.test.ts
- src/lib/pii-modes.test.ts (NEW — pure module + negative property test)
- src/content/recorder.test.ts (NEW — jsdom mode behavior + negative property test)

## make build
Exit 0. dist/ produced:
- dist/src/popup/index.html (0.94 kB)
- dist/src/popup/index.js (2.43 kB)
- dist/src/background/service-worker.js (19.64 kB)
- dist/src/content/index.js (15.17 kB)
- dist/manifest.json (1.04 kB)

## DoD coverage
- [x] Mode selector radios in popup (HTML structure + popup.ts wiring; visually verifiable on extension load)
- [x] Full mode preserves existing behavior — verified by `pii-modes.test.ts > capturePayloadForMode > full mode` and `recorder.test.ts > full mode`
- [x] Metadata mode emits metadata, never raw value — verified by `pii-modes.test.ts > metadata mode` AND the negative property tests in both `pii-modes.test.ts` and `recorder.test.ts`
- [x] None mode suppresses input events — verified by `recorder.test.ts > none mode` (no listeners registered, no events emitted)
- [x] pii_mode in session.json — verified by `exporter.test.ts > round-trips pii_mode in exported session`
- [x] Default Full — verified by `parsePiiMode(undefined) === "full"`, `recorder.test.ts > default opts behaves like full`, and `index.html` `checked` attribute on Full radio
- [x] Schema 1.1.0 — verified by `exporter.test.ts > produces a valid zip`

## Privacy chokepoint audit
The only place that reads `target.value` for input timeline events is
`capturePayloadForMode` in `src/lib/pii-modes.ts`. The recorder skips
input/change listener registration entirely under `none` mode. Negative
property tests assert that for fixed sensitive strings (passwords, account
numbers, tokens, unicode), the raw value never appears in the serialized
event JSON for `metadata` or `none` modes.
