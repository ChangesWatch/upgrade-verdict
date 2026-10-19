import * as core from "@actions/core";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { requestVerdicts } from "./api.js";
import { renderComment } from "./comment.js";
import { getFileAtRef, upsertStickyComment } from "./github.js";
import { diffLockfiles, parseLockfile, UnsupportedLockfileError } from "./lockfile.js";

const VERSION = "1.0.0";
const INSTALL_SALT = "changes.watch/upgrade-verdict";

type PullRequestEvent = {
  pull_request?: { number: number; base: { sha: string }; head: { sha: string } };
};

export async function run(): Promise<void> {
  const token = core.getInput("github-token");
  const lockfile = core.getInput("lockfile") || "package-lock.json";
  const failOn = core.getInput("fail-on") || "none";
  const comment = (core.getInput("comment") || "true").toLowerCase() === "true";
  const telemetry = (core.getInput("telemetry") || "true").toLowerCase() === "true";
  const apiUrl = core.getInput("api-url") || "https://www.changes.watch";
  if (failOn !== "none" && failOn !== "avoid") throw new Error("fail-on must be none or avoid.");
  if (!/^https:\/\/[^/]+$/.test(apiUrl.replace(/\/$/, ""))) throw new Error("api-url must be an https origin.");

  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf8")) as PullRequestEvent;
  const pr = event.pull_request;
  if (!pr || !repo) {
    core.notice("upgrade-verdict runs on pull_request events; nothing to do.");
    return;
  }

  // Lockfiles are read through the API at the base and head commits, so the
  // workflow never needs to check out or execute pull request code.
  const [baseText, headText] = await Promise.all([
    getFileAtRef(repo, lockfile, pr.base.sha, { token }),
    getFileAtRef(repo, lockfile, pr.head.sha, { token }),
  ]);
  if (!headText) {
    core.notice(`${lockfile} not found at the PR head; nothing to check.`);
    return;
  }

  let changes;
  try {
    changes = diffLockfiles(baseText ? parseLockfile(baseText) : null, parseLockfile(headText));
  } catch (error) {
    if (error instanceof UnsupportedLockfileError) {
      core.warning(error.message);
      return;
    }
    throw error;
  }

  const installId = telemetry && process.env.GITHUB_REPOSITORY_ID
    ? createHash("sha256").update(`${process.env.GITHUB_REPOSITORY_ID}:${INSTALL_SALT}`).digest("hex")
    : undefined;
  // Direct dependencies first; transitive ones fill the remaining request capacity.
  const items = await requestVerdicts({ apiUrl, changes, client: `upgrade-verdict/${VERSION}`, installId });
  const body = renderComment({ changes, items, apiUrl });

  await core.summary.addRaw(body.replace(/<!--[\s\S]*?-->/, "")).write();
  core.setOutput("changed-count", String(changes.length));
  const avoidCount = items.filter((item) => item.verdict?.verdict === "avoid").length;
  core.setOutput("avoid-count", String(avoidCount));

  if (comment) {
    try {
      const url = await upsertStickyComment(repo, pr.number, body, { token });
      core.setOutput("comment-url", url);
    } catch (error) {
      // Fork PRs get a read-only token; the job summary still has the verdicts.
      core.warning(`Could not write the PR comment (${error instanceof Error ? error.message : "unknown error"}). Verdicts are in the job summary.`);
    }
  }

  if (failOn === "avoid" && avoidCount > 0) {
    core.setFailed(`${avoidCount} dependency ${avoidCount === 1 ? "change has" : "changes have"} an avoid verdict.`);
  }
}

if (process.env.GITHUB_ACTIONS === "true") {
  run().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
}
