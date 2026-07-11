/**
 * JSON → TOON projection layer.
 *
 * Internally we always work with plain JSON. We encode to TOON only at the
 * final output boundary — never earlier. This preserves the full JSON data for
 * pagination-total computation, field extraction, and testing.
 */
import { encode } from "@toon-format/toon";

/** Render a plain JS object as a TOON-encoded string. */
export function renderBlock(data: Record<string, unknown>): string {
  return encode(data);
}

/** Render a structured error block as TOON. */
export function renderError(
  message: string,
  code: string,
  suggestions: readonly string[] = [],
): string {
  const obj: Record<string, unknown> = { error: message, code };
  if (suggestions.length > 0) {
    obj.help = [...suggestions];
  }
  return encode(obj);
}

/** Combine pre-encoded TOON blocks into a single output string, filtering empties. */
export function renderOutput(blocks: readonly string[]): string {
  return blocks.filter(Boolean).join("\n");
}
