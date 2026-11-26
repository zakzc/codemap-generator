import { execFileSync } from "node:child_process";

export const run = (cwd: string, args: string[]): string | null => {
  try {
    // external diff / textconv drivers off so no repo-configured program runs (Spec 1 §8)
    return execFileSync("git", ["-C", cwd, "-c", "core.quotepath=off", ...args], { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return null; }
};

/** Strips user/password/token from scheme URLs; scp-style `git@host:x` has no secret and is kept. */
export function sanitizeRemote(url: string): string {
  try {
    if (!url.includes("://")) return url;
    const u = new URL(url);
    u.username = ""; u.password = "";
    return u.toString();
  } catch { return ""; }
}

export type GitInfo = { root: string; commit: string | null; commitDate: string | null; dirty: boolean; remote?: string };

export function gitInfo(dir: string): GitInfo | null {
  const root = run(dir, ["rev-parse", "--show-toplevel"])?.trim();
  if (!root) return null;
  const commit = run(root, ["rev-parse", "--short", "HEAD"])?.trim() || null;
  const commitDate = commit ? run(root, ["log", "-1", "--format=%cI", "HEAD"])?.trim() || null : null;
  const dirty = (run(root, ["status", "--porcelain"]) ?? "").trim() !== "";
  const raw = run(root, ["remote", "get-url", "origin"])?.trim();
  const remote = raw ? sanitizeRemote(raw) || undefined : undefined;
  return { root, commit, commitDate, dirty, remote };
}

export const gitFiles = (root: string): string[] | null =>
  run(root, ["ls-files", "-z", "--cached"])?.split("\0").filter(Boolean) ?? null;
