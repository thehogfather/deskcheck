// Acceptance test for feature #8 — Test Level Matrix row #21.
// Pure unit test pinning that the side panel and the widget share a
// single source of truth for the privacy notice copy.

import { describe, it, expect } from "vitest";
import { buildFirstRunNoticeModel } from "./privacy-notice";
import { PRIVACY_NOTICE_BULLETS } from "./privacy";

describe("buildFirstRunNoticeModel (matrix #21)", () => {
  it("returns bullets equal to PRIVACY_NOTICE_BULLETS", () => {
    const model = buildFirstRunNoticeModel();
    expect(model.bullets).toEqual(PRIVACY_NOTICE_BULLETS);
  });

  it("has a non-empty title", () => {
    const model = buildFirstRunNoticeModel();
    expect(model.title).toBeTypeOf("string");
    expect(model.title.length).toBeGreaterThan(0);
  });

  it("has a non-empty dismissLabel", () => {
    const model = buildFirstRunNoticeModel();
    expect(model.dismissLabel).toBeTypeOf("string");
    expect(model.dismissLabel.length).toBeGreaterThan(0);
  });

  it("returns a stable shape (idempotent)", () => {
    const a = buildFirstRunNoticeModel();
    const b = buildFirstRunNoticeModel();
    expect(a).toEqual(b);
  });
});
