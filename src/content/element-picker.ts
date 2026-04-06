import { ElementInfo } from "../types";

type PickerCallback = (info: ElementInfo | null) => void;

export function startPicker(onPick: PickerCallback): () => void {
  // Create shadow host for isolation
  const host = document.createElement("div");
  host.id = "examiner-picker-host";
  const shadow = host.attachShadow({ mode: "closed" });

  // Overlay that covers the entire page
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483647;
    cursor: crosshair;
  `;

  // Highlight box that follows the hovered element
  const highlight = document.createElement("div");
  highlight.style.cssText = `
    position: fixed; pointer-events: none;
    border: 2px solid #2563eb;
    background: rgba(37, 99, 235, 0.1);
    border-radius: 2px;
    z-index: 2147483647;
    transition: all 0.05s ease;
  `;

  // Label showing element tag/class
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
    // Temporarily hide overlay to find element underneath
    overlay.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y);
    overlay.style.pointerEvents = "auto";
    // Don't select our own UI
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

  function getSelector(el: Element): string {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const testId = el.getAttribute("data-testid");
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const parts: string[] = [];
    let current: Element | null = el;
    while (current && current !== document.documentElement) {
      let sel = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (parent) {
        const tag = current.tagName;
        const siblings = Array.from(parent.children).filter(
          (s: Element) => s.tagName === tag,
        );
        if (siblings.length > 1) {
          sel += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(sel);
      current = parent;
      if (current?.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
    }
    return parts.join(" > ");
  }

  function getElementInfo(el: Element): ElementInfo {
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      class: el.className || undefined,
      text: (el.textContent ?? "").trim().slice(0, 100) || undefined,
      selector: getSelector(el),
      bounding_box: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
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
    onPick(el ? getElementInfo(el) : null);
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
