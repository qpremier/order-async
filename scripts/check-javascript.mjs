import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const targets = process.argv.slice(2);

if (targets.length === 0) {
  throw new Error("Pass one or more JavaScript files or directories to check.");
}

const files = targets.flatMap(collectJavaScriptFiles).sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);

function collectJavaScriptFiles(target) {
  const resolvedTarget = path.resolve(target);
  const stat = fs.statSync(resolvedTarget);

  if (stat.isFile()) {
    return path.extname(resolvedTarget) === ".js" ? [resolvedTarget] : [];
  }

  return fs.readdirSync(resolvedTarget, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(resolvedTarget, entry.name);

    if (entry.isDirectory()) {
      return collectJavaScriptFiles(entryPath);
    }

    return entry.isFile() && path.extname(entry.name) === ".js" ? [entryPath] : [];
  });
}
