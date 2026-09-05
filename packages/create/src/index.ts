#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { stdin as input, stdout as output } from "node:process";
import { createDefaultSite } from "@sitespec/template";

const execFileAsync = promisify(execFile);

interface Options {
  directory?: string;
  name?: string;
  install: boolean;
  git: boolean;
}

function usage(): string {
  return `create-sitespec [directory] [options]\n\nOptions:\n  --name <name>    Site display name\n  --no-install     Do not run npm install\n  --no-git         Do not initialize a Git repository\n  -h, --help       Show help\n\nRecommended:\n  npm create @sitespec@latest my-site\n`;
}

function parseArgs(argv: string[]): Options & { help?: boolean } {
  const result: Options & { help?: boolean } = { install: true, git: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-h" || arg === "--help") {
      result.help = true;
      continue;
    }
    if (arg === "--no-install") {
      result.install = false;
      continue;
    }
    if (arg === "--no-git") {
      result.git = false;
      continue;
    }
    if (arg === "--name") {
      const value = argv[index + 1];
      if (!value) throw new Error("--name requires a value");
      result.name = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    if (result.directory) throw new Error(`Unexpected argument: ${arg}`);
    result.directory = arg;
  }
  return result;
}

async function promptDirectory(): Promise<string> {
  if (!input.isTTY || !output.isTTY) return "sitespec-site";
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question("Project name: ")).trim();
    return answer || "sitespec-site";
  } finally {
    rl.close();
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["--version"], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

async function initializeGit(root: string): Promise<boolean> {
  if (!(await commandExists("git"))) return false;
  try {
    await access(resolve(root, ".git"));
    return false;
  } catch {
    await execFileAsync("git", ["-C", root, "init"], { encoding: "utf8" });
    return true;
  }
}

async function installDependencies(root: string): Promise<void> {
  await execFileAsync("npm", ["install"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
}

async function packageVersion(): Promise<string> {
  const file = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(await readFile(file, "utf8")) as { version?: string };
  if (!packageJson.version) throw new Error("@sitespec/create package version is missing");
  return packageJson.version;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const directory = options.directory ?? await promptDirectory();
  const root = resolve(directory);
  const created = await createDefaultSite({ directory: root, name: options.name, cliVersion: await packageVersion() });

  let installed = false;
  if (options.install) {
    process.stdout.write("Installing dependencies...\n");
    await installDependencies(root);
    installed = true;
  }

  let gitInitialized = false;
  if (options.git) gitInitialized = await initializeGit(root);

  const displayPath = basename(root) === directory ? directory : root;
  process.stdout.write(`\nCreated ${created.name} in ${displayPath}\n`);
  process.stdout.write(`  Site Spec files: ${created.files.length}\n`);
  process.stdout.write(`  Dependencies: ${installed ? "installed" : "not installed"}\n`);
  process.stdout.write(`  Git: ${gitInitialized ? "initialized" : "unchanged"}\n\n`);
  process.stdout.write(`Next:\n  cd ${directory}\n`);
  if (!installed) process.stdout.write("  npm install\n");
  process.stdout.write("  npm run dev\n");
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ERROR CREATE_SITESPEC_FAILED\n  ${message}\n`);
  process.exitCode = 1;
});
