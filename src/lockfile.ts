/**
 * package-lock.json v2/v3 parsing and diffing. Only the `packages` map is
 * read; lockfile v1 (npm 6) is reported as unsupported.
 */

export type LockedPackage = { name: string; version: string };

export type ParsedLockfile = {
  /** Direct dependency names declared by the root package. */
  direct: Set<string>;
  /** Install path (e.g. node_modules/a/node_modules/b) → package. */
  packages: Map<string, LockedPackage>;
};

export type LockChange = {
  name: string;
  from: string | null;
  to: string;
  direct: boolean;
};

export class UnsupportedLockfileError extends Error {}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function parseLockfile(text: string): ParsedLockfile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UnsupportedLockfileError("package-lock.json is not valid JSON.");
  }
  const lock = data as { lockfileVersion?: unknown; packages?: Record<string, Record<string, unknown>> };
  if (typeof lock.lockfileVersion !== "number" || lock.lockfileVersion < 2 || !lock.packages || typeof lock.packages !== "object") {
    throw new UnsupportedLockfileError("Only package-lock.json v2 and v3 are supported (npm 7+).");
  }

  const root = lock.packages[""] ?? {};
  const direct = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const deps = root[field];
    if (deps && typeof deps === "object") for (const name of Object.keys(deps)) direct.add(name);
  }

  const packages = new Map<string, LockedPackage>();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.includes("node_modules/") || entry.link === true) continue;
    const name = typeof entry.name === "string" ? entry.name : path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const version = entry.version;
    if (typeof version !== "string" || !NPM_NAME.test(name) || !EXACT_VERSION.test(version)) continue;
    packages.set(path, { name, version });
  }

  return { direct, packages };
}

/** Added or changed package versions in `head` compared with `base`, direct dependencies first. */
export function diffLockfiles(base: ParsedLockfile | null, head: ParsedLockfile): LockChange[] {
  const changes = new Map<string, LockChange>();
  for (const [path, pkg] of head.packages) {
    const previous = base?.packages.get(path)?.version ?? null;
    if (previous === pkg.version) continue;
    const direct = path === `node_modules/${pkg.name}` && head.direct.has(pkg.name);
    const key = `${pkg.name}@${pkg.version}`;
    const existing = changes.get(key);
    if (!existing || (direct && !existing.direct)) {
      changes.set(key, { name: pkg.name, from: previous, to: pkg.version, direct });
    }
  }
  return [...changes.values()].sort((left, right) =>
    Number(right.direct) - Number(left.direct) || left.name.localeCompare(right.name));
}
