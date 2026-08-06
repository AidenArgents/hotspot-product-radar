import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const ignored = new Set([
  path.normalize("config/radar_config.local.json"),
  path.normalize("scripts/check-no-committed-secrets.mjs"),
]);
const secretPatterns = [
  /AIza[0-9A-Za-z_-]{20,}/,
  /tvly-[0-9A-Za-z_-]{20,}/,
  /-----BEGIN PRIVATE KEY-----/,
  /SEC[0-9a-f]{40,}/i,
];

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

const leaks = [];
for (const file of walk(root)) {
  const relative = path.normalize(path.relative(root, file));
  if (ignored.has(relative)) continue;
  const text = fs.readFileSync(file, "utf8");
  if (secretPatterns.some((pattern) => pattern.test(text))) leaks.push(relative);
}

if (leaks.length) {
  console.error(`发现疑似明文密钥：${leaks.join(", ")}`);
  process.exit(1);
}
console.log("通过：版本化文件中未发现原流程明文密钥。");
