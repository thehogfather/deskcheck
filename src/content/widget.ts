import { ElementInfo, Message } from "../types";
import { startPicker } from "./element-picker";
import { cropScreenshot } from "../lib/image-utils";
import widgetCss from "./widget.css?raw";

let widgetHost: HTMLElement | null = null;
let widgetShadow: ShadowRoot | null = null;
let cancelPicker: (() => void) | null = null;

function el(
  tag: string,
  attrs?: Record<string, string>,
  children?: (Node | string)[],
): HTMLElement {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else node.setAttribute(k, v);
    }
  }
  if (children) {
    for (const child of children) {
      node.appendChild(
        typeof child === "string" ? document.createTextNode(child) : child,
      );
    }
  }
  return node;
}

export function showWidget() {
  if (widgetHost) return;

  widgetHost = document.createElement("div");
  widgetHost.id = "deskcheck-widget-host";
  const shadow = widgetHost.attachShadow({ mode: "closed" });
  widgetShadow = shadow;

  // Inject styles
  const style = document.createElement("style");
  style.textContent = widgetCss;
  shadow.appendChild(style);

  // ── Header ──
  const recDot = el("span", { class: "dc-rec-dot" });
  const titleSpan = el("span", { class: "dc-header-title" }, [recDot, "DeskCheck"]);
  const minimizeBtn = el("button", { class: "dc-minimize", title: "Minimize" }, ["\u2014"]);
  const header = el("div", { class: "dc-header" }, [titleSpan, minimizeBtn]);

  // ── Annotation ──
  const textarea = document.createElement("textarea");
  textarea.className = "dc-textarea";
  textarea.placeholder = "What did you expect? What happened instead?";

  const elementContainer = el("div", { class: "dc-element-container" });

  const pickBtn = el("button", { class: "dc-btn" }, ["Select Element"]);
  const submitBtn = el("button", { class: "dc-btn dc-btn-primary", disabled: "true" }, ["Add Note"]);
  const annotationActions = el("div", { class: "dc-row" }, [pickBtn, submitBtn]);

  // ── Session controls ──
  const screenshotBtn = el("button", { class: "dc-btn" }, ["Screenshot"]);
  const stopBtn = el("button", { class: "dc-btn dc-btn-danger" }, ["Stop & Download"]);
  const sessionActions = el("div", { class: "dc-row" }, [screenshotBtn, stopBtn]);

  // ── Body ──
  const body = el("div", { class: "dc-body" }, [
    textarea,
    elementContainer,
    annotationActions,
    el("div", { class: "dc-divider" }),
    sessionActions,
  ]);

  const widget = el("div", { class: "dc-widget" }, [header, body]);
  shadow.appendChild(widget);
  document.body.appendChild(widgetHost);

  // ── State ──
  let selectedElement: ElementInfo | null = null;

  // ── Enable/disable submit ──
  function updateSubmitState() {
    (submitBtn as HTMLButtonElement).disabled = !textarea.value.trim();
  }
  textarea.addEventListener("input", updateSubmitState);

  // ── Minimize ──
  minimizeBtn.addEventListener("click", () => {
    widget.classList.toggle("minimized");
    minimizeBtn.textContent = widget.classList.contains("minimized") ? "+" : "\u2014";
  });

  // ── Element picker ──
  function showSelectedElement(info: ElementInfo) {
    elementContainer.replaceChildren();
    const label = `${info.tag}${info.id ? "#" + info.id : ""} \u2192 ${info.selector}`;
    const labelSpan = el("span", {}, [label]);
    const clearBtn = el("button", { title: "Remove" }, ["\u00d7"]);
    clearBtn.addEventListener("click", () => {
      selectedElement = null;
      elementContainer.replaceChildren();
    });
    const row = el("div", { class: "dc-selected-element" }, [labelSpan, clearBtn]);
    elementContainer.appendChild(row);
  }

  pickBtn.addEventListener("click", () => {
    if (cancelPicker) {
      cancelPicker();
      cancelPicker = null;
    }
    cancelPicker = startPicker((info) => {
      cancelPicker = null;
      if (info) {
        selectedElement = info;
        showSelectedElement(info);
      }
    });
  });

  // ── Submit annotation ──
  submitBtn.addEventListener("click", async () => {
    const text = textarea.value.trim();
    if (!text) return;

    (submitBtn as HTMLButtonElement).disabled = true;
    submitBtn.textContent = "Saving...";

    let elementScreenshotData: string | undefined;
    if (selectedElement?.bounding_box) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "TAKE_SCREENSHOT",
          trigger: "annotation",
        } as Message);
        if (response?.dataUrl) {
          elementScreenshotData = await cropScreenshot(
            response.dataUrl,
            selectedElement.bounding_box,
            window.devicePixelRatio,
          );
        }
      } catch {
        // Fall back to annotation without element screenshot
      }
    }

    try {
      await chrome.runtime.sendMessage({
        type: "ADD_ANNOTATION",
        text,
        element: selectedElement ?? undefined,
        elementScreenshotData,
      } as Message);

      textarea.value = "";
      selectedElement = null;
      elementContainer.replaceChildren();
      submitBtn.textContent = "Add Note";
      updateSubmitState();
    } catch {
      submitBtn.textContent = "Failed \u2014 retry?";
      (submitBtn as HTMLButtonElement).disabled = false;
    }
  });

  // ── Screenshot ──
  screenshotBtn.addEventListener("click", async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TAKE_SCREENSHOT",
        trigger: "manual",
      } as Message);
      screenshotBtn.textContent = response?.screenshotId ? "Captured!" : "Failed";
    } catch {
      screenshotBtn.textContent = "Failed";
    }
    setTimeout(() => { screenshotBtn.textContent = "Screenshot"; }, 1000);
  });

  // ── Stop & Download ──
  stopBtn.addEventListener("click", async () => {
    stopBtn.textContent = "Exporting...";
    (stopBtn as HTMLButtonElement).disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: "STOP_SESSION" } as Message);
      const response = await chrome.runtime.sendMessage({ type: "EXPORT_SESSION" } as Message);
      if (response?.error) {
        stopBtn.textContent = response.error;
      }
    } catch (e) {
      stopBtn.textContent = "Export failed";
    }
    // Widget will be removed by the session-stopped handler
  });
}

export function hideWidget() {
  cancelPicker?.();
  cancelPicker = null;
  widgetHost?.remove();
  widgetHost = null;
  widgetShadow = null;
}

export function focusWidget() {
  if (!widgetShadow) return;
  const widget = widgetShadow.querySelector(".dc-widget");
  if (widget?.classList.contains("minimized")) {
    widget.classList.remove("minimized");
    const btn = widgetShadow.querySelector(".dc-minimize");
    if (btn) btn.textContent = "\u2014";
  }
  const textarea = widgetShadow.querySelector(".dc-textarea") as HTMLTextAreaElement | null;
  textarea?.focus();
}
