import { describe, it, expect } from "vitest";
import {
  buildControlsModel,
  countMaterialEvents,
} from "./sidepanel-controls";
import type { SessionStatus } from "./session-status";
import type { TimelineEvent } from "../types";

const STATES: SessionStatus[] = ["idle", "running", "paused", "stopped"];

// ─────────────────────────────────────────────────────────────────────
// Feature-17: pre-session control surface
// DoD-1 — Pre-session shows exactly Start + PII + connection-status pill;
// the lifecycle row is structurally absent (no Reset, no Download/Clear/End).
// ─────────────────────────────────────────────────────────────────────

describe("buildControlsModel — pre-session states (idle & stopped)", () => {
  for (const status of ["idle", "stopped"] as const) {
    it(`shows Start in ${status}`, () => {
      const m = buildControlsModel({
        status,
        hasResidualState: false,
        hasEvents: false,
        listenerAttached: false,
      });
      expect(m.start).toBe(true);
    });

    it(`hides every active-session lifecycle exit in ${status}`, () => {
      const m = buildControlsModel({
        status,
        hasResidualState: false,
        hasEvents: false,
        listenerAttached: false,
      });
      expect(m.annotation).toBe(false);
      expect(m.elementPicker).toBe(false);
      expect(m.pause).toBe(false);
      expect(m.download).toBe(false);
      expect(m.clear).toBe(false);
      expect(m.end).toBe(false);
    });

    it(`shows attachCliListener in ${status}`, () => {
      const m = buildControlsModel({
        status,
        hasResidualState: false,
        hasEvents: false,
        listenerAttached: false,
      });
      expect(m.attachCliListener).toBe(true);
    });

    it(`shows empty-state hint in ${status} with no residual state`, () => {
      const m = buildControlsModel({
        status,
        hasResidualState: false,
        hasEvents: false,
        listenerAttached: false,
      });
      expect(m.emptyStateHint).toBe(true);
    });

    it(`hides empty-state hint in ${status} with residual state`, () => {
      const m = buildControlsModel({
        status,
        hasResidualState: true,
        hasEvents: false,
        listenerAttached: false,
      });
      expect(m.emptyStateHint).toBe(false);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Feature-17 DoD-2 — Active (running) session shows ONLY Pause as
// lifecycle. No Stop, no Discard, no End, no Download, no Clear. The
// connection-status pill remains, and the capture-mode indicator stays.
// ─────────────────────────────────────────────────────────────────────

describe("buildControlsModel — running state (DoD-2)", () => {
  it("shows pause + interaction controls and hides every paused-state exit", () => {
    const m = buildControlsModel({
      status: "running",
      hasResidualState: false,
      hasEvents: true,
      listenerAttached: true,
    });
    expect(m.pause).toBe(true);
    expect(m.annotation).toBe(true);
    expect(m.elementPicker).toBe(true);
    // Critical: even with events present and a listener attached, the
    // running surface MUST NOT expose Download / Clear / End. The user
    // must Pause first to ship or clear.
    expect(m.download).toBe(false);
    expect(m.clear).toBe(false);
    expect(m.end).toBe(false);
  });

  it("hides start + attachCliListener while running", () => {
    const m = buildControlsModel({
      status: "running",
      hasResidualState: false,
      hasEvents: false,
      listenerAttached: false,
    });
    expect(m.start).toBe(false);
    expect(m.attachCliListener).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Feature-17 DoD-3, DoD-4 — Paused state contextual matrix
// download = clear = (status === "paused" && hasEvents)
// end       = (status === "paused" && listenerAttached)
// pause stays true (label swap to "Resume" handled in glue layer).
// ─────────────────────────────────────────────────────────────────────

describe("buildControlsModel — paused 4-cell contextual matrix (DoD-3, DoD-4, DoD-9)", () => {
  const cells: Array<[boolean, boolean, boolean, boolean, boolean]> = [
    // hasEvents, listenerAttached, expectedDownload, expectedClear, expectedEnd
    [false, false, false, false, false],
    [false, true, false, false, true],
    [true, false, true, true, false],
    [true, true, true, true, true],
  ];

  for (const [hasEvents, listenerAttached, exDownload, exClear, exEnd] of cells) {
    it(`paused × hasEvents=${hasEvents} × listenerAttached=${listenerAttached} → download=${exDownload}, clear=${exClear}, end=${exEnd}`, () => {
      const m = buildControlsModel({
        status: "paused",
        hasResidualState: false,
        hasEvents,
        listenerAttached,
      });
      expect(m.download).toBe(exDownload);
      expect(m.clear).toBe(exClear);
      expect(m.end).toBe(exEnd);
      // Pause is always shown while paused (label-swap to Resume).
      expect(m.pause).toBe(true);
    });
  }

  it("DoD-4 — empty paused (no events, no listener) shows Resume only — Download, Clear, End all absent", () => {
    const m = buildControlsModel({
      status: "paused",
      hasResidualState: false,
      hasEvents: false,
      listenerAttached: false,
    });
    expect(m.pause).toBe(true);
    expect(m.download).toBe(false);
    expect(m.clear).toBe(false);
    expect(m.end).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Feature-17 DoD-8 — Reset is removed from the surface entirely.
// Stop / Discard / Reset are no longer fields on ControlVisibility.
// ─────────────────────────────────────────────────────────────────────

describe("buildControlsModel — removed legacy flags (DoD-8)", () => {
  for (const status of STATES) {
    for (const hasEvents of [false, true]) {
      for (const listenerAttached of [false, true]) {
        it(`status=${status}, hasEvents=${hasEvents}, listener=${listenerAttached} — no stop/discard/reset properties`, () => {
          const m = buildControlsModel({
            status,
            hasResidualState: false,
            hasEvents,
            listenerAttached,
          });
          expect(m).not.toHaveProperty("stop");
          expect(m).not.toHaveProperty("discard");
          expect(m).not.toHaveProperty("reset");
        });
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
// Always-on regions (unchanged from feature-12).
// ─────────────────────────────────────────────────────────────────────

describe("buildControlsModel — always-on regions", () => {
  for (const status of STATES) {
    it(`always shows metrics row in ${status}`, () => {
      expect(
        buildControlsModel({
          status,
          hasResidualState: false,
          hasEvents: false,
          listenerAttached: false,
        }).metrics,
      ).toBe(true);
      expect(
        buildControlsModel({
          status,
          hasResidualState: true,
          hasEvents: true,
          listenerAttached: true,
        }).metrics,
      ).toBe(true);
    });
  }

  it("shows pausedBadge only when status === 'paused'", () => {
    expect(
      buildControlsModel({
        status: "running",
        hasResidualState: false,
        hasEvents: false,
        listenerAttached: false,
      }).pausedBadge,
    ).toBe(false);
    expect(
      buildControlsModel({
        status: "paused",
        hasResidualState: false,
        hasEvents: false,
        listenerAttached: false,
      }).pausedBadge,
    ).toBe(true);
    expect(
      buildControlsModel({
        status: "idle",
        hasResidualState: false,
        hasEvents: false,
        listenerAttached: false,
      }).pausedBadge,
    ).toBe(false);
    expect(
      buildControlsModel({
        status: "stopped",
        hasResidualState: false,
        hasEvents: false,
        listenerAttached: false,
      }).pausedBadge,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Feature-16 acceptance — PII fieldset / pill mutual exclusion (kept).
// ─────────────────────────────────────────────────────────────────────

describe("feature-16: PII fieldset / pill mutual exclusion", () => {
  for (const status of ["idle", "stopped"] as const) {
    it(`shows piiMode and hides piiIndicator in ${status}`, () => {
      const m = buildControlsModel({
        status,
        hasResidualState: false,
        hasEvents: false,
        listenerAttached: false,
      });
      expect(m.piiMode).toBe(true);
      expect(m.piiIndicator).toBe(false);
    });
  }
  for (const status of ["running", "paused"] as const) {
    it(`hides piiMode and shows piiIndicator in ${status}`, () => {
      const m = buildControlsModel({
        status,
        hasResidualState: false,
        hasEvents: false,
        listenerAttached: false,
      });
      expect(m.piiMode).toBe(false);
      expect(m.piiIndicator).toBe(true);
    });
  }
  it("piiMode and piiIndicator are mutually exclusive across all states", () => {
    for (const status of STATES) {
      for (const hasResidualState of [false, true]) {
        const m = buildControlsModel({
          status,
          hasResidualState,
          hasEvents: false,
          listenerAttached: false,
        });
        expect(m.piiMode).toBe(!m.piiIndicator);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Feature-12: screenshot field removed from ControlVisibility (kept).
// ─────────────────────────────────────────────────────────────────────

describe("feature-12: screenshot field absent from ControlVisibility", () => {
  for (const status of STATES) {
    it(`no screenshot property when status=${status}`, () => {
      const m = buildControlsModel({
        status,
        hasResidualState: false,
        hasEvents: false,
        listenerAttached: false,
      });
      expect(m).not.toHaveProperty("screenshot");
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Feature-17: countMaterialEvents helper.
// Pause/Resume markers do NOT count towards "the timeline has events".
// An empty-paused session that only contains a {session_paused} marker
// must still show only Resume (DoD-4).
// ─────────────────────────────────────────────────────────────────────

describe("countMaterialEvents — pause/resume markers excluded", () => {
  it("returns 0 for an empty array", () => {
    expect(countMaterialEvents([])).toBe(0);
  });

  it("returns 0 for an array containing only session_paused / session_resumed markers", () => {
    const events = [
      { type: "session_paused" } as unknown as TimelineEvent,
      { type: "session_resumed" } as unknown as TimelineEvent,
    ];
    expect(countMaterialEvents(events)).toBe(0);
  });

  it("counts non-marker events", () => {
    const events = [
      { type: "session_paused" } as unknown as TimelineEvent,
      { type: "interaction" } as unknown as TimelineEvent,
      { type: "session_resumed" } as unknown as TimelineEvent,
      { type: "console_error" } as unknown as TimelineEvent,
      { type: "screenshot" } as unknown as TimelineEvent,
    ];
    expect(countMaterialEvents(events)).toBe(3);
  });
});
