// Single source of truth for the first-run privacy notice view-model.
// Both the in-page widget (src/content/widget.ts) and the side panel
// (src/sidepanel/sidepanel.ts) render from this model so the bullets
// cannot drift between surfaces. Pinned by privacy-notice.test.ts.

import { PRIVACY_NOTICE_BULLETS } from "./privacy";

export interface FirstRunNoticeModel {
  title: string;
  bullets: readonly string[];
  dismissLabel: string;
}

export function buildFirstRunNoticeModel(): FirstRunNoticeModel {
  return {
    title: "Before you start recording",
    bullets: PRIVACY_NOTICE_BULLETS,
    dismissLabel: "Got it",
  };
}
