/**
 * Shared tokenizer used both when building the index (to precompute term
 * frequencies) and when parsing a query. Lowercases, splits on any run of
 * non-alphanumeric/underscore characters, and drops single-character tokens.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((tok) => tok.length > 1);
}
