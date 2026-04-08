// Pure state machine for the DeskCheck session lifecycle. The side
// panel and the service worker both consult this module to decide
// whether a transition is legal and what the resulting status should
// be. There is no I/O here — storage writes happen in session-store.ts
// after nextStatus() has accepted the transition.
//
// States:
//   idle     — no session exists. Either never started or cleared.
//   running  — session active, events being captured.
//   paused   — session active, capture suspended but timeline preserved.
//   stopped  — session finalised (Stop & Download flow); residual
//              events/screenshots may still be visible in the panel
//              until they are exported or cleared via Reset.
//
// Transition table (× = illegal):
//
//   from \ action   start  pause  resume  stop  discard  reset  export_complete
//   idle            run    ×      ×       ×     ×        ×      ×
//   running         ×      pause  ×       stop  idle     ×      ×
//   paused          ×      ×      run     stop  idle     ×      ×
//   stopped         run    ×      ×       ×     ×        idle   idle
//
// Business invariants pinned by tests:
//   1. Paused is never "capturing" — every capture site gates on
//      isCaptureActive(status).
//   2. Reset is only legal from stopped or idle.
//   3. Discard from running OR paused lands in idle (the session is gone).
//   4. export_complete is a no-op from idle and a silent transition
//      from stopped back to idle for the post-export cleanup flow.
//   5. "idle" is never persisted to chrome.storage.local — when the
//      session metadata key is absent, the reader infers idle.

export type SessionStatus = "idle" | "running" | "paused" | "stopped";

export type SessionAction =
  | "start"
  | "pause"
  | "resume"
  | "stop"
  | "discard"
  | "reset"
  | "export_complete";

export type TransitionResult =
  | { ok: true; next: SessionStatus }
  | { ok: false; reason: string };

/**
 * Apply an action to the current status. Returns the next status on
 * success, or an explanatory failure on an illegal transition. Pure.
 */
export function nextStatus(
  current: SessionStatus,
  action: SessionAction,
): TransitionResult {
  switch (current) {
    case "idle":
      if (action === "start") return { ok: true, next: "running" };
      if (action === "reset" || action === "export_complete") {
        return { ok: true, next: "idle" }; // no-op
      }
      return { ok: false, reason: `cannot ${action} from idle` };

    case "running":
      if (action === "pause") return { ok: true, next: "paused" };
      if (action === "stop") return { ok: true, next: "stopped" };
      if (action === "discard") return { ok: true, next: "idle" };
      return { ok: false, reason: `cannot ${action} from running` };

    case "paused":
      if (action === "resume") return { ok: true, next: "running" };
      if (action === "stop") return { ok: true, next: "stopped" };
      if (action === "discard") return { ok: true, next: "idle" };
      return { ok: false, reason: `cannot ${action} from paused` };

    case "stopped":
      if (action === "start") return { ok: true, next: "running" };
      if (action === "reset" || action === "export_complete") {
        return { ok: true, next: "idle" };
      }
      return { ok: false, reason: `cannot ${action} from stopped` };

    default: {
      const _exhaustive: never = current;
      return _exhaustive;
    }
  }
}

/** True when new timeline events should actually be captured. */
export function isCaptureActive(status: SessionStatus): boolean {
  return status === "running";
}

/** True when the lifecycle controls (Pause/Resume/Stop/Discard) should be visible. */
export function isLifecycleControlVisible(status: SessionStatus): boolean {
  return status === "running" || status === "paused";
}

/** True when Reset is a legal action. Reset only makes sense when no
 * session is in flight — either idle-with-residual or stopped. */
export function isResetEligible(status: SessionStatus): boolean {
  return status === "idle" || status === "stopped";
}

/** Compile-time exhaustiveness guard. Not called at runtime. */
export function assertExhaustiveStatus(status: SessionStatus): void {
  switch (status) {
    case "idle":
    case "running":
    case "paused":
    case "stopped":
      return;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
