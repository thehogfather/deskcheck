// Storage keys
export const STORAGE_SESSION = "deskcheck_session";
export const STORAGE_EVENTS = "deskcheck_events";
export const STORAGE_SCREENSHOTS = "deskcheck_screenshots";
export const STORAGE_PRIVACY_FIRST_RUN_SEEN = "deskcheck_privacy_first_run_seen";

// CDP domains to enable
export const CDP_DOMAINS = ["Network", "Log", "Runtime"] as const;

// Throttle intervals (ms)
export const SCROLL_THROTTLE = 1000;
export const RESIZE_THROTTLE = 500;

// Session metrics
export const SIZE_WARNING_BYTES = 50 * 1024 * 1024; // 50 MB
export const METRICS_POLL_INTERVAL_MS = 2000;
