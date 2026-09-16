import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpecVersion } from "@sitespec/core";

export async function readProjectSpecVersion(root: string): Promise<SpecVersion> {
  const source = await readFile(join(root, "site.yaml"), "utf8");
  const match = source.match(/^specVersion:\s*["']?(0\.[1234567])["']?\s*$/m);
  if (!match?.[1]) {
    throw new Error(`site.yaml must declare specVersion: "0.1", "0.2", "0.3", "0.4", "0.5", "0.6", or "0.7".`);
  }
  return match[1] as SpecVersion;
}
