// Brand tokens shared by the WebBuilder frontend.
//
// Only values that are actually duplicated across web/src today belong
// here. Currently that is exactly one colour: the brand orange
// `#F6821F`, today copy-pasted as `const ORANGE = "#F6821F"` in
// web/src/App.tsx, web/src/pages/AdminPanel.tsx, web/src/pages/ApiDocs.tsx
// and web/src/pages/Builder.tsx, plus its soft background `#fff7ed`,
// used next to it for badges in AdminPanel. Everything else in web/src
// is either a one-off page style or a generic Tailwind grey, so it stays
// where it is — do not grow this file into a speculative design system.
// See packages/ui/README.md.
export const BRAND_ORANGE = "#F6821F";

/** Soft orange background used for badges/pills next to BRAND_ORANGE. */
export const BRAND_ORANGE_SOFT = "#fff7ed";

export const brand = {
  orange: BRAND_ORANGE,
  orangeSoft: BRAND_ORANGE_SOFT,
} as const;
