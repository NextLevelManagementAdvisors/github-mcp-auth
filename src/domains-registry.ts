// Polls the org-wide authorized-domains registry at status.nlma.io and layers
// it on top of GITHUB_APPROVED_EMAIL_DOMAINS. The endpoint is deliberately
// public and unauthenticated — see /etc/nginx/sites-available/status.nlma.io
// on the VPS: /domains.json sits outside the dashboard's auth_request gate,
// with the comment "public read-only authorized-domains registry (consumed
// by downstream services: OAuth sidecars, DocuSeal, n8n). The list is not
// secret." This gateway is one of those sidecars.
//
// A transient outage at status.nlma.io must not silently change who can
// authorize here, in either direction — so a failed refresh keeps serving the
// last known-good list rather than clearing it, and the very first fetch is
// awaited at boot so the gate is populated before the server accepts traffic.

const DEFAULT_DOMAINS_URL = "https://status.nlma.io/domains.json";
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5m
const FETCH_TIMEOUT_MS = 5_000;

interface RegistryState {
  domains: string[];
  syncedOnce: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}

const state: RegistryState = {
  domains: [],
  syncedOnce: false,
  lastSyncedAt: null,
  lastError: null,
};

let pollHandle: NodeJS.Timeout | null = null;

function getDomainsUrl(): string {
  return process.env.NLMA_AUTHORIZED_DOMAINS_URL ?? DEFAULT_DOMAINS_URL;
}

interface DomainsRegistryResponse {
  domains?: unknown;
}

async function fetchOnce(): Promise<void> {
  const url = getDomainsUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as DomainsRegistryResponse;
    if (!Array.isArray(body.domains)) throw new Error("response has no domains array");
    state.domains = body.domains.filter((d): d is string => typeof d === "string");
    state.syncedOnce = true;
    state.lastSyncedAt = new Date().toISOString();
    state.lastError = null;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : "unknown error";
    console.error(
      `Failed to refresh authorized-domains registry from ${url}: ${state.lastError} — keeping last known-good list (${state.domains.length} domains)`
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch once (awaited, so the gate is populated before `listen()`), then poll
 * in the background. Safe to call more than once — later calls are no-ops.
 */
export async function startDomainsRegistrySync(): Promise<void> {
  if (pollHandle) return;
  await fetchOnce();
  pollHandle = setInterval(() => {
    void fetchOnce();
  }, POLL_INTERVAL_MS);
  pollHandle.unref?.();
}

export function stopDomainsRegistrySync(): void {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
}

/** The last successfully fetched list — empty until the first successful fetch ever completes. */
export function getRegistryDomains(): string[] {
  return state.domains;
}

/** For /health — never expose more than the registry itself already publishes. */
export function getRegistryStatus(): RegistryState & { url: string } {
  return { ...state, url: getDomainsUrl() };
}
