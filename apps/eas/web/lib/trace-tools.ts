/** Format progress text for the activity row. */

/**
 * Clip *text* to *max* characters on a word boundary where one is close by.
 *
 * Progress lines land in the row's trailing slot, which is one line wide; a
 * mid-word cut reads as corruption rather than truncation.
 */
export function clipLabel(text: string, max: number): string {
  const value = text.trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

/** A provider's own progress line, formatted for the row's trailing slot. */
export function formatProgressLabel(message: string, max = 64): string {
  return clipLabel(message, max);
}

/** Which glyph family a provider row uses. Resolved to a component by the view. */
export type ProviderGlyph = "link";

