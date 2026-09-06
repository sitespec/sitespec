#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entryUrl = new URL("../dist/index.js", import.meta.url);
const entryFile = fileURLToPath(entryUrl);

if (!existsSync(entryFile)) {
  console.error("SiteSpec CLI is installed but has not been built yet.");
  console.error("Run `npm run build` from the SiteSpec repository root, then retry this command.");
  process.exitCode = 1;
} else {
  await import(entryUrl.href);
}
