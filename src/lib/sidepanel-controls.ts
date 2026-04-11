// Pure view-model for the side panel's control region. Takes the
// current session status and residual-state flag and returns a
// declarative shape describing which controls should be rendered.
// The panel glue layer (sidepanel.ts) mounts/unmounts DOM nodes
// from this shape — NEVER toggling `display: none`. The feature #11
// DoD requires hidden controls to be "absent from the DOM, not
// merely disabled", which is enforced structurally by appending vs
// removing children, not by styling.
//
// Zero DOM, zero Chrome APIs. Trivial to unit-test exhaustively
// across the (status × residual) product.

import type { SessionStatus } from "./session-status";
import {
  isLifecycleControlVisible,
  isResetEligible,
} from "./session-status";

export interface ControlVisibility {
  /** Start button — shown pre-session (idle/stopped). */
  start: boolean;
  /** PII mode fieldset — always shown. */
  piiMode: boolean;
  /** Metrics row (duration, counts, size) — always shown. */
  metrics: boolean;
  /** Empty-state hint — shown pre-session. */
  emptyStateHint: boolean;
  /** Annotation textarea + add-note button. */
  annotation: boolean;
  /** Element picker button. */
  elementPicker: boolean;
  /** Pause button (label swaps between "Pause" and "Resume" in the glue layer). */
  pause: boolean;
  /** Stop & Download button. */
  stop: boolean;
  /** Discard button. */
  discard: boolean;
  /** Reset button — shown only when eligible AND residual state exists. */
  reset: boolean;
  /** The "paused" badge in the metrics row. */
  pausedBadge: boolean;
  /**
   * "Attach CLI listener" affordance — the feature-14 phase-1 paste row
   * that accepts a `<listener-url> <token>` string from the CLI's
   * stdout. Visible pre-session only (idle/stopped); hidden mid-session
   * so the user cannot retarget a running recording to a different
   * listener. The attached state is read from chrome.storage.local on
   * mount, not recomputed here.
   */
  attachCliListener: boolean;
}

export interface ControlsModelInputs {
  status: SessionStatus;
  hasResidualState: boolean;
}

/**
 * Compute the control visibility shape for a given (status, residual)
 * combination. This is the single source of truth for "what shows up
 * in the side panel form".
 */
export function buildControlsModel(
  inputs: ControlsModelInputs,
): ControlVisibility {
  const { status, hasResidualState } = inputs;
  const lifecycleVisible = isLifecycleControlVisible(status);
  const preSession = status === "idle" || status === "stopped";

  return {
    start: preSession,
    piiMode: true,
    metrics: true,
    emptyStateHint: preSession && !hasResidualState,
    annotation: lifecycleVisible,
    elementPicker: lifecycleVisible,
    pause: lifecycleVisible,
    stop: lifecycleVisible,
    discard: lifecycleVisible,
    // Reset only appears when there is actually something to clear.
    // An `idle` session with no residual state shows just Start.
    reset: isResetEligible(status) && hasResidualState,
    pausedBadge: status === "paused",
    // CLI listener paste affordance — pre-session only.
    attachCliListener: preSession,
  };
}
