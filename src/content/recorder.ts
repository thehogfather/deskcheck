import { TimelineEventInput, Viewport } from "../types";
import { SCROLL_THROTTLE, RESIZE_THROTTLE } from "../constants";
import { getElementInfo, isDeskCheckUi, throttle } from "../lib/dom-utils";

type EventCallback = (event: TimelineEventInput) => void;

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

  // ── Click ──
  listen(document, "click", (e) => {
    const target = e.target as Element;
    if (!target || isDeskCheckUi(target)) return;
    onEvent({
      timestamp: now(),
      type: "interaction",
      subtype: "click",
      element: getElementInfo(target),
      coordinates: { x: e.clientX, y: e.clientY },
      page_url: pageUrl(),
    });
  }, { capture: true });

  // ── Input (debounced — emit final value, not every keystroke) ──
  const INPUT_DEBOUNCE = 800;
  const inputTimers = new Map<EventTarget, ReturnType<typeof setTimeout>>();

  function emitInput(target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
    const value =
      target instanceof HTMLInputElement && target.type === "password"
        ? "[password]"
        : (target as HTMLInputElement).value?.slice(0, 200);

    onEvent({
      timestamp: now(),
      type: "interaction",
      subtype: "input",
      element: getElementInfo(target),
      value,
      page_url: pageUrl(),
    });
  }

  listen(document, "input", (e) => {
    const target = e.target as HTMLInputElement | HTMLTextAreaElement;
    if (!target?.tagName || isDeskCheckUi(target)) return;
    const tag = target.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return;

    // Clear any pending timer for this field, restart the debounce
    const prev = inputTimers.get(target);
    if (prev) clearTimeout(prev);
    inputTimers.set(target, setTimeout(() => {
      inputTimers.delete(target);
      emitInput(target);
    }, INPUT_DEBOUNCE));
  }, { capture: true });

  // Also emit immediately on change (blur / Enter) and cancel any pending debounce
  listen(document, "change", (e) => {
    const target = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (!target?.tagName || isDeskCheckUi(target)) return;
    const tag = target.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return;

    const prev = inputTimers.get(target);
    if (prev) {
      clearTimeout(prev);
      inputTimers.delete(target);
    }
    emitInput(target);
  }, { capture: true });

  cleanups.push(() => {
    for (const timer of inputTimers.values()) clearTimeout(timer);
    inputTimers.clear();
  });

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

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
