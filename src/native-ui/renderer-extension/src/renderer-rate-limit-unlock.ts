/**
 * Codex Desktop disables every local composer while the ChatGPT usage status
 * reports `rate_limit.allowed: false`, even for Threads owned by another
 * Harness that never spend ChatGPT quota. The status can arrive through
 * chunked host messages or a restored cache, so watch the page's React Query
 * cache instead and clear only that flag. `limit_reached` and
 * `rate_limit_reached_type` stay intact, so usage banners still show the
 * exhausted quota and the ChatGPT backend still rejects Codex turns.
 */

declare global {
  interface Window {
    __harnessmixRateLimitUnlockV1?: true;
  }
}

const RATE_LIMIT_QUERY_ROOT = "rate-limit-status";
const CLIENT_POLL_MS = 1000;
const MAX_CLIENT_POLLS = 120;
const MAX_FIBER_VISITS = 200_000;

interface QueryLike {
  queryKey: readonly unknown[];
  state: { data?: unknown };
}

interface QueryClientLike {
  getQueryCache(): {
    getAll(): QueryLike[];
    subscribe(listener: (event: { query?: QueryLike } | undefined) => void): () => void;
  };
  setQueryData(queryKey: readonly unknown[], data: unknown): unknown;
}

interface FiberLike {
  child: FiberLike | null;
  sibling: FiberLike | null;
  memoizedProps?: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a copy with `rate_limit.allowed` cleared, or null when no change is needed. */
export function unlockedRateLimitStatus(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || !("plan_type" in body)) return null;
  const rateLimit = body.rate_limit;
  if (!isRecord(rateLimit) || rateLimit.allowed !== false) return null;
  return { ...body, rate_limit: { ...rateLimit, allowed: true } };
}

function isQueryClient(value: unknown): value is QueryClientLike {
  return (
    isRecord(value) &&
    typeof value.getQueryCache === "function" &&
    typeof value.setQueryData === "function"
  );
}

function findQueryClient(ownerDocument: Document): QueryClientLike | null {
  const container = ownerDocument.getElementById("root") ?? ownerDocument.body?.firstElementChild;
  if (!container) return null;
  const key = Object.keys(container).find((name) => name.startsWith("__reactContainer$"));
  if (!key) return null;
  const stack: Array<FiberLike | null> = [
    (container as unknown as Record<string, FiberLike | null>)[key] ?? null,
  ];
  for (let visits = 0; stack.length > 0 && visits < MAX_FIBER_VISITS; visits += 1) {
    const fiber = stack.pop();
    if (!fiber) continue;
    const client = fiber.memoizedProps?.client;
    if (isQueryClient(client)) return client;
    stack.push(fiber.sibling, fiber.child);
  }
  return null;
}

function unlockQuery(client: QueryClientLike, query: QueryLike | undefined): void {
  if (!query || query.queryKey[0] !== RATE_LIMIT_QUERY_ROOT) return;
  const unlocked = unlockedRateLimitStatus(query.state.data);
  if (unlocked) client.setQueryData(query.queryKey, unlocked);
}

export function installRateLimitComposerUnlock(ownerWindow: Window = window): void {
  if (ownerWindow.__harnessmixRateLimitUnlockV1) return;
  ownerWindow.__harnessmixRateLimitUnlockV1 = true;
  let attempts = 0;
  const timer = ownerWindow.setInterval(() => {
    attempts += 1;
    const client = findQueryClient(ownerWindow.document);
    if (!client) {
      if (attempts >= MAX_CLIENT_POLLS) ownerWindow.clearInterval(timer);
      return;
    }
    ownerWindow.clearInterval(timer);
    const cache = client.getQueryCache();
    for (const query of cache.getAll()) unlockQuery(client, query);
    cache.subscribe((event) => unlockQuery(client, event?.query));
  }, CLIENT_POLL_MS);
}
