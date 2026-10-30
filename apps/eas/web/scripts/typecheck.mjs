#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { removeNextTypeIncludes } from "./next-type-includes.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsconfigPath = path.join(webRoot, "tsconfig.json");
const tscBin = path.join(
  webRoot,
  "node_modules",
  "typescript",
  "bin",
  "tsc",
);
const original = readFileSync(tsconfigPath, "utf8");
const isolatedTsconfigPath = path.join(
  webRoot,
  `tsconfig.eas-typecheck-${process.pid}.json`,
);
const isolatedNextEnvPath = path.join(
  webRoot,
  `next-env.eas-typecheck-${process.pid}.d.ts`,
);

let result;
try {
  const isolatedConfig = JSON.parse(removeNextTypeIncludes(original));
  isolatedConfig.include = isolatedConfig.include.map((entry) =>
    entry === "next-env.d.ts"
      ? path.basename(isolatedNextEnvPath)
      : entry,
  );
  const nextEnv = readFileSync(path.join(webRoot, "next-env.d.ts"), "utf8")
    .replace(
      /^import ["']\.\/\.next\/(?:dev\/)?types\/routes\.d\.ts["'];\s*\r?\n?/m,
      "",
    );
  writeFileSync(isolatedNextEnvPath, nextEnv, "utf8");
  writeFileSync(
    isolatedTsconfigPath,
    `${JSON.stringify(isolatedConfig, null, 2)}\n`,
    "utf8",
  );
  result = spawnSync(
    process.execPath,
    [
      tscBin,
      "-p",
      isolatedTsconfigPath,
      "--noEmit",
      "--incremental",
      "false",
    ],
    { cwd: webRoot, stdio: "inherit" },
  );
} finally {
  rmSync(isolatedTsconfigPath, { force: true });
  rmSync(isolatedNextEnvPath, { force: true });
}

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
