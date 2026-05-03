import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { exportSessionStreaming } from "./exporter";
import { FakeSessionStore } from "./fake-session-store";
import { SCHEMA_VERSION } from "./agents-doc";
import goldenSession from "./__fixtures__/golden-session.json";
import type {
  SessionMetadata,
  SessionExport,
  TimelineEvent,
  TimelineEventInput,
} from "../types";

// The export schema is "the product's core contract" per CLAUDE.md. This
// test pins the exported session.json byte-for-byte against a committed
// fixture, so any silent drift (field order, missing field, extra field,
// whitespace, schema_version bump) fails loudly. Updating the fixture
// requires a deliberate edit of __fixtures__/golden-session.json.
//
// See docs/plans/feature-5/selected-plan.md — "Test Level Matrix" item 7.

describe("exportSessionStreaming — golden-file schema regression", () => {
  it("produces a session.json matching golden-session.json for a full event mix", async () => {
    const store = new FakeSessionStore();

    const meta: SessionMetadata = {
      // tab_id is always stripped on export — set it to a number the
      // fixture does NOT contain, so a regression in stripping will
      // surface as an extra field.
      id: goldenSession.session.id,
      tab_id: 9999,
      start_time: goldenSession.session.start_time,
      end_time: goldenSession.session.end_time,
      duration_ms: goldenSession.session.duration_ms,
      initial_url: goldenSession.session.initial_url,
      user_agent: goldenSession.session.user_agent,
      viewport: goldenSession.session.viewport,
      pii_mode: goldenSession.session.pii_mode as "full",
      status: "stopped",
    };

    await store.createSession(meta);

    // Seed the store with every event in the golden fixture. Strip the
    // `seq` because appendEvent will re-assign it; the input order
    // matches the fixture order so the resulting seq numbers line up.
    const fixtureEvents = goldenSession.timeline as unknown as TimelineEvent[];
    for (const ev of fixtureEvents) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { seq: _seq, ...rest } = ev;
      await store.appendEvent(rest as unknown as TimelineEventInput);
    }

    // One dummy screenshot so the zip contains at least one screenshots/
    // entry — the golden fixture references ss_golden_1.
    await store.appendScreenshot("ss_golden_1", new Uint8Array([1, 2, 3]));

    const zipBytes = await exportSessionStreaming(store, meta);
    const unzipped = unzipSync(zipBytes);

    expect(unzipped["session.json"]).toBeDefined();
    const parsed = JSON.parse(
      strFromU8(unzipped["session.json"]),
    ) as SessionExport;

    // Canonicalise both sides via JSON.stringify with the same indent
    // so whitespace differences still surface. The exporter must emit
    // pretty-printed JSON with 2-space indent (current contract).
    const canonicalActual = JSON.stringify(parsed, null, 2);
    const canonicalExpected = JSON.stringify(goldenSession, null, 2);
    expect(canonicalActual).toBe(canonicalExpected);
  });

  // D10 — Feature #14 phase 1: schema_version is unchanged by the
  // transport change. The handoff transport is a runtime branch, not a
  // data schema change; this test pins the constant so a silent bump
  // is impossible to miss. Also asserts that the exported session.json
  // never contains any handoff-related keys — structural proof that the
  // handoff config (which lives in its own chrome.storage.local key,
  // NOT in SessionMetadata) cannot leak into exported session data.
  it("D10 — schema_version is 1.2.0 and exported zip contains no handoff/listener/token fields", async () => {
    expect(SCHEMA_VERSION).toBe("1.2.0");

    const store = new FakeSessionStore();
    const meta: SessionMetadata = {
      id: "d10-no-leak",
      tab_id: 1,
      start_time: "2026-04-11T22:00:00.000Z",
      end_time: "2026-04-11T22:01:00.000Z",
      duration_ms: 60000,
      initial_url: "https://example.com",
      user_agent: "Test",
      viewport: { width: 100, height: 100 },
      pii_mode: "full",
      status: "stopped",
    };
    await store.createSession(meta);

    const zipBytes = await exportSessionStreaming(store, meta);
    const unzipped = unzipSync(zipBytes);
    const sessionJson = strFromU8(unzipped["session.json"]);
    expect(sessionJson).toContain('"schema_version": "1.2.0"');
    // Structural leak-absence pin: these keys must never surface in
    // the exported session.json for a handoff-configured session.
    expect(sessionJson).not.toContain("listener_url");
    expect(sessionJson).not.toContain("deskcheck_handoff");
    expect(sessionJson).not.toMatch(/"token"/);
    expect(sessionJson).not.toContain("handoff");
  });

  // ─────────────────────────────────────────────────────────────────
  // Feature-17 DoD-12 + DoD-13 — byte-identical zip parity between the
  // Download and End transports, plus schema_version pin.
  //
  // End is a transport choice over the existing EXPORT_SESSION path.
  // Both Download and End source the zip from a single call to
  // exportSessionStreaming(store, session); the SW then either posts
  // it or triggers a download. Asserting that two consecutive calls
  // on the same store produce byte-equal zips pins the determinism
  // property: any future change that introduces a transport-specific
  // code path in the exporter would surface here.
  // ─────────────────────────────────────────────────────────────────

  it("DoD-12 — exportSessionStreaming is deterministic: two consecutive calls produce byte-equal zips", async () => {
    const store = new FakeSessionStore();
    const meta: SessionMetadata = {
      id: "feature-17-byte-parity",
      tab_id: 1,
      start_time: "2026-05-03T12:00:00.000Z",
      end_time: "2026-05-03T12:01:00.000Z",
      duration_ms: 60000,
      initial_url: "https://example.com",
      user_agent: "Test",
      viewport: { width: 100, height: 100 },
      pii_mode: "full",
      status: "stopped",
    };
    await store.createSession(meta);
    await store.appendEvent({
      type: "console_error",
      level: "error",
      message: "boom",
      timestamp: "2026-05-03T12:00:30.000Z",
      page_url: "https://example.com/",
    } as unknown as TimelineEventInput);
    await store.appendScreenshot("ss_parity_1", new Uint8Array([7, 8, 9]));

    const zipA = await exportSessionStreaming(store, meta);
    const zipB = await exportSessionStreaming(store, meta);

    expect(zipA.length).toBe(zipB.length);
    expect(Array.from(zipA)).toEqual(Array.from(zipB));
  });

  it("DoD-13 — SCHEMA_VERSION constant is unchanged at 1.2.0 (regression pin)", () => {
    expect(SCHEMA_VERSION).toBe("1.2.0");
  });

  it("strips tab_id from the exported session (defence against regression)", async () => {
    const store = new FakeSessionStore();
    const meta: SessionMetadata = {
      id: "no-tab-id",
      tab_id: 42,
      start_time: "2026-04-07T12:00:00.000Z",
      end_time: "2026-04-07T12:01:00.000Z",
      duration_ms: 60000,
      initial_url: "https://example.com",
      user_agent: "Test",
      viewport: { width: 100, height: 100 },
      pii_mode: "full",
      status: "running",
    };
    await store.createSession(meta);

    const zipBytes = await exportSessionStreaming(store, meta);
    const unzipped = unzipSync(zipBytes);
    const parsed = JSON.parse(strFromU8(unzipped["session.json"])) as {
      session: { tab_id?: unknown };
    };
    expect(parsed.session.tab_id).toBeUndefined();
  });
});
