export function formatJsonArtifact(content: string): { content: string; valid: boolean } {
  try {
    return { content: JSON.stringify(JSON.parse(content), null, 2), valid: true };
  } catch {
    return { content, valid: false };
  }
}
