import { Message } from "../types";

const toggleBtn = document.getElementById("toggle-session") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const errorBanner = document.getElementById("error-banner") as HTMLParagraphElement;
const sessionActions = document.getElementById("session-actions") as HTMLDivElement;
const screenshotBtn = document.getElementById("take-screenshot") as HTMLButtonElement;
const downloadBtn = document.getElementById("download-export") as HTMLButtonElement;

let recording = false;

async function sendMessage(msg: Message): Promise<any> {
  return chrome.runtime.sendMessage(msg);
}

function showError(text: string) {
  errorBanner.textContent = text;
  errorBanner.style.display = "block";
}

function clearError() {
  errorBanner.textContent = "";
  errorBanner.style.display = "none";
}

async function refreshState() {
  try {
    const state = await sendMessage({ type: "GET_SESSION_STATE" });
    recording = state?.recording ?? false;
    updateUI();
  } catch {
    recording = false;
    updateUI();
  }
}

function updateUI() {
  if (recording) {
    toggleBtn.textContent = "Stop Session";
    toggleBtn.classList.add("recording");
    statusEl.textContent = "Recording...";
    sessionActions.style.display = "flex";
    downloadBtn.style.display = "none";
  } else {
    toggleBtn.textContent = "Start Session";
    toggleBtn.classList.remove("recording");
    statusEl.textContent = "Ready";
    sessionActions.style.display = "none";
  }
}

// Show download button after stopping a session
function showDownload() {
  sessionActions.style.display = "flex";
  downloadBtn.style.display = "block";
  screenshotBtn.style.display = "none";
}

toggleBtn.addEventListener("click", async () => {
  clearError();
  try {
    if (recording) {
      await sendMessage({ type: "STOP_SESSION" });
      recording = false;
      updateUI();
      showDownload();
    } else {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id) return;
      const response = await sendMessage({
        type: "START_SESSION",
        tabId: tab.id,
        url: tab.url ?? "",
        viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
      });
      recording = true;
      updateUI();
      if (response?.warnings?.length) {
        showError(response.warnings.join(" "));
      }
    }
  } catch (e) {
    showError("Failed to toggle session.");
  }
});

screenshotBtn.addEventListener("click", async () => {
  clearError();
  try {
    const response = await sendMessage({ type: "TAKE_SCREENSHOT", trigger: "manual" });
    if (response?.screenshotId) {
      screenshotBtn.textContent = "Captured!";
    } else {
      showError("Screenshot failed — tab may not be visible.");
    }
  } catch {
    showError("Screenshot failed.");
  }
  setTimeout(() => {
    screenshotBtn.textContent = "Screenshot";
  }, 1000);
});

downloadBtn.addEventListener("click", async () => {
  clearError();
  downloadBtn.textContent = "Exporting...";
  downloadBtn.disabled = true;
  try {
    const response = await sendMessage({ type: "EXPORT_SESSION" });
    if (response?.error) {
      showError(`Export failed: ${response.error}`);
    }
  } catch {
    showError("Export failed.");
  }
  downloadBtn.textContent = "Download Report";
  downloadBtn.disabled = false;
});

refreshState();
