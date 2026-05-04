// Pure view-model for the side panel's control region. Takes the
// current session status, residual-state flag, whether the timeline has
// any material events, and whether a CLI handoff listener is attached
// — and returns a declarative shape describing which controls should
// be rendered. The panel glue layer (sidepanel.ts) mounts/unmounts DOM
// nodes from this shape — NEVER toggling `display: none`. The feature
// #11 DoD requires hidden controls to be "absent from the DOM, not
// merely disabled", which is enforced structurally by appending vs
// removing children, not by styling.
//
// Feature #17 narrows the user-driven verb surface from
// {Start, Pause, Resume, Stop, Discard, Reset} to a smaller, contextual
// set:
//   pre-session  → Start
//   running      → Pause
//   paused       → Resume + (Download, Clear when timeline has events)
//                          + (End when a CLI listener is attached)
// Stop / Discard / Reset are removed from the surface — Clear subsumes
// the post-session "drop residual state" role. The underlying
// SessionStatus state machine is unchanged.
//
// Zero DOM, zero Chrome APIs.

import type { SessionStatus } from "./session-status";
import type { TimelineEvent } from "../types";

export interface ControlVisibility {
  /** Start button — shown pre-session (idle/stopped). */
  start: boolean;
  /**
   * PII mode fieldset — shown ONLY pre-session (idle/stopped). The
   * mode is frozen at session start (feature #16); during running and
   * paused states the fieldset is removed from the DOM and replaced by
   * the non-interactive `piiIndicator` pill. Hide-not-disable.
   */
  piiMode: boolean;
  /**
   * Capture-mode indicator pill — shown ONLY during an active session
   * (running/paused). Decorative read-only affordance that surfaces the
   * frozen PII mode without offering interaction. Mutually exclusive
   * with `piiMode` — exactly one of the two is true at any time.
   */
  piiIndicator: boolean;
  /** Metrics row (duration, counts, size) — always shown. */
  metrics: boolean;
  /** Empty-state hint — shown pre-session. */
  emptyStateHint: boolean;
  /** Annotation textarea + add-note button. */
  annotation: boolean;
  /** Element picker button. */
  elementPicker: boolean;
  /**
   * Pause button. Shown during running AND paused (the glue layer swaps
   * the label between "Pause" and "Resume"). Pre-session it is absent.
   */
  pause: boolean;
  /**
   * Download button — finalise + zip + browser download. Replaces the
   * legacy Stop verb. Only appears in `paused` state when the timeline
   * has at least one material event.
   */
  download: boolean;
  /**
   * Clear button — irreversibly drops the session and returns to
   * pre-session. Replaces the legacy Discard + Reset verbs. Only
   * appears in `paused` state when the timeline has at least one
   * material event. Like Discard, it shows a destructive confirmation
   * dialog before proceeding.
   */
  clear: boolean;
  /**
   * End button — signals the attached CLI listener that the session is
   * complete. Reuses the existing STOP_SESSION + EXPORT_SESSION path,
   * which already routes through the handoff branch when a handoff
   * config is present (feature #14 phase 2). Only appears in `paused`
   * state when a CLI listener is attached.
   */
  end: boolean;
  /** The "paused" badge in the metrics row. */
  pausedBadge: boolean;
  /**
   * "Attach CLI listener" affordance — the feature-14 phase-1 paste row
   * that accepts a `<listener-url> <token>` string from the CLI's
   * stdout. Visible pre-session only (idle/stopped); hidden mid-session
   * so the user cannot retarget a running recording to a different
   * listener.
   */
  attachCliListener: boolean;
}

export interface ControlsModelInputs {
  status: SessionStatus;
  hasResidualState: boolean;
  /**
   * Whether the timeline has at least one material event. Pause/Resume
   * markers do NOT count — see countMaterialEvents.
   */
  hasEvents: boolean;
  /**
   * Whether a CLI handoff listener is currently attached. Determines
   * whether the End exit appears in paused state.
   */
  listenerAttached: boolean;
}

/**
 * Compute the control visibility shape for a given (status, residual,
 * hasEvents, listenerAttached) combination. This is the single source
 * of truth for "what shows up in the side panel form".
 */
export function buildControlsModel(
  inputs: ControlsModelInputs,
): ControlVisibility {
  const { status, hasResidualState, hasEvents, listenerAttached } = inputs;
  const preSession = status === "idle" || status === "stopped";
  const lifecycleVisible = status === "running" || status === "paused";
  const isPaused = status === "paused";

  return {
    start: preSession,
    piiMode: preSession,
    piiIndicator: !preSession,
    metrics: true,
    emptyStateHint: preSession && !hasResidualState,
    annotation: lifecycleVisible,
    elementPicker: lifecycleVisible,
    pause: lifecycleVisible,
    // Feature-17: contextual exits — paused-only, gated on event count
    // for Download/Clear and on listener attachment for End.
    download: isPaused && hasEvents,
    clear: isPaused && hasEvents,
    end: isPaused && listenerAttached,
    pausedBadge: status === "paused",
    attachCliListener: preSession,
  };
}

/**
 * Count timeline events that contribute to "the user has captured
 * something worth shipping or discarding". Pause/Resume markers are
 * bookkeeping, not material events — an empty-paused session shows
 * only the Resume affordance because no Download or Clear is meaningful.
 */
export function countMaterialEvents(events: TimelineEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type === "session_paused" || event.type === "session_resumed") {
      continue;
    }
    count++;
  }
  return count;
}
