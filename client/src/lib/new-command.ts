/** Return the topic from a `/new` command, or null when the input is ordinary text. */
export function parseNewCommand(content: string): string | null {
  const match = content.trim().match(/^\/new(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return match[1]?.trim() ?? "";
}
