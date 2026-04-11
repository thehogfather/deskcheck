# Feature #14 phase 1 — Validation evidence

## Task
Orchestration cycle for phase 1 of roadmap feature #14 (CLI integration — local handoff receiver).

## Validation summary (Phase 5)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `make typecheck` | ✅ clean |
| Tests | `make test` | ✅ **544/544 passing** (36 files) |
| Build | `make build` | ✅ typecheck + vite bundling clean |

## Acceptance test matrix (D1–D10) status

All 10 D-level acceptance tests from `docs/plans/feature-14/selected-plan.md` section 4 are passing.

| # | DoD item | Test file | Status |
|---|---|---|---|
| D1 | CLI ships, `--help` prints usage | `cli/deskcheck.test.mjs` | ✅ |
| D2 | `deskcheck listen` binds loopback, writes DIR/\<id\>.zip | `cli/deskcheck.test.mjs` | ✅ |
| D3 | SW POSTs to listener when configured | `tests/service-worker-handoff.test.ts` | ✅ |
| D4 | Listener rejects wrong token with 401, no file | `cli/deskcheck.test.mjs` | ✅ |
| D5 | 127.0.0.1-only bind | `cli/deskcheck.test.mjs` | ✅ |
| D6 | Opt-in pin: no config → no fetch | `tests/service-worker-handoff.test.ts` | ✅ |
| D7 | Byte-for-byte round-trip | `cli/deskcheck.test.mjs` | ✅ |
| D8a | Tokens unique across CLI runs | `cli/deskcheck.test.mjs` | ✅ |
| D8b | Mismatch rejection (covered by D4) | `cli/deskcheck.test.mjs` | ✅ |
| D8c | Old token rejected by new CLI | `cli/deskcheck.test.mjs` | ✅ |
| D9 | Privacy copy mentions CLI + loopback | `src/lib/privacy.test.ts` | ✅ |
| D10 | `schema_version` unchanged + no handoff leak | `src/lib/exporter.golden.test.ts` | ✅ |

## Supporting tests (S1–S19)

| # | Description | Test file | Status |
|---|---|---|---|
| S1 | URL validator adversarial cases (DNS suffix, traversal, fragment, https, credentials) | `src/lib/handoff.test.ts` | ✅ |
| S2 | `redactToken` scrubs 16+ hex-char sequences | `src/lib/handoff.test.ts` | ✅ |
| S3 | `constantTimeEqual` handles length mismatch without leaking | `src/lib/handoff.test.ts` | ✅ |
| S4 | `getHandoffConfig` returns null on storage read failure | `src/lib/handoff-store.test.ts` | ✅ |
| S5 | `performHandoff` transport_error on fetch throw | `src/background/handoff-post.test.ts` | ✅ |
| S6 | `performHandoff` rejected on 401 | `src/background/handoff-post.test.ts` | ✅ |
| S7 | `performHandoff` ok on 200/201 | `src/background/handoff-post.test.ts` | ✅ |
| S8 | `performHandoff` transport_error on redirect | `src/background/handoff-post.test.ts` | ✅ |
| S9 | `performHandoff` abort via AbortController timeout | `src/background/handoff-post.test.ts` | ✅ |
| S10 | SW handoff 401 → download + EXPORT_WARNING broadcast | `tests/service-worker-handoff.test.ts` | ✅ |
| S11 | SW handoff ok → SESSION_CLEARED broadcast, no download | `tests/service-worker-handoff.test.ts` | ✅ |
| S12 | Both transports fail → OPFS session retained | `tests/service-worker-handoff.test.ts` | ✅ |
| S13 | CLI rejects path-traversal session_id with 400 | `cli/deskcheck.test.mjs` | ✅ |
| S14 | CLI rejects Content-Length > 200 MB with 413 | `cli/deskcheck.test.mjs` | ✅ |
| S15 | CLI rejects wrong Content-Type with 415 | `cli/deskcheck.test.mjs` | ✅ |
| S16 | CLI atomic writes (tmp + rename, no debris on success) | `cli/deskcheck.test.mjs` | ✅ |
| S17 | Replay (same session_id) returns 409, first file intact | `cli/deskcheck.test.mjs` | ✅ |
| S18 | Content script cannot import handoff-store (grep) | `tests/content-no-handoff-write.test.ts` | ✅ |
| S19 | Side panel handoff-store usage scoped to sidepanel.ts (grep) | `tests/sidepanel-no-handoff-write.test.ts` | ✅ |

## Key invariants encoded as tests

1. **Opt-in**: `handoff-store.get() === null ⇒ fetch() never called in EXPORT_SESSION` (D6)
2. **Data retention**: `POST failed AND download failed ⇒ OPFS session NOT deleted` (S12)
3. **Single-use tokens**: second POST with same session_id returns 409, first file intact (S17)
4. **No token leakage**: `session.json` never contains the token (D10)
5. **Loopback bind**: non-127.0.0.1 connect fails (D5)
6. **Content-origin isolation**: content scripts structurally cannot forge a handoff config (S18)

## Judge open questions — resolved

| # | Question | Resolution |
|---|---|---|
| 1 | MV3 `fetch` to `http://127.0.0.1:<port>` — host_permissions needed? | **No manifest change needed.** `host_permissions: ["<all_urls>"]` already in `manifest.json` covers loopback. Pinned by the D3 test passing end-to-end. |
| 2 | Add `"bin"` entry to `package.json` now? | **Deferred.** The CLI is invoked via `node cli/deskcheck.mjs listen --out DIR` in phase 1 — no bin entry added. Phase 2 can add it alongside `deskcheck record <url>` when npx invocation becomes a user-facing story. |

## Out of scope (phase 2 cycle)

- `deskcheck record <url>` command (Chrome launcher)
- Hash-fragment marker detection in the content script
- Side panel "Connected to terminal session" badge
- `--profile isolated` mode with `--load-extension`
- MCP server wrapper

## Commits in this orchestration cycle

```
f96f9ff test(feature-14): add grep tests S18/S19 + document CLI handoff in ARCHITECTURE.md
8a6424f feat(feature-14): side panel "Attach CLI listener" affordance + privacy copy update
a215225 feat(feature-14): wire EXPORT_SESSION to the CLI handoff path
e53e800 feat(feature-14): implement handoff module chain + CLI listener
3a46deb test(feature-14): phase 3 — failing D-level acceptance tests + stub modules
6b73724 chore(orchestrator): phase 2 — plans and judge selection for feature #14
7cbc300 chore(orchestrator): phase 0 — initialize workspace for feature #14 CLI integration
```
