import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { initProject } from "../packages/cli/src/init.ts";
import {
  deployGitHubPages,
  expectedGitHubPagesUrl,
  githubPagesWorkflow
} from "../packages/cli/src/deploy-github-pages.ts";

const execFileAsync = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args]);
}

test("GitHub Pages URL inference handles user and project sites", () => {
  assert.equal(expectedGitHubPagesUrl("octocat", "octocat.github.io"), "https://octocat.github.io");
  assert.equal(expectedGitHubPagesUrl("octocat", "docs"), "https://octocat.github.io/docs");
});

test("generated workflow uses the current GitHub Pages Actions flow", () => {
  const workflow = githubPagesWorkflow("main");
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.match(workflow, /actions\/configure-pages@v5/);
  assert.match(workflow, /actions\/upload-pages-artifact@v4/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /path: \.\/dist/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npm run build/);
  assert.doesNotMatch(workflow, /npm exec --yes/);
});

test("npm run site -- deploy github-pages creates an idempotent workflow and builds for the repository base path", async () => {
  const temp = await mkdtemp(join(tmpdir(), "site-pages-deploy-"));
  const root = join(temp, "acme");
  try {
    await initProject({ directory: root, name: "Acme" });
    const site = (await readFile(join(root, "site.yaml"), "utf8"))
      .replace("https://acme.test", "https://octocat.github.io/acme");
    await writeFile(join(root, "site.yaml"), site, "utf8");

    const home = (await readFile(join(root, "pages", "home.yaml"), "utf8"))
      .replace('href: https://github.com/sitespec/sitespec', 'href: /');
    await writeFile(join(root, "pages", "home.yaml"), home, "utf8");
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ name: "acme", lockfileVersion: 3, requires: true, packages: {} }, null, 2) + "\n", "utf8");

    await git(root, "init", "-b", "main");
    await git(root, "remote", "add", "origin", "https://github.com/octocat/acme.git");

    const first = await deployGitHubPages({ root });
    assert.equal(first.repository, "octocat/acme");
    assert.equal(first.branch, "main");
    assert.equal(first.workflowChanged, true);
    assert.equal(first.siteUrl, "https://octocat.github.io/acme");
    assert.equal(first.customDomain, false);

    const workflow = await readFile(join(root, ".github", "workflows", "site-pages.yml"), "utf8");
    assert.match(workflow, /branches:\n      - "main"/);
    assert.match(workflow, /run: npm ci/);
    assert.match(workflow, /run: npm run build/);

    const html = await readFile(join(root, "dist", "index.html"), "utf8");
    assert.match(html, /href="\/acme\/"/);
    assert.match(html, /rel="icon" href="\/acme\/brand\/favicon\.svg"/);

    const examplesHtml = await readFile(join(root, "dist", "examples", "index.html"), "utf8");
    assert.match(examplesHtml, /href="\/acme\/examples\?page=2"/);
    assert.doesNotMatch(examplesHtml, /href="\/examples\?page=2"/);

    const second = await deployGitHubPages({ root });
    assert.equal(second.workflowChanged, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
