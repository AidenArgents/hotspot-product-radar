import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const ignored = new Set([path.normalize("scripts/check-no-committed-secrets.mjs")]);
const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".html",
  ".css",
  ".md",
  ".txt",
  ".bat",
  ".cmd",
  ".ps1",
  ".yml",
  ".yaml",
]);
const secretPatterns = [
  /AIza[0-9A-Za-z_-]{20,}/,
  /tvly-[0-9A-Za-z_-]{20,}/,
  /-----BEGIN PRIVATE KEY-----/,
  /SEC[0-9a-f]{40,}/i,
];

const output = execFileSync(
  "git",
  ["-c", "core.quotePath=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
);
const files = output.split("\0").filter(Boolean);
const leaks = [];

for (const relativeName of files) {
  const relative = path.normalize(relativeName);
  if (ignored.has(relative)) continue;
  if (!textExtensions.has(path.extname(relative).toLowerCase())) continue;

  const file = path.join(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  const content = fs.readFileSync(file, "utf8");
  if (secretPatterns.some((pattern) => pattern.test(content))) leaks.push(relativeName);
}

if (leaks.length) {
  console.error(`发现疑似明文密钥：${leaks.join(", ")}`);
  process.exit(1);
}
console.log("通过：待发布文件中未发现明文密钥。");
