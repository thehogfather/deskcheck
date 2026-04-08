import type { PiiCaptureMode, InputMetadata } from "./lib/pii-modes";

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

export type TimelineEvent =
  | InteractionEvent
  | ViewportResizeEvent
  | NetworkErrorEvent
  | ConsoleErrorEvent
  | JsExceptionEvent
  | AnnotationEvent
  | ScreenshotEvent;

// ── Export Schema ──

export interface SessionExport {
  schema_version: "1.1.0";
  session: SessionMetadata;
  timeline: TimelineEvent[];
  summary: SessionSummary;
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
  | { type: "SESSION_STATE"; recording: boolean; sessionId: string | null; activeTabId: number | null }
  | { type: "START_SESSION"; tabId: number; url: string; viewport: Viewport; piiMode?: PiiCaptureMode }
  | { type: "STOP_SESSION" }
  | { type: "PAUSE_SESSION" }
  | { type: "RESUME_SESSION" }
  | { type: "SESSION_STARTED"; sessionId: string; piiMode: PiiCaptureMode }
  | { type: "SESSION_STOPPED" }
  | { type: "RECORD_EVENT"; event: TimelineEventInput }
  | { type: "TAKE_SCREENSHOT"; trigger: ScreenshotEvent["trigger"] }
  | { type: "EXPORT_SESSION" }
  | { type: "ADD_ANNOTATION"; text: string; element?: ElementInfo; elementScreenshotData?: string }
  | { type: "START_ELEMENT_PICKER" }
  | { type: "CANCEL_ELEMENT_PICKER" }
  | { type: "PICK_ELEMENT_RESULT"; element: ElementInfo | null; devicePixelRatio: number };

export type { PiiCaptureMode, InputMetadata } from "./lib/pii-modes";
