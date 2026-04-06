import { ElementInfo } from "../types";
import { getElementInfo } from "../lib/dom-utils";

type PickerCallback = (info: ElementInfo | null) => void;

export function startPicker(onPick: PickerCallback): () => void {
  const host = document.createElement("div");
  host.id = "examiner-picker-host";
  const shadow = host.attachShadow({ mode: "closed" });

  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483647;
    cursor: crosshair;
  `;

  const highlight = document.createElement("div");
  highlight.style.cssText = `
    position: fixed; pointer-events: none;
    border: 2px solid #2563eb;
    background: rgba(37, 99, 235, 0.1);
    border-radius: 2px;
    z-index: 2147483647;
    transition: all 0.05s ease;
  `;

  const label = document.createElement("div");
  label.style.cssText = `
    position: fixed; pointer-events: none;
    background: #2563eb; color: white;
    font: 11px/1.4 monospace; padding: 2px 6px;
    border-radius: 2px; z-index: 2147483647;
    white-space: nowrap;
  `;

  shadow.appendChild(overlay);
  shadow.appendChild(highlight);
  shadow.appendChild(label);
  document.body.appendChild(host);

  let hoveredElement: Element | null = null;

  function getElementUnder(x: number, y: number): Element | null {
    overlay.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y);
    overlay.style.pointerEvents = "auto";
    if (el?.closest("#examiner-picker-host, #examiner-widget-host")) {
      return null;
    }
    return el;
  }

  function updateHighlight(el: Element) {
    const rect = el.getBoundingClientRect();
    highlight.style.top = `${rect.top}px`;
    highlight.style.left = `${rect.left}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    highlight.style.display = "block";

    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className
      ? `.${String(el.className).split(/\s+/).slice(0, 2).join(".")}`
      : "";
    label.textContent = `${tag}${id}${cls}`;
    label.style.top = `${Math.max(0, rect.top - 22)}px`;
    label.style.left = `${rect.left}px`;
    label.style.display = "block";
  }

  function handleMouseMove(e: MouseEvent) {
    const el = getElementUnder(e.clientX, e.clientY);
    if (el && el !== hoveredElement) {
      hoveredElement = el;
      updateHighlight(el);
    }
  }

  function handleClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const el = getElementUnder(e.clientX, e.clientY);
    cleanup();
    onPick(el ? getElementInfo(el, { includeBoundingBox: true }) : null);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      cleanup();
      onPick(null);
    }
  }

  overlay.addEventListener("mousemove", handleMouseMove);
  overlay.addEventListener("click", handleClick);
  document.addEventListener("keydown", handleKeyDown, true);

  function cleanup() {
    overlay.removeEventListener("mousemove", handleMouseMove);
    overlay.removeEventListener("click", handleClick);
    document.removeEventListener("keydown", handleKeyDown, true);
    host.remove();
  }

  return cleanup;
}
