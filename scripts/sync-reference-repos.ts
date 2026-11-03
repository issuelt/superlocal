// Clones or updates the read-only reference repositories in `/.reference/`
// (gitignored) at the main checkout's root, so every worktree shares one copy.
// Adapted from t3code's scripts/sync-reference-repos.ts, which vendors with
// git subtree; here each repo is a plain shallow clone.
//
//   bun --no-env-file run sync:repos                 sync every repo
//   bun --no-env-file run sync:repos effect t3code   sync the named repos
//   bun --no-env-file run sync:repos --latest        follow each repo's branch, ignoring pins
//   bun --no-env-file run sync:repos --dry-run       print the plan only
//   bun --no-env-file run sync:repos --dir <path>    use another reference directory
//
// A clone with local changes is skipped, never reset.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

interface ReferenceRepo {
  readonly id: string;
  readonly url: string;
  readonly branch: string;
  // Pin to the version we install: [manifest, dependency, tag prefix].
  readonly pin?: readonly [manifest: string, dependency: string, tagPrefix: string];
}

const REPOS: ReadonlyArray<ReferenceRepo> = [
  {
    id: "effect",
    url: "https://github.com/Effect-TS/effect.git",
    branch: "main",
    pin: ["packages/inbox-sdk/package.json", "effect", "effect@"],
  },
  { id: "t3code", url: "https://github.com/pingdotgg/t3code.git", branch: "main" },
  { id: "executor", url: "https://github.com/UsefulSoftwareCo/executor.git", branch: "main" },
  { id: "opencode", url: "https://github.com/anomalyco/opencode.git", branch: "dev" },
];

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    latest: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    dir: { type: "string" },
  },
});

const unknown = positionals.filter((id) => !REPOS.some((repo) => repo.id === id));
if (unknown.length > 0) {
  console.error(
    `Unknown repo: ${unknown.join(", ")}. Expected: ${REPOS.map((r) => r.id).join(", ")}.`,
  );
  process.exit(1);
}
const selected = positionals.length > 0 ? REPOS.filter((r) => positionals.includes(r.id)) : REPOS;

// The first `git worktree list` entry is the main checkout.
const mainCheckout = (await $`git worktree list --porcelain`.text())
  .split("\n")[0]!
  .replace(/^worktree /u, "");
const referenceDir = values.dir ?? join(mainCheckout, ".reference");

const resolveRef = async (repo: ReferenceRepo) => {
  if (!repo.pin || values.latest) return { ref: repo.branch, tag: false };
  const [manifest, dependency, tagPrefix] = repo.pin;
  const pkg: { dependencies?: Record<string, string> } = await Bun.file(manifest).json();
  const version = pkg.dependencies?.[dependency]?.replace(/^[\^~]/u, "");
  if (!version)
    throw new Error(`${manifest} has no ${dependency} dependency to pin ${repo.id} to.`);
  return { ref: `${tagPrefix}${version}`, tag: true };
};

let failed = false;
for (const repo of selected) {
  const dir = join(referenceDir, repo.id);
  const { ref, tag } = await resolveRef(repo);
  const exists = existsSync(join(dir, ".git"));
  console.log(`${repo.id}: ${exists ? "update" : "clone"} ${ref} -> ${dir}`);
  if (values["dry-run"]) continue;

  try {
    if (!exists) {
      await $`git -c advice.detachedHead=false clone --quiet --depth 1 --branch ${ref} ${repo.url} ${dir}`;
    } else if ((await $`git -C ${dir} status --porcelain`.text()).trim()) {
      console.warn(`  skipped: ${dir} has local changes`);
      continue;
    } else {
      const refspec = tag ? `refs/tags/${ref}:refs/tags/${ref}` : ref;
      await $`git -C ${dir} fetch --quiet --depth 1 origin ${refspec}`;
      // A tag pin detaches HEAD; a branch keeps its name and moves to the fetched tip.
      if (tag) await $`git -C ${dir} checkout --quiet --detach ${ref}`;
      else await $`git -C ${dir} checkout --quiet -B ${ref} FETCH_HEAD`;
    }
    console.log(`  at ${(await $`git -C ${dir} log -1 ${"--format=%h %s"}`.text()).trim()}`);
  } catch (error) {
    failed = true;
    console.error(`  failed: ${error instanceof $.ShellError ? error.stderr.toString() : error}`);
  }
}
process.exit(failed ? 1 : 0);
