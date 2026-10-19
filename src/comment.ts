/**
 * PR comment rendering. Only our own generated text reaches the comment:
 * maintainer-written deprecation messages are replaced by a neutral label,
 * Markdown is escaped, @mentions are neutralised and links point to
 * changes.watch only.
 */

import type { BatchItem, Verdict, VerdictReason } from "./api.js";
import { MARKER } from "./github.js";
import type { LockChange } from "./lockfile.js";

const VERDICT_LABEL: Record<Verdict, string> = {
  avoid: "🔴 Avoid",
  skip: "🟠 Skip",
  wait: "🟠 Wait",
  review: "🔵 Review",
  go: "🟢 Safe",
  unknown: "⚪ Not enough data",
};
const STATUS_LABEL: Record<Exclude<BatchItem["status"], "ok">, string> = {
  not_found: "— Not on npm",
  pending: "⏳ Computing",
  unavailable: "⏳ Sources unavailable",
  invalid: "— Not checked",
};
const MAINTAINER_TEXT_REASONS = new Set(["registry_deprecated", "registry_deprecated_security"]);
const MAX_ROWS = 50;
const MAX_VOTE_LINKS = 5;

export function escapeMarkdown(value: string) {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_{}[\]()<>#+!|~])/g, "\\$1")
    .replace(/@/g, "@​")
    .replace(/:\/\//g, ":/​/")
    .trim();
}

export function safeReasonLabel(reason: VerdictReason) {
  if (MAINTAINER_TEXT_REASONS.has(reason.code)) {
    return reason.code === "registry_deprecated_security"
      ? "Deprecated on npm for a security reason"
      : "Deprecated by the maintainer on npm";
  }
  const label = reason.label.length > 140 ? `${reason.label.slice(0, 139)}…` : reason.label;
  return escapeMarkdown(label);
}

export function renderComment(input: {
  changes: LockChange[];
  items: BatchItem[];
  apiUrl: string;
  skippedLockfileNote?: string;
}): string {
  const base = input.apiUrl.replace(/\/$/, "");
  const byKey = new Map(input.items.map((item) => [`${item.name}@${item.to}`, item]));
  const direct = input.changes.filter((change) => change.direct);
  const transitive = input.changes.filter((change) => !change.direct);
  const flaggedTransitive = transitive.filter((change) => {
    const verdict = byKey.get(`${change.name}@${change.to}`)?.verdict?.verdict;
    return verdict === "avoid" || verdict === "skip";
  });

  const lines = [MARKER, "### Changes.Watch upgrade verdicts", ""];
  if (input.skippedLockfileNote) lines.push(`> ${escapeMarkdown(input.skippedLockfileNote)}`, "");

  const rows = [...direct, ...flaggedTransitive].slice(0, MAX_ROWS);
  if (rows.length === 0) {
    lines.push(input.changes.length === 0
      ? "No npm dependency versions changed in this pull request."
      : `Checked ${input.changes.length} transitive version changes — none to avoid or skip.`);
  } else {
    lines.push("| Package | Change | Verdict | Why |", "|---|---|---|---|");
    for (const change of rows) {
      const item = byKey.get(`${change.name}@${change.to}`);
      lines.push(`| \`${change.name}\`${change.direct ? "" : " (transitive)"} | ${change.from ? `${change.from} → ` : "added "}${change.to} | ${verdictCell(change, item, base)} | ${whyCell(item)} |`);
    }
    if (transitive.length > 0) {
      lines.push("", `<sub>${transitive.length} transitive version changes checked; only avoid/skip verdicts are listed.</sub>`);
    }
  }

  const votable = direct
    .map((change) => ({ change, item: byKey.get(`${change.name}@${change.to}`) }))
    .filter(({ item }) => item?.status === "ok" && item.verdict && item.verdict.verdict !== "avoid")
    .slice(0, MAX_VOTE_LINKS);
  if (votable.length > 0) {
    lines.push("", "**Did an upgrade work for you?** One vote per GitHub account helps other teams:");
    for (const { change, item } of votable) {
      const url = verdictUrl(base, change);
      const from = change.from ? `&from=${encodeURIComponent(change.from)}` : "";
      lines.push(`- \`${change.name}@${change.to}\`: [worked](${url}?vote=worked${from}&src=pr#vote) · [broke something](${url}?vote=broke${from}&src=pr#vote)`);
    }
  }

  lines.push(
    "",
    `<sub>Verdicts come from public evidence (npm, OSV, deps.dev, GitHub) and developer votes. [How verdicts work](${base}/packages/how-verdicts-work) · [upgrade-verdict](https://github.com/ChangesWatch/upgrade-verdict)</sub>`,
  );
  return lines.join("\n");
}

function verdictCell(change: LockChange, item: BatchItem | undefined, base: string) {
  if (!item) return "— Not checked";
  if (item.status !== "ok" || !item.verdict) return STATUS_LABEL[item.status as Exclude<BatchItem["status"], "ok">] ?? "—";
  const label = VERDICT_LABEL[item.verdict.verdict] ?? "—";
  const recommended = item.verdict.recommendedVersion && item.verdict.recommendedVersion !== item.to && item.verdict.verdict !== "go"
    ? ` → ${escapeMarkdown(item.verdict.recommendedVersion)}`
    : "";
  return `[${label}](${verdictUrl(base, change)})${recommended}`;
}

function whyCell(item: BatchItem | undefined) {
  if (!item || item.status !== "ok" || !item.verdict) return "";
  const parts: string[] = [];
  const fixed = item.pair?.fixedAdvisories ?? [];
  if (fixed.length > 0) {
    const serious = fixed.filter((advisory) => advisory.severity === "critical" || advisory.severity === "high").length;
    parts.push(`fixes ${fixed.length} ${fixed.length === 1 ? "advisory" : "advisories"}${serious > 0 ? ` (${serious} high/critical)` : ""}`);
  }
  const reason = item.verdict.reasons[0];
  if (reason) parts.push(safeReasonLabel(reason));
  return parts.join(" · ");
}

/** Always a changes.watch link built from lockfile-validated parts, never a URL from the response. */
function verdictUrl(base: string, change: LockChange) {
  return `${base}/packages/npm/${change.name}@${change.to}`;
}
