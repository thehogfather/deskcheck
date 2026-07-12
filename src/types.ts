import type { PiiCaptureMode, InputMetadata } from "./lib/pii-modes";
import type { SessionStatus } from "./lib/session-status";

// ── Session ──

export interface SessionMetadata {
  id: string;
  tab_id: number;
  start_time: string;
  end_time: string | null;
  duration_ms: number | null;
  initial_url: string;
  user_agent: string;
  viewport: Viewport;
  pii_mode: PiiCaptureMode;
  /**
   * Lifecycle state of the session. Written on every transition
   * (running → paused → running → stopped). Legacy sessions written
   * before schema 1.2.0 default to `"running"` if `end_time` is null
   * and `"stopped"` otherwise — legacy compat lives in
   * `session-store.getSession()`.
   *
   * Note: `"idle"` is never persisted. When the session metadata key
   * is absent the reader infers idle.
   */
  status: Exclude<SessionStatus, "idle">;
}

export interface Viewport {
  width: number;
  height: number;
}

// ── Timeline Events ──

interface BaseEvent {
  seq: number;
  timestamp: string;
  page_url: string;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementInfo {
  tag: string;
  id?: string;
  class?: string;
  text?: string;
  selector: string;
  bounding_box?: BoundingBox;
}

export interface InteractionEvent extends BaseEvent {
  type: "interaction";
  subtype: "click" | "input" | "scroll" | "navigation";
  element?: ElementInfo;
  coordinates?: { x: number; y: number };
  value?: string;
  value_metadata?: InputMetadata;
  scroll_position?: { x: number; y: number };
  from_url?: string;
  to_url?: string;
}

export interface ViewportResizeEvent extends BaseEvent {
  type: "viewport_resize";
  from: Viewport;
  to: Viewport;
}

export interface NetworkErrorEvent extends BaseEvent {
  type: "network_error";
  method: string;
  url: string;
  status: number;
  status_text: string;
  request_headers: Record<string, string>;
  response_body_preview?: string;
}

export interface ConsoleErrorEvent extends BaseEvent {
  type: "console_error";
  level: "error" | "warning";
  message: string;
  stack_trace?: string;
}

export interface JsExceptionEvent extends BaseEvent {
  type: "js_exception";
  message: string;
  stack_trace: string;
  source_url?: string;
  line?: number;
  column?: number;
}

export interface AnnotationEvent extends BaseEvent {
  type: "annotation";
  text: string;
  element?: ElementInfo;
  screenshot_id: string;
  element_screenshot_id?: string;
}

export interface ScreenshotEvent extends BaseEvent {
  type: "screenshot";
  id: string;
  file: string;
  viewport: Viewport;
  trigger: "annotation" | "navigation" | "manual";
}

/**
 * Marker written to the timeline when the user pauses capture via the
 * side panel. Paired with a `session_resumed` marker (or the end of
 * the session) so exported zips are self-describing about gaps in
 * coverage. No payload — the timestamp is the signal.
 */
export interface SessionPausedEvent extends BaseEvent {
  type: "session_paused";
}

/**
 * Marker written to the timeline when the user resumes capture after
 * a pause. See SessionPausedEvent for the paired semantics.
 */
export interface SessionResumedEvent extends BaseEvent {
  type: "session_resumed";
}

/**
 * Written when the user opts to move the active recording from one tab
 * to another (feature #7). The recording pointer — chrome.debugger
 * attachment, content-script injection, and screenshot target — moves
 * to `to_tab_id` at this timestamp. Events since the previous marker
 * (or session start) belong to `from_tab_id`; events after this marker
 * belong to `to_tab_id` until the next marker. `page_url` mirrors
 * `to_url` so the base-field invariant ("the page the event happened on")
 * points at the tab the recording lives on once the switch completes.
 *
 * The switch is always explicit and user-initiated — DeskCheck never
 * follows the user across tabs implicitly (feature #7 privacy invariant).
 *
 * Added in schema 1.3.0.
 */
export interface TabSwitchEvent extends BaseEvent {
  type: "tab_switch";
  from_tab_id: number | null;
  from_url: string;
  to_tab_id: number;
  to_url: string;
}

export type TimelineEvent =
  | InteractionEvent
  | ViewportResizeEvent
  | NetworkErrorEvent
  | ConsoleErrorEvent
  | JsExceptionEvent
  | AnnotationEvent
  | ScreenshotEvent
  | SessionPausedEvent
  | SessionResumedEvent
  | TabSwitchEvent;

// ── Export Schema ──

export interface SessionExport {
  schema_version: "1.3.0";
  session: SessionMetadata;
  timeline: TimelineEvent[];
  summary: SessionSummary;
}

/**
 * One contiguous segment of the recording bound to a single tab.
 *
 * Segments are delimited by `tab_switch` events: the recording starts on
 * the session's initial tab and a new segment begins after each switch.
 * Switching back to a previously-recorded tab opens a fresh segment — the
 * list is timeline-ordered, not deduplicated by tab. Added in schema
 * 1.3.0 (feature #7).
 */
export interface TabSummary {
  /** URL the recording was bound to for this segment. */
  url: string;
  /** Number of timeline events captured while bound to this tab. */
  events: number;
}

export interface SessionSummary {
  total_events: number;
  annotations: number;
  console_errors: number;
  console_warnings: number;
  network_failures: number;
  js_exceptions: number;
  screenshots: number;
  pages_visited: string[];
  /**
   * Per-tab breakdown of the timeline, one entry per contiguous recording
   * segment (see TabSummary). For a single-tab session this is one entry.
   * Added in schema 1.3.0 (feature #7).
   */
  tabs: TabSummary[];
}

// ── Messages (content script <-> service worker) ──

// Distributive Omit that preserves union discrimination
type DistributiveOmit<T, K extends keyof any> = T extends any
  ? Omit<T, K>
  : never;

export type TimelineEventInput = DistributiveOmit<TimelineEvent, "seq">;

export interface SessionMetrics {
  startTime: string;
  eventCount: number;
  screenshotCount: number;
  eventsSizeBytes: number;
  screenshotsSizeBytes: number;
}

export type Message =
  | { type: "GET_SESSION_STATE" }
  | { type: "GET_SESSION_METRICS" }
  | { type: "GET_EVENTS_SNAPSHOT" }
  | { type: "SESSION_STATE"; recording: boolean; sessionId: string | null; activeTabId: number | null }
  | { type: "START_SESSION"; tabId: number; url: string; viewport: Viewport; piiMode?: PiiCaptureMode }
  | { type: "STOP_SESSION" }
  | { type: "PAUSE_SESSION" }
  | { type: "RESUME_SESSION" }
  // Feature #7: opt-in tab switching. Sent by the side panel when the
  // user, while on a tab the session is NOT recording, clicks "Switch
  // recording here". The service worker moves the debugger + content
  // script + screenshot target to `tabId` and logs a `tab_switch` event.
  | { type: "SWITCH_RECORDING_TAB"; tabId: number }
  | { type: "DISCARD_SESSION" }
  | { type: "RESET_SESSION" }
  | { type: "SESSION_STARTED"; sessionId: string; piiMode: PiiCaptureMode }
  | { type: "SESSION_STOPPED" }
  | { type: "RECORD_EVENT"; event: TimelineEventInput }
  | { type: "TAKE_SCREENSHOT"; trigger: ScreenshotEvent["trigger"] }
  | { type: "EXPORT_SESSION" }
  | { type: "ADD_ANNOTATION"; text: string; element?: ElementInfo; elementScreenshotData?: string }
  | { type: "START_ELEMENT_PICKER" }
  | { type: "CANCEL_ELEMENT_PICKER" }
  | { type: "PICK_ELEMENT_RESULT"; element: ElementInfo | null; devicePixelRatio: number }
  // ── Live broadcasts from the service worker to the side panel ──
  // After feature #5 moved events out of chrome.storage.local into OPFS,
  // the side panel can no longer subscribe to a storage key for live
  // updates. The SW broadcasts these messages instead. The side panel's
  // sidepanel-events-source.ts subscribes via chrome.runtime.onMessage.
  | { type: "EVENT_APPENDED"; event: TimelineEvent }
  | { type: "SCREENSHOT_APPENDED"; id: string; dataUrl: string }
  | { type: "SESSION_CLEARED" }
  // Feature #7: broadcast after the recording pointer moves to a new
  // tab so every open side panel can re-evaluate whether it is sitting
  // on the recording tab (and show/clear the "switch recording here"
  // offer accordingly). Only sent on a successful switch — session end
  // is signalled via session-storage changes, not this message.
  | { type: "RECORDING_TAB_CHANGED"; tabId: number }
  // Feature #14 phase 1: the service worker broadcasts this when the CLI
  // handoff path fell through (listener unreachable, rejected, or the
  // final download fallback also failed). The side panel renders the
  // message in the existing #async-error slot so the user knows the
  // export did not land at the listener even though the Stop click
  // appeared to succeed.
  | { type: "EXPORT_WARNING"; message: string }
  // Feature #14 phase 2: marker-detector -> SW -> side panel handoff wiring
  | { type: "MARKER_DETECTED"; marker: { sessionId: string; token: string; port: number }; tabId: number | null }
  | { type: "GET_PENDING_HANDOFF" }
  | { type: "CANCEL_PENDING_HANDOFF"; tabId: number }
  | { type: "PENDING_HANDOFF_CHANGED"; pending: import("./lib/pending-handoff-store").PendingHandoffConfig | null; active: import("./lib/handoff").HandoffConfig | null };

export type { PiiCaptureMode, InputMetadata } from "./lib/pii-modes";
