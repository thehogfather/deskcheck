import { Message, TimelineEventInput } from "../types";
import { STORAGE_SESSION } from "../constants";
import { startRecording } from "./recorder";
import { showWidget, hideWidget, focusWidget } from "./widget";
import {
  DEFAULT_PII_MODE,
  parsePiiMode,
  type PiiCaptureMode,
} from "../lib/pii-modes";

// Prevent duplicate injection (manifest + programmatic)
const GUARD = "__deskcheck_loaded__";
if (!(window as any)[GUARD]) {
  (window as any)[GUARD] = true;
  init();
}

function init() {
  let stopRecording: (() => void) | null = null;
  let isRecording = false;

  let sendFailCount = 0;
  function sendEvent(event: TimelineEventInput) {
    chrome.runtime
      .sendMessage({ type: "RECORD_EVENT", event } as Message)
      .then(() => { sendFailCount = 0; })
      .catch((err) => {
        sendFailCount++;
        if (sendFailCount === 1 || sendFailCount % 50 === 0) {
          console.warn(`[DeskCheck] Failed to send event (failures: ${sendFailCount}):`, err);
        }
      });
  }

  function startSession(piiMode: PiiCaptureMode = DEFAULT_PII_MODE) {
    if (isRecording) return;
    isRecording = true;
    stopRecording = startRecording(sendEvent, { piiMode });
    showWidget();
  }

  function stopSession() {
    if (!isRecording) return;
    isRecording = false;
    stopRecording?.();
    stopRecording = null;
    hideWidget();
  }

  // ── Primary: listen for messages from service worker ──
  // SESSION_STARTED is only sent to the active tab, so this is already scoped

  chrome.runtime.onMessage.addListener((msg: Message) => {
    if (msg.type === "SESSION_STARTED") {
      startSession(parsePiiMode(msg.piiMode));
    } else if (msg.type === "SESSION_STOPPED") {
      stopSession();
    } else if (msg.type === "FOCUS_ANNOTATION") {
      focusWidget();
    }
  });

  // ── Fallback 1: check on content script load ──
  // Only start if this is the active session tab

  chrome.runtime
    .sendMessage({ type: "GET_SESSION_STATE" } as Message)
    .then(async (response) => {
      if (response?.recording) {
        // Verify we're on the right tab by checking if the service worker
        // will accept our events (it filters by sender.tab.id)
        startSession(parsePiiMode(response.piiMode));
      }
    })
    .catch((err) => {
      console.warn("[DeskCheck] Could not check session state:", err);
    });

  // ── Fallback 2: watch storage for session changes ──
  // When a new session appears, only start if this tab matches

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (STORAGE_SESSION in changes) {
      const newSession = changes[STORAGE_SESSION].newValue;
      const oldSession = changes[STORAGE_SESSION].oldValue;

      if (newSession?.end_time && isRecording) {
        stopSession();
      } else if (!newSession && oldSession && isRecording) {
        stopSession();
      }
      // For new sessions, don't auto-start from storage.onChanged.
      // The service worker sends SESSION_STARTED only to the target tab,
      // and programmatically injects the content script there.
      // This prevents other tabs from activating.
    }
  });
}
