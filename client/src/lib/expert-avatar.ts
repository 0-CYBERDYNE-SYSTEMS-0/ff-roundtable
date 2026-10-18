import { catalogAvatar } from "@shared/expert-catalog";

export function resolveExpertAvatar(role: string, avatarUrl?: string | null): string {
  return avatarUrl && !avatarUrl.startsWith("http") ? avatarUrl : catalogAvatar(role);
}
