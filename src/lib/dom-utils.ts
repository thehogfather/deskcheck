import { ElementInfo } from "../types";

// CSS.escape may not be available in test environments (jsdom)
const cssEscape = (s: string): string =>
  typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s;

export function getSelector(el: Element): string {
  if (el.id) return `#${cssEscape(el.id)}`;

  const testId = el.getAttribute("data-testid");
  if (testId) return `[data-testid="${cssEscape(testId)}"]`;

  for (const attr of el.attributes) {
    if (attr.name.startsWith("data-") && attr.name !== "data-testid") {
      return `[${attr.name}="${cssEscape(attr.value)}"]`;
    }
  }

  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (parent) {
      const currentTag = current.tagName;
      const siblings = Array.from(parent.children).filter(
        (s: Element) => s.tagName === currentTag,
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }
    parts.unshift(selector);
    current = parent;
    if (current?.id) {
      parts.unshift(`#${cssEscape(current.id)}`);
      break;
    }
  }
  return parts.join(" > ");
}

export function getElementInfo(
  el: Element,
  opts?: { includeBoundingBox?: boolean },
): ElementInfo {
  const info: ElementInfo = {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    class: el.className || undefined,
    text: (el.textContent ?? "").trim().slice(0, 100) || undefined,
    selector: getSelector(el),
  };
  if (opts?.includeBoundingBox) {
    const rect = el.getBoundingClientRect();
    info.bounding_box = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }
  return info;
}

export function isExaminerUi(el: Element): boolean {
  return (
    !!el.closest("#examiner-widget-host, #examiner-picker-host") ||
    el.id === "examiner-widget-host" ||
    el.id === "examiner-picker-host"
  );
}

export function throttle<T extends (...args: any[]) => void>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    }
  };
}
