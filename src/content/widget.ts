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
  const shadow = widgetHost.attachShadow({ mode: "open" });
  widgetShadow = shadow;

  // Inject styles
  const style = document.createElement("style");
  style.textContent = widgetCss;
  shadow.appendChild(style);

  // Build widget DOM
  const recDot = el("span", { class: "deskcheck-rec-dot" });
  const titleSpan = el("span", { class: "deskcheck-header-title" }, [
    recDot,
    "DeskCheck",
  ]);
  const minimizeBtn = el("button", {
    class: "deskcheck-minimize",
    title: "Minimize",
  }, ["—"]);
  const header = el("div", { class: "deskcheck-header" }, [
    titleSpan,
    minimizeBtn,
  ]);

  const textarea = document.createElement("textarea");
  textarea.className = "deskcheck-textarea";
  textarea.placeholder = "What did you expect? What happened instead?";

  const elementContainer = el("div", { class: "deskcheck-element-container" });

  const pickBtn = el("button", { class: "deskcheck-btn" }, ["Select Element"]);
  const submitBtn = el(
    "button",
    { class: "deskcheck-btn deskcheck-btn-primary", disabled: "true" },
    ["Add Annotation"],
  );
  const actions = el("div", { class: "deskcheck-actions" }, [
    pickBtn,
    submitBtn,
  ]);

  const body = el("div", { class: "deskcheck-body" }, [
    textarea,
    elementContainer,
    actions,
  ]);

  const widget = el("div", { class: "deskcheck-widget" }, [header, body]);
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
    minimizeBtn.textContent = widget.classList.contains("minimized")
      ? "+"
      : "—";
  });

  // ── Element picker ──
  function showSelectedElement(info: ElementInfo) {
    elementContainer.replaceChildren();
    const label = `${info.tag}${info.id ? "#" + info.id : ""} → ${info.selector}`;
    const labelSpan = el("span", {}, [label]);
    const clearBtn = el("button", { title: "Remove" }, ["\u00d7"]);
    clearBtn.addEventListener("click", () => {
      selectedElement = null;
      elementContainer.replaceChildren();
    });
    const row = el("div", { class: "deskcheck-selected-element" }, [
      labelSpan,
      clearBtn,
    ]);
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

    // If element selected with bounding box, crop a screenshot of just that element
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

    await chrome.runtime.sendMessage({
      type: "ADD_ANNOTATION",
      text,
      element: selectedElement ?? undefined,
      elementScreenshotData,
    } as Message);

    // Reset form
    textarea.value = "";
    selectedElement = null;
    elementContainer.replaceChildren();
    submitBtn.textContent = "Add Annotation";
    updateSubmitState();
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
  const widget = widgetShadow.querySelector(".deskcheck-widget");
  if (widget?.classList.contains("minimized")) {
    widget.classList.remove("minimized");
    const btn = widgetShadow.querySelector(".deskcheck-minimize");
    if (btn) btn.textContent = "—";
  }
  const textarea = widgetShadow.querySelector(
    ".deskcheck-textarea",
  ) as HTMLTextAreaElement | null;
  textarea?.focus();
}
