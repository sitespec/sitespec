import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createDefaultSite,
  type CreateDefaultSiteResult
} from "@sitespec/template";

export interface InitProjectOptions {
  directory: string;
  name?: string;
}

export type InitProjectResult = CreateDefaultSiteResult;

async function cliVersion(): Promise<string> {
  const packageFile = fileURLToPath(new URL("../package.json", import.meta.url));
  const packageJson = JSON.parse(await readFile(packageFile, "utf8")) as { version?: string };
  if (!packageJson.version) throw new Error("@sitespec/cli package version is missing");
  return packageJson.version;
}

export async function initProject(options: InitProjectOptions): Promise<InitProjectResult> {
  return createDefaultSite({ ...options, cliVersion: await cliVersion() });
}
