import { Message, TimelineEventInput } from "../types";
import { STORAGE_SESSION } from "../constants";
import { startRecording } from "./recorder";
import { startPicker } from "./element-picker";
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
  let cancelPicker: (() => void) | null = null;

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
  }

  function stopSession() {
    if (!isRecording) return;
    isRecording = false;
    stopRecording?.();
    stopRecording = null;
    cancelPicker?.();
    cancelPicker = null;
  }

  // ── Element picker bridge ──
  // The side panel triggers the picker via START_ELEMENT_PICKER. The
  // picker overlay lives in the content script (closed Shadow DOM)
  // because it must hit-test elements on the page. Result is sent back
  // via chrome.runtime.sendMessage so the side panel can listen.
  function handleStartPicker() {
    cancelPicker?.();
    cancelPicker = startPicker((info) => {
      cancelPicker = null;
      const result: Message = {
        type: "PICK_ELEMENT_RESULT",
        element: info,
        devicePixelRatio: window.devicePixelRatio,
      };
      // Fire-and-forget; the side panel listens via runtime.onMessage.
      chrome.runtime.sendMessage(result).catch(() => {
        // Side panel may have closed mid-pick — drop silently.
      });
    });
  }

  // ── Primary: listen for messages from service worker / side panel ──

  chrome.runtime.onMessage.addListener((msg: Message) => {
    if (msg.type === "SESSION_STARTED") {
      startSession(parsePiiMode(msg.piiMode));
    } else if (msg.type === "SESSION_STOPPED") {
      stopSession();
    } else if (msg.type === "START_ELEMENT_PICKER") {
      handleStartPicker();
    } else if (msg.type === "CANCEL_ELEMENT_PICKER") {
      cancelPicker?.();
      cancelPicker = null;
    }
  });

  // ── Fallback 1: check on content script load ──
  // Only start if this is the active session tab

  chrome.runtime
    .sendMessage({ type: "GET_SESSION_STATE" } as Message)
    .then(async (response) => {
      if (response?.recording) {
        startSession(parsePiiMode(response.piiMode));
      }
    })
    .catch((err) => {
      console.warn("[DeskCheck] Could not check session state:", err);
    });

  // ── Fallback 2: watch storage for session changes ──

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
    }
  });
}
