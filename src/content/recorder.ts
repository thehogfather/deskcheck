import { ElementInfo, TimelineEventInput, Viewport } from "../types";
import { SCROLL_THROTTLE, RESIZE_THROTTLE } from "../constants";

type EventCallback = (event: TimelineEventInput) => void;

// ── CSS Selector Generation ──

function getSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;

  const testId = el.getAttribute("data-testid");
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

  // Check other data-* attributes
  for (const attr of el.attributes) {
    if (attr.name.startsWith("data-") && attr.name !== "data-testid") {
      return `[${attr.name}="${CSS.escape(attr.value)}"]`;
    }
  }

  // Build a path using tag + nth-child
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
    // Keep paths short — stop at a unique ID ancestor
    if (current?.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
  }
  return parts.join(" > ");
}

function getElementInfo(el: Element): ElementInfo {
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    class: el.className || undefined,
    text: (el.textContent ?? "").trim().slice(0, 100) || undefined,
    selector: getSelector(el),
  };
}

// ── Throttle helper ──

function throttle<T extends (...args: any[]) => void>(
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

// ── Recorder ──

export function startRecording(onEvent: EventCallback): () => void {
  const pageUrl = () => location.href;
  const now = () => new Date().toISOString();
  const cleanups: (() => void)[] = [];

  function listen<K extends keyof DocumentEventMap>(
    target: EventTarget,
    event: K,
    handler: (e: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) {
    target.addEventListener(event, handler as EventListener, options);
    cleanups.push(() =>
      target.removeEventListener(event, handler as EventListener, options),
    );
  }

  function isExaminerUi(el: Element): boolean {
    return !!el.closest("#examiner-widget-host, #examiner-picker-host") ||
      el.id === "examiner-widget-host" ||
      el.id === "examiner-picker-host";
  }

  // ── Click ──
  listen(document, "click", (e) => {
    const target = e.target as Element;
    if (!target || isExaminerUi(target)) return;
    onEvent({
      timestamp: now(),
      type: "interaction",
      subtype: "click",
      element: getElementInfo(target),
      coordinates: { x: e.clientX, y: e.clientY },
      page_url: pageUrl(),
    });
  }, { capture: true });

  // ── Input ──
  listen(document, "input", (e) => {
    const target = e.target as HTMLInputElement | HTMLTextAreaElement;
    if (!target?.tagName || isExaminerUi(target)) return;
    const tag = target.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return;

    // Don't record password values
    const value =
      target instanceof HTMLInputElement && target.type === "password"
        ? "[password]"
        : target.value?.slice(0, 200);

    onEvent({
      timestamp: now(),
      type: "interaction",
      subtype: "input",
      element: getElementInfo(target),
      value,
      page_url: pageUrl(),
    });
  }, { capture: true });

  // ── Scroll (throttled) ──
  const handleScroll = throttle(() => {
    onEvent({
      timestamp: now(),
      type: "interaction",
      subtype: "scroll",
      scroll_position: { x: window.scrollX, y: window.scrollY },
      page_url: pageUrl(),
    });
  }, SCROLL_THROTTLE);
  listen(window as any, "scroll" as any, handleScroll, { passive: true });

  // ── Viewport Resize (throttled) ──
  let lastViewport: Viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
  };
  const handleResize = throttle(() => {
    const newViewport: Viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };
    onEvent({
      timestamp: now(),
      type: "viewport_resize",
      from: lastViewport,
      to: newViewport,
      page_url: pageUrl(),
    });
    lastViewport = newViewport;
  }, RESIZE_THROTTLE);
  listen(window as any, "resize" as any, handleResize);

  // ── Navigation (SPA) ──
  let lastUrl = pageUrl();

  function checkNavigation() {
    const currentUrl = pageUrl();
    if (currentUrl !== lastUrl) {
      onEvent({
        timestamp: now(),
        type: "interaction",
        subtype: "navigation",
        from_url: lastUrl,
        to_url: currentUrl,
        page_url: currentUrl,
      });
      lastUrl = currentUrl;
    }
  }

  listen(window as any, "popstate" as any, checkNavigation);
  listen(window as any, "hashchange" as any, checkNavigation);

  // MutationObserver as fallback for pushState navigation
  const observer = new MutationObserver(
    throttle(checkNavigation, 500),
  );
  observer.observe(document.body, { childList: true, subtree: true });
  cleanups.push(() => observer.disconnect());

  // Return cleanup function
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
