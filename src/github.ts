/** Minimal GitHub REST helpers (fetch-based, no checkout of PR code required). */

const API = "https://api.github.com";
const MARKER = "<!-- changes-watch:upgrade-verdict -->";

export { MARKER };

type Options = { token: string; fetchImpl?: typeof fetch };

function headers(token: string, accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "changes-watch-upgrade-verdict",
  };
}

/** Raw file content at a commit, or null when the file does not exist there. */
export async function getFileAtRef(repo: string, path: string, ref: string, options: Options): Promise<string | null> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await (options.fetchImpl ?? fetch)(
    `${API}/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    { headers: headers(options.token, "application/vnd.github.raw") },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read ${path} at ${ref.slice(0, 7)}: HTTP ${response.status}`);
  return response.text();
}

/** Creates or updates the single comment that carries MARKER. Returns its URL. */
export async function upsertStickyComment(repo: string, issueNumber: number, body: string, options: Options): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let existingId: number | null = null;

  for (let page = 1; page <= 10 && existingId === null; page++) {
    const response = await fetchImpl(`${API}/repos/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`, {
      headers: headers(options.token),
    });
    if (!response.ok) throw new Error(`Could not list PR comments: HTTP ${response.status}`);
    const comments = (await response.json()) as Array<{ id: number; body?: string; user?: { type?: string } }>;
    const found = comments.find((comment) => comment.user?.type === "Bot" && comment.body?.includes(MARKER));
    if (found) existingId = found.id;
    if (comments.length < 100) break;
  }

  const response = existingId === null
    ? await fetchImpl(`${API}/repos/${repo}/issues/${issueNumber}/comments`, {
        method: "POST",
        headers: { ...headers(options.token), "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      })
    : await fetchImpl(`${API}/repos/${repo}/issues/comments/${existingId}`, {
        method: "PATCH",
        headers: { ...headers(options.token), "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
  if (!response.ok) throw new Error(`Could not write the PR comment: HTTP ${response.status}`);
  const comment = (await response.json()) as { html_url?: string };
  return comment.html_url ?? "";
}
