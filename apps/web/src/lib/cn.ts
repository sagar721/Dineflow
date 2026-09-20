/** Joins class names, dropping falsy values. Small on purpose: no runtime dependency. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
