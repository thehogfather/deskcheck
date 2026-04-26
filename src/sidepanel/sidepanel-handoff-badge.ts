// Pure view-model for the "Connected to terminal session <id>" badge.
// Feature #14 phase 2.
//
// Type-only interfaces are inlined to avoid importing the storage
// module (the S19 grep test structurally prevents it from being
// referenced in sidepanel files other than sidepanel.ts).

export interface PendingBadgeInput {
  session_id_hint: string;
  token: string;
}

export interface ActiveBadgeInput {
  listener_url: string;
  token: string;
}

export interface HandoffBadgeState {
  visible: boolean;
  sessionIdShort: string;
  tone: "armed" | "connected";
}

export function buildHandoffBadgeModel(
  pending: PendingBadgeInput | null,
  active: ActiveBadgeInput | null,
): HandoffBadgeState {
  if (active) {
    return {
      visible: true,
      sessionIdShort: "",
      tone: "connected",
    };
  }
  if (pending) {
    return {
      visible: true,
      sessionIdShort: pending.session_id_hint.slice(0, 8),
      tone: "armed",
    };
  }
  return { visible: false, sessionIdShort: "", tone: "armed" };
}
