// chrome.storage.local keys. As of feature-5 (OPFS persistence), events
// and screenshots are no longer kept in chrome.storage.local — they live
// in OPFS under `/sessions/<id>/`. Only session metadata and the
// first-run flag remain here.
export const STORAGE_SESSION = "deskcheck_session";
export const STORAGE_PRIVACY_FIRST_RUN_SEEN = "deskcheck_privacy_first_run_seen";
// Feature #14 phase 1: CLI handoff configuration. Holds the listener URL +
// bearer token once the user has pasted them from `deskcheck listen`'s
// ready line. Absence of this key is the opt-in kill switch — the service
// worker's export path never emits localhost traffic unless this key is
// present and its listener_url passes the loopback validator.
export const STORAGE_HANDOFF_CONFIG = "deskcheck_handoff";
export const STORAGE_PENDING_HANDOFFS = "deskcheck_pending_handoffs";

// Side panel entry point. The manifest intentionally has NO
// `side_panel.default_path` — a global default creates a
// Chrome-owned panel instance that overrides per-tab setOptions and
// ignores the documented tab-switch hide/show behaviour. This was
// tracked as an "Opening SidePanel with tabId Results in Global
// SidePanel" bug in the chrome-extensions-samples repo; the fix is
// to configure the panel exclusively via per-tab setOptions. The
// service worker sets this path per-tab on every action click and
// on every newly-created tab while a binding is active.
export const SIDEPANEL_PATH = "src/sidepanel/index.html";

// CDP domains to enable
export const CDP_DOMAINS = ["Network", "Log", "Runtime"] as const;

// Throttle intervals (ms)
export const SCROLL_THROTTLE = 1000;
export const RESIZE_THROTTLE = 500;

// Session metrics
export const SIZE_WARNING_BYTES = 50 * 1024 * 1024; // 50 MB
export const METRICS_POLL_INTERVAL_MS = 2000;
