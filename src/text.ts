/** Small text helpers. */

/** `text` without any of `chars` at its end (a loop, so it stays quick on any input). */
export function trimEnd(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end -= 1;
  return text.slice(0, end);
}
