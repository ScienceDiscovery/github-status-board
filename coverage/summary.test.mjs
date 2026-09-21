import assert from "node:assert/strict";
import { test } from "node:test";

import { isTestSource, parseLcov, summarizeCoverage } from "./summary.mjs";

const lcov = `TN:
SF:packages/example/dist/index.js
FNF:2
FNH:1
BRF:4
BRH:3
LF:8
LH:6
end_of_record
TN:
SF:packages/example/dist/index.test.js
FNF:1
FNH:1
BRF:1
BRH:1
LF:2
LH:2
end_of_record
`;

test("recognizes test and temporary source paths", () => {
  assert.equal(isTestSource("packages/example/dist/index.test.js"), true);
  assert.equal(isTestSource("packages\\example\\__tests__\\helper.js"), true);
  assert.equal(isTestSource(".tmp/server.mjs"), true);
  assert.equal(isTestSource("packages/example/dist/index.js"), false);
});

test("filters test files and aggregates LCOV metrics", () => {
  const summary = summarizeCoverage(parseLcov(lcov));
  assert.equal(summary.files, 1);
  assert.deepEqual(summary.totals.lines, { covered: 6, percentage: 75, total: 8 });
  assert.deepEqual(summary.totals.branches, { covered: 3, percentage: 75, total: 4 });
  assert.deepEqual(summary.totals.functions, { covered: 1, percentage: 50, total: 2 });
});
