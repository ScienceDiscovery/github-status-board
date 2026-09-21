import { spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { writeCoverageSummary } from "./summary.mjs";

const sourceRoot = resolve(process.argv[2] || "target");
const outputDirectory = resolve(process.argv[3] || "coverage-output");
const rawLcov = join(outputDirectory, ".node.lcov");
const testConcurrency = process.env.COVERAGE_TEST_CONCURRENCY?.trim() || "4";

if (!/^[1-9]\d*$/.test(testConcurrency)) {
  throw new Error("COVERAGE_TEST_CONCURRENCY must be a positive integer");
}

async function collectFiles(directory, predicate) {
  const found = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && predicate(path)) found.push(path);
    }
  }
  try {
    await stat(directory);
    await visit(directory);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return found;
    throw error;
  }
  return found;
}

function nodeTestFile(path) {
  const normalized = relative(sourceRoot, path).replaceAll("\\", "/");
  return (normalized.includes("/dist/") && normalized.endsWith(".test.js"))
    || normalized.startsWith("scripts/") && normalized.endsWith(".test.mjs")
    || normalized.startsWith("services/runner/scripts/") && normalized.endsWith(".test.mjs");
}

async function nodeTestFiles() {
  const files = await Promise.all([
    collectFiles(join(sourceRoot, "packages"), nodeTestFile),
    collectFiles(join(sourceRoot, "scripts"), nodeTestFile),
    collectFiles(join(sourceRoot, "services"), nodeTestFile),
  ]);
  return files.flat().sort().map((file) => relative(sourceRoot, file));
}

function run(command, args) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd: sourceRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit(code ?? (signal ? 128 : 1)));
  });
}

await mkdir(dirname(rawLcov), { recursive: true });
const testFiles = await nodeTestFiles();
if (testFiles.length === 0) throw new Error(`No built Node test files found below ${sourceRoot}`);

console.log(`Collecting ScienceDiscovery Node coverage from ${testFiles.length} test files.`);
const testExitCode = await run(process.execPath, [
  "--experimental-test-coverage",
  "--test",
  `--test-concurrency=${testConcurrency}`,
  "--test-reporter=spec",
  "--test-reporter=lcov",
  "--test-reporter-destination=stdout",
  `--test-reporter-destination=${rawLcov}`,
  ...testFiles,
]);

const summary = await writeCoverageSummary({
  input: rawLcov,
  jsonOutput: join(outputDirectory, "summary.json"),
  lcovOutput: join(outputDirectory, "lcov.info"),
  metadata: {
    repository: process.env.SCIENCEDISCOVERY_REPOSITORY || "openJiuwen-ai/sciencediscovery",
    sha: process.env.SCIENCEDISCOVERY_SHA || null,
  },
});

for (const metric of ["lines", "branches", "functions"]) {
  const value = summary.totals[metric];
  console.log(`${metric}: ${value.covered}/${value.total} (${value.percentage ?? "n/a"}%)`);
}
console.log(`Coverage reports written to ${outputDirectory}`);
process.exitCode = testExitCode;
