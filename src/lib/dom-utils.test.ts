// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSelector, getElementInfo, isDeskCheckUi, throttle } from "./dom-utils";

// Helper to set up DOM fixtures using safe DOM APIs
function setBody(...children: Element[]) {
  document.body.replaceChildren(...children);
}

function create(
  tag: string,
  attrs?: Record<string, string>,
  children?: (Element | string)[],
): Element {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  }
  if (children) {
    for (const child of children) {
      el.appendChild(
        typeof child === "string"
          ? document.createTextNode(child)
          : child,
      );
    }
  }
  return el;
}

describe("getSelector", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("returns #id for element with id", () => {
    const btn = create("button", { id: "submit" }, ["Go"]);
    setBody(btn);
    expect(getSelector(btn)).toBe("#submit");
  });

  it("returns [data-testid] for element with data-testid", () => {
    const div = create("div", { "data-testid": "header" }, ["Title"]);
    setBody(div);
    expect(getSelector(div)).toBe('[data-testid="header"]');
  });

  it("returns [data-*] for element with other data attribute", () => {
    const span = create("span", { "data-role": "icon" }, ["X"]);
    setBody(span);
    expect(getSelector(span)).toBe('[data-role="icon"]');
  });

  it("prefers data-testid over other data-* attributes", () => {
    const div = create("div", {
      "data-testid": "main",
      "data-section": "hero",
    }, ["Content"]);
    setBody(div);
    expect(getSelector(div)).toBe('[data-testid="main"]');
  });

  it("builds nth-of-type path for elements without id or data-*", () => {
    const ul = create("ul", {}, [
      create("li", {}, ["A"]),
      create("li", {}, ["B"]),
      create("li", {}, ["C"]),
    ]);
    setBody(ul);
    const secondLi = ul.querySelectorAll("li")[1];
    const selector = getSelector(secondLi);
    expect(selector).toContain("li:nth-of-type(2)");
  });

  it("truncates path at ancestor with id", () => {
    const root = create("div", { id: "root" }, [
      create("div", {}, [create("span", {}, ["Text"])]),
    ]);
    setBody(root);
    const span = root.querySelector("span")!;
    const selector = getSelector(span);
    expect(selector).toMatch(/^#root > /);
    expect(selector).toContain("span");
  });

  it("handles single element without siblings (no nth-of-type)", () => {
    const div = create("div", {}, [create("p", {}, ["Only child"])]);
    setBody(div);
    const p = div.querySelector("p")!;
    const selector = getSelector(p);
    expect(selector).not.toContain("nth-of-type");
  });
});

describe("getElementInfo", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("returns tag, id, class, text, selector", () => {
    const btn = create("button", { id: "btn", class: "primary" }, ["Click me"]);
    setBody(btn);
    const info = getElementInfo(btn);
    expect(info.tag).toBe("button");
    expect(info.id).toBe("btn");
    expect(info.class).toBe("primary");
    expect(info.text).toBe("Click me");
    expect(info.selector).toBe("#btn");
    expect(info.bounding_box).toBeUndefined();
  });

  it("includes bounding_box when requested", () => {
    const box = create("div", { id: "box" }, ["Content"]);
    setBody(box);
    const info = getElementInfo(box, { includeBoundingBox: true });
    expect(info.bounding_box).toBeDefined();
    expect(info.bounding_box).toHaveProperty("x");
    expect(info.bounding_box).toHaveProperty("y");
    expect(info.bounding_box).toHaveProperty("width");
    expect(info.bounding_box).toHaveProperty("height");
  });

  it("truncates long text to 100 chars", () => {
    const longText = "A".repeat(200);
    const p = create("p", { id: "p" }, [longText]);
    setBody(p);
    const info = getElementInfo(p);
    expect(info.text!.length).toBe(100);
  });

  it("omits empty optional fields", () => {
    const span = create("span", {}, ["text"]);
    setBody(span);
    const info = getElementInfo(span);
    expect(info.id).toBeUndefined();
    expect(info.class).toBeUndefined();
  });
});

describe("isDeskCheckUi", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("returns true for deskcheck widget host", () => {
    const host = create("div", { id: "deskcheck-widget-host" });
    setBody(host);
    expect(isDeskCheckUi(host)).toBe(true);
  });

  it("returns true for child of deskcheck widget host", () => {
    const host = create("div", { id: "deskcheck-widget-host" }, [
      create("button", {}, ["Click"]),
    ]);
    setBody(host);
    const btn = host.querySelector("button")!;
    expect(isDeskCheckUi(btn)).toBe(true);
  });

  it("returns false for regular page element", () => {
    const btn = create("button", {}, ["Click"]);
    setBody(btn);
    expect(isDeskCheckUi(btn)).toBe(false);
  });
});

describe("throttle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("calls function immediately on first invocation", () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);
    throttled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("suppresses calls within throttle interval", () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);
    throttled();
    vi.advanceTimersByTime(50);
    throttled();
    throttled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("allows call after interval has passed", () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);
    throttled();
    vi.advanceTimersByTime(101);
    throttled();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("passes arguments through", () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);
    throttled("a", "b");
    expect(fn).toHaveBeenCalledWith("a", "b");
  });
});
