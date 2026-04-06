import { Message } from "../types";

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const downloadBtn = document.getElementById("download-btn") as HTMLButtonElement;

async function sendMessage(msg: Message): Promise<any> {
  return chrome.runtime.sendMessage(msg);
}

function showError(text: string) {
  statusEl.textContent = text;
  statusEl.classList.add("error");
}

async function refreshState() {
  try {
    const state = await sendMessage({ type: "GET_SESSION_STATE" });
    if (state?.recording) {
      statusEl.textContent = "Session active \u2014 use the overlay on the page.";
      startBtn.classList.add("hidden");
      downloadBtn.classList.add("hidden");
    } else if (state?.hasExportableSession) {
      statusEl.textContent = "";
      startBtn.classList.remove("hidden");
      downloadBtn.classList.remove("hidden");
    } else {
      statusEl.textContent = "";
      startBtn.classList.remove("hidden");
      downloadBtn.classList.add("hidden");
    }
  } catch {
    // Service worker not ready
  }
}

startBtn.addEventListener("click", async () => {
  statusEl.textContent = "";
  statusEl.classList.remove("error");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const response = await sendMessage({
      type: "START_SESSION",
      tabId: tab.id,
      url: tab.url ?? "",
      viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
    });
    if (response?.warnings?.length) {
      showError(response.warnings.join(" "));
    } else {
      window.close();
    }
  } catch {
    showError("Failed to start session.");
  }
});

downloadBtn.addEventListener("click", async () => {
  statusEl.textContent = "";
  statusEl.classList.remove("error");
  downloadBtn.textContent = "Exporting...";
  downloadBtn.disabled = true;
  try {
    const response = await sendMessage({ type: "EXPORT_SESSION" });
    if (response?.error) {
      showError(`Export failed: ${response.error}`);
    } else {
      downloadBtn.classList.add("hidden");
    }
  } catch (e) {
    showError(`Export failed: ${e}`);
  }
  downloadBtn.textContent = "Download Report";
  downloadBtn.disabled = false;
});

refreshState();
