import { readFile, writeFile } from "node:fs/promises";

const metricKeys = {
  branches: ["BRH", "BRF"],
  functions: ["FNH", "FNF"],
  lines: ["LH", "LF"],
};

function numericField(lines, key) {
  const field = lines.find((line) => line.startsWith(`${key}:`));
  return field ? Number(field.slice(key.length + 1)) : 0;
}

export function parseLcov(source) {
  return source.split(/end_of_record\r?\n/).map((record) => {
    const text = record.trim();
    if (!text) return undefined;
    const lines = text.split(/\r?\n/);
    const file = lines.find((line) => line.startsWith("SF:"))?.slice(3);
    if (!file) throw new Error("LCOV record is missing an SF field");
    const metrics = Object.fromEntries(Object.entries(metricKeys).map(([name, [covered, total]]) => [name, {
      covered: numericField(lines, covered),
      total: numericField(lines, total),
    }]));
    return { file, metrics, text: `${text}\nend_of_record\n` };
  }).filter(Boolean);
}

export function isTestSource(file) {
  const normalized = file.replaceAll("\\", "/");
  return /(^|\/)(?:test|tests|__tests__|\.tmp)\//.test(normalized)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(normalized);
}

function percentage(covered, total) {
  return total === 0 ? null : Number(((covered / total) * 100).toFixed(2));
}

export function summarizeCoverage(records) {
  const measured = records.filter((record) => !isTestSource(record.file));
  const totals = Object.fromEntries(Object.keys(metricKeys).map((name) => {
    const covered = measured.reduce((sum, record) => sum + record.metrics[name].covered, 0);
    const total = measured.reduce((sum, record) => sum + record.metrics[name].total, 0);
    return [name, { covered, percentage: percentage(covered, total), total }];
  }));
  return { files: measured.length, records: measured, totals };
}

export async function writeCoverageSummary({ input, lcovOutput, jsonOutput, metadata }) {
  const records = parseLcov(await readFile(input, "utf8"));
  const summary = summarizeCoverage(records);
  const document = {
    files: summary.files,
    scope: "Built ScienceDiscovery Node.js tests; excludes browser/TSX, Python, and Playwright suites.",
    source: metadata,
    totals: summary.totals,
  };
  await Promise.all([
    writeFile(lcovOutput, summary.records.map((record) => record.text).join("")),
    writeFile(jsonOutput, `${JSON.stringify(document, null, 2)}\n`),
  ]);
  return document;
}
