import { QueryClient, QueryFunction } from "@tanstack/react-query";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey[0] as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

/**
 * Account switch: staleTime is Infinity, so the previous user's conversations,
 * usage and tier would keep showing until a reload. Drop every cached query,
 * then seed the new session's user.
 */
export function resetCacheForSession(client: { clear: () => void; setQueryData: (key: unknown[], data: unknown) => unknown }, user: unknown) {
  clearUserScopedStorage();
  client.clear();
  client.setQueryData(["/api/user"], user);
}

type KeyStorage = { length: number; key: (i: number) => string | null; removeItem: (k: string) => void; clear?: () => void };
/** Per-account browser state (Week-1 picks, dismissals); layout prefs such as sidebar widths and theme stay. */
export const USER_SCOPED_STORAGE_KEY = /^(farmFriendCalendarStart:|ffFarmProfileDismissed|ffCharterNudgeDismissed)/;
/** Logout / account switch: drop the previous account's form state from local and session storage. */
export function clearUserScopedStorage(local?: KeyStorage | null, session?: KeyStorage | null): number {
  let removed = 0;
  try {
    const ls = local !== undefined ? local : (typeof window !== "undefined" ? window.localStorage : null);
    if (ls) {
      const keys: string[] = [];
      for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && USER_SCOPED_STORAGE_KEY.test(k)) keys.push(k); }
      for (const k of keys) { ls.removeItem(k); removed++; }
    }
  } catch { /* storage unavailable */ }
  try {
    const ss = session !== undefined ? session : (typeof window !== "undefined" ? window.sessionStorage : null);
    ss?.clear?.();
  } catch { /* storage unavailable */ }
  return removed;
}
