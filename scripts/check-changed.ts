// Runs the fast checks for this branch's changes, side by side: format and lint
// of the changed files, knip, typecheck of the affected workspaces and their
// dependents, and the test suites that exercise them. Adapted from t3code's
// scripts/check-changed.ts.
//
//   bun --no-env-file run check:changed          compare against the merge base with origin/main
//   bun --no-env-file run check:changed <ref>    compare against the merge base with <ref>
//
// Uncommitted, untracked and deleted files count. Exits non-zero when any step fails.
import { existsSync } from "node:fs";
import { $ } from "bun";

const bunRun = (...args: ReadonlyArray<string>) => ["bun", "--no-env-file", "run", ...args];

// Typechecks run side by side; test suites run one at a time after them,
// because their timing-sensitive cases time out on a loaded machine.
const CHECKS = {
  sdk: { kind: "typecheck", cmd: bunRun("--cwd", "packages/inbox-sdk", "typecheck") },
  web: { kind: "typecheck", cmd: bunRun("--cwd", "apps/web", "tsc", "--noEmit", "-p", ".") },
  host: { kind: "typecheck", cmd: bunRun("--cwd", "apps/local-host", "typecheck") },
  mock: { kind: "typecheck", cmd: bunRun("--cwd", "apps/mock-api", "typecheck") },
  "test:api": { kind: "test", cmd: bunRun("test:api") },
  "test:web": { kind: "test", cmd: bunRun("test:web") },
} as const;

type Check = keyof typeof CHECKS;
const EVERYTHING: ReadonlyArray<Check> = ["sdk", "web", "host", "mock", "test:api", "test:web"];

// Path prefix -> checks that can change with it. inbox-sdk feeds every app;
// apps/shared is imported by web and local-host. Both suites import local-host,
// mock-api and shared code, and test:web also imports the SDK.
const AFFECTS: ReadonlyArray<readonly [prefix: string, checks: ReadonlyArray<Check>]> = [
  ["packages/inbox-sdk/", EVERYTHING],
  ["apps/mock-api/", ["mock", "host", "test:api", "test:web"]],
  ["apps/shared/", ["web", "host", "test:api", "test:web"]],
  ["apps/local-host/", ["host", "test:api", "test:web"]],
  ["apps/web/", ["web", "test:web"]],
  // apps/local-host's tsconfig also typechecks the root scripts.
  ["scripts/", ["host"]],
  ["tsconfig.base.json", ["sdk", "web", "host", "mock"]],
  ["package.json", EVERYTHING],
  ["bun.lock", EVERYTHING],
];

const LINTABLE = /\.(?:[cm]?[jt]sx?)$/u;

const lines = (text: string) => text.split("\n").filter(Boolean);

const base = Bun.argv[2] ?? "origin/main";
const mergeBase = (await $`git merge-base HEAD ${base}`.text()).trim();
const changed = [
  ...new Set([
    ...lines(await $`git diff --name-only --diff-filter=ACMRD ${mergeBase}`.text()),
    ...lines(await $`git ls-files --others --exclude-standard`.text()),
  ]),
].toSorted();

if (changed.length === 0) {
  console.log(`No changes against ${base} (${mergeBase.slice(0, 12)}).`);
  process.exit(0);
}

const affected = new Set<Check>();
for (const file of changed) {
  for (const [prefix, checks] of AFFECTS) {
    if (file === prefix || file.startsWith(prefix)) checks.forEach((c) => affected.add(c));
  }
}
// Deleted files still pick checks and knip, but format and lint need files on disk.
const present = changed.filter((file) => existsSync(file));
const code = changed.filter((file) => LINTABLE.test(file));
const presentCode = code.filter((file) => present.includes(file));

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

const steps: Array<Step> = [];
const tests: Array<Step> = [];
if (present.length > 0) {
  steps.push({
    name: "fmt",
    cmd: ["oxfmt", "--check", "--no-error-on-unmatched-pattern", ...present],
  });
}
if (presentCode.length > 0) {
  steps.push({
    name: "lint",
    cmd: ["oxlint", "--report-unused-disable-directives", ...presentCode],
  });
}
if (code.length > 0 || changed.some((file) => file.endsWith("package.json"))) {
  steps.push({
    name: "knip",
    cmd: ["knip", "--no-progress", "--reporter", "json"],
    report: knipInChangedFiles,
  });
}
for (const check of affected) {
  const { kind, cmd } = CHECKS[check];
  if (kind === "test") tests.push({ name: check, cmd });
  else steps.push({ name: `typecheck:${check}`, cmd });
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
