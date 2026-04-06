import { TimelineEventInput } from "../types";

type EventCallback = (event: TimelineEventInput) => void;

const CDP_VERSION = "1.3";

let attachedTabId: number | null = null;
let onEventCallback: EventCallback | null = null;
let pageUrl = "";

// Track request URLs for correlating responses
const requestUrls = new Map<string, { url: string; method: string }>();

export async function attach(
  tabId: number,
  currentUrl: string,
  onEvent: EventCallback,
): Promise<void> {
  attachedTabId = tabId;
  onEventCallback = onEvent;
  pageUrl = currentUrl;

  await chrome.debugger.attach({ tabId }, CDP_VERSION);
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  await chrome.debugger.sendCommand({ tabId }, "Log.enable");
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");

  chrome.debugger.onEvent.addListener(handleCdpEvent);
  chrome.debugger.onDetach.addListener(handleDetach);
}

export async function detach(): Promise<void> {
  if (attachedTabId !== null) {
    try {
      await chrome.debugger.detach({ tabId: attachedTabId });
    } catch {
      // Already detached
    }
  }
  chrome.debugger.onEvent.removeListener(handleCdpEvent);
  chrome.debugger.onDetach.removeListener(handleDetach);
  attachedTabId = null;
  onEventCallback = null;
  requestUrls.clear();
}

export function updatePageUrl(url: string) {
  pageUrl = url;
}

function emit(event: TimelineEventInput) {
  onEventCallback?.(event);
}

function isExtensionUrl(url: string | undefined): boolean {
  return !!url && url.startsWith("chrome-extension://");
}

function handleCdpEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, any>,
) {
  if (source.tabId !== attachedTabId || !params) return;

  const now = new Date().toISOString();

  switch (method) {
    // ── Network: track requests ──
    case "Network.requestWillBeSent": {
      const { requestId, request } = params;
      // Skip requests from other Chrome extensions
      if (isExtensionUrl(request.url)) break;
      requestUrls.set(requestId, {
        url: request.url,
        method: request.method,
      });
      break;
    }

    // ── Network: capture failed responses (4xx, 5xx) ──
    case "Network.responseReceived": {
      const { requestId, response } = params;
      const status = response.status as number;
      if (status >= 400) {
        const req = requestUrls.get(requestId);
        emit({
          timestamp: now,
          type: "network_error",
          method: req?.method ?? "GET",
          url: response.url ?? req?.url ?? "",
          status,
          status_text: response.statusText ?? "",
          request_headers: response.requestHeaders ?? {},
          page_url: pageUrl,
        });
      }
      requestUrls.delete(requestId);
      break;
    }

    // ── Network: loading failures (aborted, DNS, etc) ──
    case "Network.loadingFailed": {
      const { requestId, errorText } = params;
      const req = requestUrls.get(requestId);
      if (req) {
        emit({
          timestamp: now,
          type: "network_error",
          method: req.method,
          url: req.url,
          status: 0,
          status_text: errorText ?? "Loading failed",
          request_headers: {},
          page_url: pageUrl,
        });
      }
      requestUrls.delete(requestId);
      break;
    }

    // ── Console: errors and warnings via Log domain ──
    case "Log.entryAdded": {
      const entry = params.entry;
      // Skip logs from other Chrome extensions
      if (isExtensionUrl(entry.url)) break;
      if (entry.level === "error" || entry.level === "warning") {
        emit({
          timestamp: now,
          type: "console_error",
          level: entry.level as "error" | "warning",
          message: entry.text ?? "",
          stack_trace: entry.stackTrace
            ? formatStackTrace(entry.stackTrace)
            : undefined,
          page_url: pageUrl,
        });
      }
      break;
    }

    // ── Runtime: uncaught exceptions ──
    case "Runtime.exceptionThrown": {
      const { exceptionDetails } = params;
      // Skip exceptions from other Chrome extensions
      if (isExtensionUrl(exceptionDetails.url)) break;
      const exception = exceptionDetails.exception;
      const message =
        exception?.description ??
        exceptionDetails.text ??
        "Unknown exception";
      emit({
        timestamp: now,
        type: "js_exception",
        message,
        stack_trace: exceptionDetails.stackTrace
          ? formatStackTrace(exceptionDetails.stackTrace)
          : message,
        source_url: exceptionDetails.url,
        line: exceptionDetails.lineNumber,
        column: exceptionDetails.columnNumber,
        page_url: pageUrl,
      });
      break;
    }
  }
}

function handleDetach(
  source: chrome.debugger.Debuggee,
  reason: string,
) {
  if (source.tabId !== attachedTabId) return;
  console.warn("[Examiner] Debugger detached:", reason);
  // Emit a note in the timeline so the user knows DevTools capture was interrupted
  emit({
    timestamp: new Date().toISOString(),
    type: "console_error",
    level: "warning",
    message: `[Examiner] DevTools capture interrupted: ${reason}. Console and network errors may not be recorded until session restart.`,
    page_url: pageUrl,
  });
  attachedTabId = null;
}

function formatStackTrace(
  stackTrace: { callFrames: Array<{ functionName: string; url: string; lineNumber: number; columnNumber: number }> },
): string {
  return stackTrace.callFrames
    .map(
      (f) =>
        `  at ${f.functionName || "(anonymous)"} (${f.url}:${f.lineNumber}:${f.columnNumber})`,
    )
    .join("\n");
}
