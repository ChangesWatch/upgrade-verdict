/** Client for the Changes.Watch batch verdict API. */

import type { LockChange } from "./lockfile.js";

export type Verdict = "avoid" | "skip" | "wait" | "review" | "go" | "unknown";

export type VerdictReason = { code: string; label: string; sourceUrl: string };

export type BatchItem = {
  name: string;
  from: string | null;
  to: string;
  status: "ok" | "not_found" | "pending" | "unavailable" | "invalid";
  verdict?: {
    verdict: Verdict;
    recommendedVersion: string | null;
    reasons: VerdictReason[];
    url: string;
  };
  pair?: {
    direction: "upgrade" | "downgrade" | "same";
    crossesBreakingBoundary: boolean;
    fixedAdvisories: Array<{ id: string; severity: string }> | null;
    newAdvisories: Array<{ id: string; severity: string; malicious: boolean }> | null;
  } | null;
};

const MAX_ITEMS = 100;
const MAX_RETRY_WAIT_MS = 30_000;

export async function requestVerdicts(input: {
  apiUrl: string;
  changes: LockChange[];
  client: string;
  installId?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<BatchItem[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const changes = input.changes.slice(0, MAX_ITEMS);
  if (changes.length === 0) return [];

  const post = async () => {
    const response = await fetchImpl(`${input.apiUrl.replace(/\/$/, "")}/api/v1/verdicts/npm/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": input.client },
      body: JSON.stringify({
        items: changes.map((change) => ({ name: change.name, to: change.to, ...(change.from ? { from: change.from } : {}) })),
        client: input.client,
        ...(input.installId ? { installId: input.installId } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Changes.Watch API returned HTTP ${response.status}`);
    return (await response.json()) as { items: BatchItem[]; retryAfterSeconds?: number };
  };

  let result = await post();
  // Cold versions are computed in batches; one retry picks up the rest.
  if (result.items.some((item) => item.status === "pending")) {
    await sleep(Math.min((result.retryAfterSeconds ?? 30) * 1000, MAX_RETRY_WAIT_MS));
    result = await post();
  }
  return result.items;
}
