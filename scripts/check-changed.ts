// Runs the fast checks for this branch's changes, side by side: format and lint
// of the changed files, knip, typecheck of the affected workspaces and their
// dependents, and the test suites those workspaces own. Adapted from t3code's
// scripts/check-changed.ts.
//
//   bun --no-env-file run check:changed          compare against the merge base with origin/main
//   bun --no-env-file run check:changed <ref>    compare against the merge base with <ref>
//
// Uncommitted and untracked files count. Exits non-zero when any step fails.
import { $ } from "bun";

type Workspace = "sdk" | "web" | "host" | "mock";

// Path prefix -> workspaces whose typecheck or tests can change with it.
// inbox-sdk feeds every app; apps/shared is imported by web and local-host.
const AFFECTS: ReadonlyArray<readonly [prefix: string, workspaces: ReadonlyArray<Workspace>]> = [
  ["packages/inbox-sdk/", ["sdk", "web", "host", "mock"]],
  ["apps/mock-api/", ["mock", "host"]],
  ["apps/shared/", ["web", "host"]],
  ["apps/web/", ["web"]],
  ["apps/local-host/", ["host"]],
  // apps/local-host's tsconfig also typechecks the root scripts.
  ["scripts/", ["host"]],
  ["package.json", ["sdk", "web", "host", "mock"]],
  ["bun.lock", ["sdk", "web", "host", "mock"]],
];

const TYPECHECK: Record<Workspace, ReadonlyArray<string>> = {
  sdk: ["bun", "--no-env-file", "run", "--cwd", "packages/inbox-sdk", "typecheck"],
  web: ["bun", "--no-env-file", "run", "--cwd", "apps/web", "tsc", "--noEmit", "-p", "."],
  host: ["bun", "--no-env-file", "run", "--cwd", "apps/local-host", "typecheck"],
  mock: ["bun", "--no-env-file", "run", "--cwd", "apps/mock-api", "typecheck"],
};

const TESTS: Partial<Record<Workspace, ReadonlyArray<string>>> = {
  sdk: ["bun", "--no-env-file", "run", "test:api"],
  web: ["bun", "--no-env-file", "run", "test:web"],
};

const LINTABLE = /\.(?:[cm]?[jt]sx?)$/u;

const lines = (text: string) => text.split("\n").filter(Boolean);

const base = Bun.argv[2] ?? "origin/main";
const mergeBase = (await $`git merge-base HEAD ${base}`.text()).trim();
const changed = [
  ...new Set([
    ...lines(await $`git diff --name-only --diff-filter=ACMR ${mergeBase}`.text()),
    ...lines(await $`git ls-files --others --exclude-standard`.text()),
  ]),
].toSorted();

if (changed.length === 0) {
  console.log(`No changes against ${base} (${mergeBase.slice(0, 12)}).`);
  process.exit(0);
}

const affected = new Set<Workspace>();
for (const file of changed) {
  for (const [prefix, workspaces] of AFFECTS) {
    if (file === prefix || file.startsWith(prefix)) workspaces.forEach((w) => affected.add(w));
  }
}
const code = changed.filter((file) => LINTABLE.test(file));

// `report` turns a step's stdout into the problems that count; empty means it
// passed, whatever the exit code.
type Step = { name: string; cmd: ReadonlyArray<string>; report?: (stdout: string) => string };

// The shape of `knip --reporter json`: one entry per file, one array per issue
// category. `duplicates` holds groups of names that export the same thing.
type KnipItem = { name: string } | ReadonlyArray<{ name: string }>;
type KnipReport = {
  issues: Array<{ file: string; [category: string]: string | ReadonlyArray<KnipItem> }>;
};

const knipItemName = (item: KnipItem) =>
  "name" in item ? item.name : item.map((alias) => alias.name).join("|");

// knip checks the whole repo, which still has older findings; keep the ones in changed files.
const knipInChangedFiles = (stdout: string) => {
  const { issues }: KnipReport = JSON.parse(stdout);
  return issues
    .filter((issue) => changed.includes(issue.file))
    .flatMap(({ file, ...categories }) =>
      Object.entries(categories).flatMap(([category, items]) =>
        typeof items !== "string" && items.length > 0
          ? [`${file}: ${category} ${items.map(knipItemName).join(", ")}`]
          : [],
      ),
    )
    .join("\n");
};

// Static checks run side by side; test suites run one at a time after them,
// because their timing-sensitive cases time out on a loaded machine.
const steps: Array<Step> = [
  { name: "fmt", cmd: ["oxfmt", "--check", "--no-error-on-unmatched-pattern", ...changed] },
];
const tests: Array<Step> = [];
if (code.length > 0) {
  steps.push({ name: "lint", cmd: ["oxlint", "--report-unused-disable-directives", ...code] });
}
if (code.length > 0 || changed.some((file) => file.endsWith("package.json"))) {
  steps.push({
    name: "knip",
    cmd: ["knip", "--no-progress", "--reporter", "json"],
    report: knipInChangedFiles,
  });
}
for (const workspace of affected) {
  steps.push({ name: `typecheck:${workspace}`, cmd: TYPECHECK[workspace] });
  const test = TESTS[workspace];
  if (test) tests.push({ name: `test:${workspace}`, cmd: test });
}

console.log(
  `${changed.length} changed files against ${base} (${mergeBase.slice(0, 12)}); running ${[...steps, ...tests].map((s) => s.name).join(", ")}.\n`,
);

const env = {
  ...process.env,
  PATH: `${process.cwd()}/node_modules/.bin:${process.env.PATH}`,
  // Keep live provider tests off, as AGENTS.md requires for test:api.
  INBOX_TEST_LIVE: "false",
};

const run = async ({ name, cmd, report }: Step) => {
  const started = performance.now();
  const proc = Bun.spawn([...cmd], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let problems = exitCode === 0 ? "" : `${stdout}${stderr}`;
  if (report) {
    try {
      problems = report(stdout);
    } catch {
      // Unreadable output means the tool itself failed; show what it printed.
      problems ||= `${stdout}${stderr}`;
    }
  }
  const ok = problems === "";
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} (${seconds}s)`);
  if (!ok) console.log(`${problems}\n`);
  return { name, ok, seconds };
};

const results = await Promise.all(steps.map(run));
for (const test of tests) results.push(await run(test));

console.log("\nSummary");
for (const { name, ok, seconds } of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} (${seconds}s)`);
}
process.exit(results.every((result) => result.ok) ? 0 : 1);
