// STUB — Phase 3 (failing acceptance tests). Phase 4 will implement.
//
// Single source of truth for the first-run privacy notice view-model.
// Both the in-page widget and the side panel render from this model so
// the bullets cannot drift between surfaces.

export interface FirstRunNoticeModel {
  title: string;
  bullets: readonly string[];
  dismissLabel: string;
}

export function buildFirstRunNoticeModel(): FirstRunNoticeModel {
  throw new Error("privacy-notice.buildFirstRunNoticeModel not implemented");
}
