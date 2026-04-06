import { Message } from "../types";

const toggleBtn = document.getElementById("toggle-session") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const sessionActions = document.getElementById("session-actions") as HTMLDivElement;
const screenshotBtn = document.getElementById("take-screenshot") as HTMLButtonElement;
const downloadBtn = document.getElementById("download-export") as HTMLButtonElement;

let recording = false;

async function sendMessage(msg: Message): Promise<any> {
  return chrome.runtime.sendMessage(msg);
}

async function refreshState() {
  const state = await sendMessage({ type: "GET_SESSION_STATE" });
  recording = state.recording;
  updateUI();
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
    await sendMessage({
      type: "START_SESSION",
      tabId: tab.id,
      url: tab.url ?? "",
      viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
    });
    recording = true;
    updateUI();
  }
});

screenshotBtn.addEventListener("click", async () => {
  screenshotBtn.textContent = "Captured!";
  await sendMessage({ type: "TAKE_SCREENSHOT", trigger: "manual" });
  setTimeout(() => {
    screenshotBtn.textContent = "Screenshot";
  }, 1000);
});

downloadBtn.addEventListener("click", async () => {
  downloadBtn.textContent = "Exporting...";
  downloadBtn.disabled = true;
  await sendMessage({ type: "EXPORT_SESSION" });
  downloadBtn.textContent = "Download Report";
  downloadBtn.disabled = false;
});

refreshState();
