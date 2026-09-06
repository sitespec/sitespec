import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../packages/cli/src/init.ts";
import { buildProject } from "../packages/cli/src/build.ts";
import { inspectProject, validateProject } from "../packages/core/src/index.ts";

async function starter(prefix: string): Promise<{ temp: string; root: string }> {
  const temp = await mkdtemp(join(tmpdir(), prefix));
  const root = join(temp, "acme");
  await initProject({ directory: root, name: "Acme" });
  return { temp, root };
}

const localFontConfig = `specVersion: "0.1"
fonts:
  acme-sans:
    family: Acme Sans
    sources:
      - src: /fonts/acme-sans.woff2
        format: woff2
        weight: "100 900"
      - src: /fonts/acme-sans-italic.woff2
        format: woff2
        weight: "100 900"
        style: italic
        display: swap
`;

test("sitespec init creates the local-font design contract", async () => {
  const { temp, root } = await starter("site-spec-fonts-init-");
  try {
    const fonts = await readFile(join(root, "design", "fonts.yaml"), "utf8");
    assert.match(fonts, /specVersion: "0\.4"/);
    assert.match(fonts, /family: Inter/);
    assert.match(fonts, /src: \/fonts\/Inter-Regular\.woff2/);
    const result = await inspectProject(root, "fonts");
    assert.equal(result.type, "fonts");
    const inspected = result.fonts as { remoteFonts: boolean; formats: string[]; families: unknown[] };
    assert.equal(inspected.remoteFonts, false);
    assert.deepEqual(inspected.formats, ["woff2", "woff"]);
    assert.equal(inspected.families.length, 1);
    const family = inspected.families[0] as { id: string; family: string; sources: Array<{ src: string; format: string; weight: number }> };
    assert.equal(family.id, "inter");
    assert.equal(family.family, "Inter");
    assert.equal(family.sources[0]?.src, "/fonts/Inter-Regular.woff2");
    assert.equal(family.sources[0]?.format, "woff2");
    assert.equal(family.sources[0]?.weight, 400);
    assert.ok((await readFile(join(root, "public", "fonts", "Inter-Regular.woff2"))).length > 0);
    assert.match(await readFile(join(root, "public", "fonts", "LICENSE.txt"), "utf8"), /SIL OPEN FONT LICENSE/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("local variable and italic font faces validate with defaults", async () => {
  const { temp, root } = await starter("site-spec-fonts-valid-");
  try {
    await writeFile(join(root, "public", "fonts", "acme-sans.woff2"), "test fixture", "utf8");
    await writeFile(join(root, "public", "fonts", "acme-sans-italic.woff2"), "test fixture", "utf8");
    await writeFile(join(root, "design", "fonts.yaml"), localFontConfig, "utf8");
    const tokenFile = join(root, "design", "tokens.json");
    const tokenSource = await readFile(tokenFile, "utf8");
    await writeFile(
      tokenFile,
      tokenSource.replace(
        '"Inter, ui-sans-serif, system-ui, sans-serif"',
        '"Acme Sans, ui-sans-serif, system-ui, sans-serif"'
      ),
      "utf8"
    );

    const result = await validateProject(root);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics, null, 2));

    const inspected = await inspectProject(root, "fonts");
    const fonts = inspected.fonts as { families: Array<{ id: string; family: string; sources: Array<{ style: string; display: string; weight: string | number }> }> };
    assert.equal(fonts.families[0]?.id, "acme-sans");
    assert.equal(fonts.families[0]?.family, "Acme Sans");
    assert.equal(fonts.families[0]?.sources[0]?.style, "normal");
    assert.equal(fonts.families[0]?.sources[0]?.display, "swap");
    assert.equal(fonts.families[0]?.sources[1]?.style, "italic");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("missing local font file is repair-oriented", async () => {
  const { temp, root } = await starter("site-spec-fonts-missing-");
  try {
    await writeFile(join(root, "design", "fonts.yaml"), localFontConfig, "utf8");
    const result = await validateProject(root);
    const diagnostic = result.diagnostics.find(item => item.code === "FONT_ASSET_NOT_FOUND");
    assert.ok(diagnostic);
    assert.equal(diagnostic.file, "design/fonts.yaml");
    assert.equal(diagnostic.actual, "/fonts/acme-sans.woff2");
    assert.ok(diagnostic.suggestions?.some(item => item.action === "add-font-file" && item.file === "public/fonts/acme-sans.woff2"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("remote font URLs are rejected by the current contract", async () => {
  const { temp, root } = await starter("site-spec-fonts-remote-");
  try {
    await writeFile(join(root, "design", "fonts.yaml"), `specVersion: "0.1"
fonts:
  remote:
    family: Remote Font
    sources:
      - src: https://example.com/font.woff2
        format: woff2
        weight: 400
`, "utf8");
    const result = await validateProject(root);
    const diagnostic = result.diagnostics.find(item => item.code === "FONT_ASSET_PATH_INVALID");
    assert.ok(diagnostic);
    assert.equal(diagnostic.actual, "https://example.com/font.woff2");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("component and shell @font-face declarations are forbidden", async () => {
  const { temp, root } = await starter("site-spec-fonts-font-face-");
  try {
    const file = join(root, "shell", "default.astro");
    const source = await readFile(file, "utf8");
    await writeFile(file, source.replace("<style is:global>", `<style is:global>\n  @font-face { font-family: var(--font-family-body); src: url('/fonts/x.woff2'); }`), "utf8");
    const result = await validateProject(root);
    assert.ok(result.diagnostics.some(item => item.code === "DESIGN_FONT_FACE_FORBIDDEN" && item.file === "shell/default.astro"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});




test("declared font family must be wired into primitive fontFamily tokens", async () => {
  const { temp, root } = await starter("site-spec-fonts-token-wire-");
  try {
    await writeFile(join(root, "public", "fonts", "acme-sans.woff2"), "test fixture", "utf8");
    await writeFile(join(root, "design", "fonts.yaml"), `specVersion: "0.1"
fonts:
  acme-sans:
    family: Acme Sans
    sources:
      - src: /fonts/acme-sans.woff2
        format: woff2
        weight: 400
`, "utf8");
    const result = await validateProject(root);
    const diagnostic = result.diagnostics.find(item => item.code === "FONT_FAMILY_NOT_IN_TOKENS");
    assert.ok(diagnostic);
    assert.ok(diagnostic.suggestions?.some(item => item.action === "wire-font-to-design-tokens" && item.file === "design/tokens.json"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("npm run build generates @font-face CSS with deployment base-path rebasing", async () => {
  const { temp, root } = await starter("site-spec-fonts-build-");
  try {
    await writeFile(join(root, "public", "fonts", "acme-sans.woff2"), "test fixture", "utf8");
    await writeFile(join(root, "design", "fonts.yaml"), `specVersion: "0.1"
fonts:
  acme-sans:
    family: Acme Sans
    sources:
      - src: /fonts/acme-sans.woff2
        format: woff2
        weight: 400
`, "utf8");

    const siteFile = join(root, "site.yaml");
    const siteSource = await readFile(siteFile, "utf8");
    await writeFile(siteFile, siteSource.replace("https://acme.test", "https://example.github.io/acme"), "utf8");

    const tokenFile = join(root, "design", "tokens.json");
    const tokenSource = await readFile(tokenFile, "utf8");
    await writeFile(
      tokenFile,
      tokenSource.replace(
        '"Inter, ui-sans-serif, system-ui, sans-serif"',
        '"Acme Sans, ui-sans-serif, system-ui, sans-serif"'
      ),
      "utf8"
    );

    const result = await buildProject(root);
    assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));
    const css = await readFile(join(root, ".site", "astro", "src", "styles", "fonts.css"), "utf8");
    assert.match(css, /font-family: "Acme Sans";/);
    assert.match(css, /url\("\/acme\/fonts\/acme-sans\.woff2"\) format\("woff2"\)/);
    assert.match(css, /font-display: swap;/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
