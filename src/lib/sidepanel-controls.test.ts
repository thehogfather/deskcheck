import { describe, it, expect } from "vitest";
import { buildControlsModel } from "./sidepanel-controls";
import type { SessionStatus } from "./session-status";

const STATES: SessionStatus[] = ["idle", "running", "paused", "stopped"];

describe("buildControlsModel — pre-session states (idle & stopped)", () => {
  for (const status of ["idle", "stopped"] as const) {
    it(`shows Start in ${status}`, () => {
      const m = buildControlsModel({ status, hasResidualState: false });
      expect(m.start).toBe(true);
    });

    it(`hides all interaction/lifecycle controls in ${status}`, () => {
      const m = buildControlsModel({ status, hasResidualState: false });
      expect(m.annotation).toBe(false);
      expect(m.elementPicker).toBe(false);
      expect(m.pause).toBe(false);
      expect(m.stop).toBe(false);
      expect(m.discard).toBe(false);
    });

    it(`shows attachCliListener in ${status}`, () => {
      const m = buildControlsModel({ status, hasResidualState: false });
      expect(m.attachCliListener).toBe(true);
    });

    it(`shows empty-state hint in ${status} with no residual state`, () => {
      const m = buildControlsModel({ status, hasResidualState: false });
      expect(m.emptyStateHint).toBe(true);
    });

    it(`hides empty-state hint in ${status} with residual state`, () => {
      const m = buildControlsModel({ status, hasResidualState: true });
      expect(m.emptyStateHint).toBe(false);
    });
  }
});

describe("buildControlsModel — in-flight states (running & paused)", () => {
  for (const status of ["running", "paused"] as const) {
    it(`hides Start in ${status}`, () => {
      const m = buildControlsModel({ status, hasResidualState: false });
      expect(m.start).toBe(false);
    });

    it(`shows interaction controls in ${status}`, () => {
      const m = buildControlsModel({ status, hasResidualState: false });
      expect(m.annotation).toBe(true);
      expect(m.elementPicker).toBe(true);
    });

    it(`shows all lifecycle controls (pause/stop/discard) in ${status}`, () => {
      const m = buildControlsModel({ status, hasResidualState: false });
      expect(m.pause).toBe(true);
      expect(m.stop).toBe(true);
      expect(m.discard).toBe(true);
    });

    it(`hides attachCliListener in ${status} (cannot retarget mid-session)`, () => {
      const m = buildControlsModel({ status, hasResidualState: false });
      expect(m.attachCliListener).toBe(false);
    });

    it(`hides reset in ${status} regardless of residual state`, () => {
      expect(buildControlsModel({ status, hasResidualState: false }).reset).toBe(false);
      expect(buildControlsModel({ status, hasResidualState: true }).reset).toBe(false);
    });

    it(`hides empty-state hint in ${status}`, () => {
      expect(buildControlsModel({ status, hasResidualState: false }).emptyStateHint).toBe(false);
      expect(buildControlsModel({ status, hasResidualState: true }).emptyStateHint).toBe(false);
    });
  }

  it("shows pausedBadge only when status === 'paused'", () => {
    expect(buildControlsModel({ status: "running", hasResidualState: false }).pausedBadge).toBe(false);
    expect(buildControlsModel({ status: "paused", hasResidualState: false }).pausedBadge).toBe(true);
    expect(buildControlsModel({ status: "idle", hasResidualState: false }).pausedBadge).toBe(false);
    expect(buildControlsModel({ status: "stopped", hasResidualState: false }).pausedBadge).toBe(false);
  });
});

describe("buildControlsModel — reset visibility", () => {
  it("reset is true only when (idle or stopped) AND residual state exists", () => {
    const expected: Array<[SessionStatus, boolean, boolean]> = [
      ["idle", false, false],
      ["idle", true, true],
      ["running", false, false],
      ["running", true, false],
      ["paused", false, false],
      ["paused", true, false],
      ["stopped", false, false],
      ["stopped", true, true],
    ];
    for (const [status, hasResidualState, expectedReset] of expected) {
      const m = buildControlsModel({ status, hasResidualState });
      expect(m.reset).toBe(expectedReset);
    }
  });
});

describe("buildControlsModel — always-on regions", () => {
  for (const status of STATES) {
    it(`always shows metrics row in ${status}`, () => {
      expect(buildControlsModel({ status, hasResidualState: false }).metrics).toBe(true);
      expect(buildControlsModel({ status, hasResidualState: true }).metrics).toBe(true);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Feature #16 acceptance — PII fieldset is hidden during active session,
// replaced by a non-interactive capture-mode indicator pill.
// ─────────────────────────────────────────────────────────────────────

describe("feature-16: PII fieldset visibility per status", () => {
  for (const status of ["idle", "stopped"] as const) {
    it(`shows piiMode fieldset in ${status}`, () => {
      expect(buildControlsModel({ status, hasResidualState: false }).piiMode).toBe(true);
      expect(buildControlsModel({ status, hasResidualState: true }).piiMode).toBe(true);
    });
  }

  for (const status of ["running", "paused"] as const) {
    it(`hides piiMode fieldset in ${status} (frozen at start)`, () => {
      expect(buildControlsModel({ status, hasResidualState: false }).piiMode).toBe(false);
      expect(buildControlsModel({ status, hasResidualState: true }).piiMode).toBe(false);
    });
  }
});

describe("feature-16: piiIndicator pill visibility per status", () => {
  for (const status of ["idle", "stopped"] as const) {
    it(`hides piiIndicator pill in ${status}`, () => {
      expect(buildControlsModel({ status, hasResidualState: false }).piiIndicator).toBe(false);
      expect(buildControlsModel({ status, hasResidualState: true }).piiIndicator).toBe(false);
    });
  }

  for (const status of ["running", "paused"] as const) {
    it(`shows piiIndicator pill in ${status}`, () => {
      expect(buildControlsModel({ status, hasResidualState: false }).piiIndicator).toBe(true);
      expect(buildControlsModel({ status, hasResidualState: true }).piiIndicator).toBe(true);
    });
  }

  it("piiMode and piiIndicator are mutually exclusive across all states", () => {
    for (const status of STATES) {
      for (const hasResidualState of [false, true]) {
        const m = buildControlsModel({ status, hasResidualState });
        expect(m.piiMode).toBe(!m.piiIndicator);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Feature #12 acceptance — screenshot field removed
// ─────────────────────────────────────────────────────────────────────

describe("feature-12: screenshot field removed from ControlVisibility", () => {
  for (const status of STATES) {
    for (const hasResidualState of [false, true]) {
      it(`no screenshot property when status=${status}, residual=${hasResidualState}`, () => {
        const m = buildControlsModel({ status, hasResidualState });
        expect(m).not.toHaveProperty("screenshot");
      });
    }
  }
});
