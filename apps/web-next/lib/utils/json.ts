/**
 * Parse JSON from model response, extracting it from surrounding text if needed.
 */
export function parseJSON(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }
  const match =
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) ||
    trimmed.match(/(\{[\s\S]*\})/);
  if (match) {
    return JSON.parse(match[1].trim());
  }
  throw new Error("No JSON found in response");
}
