import { TimelineEventInput } from "../types";

type EventCallback = (event: TimelineEventInput) => void;

const CDP_VERSION = "1.3";

export function isExtensionUrl(url: string | undefined): boolean {
  return !!url && url.startsWith("chrome-extension://");
}

export function formatStackTrace(
  stackTrace: {
    callFrames: Array<{
      functionName: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    }>;
  },
): string {
  return stackTrace.callFrames
    .map(
      (f) =>
        `  at ${f.functionName || "(anonymous)"} (${f.url}:${f.lineNumber}:${f.columnNumber})`,
    )
    .join("\n");
}

export class DebuggerClient {
  private attachedTabId: number | null = null;
  private onEvent: EventCallback | null = null;
  private pageUrl = "";
  private requestUrls = new Map<string, { url: string; method: string }>();

  // Bind handlers so they can be added/removed as listeners
  private handleCdpEvent = this._handleCdpEvent.bind(this);
  private handleDetach = this._handleDetach.bind(this);

  async attach(
    tabId: number,
    currentUrl: string,
    onEvent: EventCallback,
  ): Promise<void> {
    this.attachedTabId = tabId;
    this.onEvent = onEvent;
    this.pageUrl = currentUrl;

    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
    await chrome.debugger.sendCommand({ tabId }, "Log.enable");
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");

    chrome.debugger.onEvent.addListener(this.handleCdpEvent);
    chrome.debugger.onDetach.addListener(this.handleDetach);
  }

  async detach(): Promise<void> {
    if (this.attachedTabId !== null) {
      try {
        await chrome.debugger.detach({ tabId: this.attachedTabId });
      } catch {
        // Already detached
      }
    }
    chrome.debugger.onEvent.removeListener(this.handleCdpEvent);
    chrome.debugger.onDetach.removeListener(this.handleDetach);
    this.attachedTabId = null;
    this.onEvent = null;
    this.requestUrls.clear();
  }

  updatePageUrl(url: string) {
    this.pageUrl = url;
  }

  private emit(event: TimelineEventInput) {
    this.onEvent?.(event);
  }

  private _handleCdpEvent(
    source: chrome.debugger.Debuggee,
    method: string,
    params?: Record<string, any>,
  ) {
    if (source.tabId !== this.attachedTabId || !params) return;

    const now = new Date().toISOString();

    switch (method) {
      case "Network.requestWillBeSent": {
        const { requestId, request } = params;
        if (isExtensionUrl(request.url)) break;
        this.requestUrls.set(requestId, {
          url: request.url,
          method: request.method,
        });
        break;
      }

      case "Network.responseReceived": {
        const { requestId, response } = params;
        const status = response.status as number;
        if (status >= 400) {
          const req = this.requestUrls.get(requestId);
          this.emit({
            timestamp: now,
            type: "network_error",
            method: req?.method ?? "GET",
            url: response.url ?? req?.url ?? "",
            status,
            status_text: response.statusText ?? "",
            request_headers: response.requestHeaders ?? {},
            page_url: this.pageUrl,
          });
        }
        this.requestUrls.delete(requestId);
        break;
      }

      case "Network.loadingFailed": {
        const { requestId, errorText } = params;
        const req = this.requestUrls.get(requestId);
        if (req) {
          this.emit({
            timestamp: now,
            type: "network_error",
            method: req.method,
            url: req.url,
            status: 0,
            status_text: errorText ?? "Loading failed",
            request_headers: {},
            page_url: this.pageUrl,
          });
        }
        this.requestUrls.delete(requestId);
        break;
      }

      case "Log.entryAdded": {
        const entry = params.entry;
        if (isExtensionUrl(entry.url)) break;
        if (entry.level === "error" || entry.level === "warning") {
          this.emit({
            timestamp: now,
            type: "console_error",
            level: entry.level as "error" | "warning",
            message: entry.text ?? "",
            stack_trace: entry.stackTrace
              ? formatStackTrace(entry.stackTrace)
              : undefined,
            page_url: this.pageUrl,
          });
        }
        break;
      }

      case "Runtime.exceptionThrown": {
        const { exceptionDetails } = params;
        if (isExtensionUrl(exceptionDetails.url)) break;
        const exception = exceptionDetails.exception;
        const message =
          exception?.description ??
          exceptionDetails.text ??
          "Unknown exception";
        this.emit({
          timestamp: now,
          type: "js_exception",
          message,
          stack_trace: exceptionDetails.stackTrace
            ? formatStackTrace(exceptionDetails.stackTrace)
            : message,
          source_url: exceptionDetails.url,
          line: exceptionDetails.lineNumber,
          column: exceptionDetails.columnNumber,
          page_url: this.pageUrl,
        });
        break;
      }
    }
  }

  private _handleDetach(
    source: chrome.debugger.Debuggee,
    reason: string,
  ) {
    if (source.tabId !== this.attachedTabId) return;
    console.warn("[DeskCheck] Debugger detached:", reason);
    this.emit({
      timestamp: new Date().toISOString(),
      type: "console_error",
      level: "warning",
      message: `[DeskCheck] DevTools capture interrupted: ${reason}. Console and network errors may not be recorded until session restart.`,
      page_url: this.pageUrl,
    });
    this.attachedTabId = null;
  }
}
