import { describe, expect, it, vi } from "vitest";
import { requestVerdicts, type BatchItem } from "../src/api.js";
import { escapeMarkdown, renderComment, safeReasonLabel } from "../src/comment.js";
import { MARKER, upsertStickyComment } from "../src/github.js";
import { diffLockfiles, parseLockfile, UnsupportedLockfileError } from "../src/lockfile.js";

function lock(packages: Record<string, unknown>, root: Record<string, unknown> = { dependencies: { next: "^16.0.0" } }) {
  return JSON.stringify({ lockfileVersion: 3, packages: { "": root, ...packages } });
}

describe("lockfile diff", () => {
  it("finds changed and added versions, direct dependencies first, deduped across install paths", () => {
    const base = parseLockfile(lock({
      "node_modules/next": { version: "16.3.5" },
      "node_modules/debug": { version: "4.4.1" },
    }));
    const head = parseLockfile(lock({
      "node_modules/next": { version: "16.4.2" },
      "node_modules/debug": { version: "4.4.2" },
      "node_modules/a/node_modules/debug": { version: "4.4.2" },
      "node_modules/@scope/new-pkg": { version: "1.0.0" },
      "packages/app": { version: "0.0.1" },
      "node_modules/linked": { link: true, resolved: "packages/app" },
    }));

    expect(diffLockfiles(base, head)).toEqual([
      { name: "next", from: "16.3.5", to: "16.4.2", direct: true },
      { name: "@scope/new-pkg", from: null, to: "1.0.0", direct: false },
      { name: "debug", from: "4.4.1", to: "4.4.2", direct: false },
    ]);
  });

  it("rejects lockfile v1 and invalid JSON", () => {
    expect(() => parseLockfile(JSON.stringify({ lockfileVersion: 1, dependencies: {} }))).toThrow(UnsupportedLockfileError);
    expect(() => parseLockfile("{")).toThrow(UnsupportedLockfileError);
  });
});

function item(name: string, from: string | null, to: string, verdict: NonNullable<BatchItem["verdict"]>["verdict"], extra: Partial<BatchItem> = {}): BatchItem {
  return {
    name,
    from,
    to,
    status: "ok",
    verdict: {
      verdict,
      recommendedVersion: verdict === "skip" ? "16.4.3" : null,
      reasons: [{ code: "no_negative_signals", label: "Older than 72 h, no known advisories.", sourceUrl: "https://www.npmjs.com/x" }],
      url: "https://evil.example/should-not-be-used",
    },
    pair: { direction: "upgrade", crossesBreakingBoundary: false, fixedAdvisories: [{ id: "GHSA-1", severity: "critical" }], newAdvisories: [] },
    ...extra,
  };
}

describe("PR comment", () => {
  it("renders a sticky table with changes.watch links and vote links for direct upgrades", () => {
    const body = renderComment({
      apiUrl: "https://www.changes.watch",
      changes: [
        { name: "next", from: "16.3.5", to: "16.4.2", direct: true },
        { name: "debug", from: "4.4.1", to: "4.4.2", direct: false },
        { name: "ms", from: "2.1.2", to: "2.1.3", direct: false },
      ],
      items: [
        item("next", "16.3.5", "16.4.2", "go"),
        item("debug", "4.4.1", "4.4.2", "avoid"),
        item("ms", "2.1.2", "2.1.3", "go"),
      ],
    });

    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("| `next` | 16.3.5 → 16.4.2 | [🟢 Safe](https://www.changes.watch/packages/npm/next@16.4.2) | fixes 1 advisory (1 high/critical) · Older than 72 h, no known advisories. |");
    expect(body).toContain("| `debug` (transitive) | 4.4.1 → 4.4.2 | [🔴 Avoid](https://www.changes.watch/packages/npm/debug@4.4.2)");
    expect(body).not.toContain("`ms`");
    expect(body).toContain("[worked](https://www.changes.watch/packages/npm/next@16.4.2?vote=worked&from=16.3.5&src=pr#vote)");
    expect(body).not.toContain("evil.example");
  });

  it("never copies maintainer text and neutralises markdown, mentions and links in labels", () => {
    expect(safeReasonLabel({ code: "registry_deprecated", label: "Deprecated: see https://evil.example @everyone", sourceUrl: "x" }))
      .toBe("Deprecated by the maintainer on npm");
    const escaped = escapeMarkdown("a|b [x](https://evil.example) @team <img>");
    expect(escaped).not.toMatch(/\[x\]\(/);
    expect(escaped).toContain("\\|");
    expect(escaped).toContain("@​team");
    expect(escaped).toContain(":/​/");
  });

  it("says so when nothing changed", () => {
    expect(renderComment({ apiUrl: "https://www.changes.watch", changes: [], items: [] }))
      .toContain("No npm dependency versions changed in this pull request.");
  });
});

describe("API client", () => {
  it("retries once when some items are still being computed", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ name: "next", from: null, to: "16.4.2", status: "pending" }], retryAfterSeconds: 30 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [item("next", null, "16.4.2", "go")] })));
    const sleep = vi.fn(async () => undefined);

    const items = await requestVerdicts({
      apiUrl: "https://www.changes.watch",
      changes: [{ name: "next", from: null, to: "16.4.2", direct: true }],
      client: "upgrade-verdict/1.0.0",
      installId: "a".repeat(64),
      fetchImpl,
      sleep,
    });

    expect(items[0]!.status).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(30_000);
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body));
    expect(body).toEqual({ items: [{ name: "next", to: "16.4.2" }], client: "upgrade-verdict/1.0.0", installId: "a".repeat(64) });
  });
});

describe("sticky comment", () => {
  it("updates the bot comment that carries the marker instead of creating a new one", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/comments?per_page")) {
        return new Response(JSON.stringify([
          { id: 1, body: `${MARKER} spoof`, user: { type: "User" } },
          { id: 2, body: `${MARKER} old`, user: { type: "Bot" } },
        ]));
      }
      return new Response(JSON.stringify({ html_url: `https://github.com/o/r/pull/7#issuecomment-${init?.method}` }));
    });

    const url = await upsertStickyComment("o/r", 7, "new body", { token: "t", fetchImpl });

    expect(url).toBe("https://github.com/o/r/pull/7#issuecomment-PATCH");
    expect(String(fetchImpl.mock.calls[1]![0])).toBe("https://api.github.com/repos/o/r/issues/comments/2");
  });
});
