import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildRegistry,
  buildUiRegistry,
  inspectDesign,
  loadDesignSystemContract,
  type RegisteredComponent,
  type RegisteredUiPrimitive,
  type ResolvedSite
} from "@sitespec/core";

interface DesignLabOptions {
  root: string;
  generatedSrc: string;
  site: ResolvedSite;
}

type SampleMode = "normal" | "stress";

type JsonSchema = Record<string, unknown>;

interface LabFixture {
  normal?: Record<string, unknown>;
  stress?: Record<string, unknown>;
  normalError?: string;
  stressError?: string;
}

const PLACEHOLDER_PATH = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 1200 800%27%3E%3Crect width=%271200%27 height=%27800%27 fill=%27%23e7e6df%27/%3E%3Ccircle cx=%27930%27 cy=%27180%27 r=%27180%27 fill=%27%235746db%27/%3E%3Crect x=%27120%27 y=%27140%27 width=%27520%27 height=%2750%27 rx=%278%27 fill=%27%23171713%27/%3E%3Crect x=%27120%27 y=%27230%27 width=%27690%27 height=%2724%27 rx=%276%27 fill=%27%2368685f%27/%3E%3C/svg%3E";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: string, schema: JsonSchema): string {
  const minLength = typeof schema.minLength === "number" ? schema.minLength : 0;
  const maxLength = typeof schema.maxLength === "number" ? schema.maxLength : undefined;
  let result = value;
  if (maxLength !== undefined && result.length > maxLength) result = result.slice(0, maxLength);
  if (result.length < minLength) result = `${result}${"x".repeat(minLength - result.length)}`;
  return result;
}

function sampleString(key: string, schema: JsonSchema, mode: SampleMode, index: number): string {
  const lower = key.toLowerCase();
  const stress = mode === "stress";
  let value = stress ? "A deliberately long sample value used to expose wrapping, overflow, hierarchy, and spacing problems in the design system" : "Sample";

  if (lower === "id" || lower.endsWith("id")) value = `sample-${index + 1}`;
  else if (lower.includes("href") || lower === "url") value = "#design-lab";
  else if (lower === "src") value = PLACEHOLDER_PATH;
  else if (lower.includes("alt")) value = "Abstract SiteSpec Design Lab placeholder";
  else if (lower.includes("eyebrow")) value = stress ? "DESIGN SYSTEM / STRESS TEST / LONG EYEBROW" : "Design system";
  else if (lower.includes("title") || lower.includes("heading") || lower === "name") value = stress
    ? "A much longer heading that deliberately wraps across several lines to test the resilience of this design system"
    : index > 0 ? `Design system example ${index + 1}` : "Design systems as executable constraints";
  else if (lower.includes("description") || lower === "text" || lower.includes("summary")) value = stress
    ? "This intentionally verbose paragraph is long enough to create awkward line lengths and multiple wrapped lines. It helps reveal fragile spacing, density, contrast, and alignment decisions before they reach a real page."
    : "A practical preview of typography, spacing, hierarchy, and component behavior using the real SiteSpec implementation.";
  else if (lower === "label") value = stress ? "Open the complete design system documentation" : "Explore SiteSpec";
  else if (lower.includes("date")) value = "2026-09-16";
  else if (lower === "format") value = "markdown";
  else if (lower === "source") value = "Design Lab fixture source";
  else if (lower === "html") value = stress
    ? "<p>This is a longer rendered content fixture with enough text to exercise paragraph rhythm and vertical spacing across multiple lines.</p><p>It intentionally contains a second paragraph.</p>"
    : "<p>Rendered content fixture for the SiteSpec Design Lab.</p>";
  else if (lower.includes("family")) value = "system-ui, sans-serif";

  return boundedText(value, schema);
}

function sampleRef(ref: string, mode: SampleMode): unknown {
  const stress = mode === "stress";
  if (ref.endsWith(":type:action")) return {
    label: stress ? "Open the complete design system documentation" : "Explore SiteSpec",
    href: "#design-lab",
    target: "self"
  };
  if (ref.endsWith(":type:navigation")) {
    const count = stress ? 7 : 3;
    return Array.from({ length: count }, (_, index) => ({
      id: `item-${index + 1}`,
      label: stress ? `Navigation item with a deliberately long label ${index + 1}` : `Navigation ${index + 1}`,
      href: "#design-lab",
      target: "self"
    }));
  }
  if (ref.endsWith(":type:pagination")) return {
    currentPage: 2,
    totalPages: stress ? 12 : 4,
    previousHref: "#design-lab",
    nextHref: "#design-lab",
    pages: Array.from({ length: stress ? 9 : 4 }, (_, index) => ({
      page: index + 1,
      href: "#design-lab",
      current: index === 1
    }))
  };
  if (ref.includes(":type:image")) return {
    src: PLACEHOLDER_PATH,
    alt: "Abstract SiteSpec Design Lab placeholder",
    width: 1200,
    height: 800,
    loading: "eager",
    decoding: "async"
  };
  return {};
}

function numberValue(schema: JsonSchema, integer: boolean, mode: SampleMode): number {
  const minimum = typeof schema.minimum === "number" ? schema.minimum : 0;
  const maximum = typeof schema.maximum === "number" ? schema.maximum : undefined;
  let value = mode === "stress" && maximum !== undefined ? maximum : Math.max(minimum, integer ? 2 : 1.5);
  if (maximum !== undefined) value = Math.min(value, maximum);
  return integer ? Math.round(value) : value;
}

function sampleFromSchema(
  schemaValue: unknown,
  key = "value",
  mode: SampleMode = "normal",
  depth = 0,
  index = 0,
  includeOptional = true
): unknown {
  if (!isRecord(schemaValue) || depth > 8) return {};
  const schema = schemaValue as JsonSchema;

  if (typeof schema.$ref === "string") return sampleRef(schema.$ref, mode);
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return sampleFromSchema(schema.oneOf[0], key, mode, depth + 1, index, includeOptional);
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return sampleFromSchema(schema.anyOf[0], key, mode, depth + 1, index, includeOptional);

  let type = typeof schema.type === "string" ? schema.type : undefined;
  if (!type && isRecord(schema.properties)) type = "object";
  if (!type && schema.items) type = "array";

  if (type === "object") {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
    const output: Record<string, unknown> = {};
    let propertyIndex = 0;
    for (const [property, childSchema] of Object.entries(properties)) {
      // Exercise the full public contract first, but allow a required-only fallback for
      // schemas whose optional values cannot be inferred safely from JSON Schema alone.
      if (property === "error" && !required.has(property)) {
        propertyIndex += 1;
        continue;
      }
      if (required.has(property) || (includeOptional && depth < 5)) {
        output[property] = sampleFromSchema(childSchema, property, mode, depth + 1, propertyIndex, includeOptional);
      }
      propertyIndex += 1;
    }
    return output;
  }

  if (type === "array") {
    const minimum = typeof schema.minItems === "number" ? schema.minItems : 1;
    const maximum = typeof schema.maxItems === "number" ? schema.maxItems : undefined;
    let count = mode === "stress" ? Math.max(minimum, 6) : Math.max(minimum, 3);
    if (maximum !== undefined) count = Math.min(count, maximum);
    return Array.from({ length: count }, (_, itemIndex) => sampleFromSchema(schema.items, key, mode, depth + 1, itemIndex, includeOptional));
  }
  if (type === "integer") return numberValue(schema, true, mode);
  if (type === "number") return numberValue(schema, false, mode);
  if (type === "boolean") {
    const lower = key.toLowerCase();
    if (["disabled", "readonly", "required"].includes(lower)) return false;
    return mode === "stress";
  }
  if (type === "null") return null;
  return sampleString(key, schema, mode, index);
}

function validationMessage(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) return "Generated fixture does not satisfy the contract.";
  return errors.slice(0, 3).map(error => {
    if (!isRecord(error)) return String(error);
    const path = typeof error.instancePath === "string" ? error.instancePath : "";
    const message = typeof error.message === "string" ? error.message : "invalid value";
    return `${path || "/"} ${message}`;
  }).join("; ");
}

function validatedFixture(
  item: RegisteredComponent | RegisteredUiPrimitive,
  mode: SampleMode
): { value?: Record<string, unknown>; error?: string } {
  const fullValue = sampleFromSchema(item.manifest.props, "props", mode, 0, 0, true);
  const full = isRecord(fullValue) ? fullValue : undefined;
  if (full && item.validateProps(full)) return { value: full };

  const requiredValue = sampleFromSchema(item.manifest.props, "props", mode, 0, 0, false);
  const required = isRecord(requiredValue) ? requiredValue : undefined;
  if (required && item.validateProps(required)) return { value: required };

  return { error: validationMessage(item.validateProps.errors) };
}

function fixtureFor(item: RegisteredComponent | RegisteredUiPrimitive): LabFixture {
  const normal = validatedFixture(item, "normal");
  const stress = validatedFixture(item, "stress");
  return {
    normal: normal.value,
    stress: stress.value,
    normalError: normal.error,
    stressError: stress.error
  };
}

export function designLabStressFixture(item: RegisteredComponent): Record<string, unknown> | undefined {
  return validatedFixture(item, "stress").value;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2).replaceAll("</script", "<\\/script");
}

function astroText(value: unknown): string {
  return `{${JSON.stringify(String(value))}}`;
}

function uiPropSchema(item: RegisteredUiPrimitive, prop: string): JsonSchema | undefined {
  const schema = item.manifest.props;
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;
  const value = schema.properties[prop];
  return isRecord(value) ? value : undefined;
}

function uiHasProp(item: RegisteredUiPrimitive, prop: string): boolean {
  return uiPropSchema(item, prop) !== undefined;
}

function uiStateProps(item: RegisteredUiPrimitive, variant: string, state: string): string {
  const props: string[] = [];
  if (uiHasProp(item, "id")) props.push(` id=${JSON.stringify(`lab-${item.id}-${variant}-${state}`)}`);
  if (uiHasProp(item, "disabled")) props.push(` disabled={${state === "disabled" ? "true" : "false"}}`);
  if (uiHasProp(item, "readonly")) props.push(` readonly={${state === "readonly" ? "true" : "false"}}`);
  if (uiHasProp(item, "checked")) props.push(` checked={${state === "checked" ? "true" : "false"}}`);
  if (uiHasProp(item, "error")) {
    props.push(state === "invalid"
      ? ` error="This value does not satisfy the field requirements."`
      : ` error={undefined}`);
  }
  return props.join("");
}

function uiMarkup(items: RegisteredUiPrimitive[]): { imports: string; constants: string; markup: string } {
  const imports: string[] = [];
  const constants: string[] = [];
  const markup: string[] = [];

  items.forEach((item, itemIndex) => {
    const name = `Ui${itemIndex}`;
    const fixture = fixtureFor(item);
    imports.push(`import ${name} from "@site-project/${item.implementation}";`);
    constants.push(`const uiFixture${itemIndex} = ${serialize(fixture)};`);
    const variants = item.variants.length ? item.variants : ["default"];
    const states = item.states.length ? item.states : ["default"];

    const cases = variants.map(variant => {
      const stateCells = states.map(state => {
        const stateProp = uiStateProps(item, variant, state);
        const normal = fixture.normal
          ? `<div class="lab-fixture" data-lab-fixture-mode="normal"><${name} {...uiFixture${itemIndex}.normal} variant=${JSON.stringify(variant)}${stateProp} /></div>`
          : `<div class="lab-fixture-error" data-lab-fixture-mode="normal">Automatic fixture unavailable: {uiFixture${itemIndex}.normalError}</div>`;
        const stress = fixture.stress
          ? `<div class="lab-fixture" data-lab-fixture-mode="stress"><${name} {...uiFixture${itemIndex}.stress} variant=${JSON.stringify(variant)}${stateProp} /></div>`
          : `<div class="lab-fixture-error" data-lab-fixture-mode="stress">Automatic stress fixture unavailable: {uiFixture${itemIndex}.stressError}</div>`;
        return `<div class="lab-state-cell" data-lab-ui-state=${JSON.stringify(state)}>
          <div class="lab-state-label"><code>${state}</code></div>
          <div class="lab-preview-surface">${normal}${stress}</div>
        </div>`;
      }).join("\n");

      return `<article class="lab-case lab-ui-case" data-lab-ui=${JSON.stringify(item.id)} data-lab-ui-variant=${JSON.stringify(variant)}>
        <div class="lab-case-head"><strong>${variant}</strong><code>${item.role}</code></div>
        <div class="lab-state-grid" style=${JSON.stringify(`--lab-state-count:${states.length}`)}>${stateCells}</div>
      </article>`;
    }).join("\n");

    markup.push(`<section class="lab-group" id=${JSON.stringify(`ui-${item.id}`)}>
      <div class="lab-group-head"><div><p class="lab-kicker">UI primitive</p><h2>${item.id}</h2></div><p>${astroText(item.manifest.description ?? "No description.")}</p></div>
      <div class="lab-case-list">${cases}</div>
    </section>`);
  });

  return { imports: imports.join("\n"), constants: constants.join("\n"), markup: markup.join("\n") };
}

function formBenchmarkMarkup(items: RegisteredUiPrimitive[]): string {
  const required = ["button", "text-field", "textarea-field", "select-field", "checkbox", "radio-group", "switch"];
  const aliases = new Map(items.map((item, index) => [item.id, `Ui${index}`]));
  if (required.some(id => !aliases.has(id))) return "";

  const Button = aliases.get("button")!;
  const TextField = aliases.get("text-field")!;
  const TextareaField = aliases.get("textarea-field")!;
  const SelectField = aliases.get("select-field")!;
  const Checkbox = aliases.get("checkbox")!;
  const RadioGroup = aliases.get("radio-group")!;
  const Switch = aliases.get("switch")!;

  const normal = `<div class="lab-form-demo" role="group" aria-label="Form composition benchmark">
    <${TextField} id="benchmark-name" label="Name" name="name" autocomplete="name" placeholder="Ada Lovelace" description="Use the name shown to collaborators." />
    <${TextField} id="benchmark-email" label="Email" name="email" type="email" autocomplete="email" placeholder="ada@example.com" required={true} />
    <${SelectField} id="benchmark-role" label="Role" name="role" value="engineering" options={[{ label: "Engineering", value: "engineering" }, { label: "Design", value: "design" }, { label: "Product", value: "product" }]} />
    <${TextareaField} id="benchmark-message" label="Message" name="message" rows={4} placeholder="Tell us what you are building" />
    <${RadioGroup} id="benchmark-plan" label="Workspace" name="workspace" value="team" options={[{ label: "Personal", value: "personal" }, { label: "Team", value: "team" }]} />
    <${Checkbox} id="benchmark-updates" label="Send product updates" name="updates" checked={true} description="Occasional release notes and migration guidance." />
    <${Switch} id="benchmark-public" label="Public profile" name="public" checked={true} description="Allow other users to discover this workspace." />
    <div class="lab-form-actions"><${Button} label="Save settings" type="submit" variant="primary" /><${Button} label="Cancel" type="button" variant="secondary" /></div>
  </div>`;

  const stress = `<div class="lab-form-demo" role="group" aria-label="Form composition stress benchmark">
    <${TextField} id="benchmark-name-stress" label="A deliberately long account holder name label that tests wrapping in narrow layouts" name="name" value="A deliberately long value that should remain usable without breaking the surrounding layout" description="Supporting text is intentionally verbose so that spacing, wrapping, and hierarchy problems become visible before this form reaches production." />
    <${TextField} id="benchmark-email-stress" label="Email address used for security notifications and account recovery" name="email" type="email" value="invalid-address" error="Enter a valid email address before continuing. This longer validation message also tests wrapped error copy." required={true} />
    <${SelectField} id="benchmark-role-stress" label="Primary responsibility inside this unusually complex organization" name="role" value="engineering" options={[{ label: "Engineering and technical operations with an intentionally long option label", value: "engineering" }, { label: "Design and research", value: "design" }, { label: "Product strategy and delivery", value: "product" }]} />
    <${TextareaField} id="benchmark-message-stress" label="Detailed project context" name="message" rows={7} value="This intentionally long multiline value exercises vertical rhythm, field density, resizing behavior, and the relationship between labels, controls, supporting copy, and actions." error="Add enough implementation detail for another person to understand the request without additional context." />
    <${RadioGroup} id="benchmark-plan-stress" label="Choose the workspace model that best describes how your organization will use SiteSpec" name="workspace" value="team" options={[{ label: "Personal workspace for one maintainer", value: "personal" }, { label: "Team workspace shared across engineering, design, and product", value: "team" }, { label: "Organization-wide workspace with a deliberately long descriptive option", value: "organization" }]} />
    <${Checkbox} id="benchmark-updates-stress" label="Send release notes, migration guidance, compatibility notices, and other important product updates" name="updates" error="You must acknowledge this option for the stress benchmark." />
    <${Switch} id="benchmark-public-stress" label="Make this workspace discoverable to other organization members" name="public" checked={false} description="This description is deliberately longer to verify alignment between the switch control and multiline supporting content." />
    <div class="lab-form-actions"><${Button} label="Save these deliberately complicated settings" type="submit" variant="primary" /><${Button} label="Return without saving changes" type="button" variant="secondary" /></div>
  </div>`;

  return `<section class="lab-group" data-lab-form-benchmark>
    <div class="lab-group-head"><div><p class="lab-kicker">Composition benchmark</p><h2>Form</h2></div><p>Real form primitives composed together under the active theme and Stress mode.</p></div>
    <article class="lab-case"><div class="lab-case-head"><strong>Form composition</strong><code>responsive</code></div><div class="lab-form-preview"><div data-lab-fixture-mode="normal">${normal}</div><div data-lab-fixture-mode="stress">${stress}</div></div></article>
  </section>`;
}

function sectionMarkup(items: RegisteredComponent[]): { imports: string; constants: string; markup: string } {
  const imports: string[] = [];
  const constants: string[] = [];
  const markup: string[] = [];

  items.forEach((item, itemIndex) => {
    const name = `Section${itemIndex}`;
    const fixture = fixtureFor(item);
    imports.push(`import ${name} from "@site-project/components/${item.id}/index.astro";`);
    constants.push(`const sectionFixture${itemIndex} = ${serialize(fixture)};`);
    const variants = item.variants.length ? item.variants : ["default"];
    const themes = item.themes.length ? item.themes : ["default"];
    const combos: Array<{ variant: string; theme: string }> = [];
    for (const variant of variants) for (const theme of themes) combos.push({ variant, theme });

    const cases = combos.map((combo, caseIndex) => {
      const identity = `lab-${item.id}-${caseIndex}`;
      const normal = fixture.normal
        ? `<div class="lab-fixture" data-lab-fixture-mode="normal"><${name} sectionId=${JSON.stringify(`${identity}-normal`)} variant=${JSON.stringify(combo.variant)} theme=${JSON.stringify(combo.theme)} props={sectionFixture${itemIndex}.normal} /></div>`
        : `<div class="lab-fixture-error" data-lab-fixture-mode="normal">Automatic fixture unavailable: {sectionFixture${itemIndex}.normalError}</div>`;
      const stress = fixture.stress
        ? `<div class="lab-fixture" data-lab-fixture-mode="stress"><${name} sectionId=${JSON.stringify(`${identity}-stress`)} variant=${JSON.stringify(combo.variant)} theme=${JSON.stringify(combo.theme)} props={sectionFixture${itemIndex}.stress} /></div>`
        : `<div class="lab-fixture-error" data-lab-fixture-mode="stress">Automatic stress fixture unavailable: {sectionFixture${itemIndex}.stressError}</div>`;
      return `<article class="lab-case lab-section-case" data-lab-section=${JSON.stringify(item.id)}>
        <div class="lab-case-head"><strong>${combo.variant}</strong><code>theme: ${combo.theme}</code></div>
        <div class="lab-section-preview">${normal}${stress}</div>
      </article>`;
    }).join("\n");

    markup.push(`<section class="lab-group" id=${JSON.stringify(`section-${item.id}`)}>
      <div class="lab-group-head"><div><p class="lab-kicker">Section</p><h2>${item.id}</h2></div><p>${astroText(item.manifest.description ?? "No description.")}</p></div>
      <div class="lab-section-list">${cases}</div>
    </section>`);
  });

  return { imports: imports.join("\n"), constants: constants.join("\n"), markup: markup.join("\n") };
}

function tokenMarkup(
  tokens: Awaited<ReturnType<typeof inspectDesign>>["design"]["semantic"],
  primitive: Awaited<ReturnType<typeof inspectDesign>>["design"]["primitive"]
): string {
  const colors = tokens.filter(token => token.type === "color");
  const typography = tokens.filter(token => token.name.startsWith("font."));
  const layout = tokens.filter(token => !colors.includes(token) && !typography.includes(token));

  const colorCards = colors.map(token => `<article class="lab-token-card">
    <div class="lab-swatch" style=${JSON.stringify(`background: var(${token.cssVariable});`)}></div>
    <strong>${token.name}</strong><code>${token.cssVariable}</code><small>${token.alias ?? String(token.value)}</small>
  </article>`).join("\n");

  const typographyStyle = (token: { name: string; cssVariable: string }): string => {
    if (token.name.includes(".family.")) return `font-family: var(${token.cssVariable});`;
    if (token.name.includes(".size.")) return `font-size: var(${token.cssVariable});`;
    if (token.name.includes(".lineHeight.")) return `line-height: var(${token.cssVariable});`;
    if (token.name.includes(".weight.")) return `font-weight: var(${token.cssVariable});`;
    if (token.name.includes(".letterSpacing.")) return `letter-spacing: var(${token.cssVariable});`;
    return "";
  };
  const typeCard = (token: { name: string; cssVariable: string; value: string | number; alias?: string }): string =>
    `<article class="lab-type-card"><div class="lab-type-sample" style=${JSON.stringify(typographyStyle(token))}>Aa SiteSpec 0123</div><strong>${token.name}</strong><code>${token.cssVariable}</code><small>${token.alias ?? String(token.value)}</small></article>`;

  const typographyCards = typography.map(typeCard).join("\n");
  const primitiveTypography = primitive.filter(token => token.name.startsWith("font."));
  const primitiveTypographyCards = primitiveTypography.map(typeCard).join("\n");
  const otherPrimitive = primitive.filter(token => !token.name.startsWith("font."));

  const layoutRows = layout.map(token => `<tr><td><strong>${token.name}</strong></td><td><code>${token.cssVariable}</code></td><td>${astroText(token.alias ?? token.value)}</td><td><span class="lab-token-measure" style=${JSON.stringify(token.type === "dimension" ? `width: var(${token.cssVariable});` : "")}></span></td></tr>`).join("\n");
  const primitiveRows = otherPrimitive.map(token => `<tr><td><strong>${token.name}</strong></td><td><code>${token.type}</code></td><td>${astroText(token.value)}</td><td><code>${token.cssVariable}</code></td></tr>`).join("\n");

  return `<section class="lab-group"><div class="lab-group-head"><div><p class="lab-kicker">Foundation</p><h2>Color</h2></div><p>Semantic colors consumed by components and shell.</p></div><div class="lab-token-grid">${colorCards}</div></section>
  <section class="lab-group"><div class="lab-group-head"><div><p class="lab-kicker">Foundation</p><h2>Typography</h2></div><p>Semantic family, size, line-height, weight, and letter-spacing vocabulary.</p></div><div class="lab-type-grid">${typographyCards}</div></section>
  <section class="lab-group"><div class="lab-group-head"><div><p class="lab-kicker">Foundation</p><h2>Primitive typography</h2></div><p>Raw type-scale decisions. Reusable implementation code should consume the semantic typography tokens above.</p></div><div class="lab-type-grid">${primitiveTypographyCards}</div></section>
  <section class="lab-group"><div class="lab-group-head"><div><p class="lab-kicker">Foundation</p><h2>Layout & other tokens</h2></div><p>Spacing, size, radius, and other semantic values.</p></div><div class="lab-table-wrap"><table class="lab-token-table"><thead><tr><th>Token</th><th>CSS variable</th><th>Source</th><th>Measure</th></tr></thead><tbody>${layoutRows}</tbody></table></div></section>
  <section class="lab-group"><div class="lab-group-head"><div><p class="lab-kicker">Foundation</p><h2>Other primitive tokens</h2></div><p>Raw Design System decisions outside typography. Components should consume semantic tokens instead.</p></div><div class="lab-table-wrap"><table class="lab-token-table"><thead><tr><th>Token</th><th>Type</th><th>Value</th><th>CSS variable</th></tr></thead><tbody>${primitiveRows}</tbody></table></div></section>`;
}

function labCss(): string {
  return String.raw`
  :root { color-scheme: light; --lab-bg: #f4f4f0; --lab-panel: #ffffff; --lab-text: #151515; --lab-muted: #6d6d67; --lab-border: #d9d9d2; --lab-accent: #5746db; --lab-code: #eeeeea; }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; background: var(--lab-bg); color: var(--lab-text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  button, select { font: inherit; }
  code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .lab-shell { min-height: 100vh; }
  .lab-topbar { position: sticky; top: 0; z-index: 100; display: grid; grid-template-columns: minmax(220px, 1fr) auto auto; gap: 18px; align-items: center; min-height: 68px; padding: 10px 20px; border-bottom: 1px solid var(--lab-border); background: color-mix(in srgb, var(--lab-panel) 94%, transparent); backdrop-filter: blur(16px); }
  .lab-brand strong { display: block; font-size: 15px; }.lab-brand span { display: block; color: var(--lab-muted); font-size: 12px; }
  .lab-tabs { display: flex; gap: 4px; padding: 4px; border: 1px solid var(--lab-border); border-radius: 9px; background: var(--lab-bg); }
  .lab-tabs button, .lab-toggle, .lab-control select { border: 0; border-radius: 6px; background: transparent; color: var(--lab-text); padding: 7px 10px; cursor: pointer; }
  .lab-tabs button[aria-selected="true"], .lab-toggle[aria-pressed="true"] { background: var(--lab-panel); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
  .lab-controls { display: flex; gap: 8px; align-items: center; }.lab-control { display: flex; gap: 6px; align-items: center; color: var(--lab-muted); }.lab-control select { border: 1px solid var(--lab-border); background: var(--lab-panel); }
  .lab-main { width: min(1500px, calc(100% - 36px)); margin: 0 auto; padding: 30px 0 80px; }
  .lab-panel[hidden] { display: none; }
  .lab-summary { display: grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap: 10px; margin-bottom: 28px; }.lab-stat { padding: 16px; border: 1px solid var(--lab-border); border-radius: 10px; background: var(--lab-panel); }.lab-stat strong { display: block; font-size: 24px; }.lab-stat span { color: var(--lab-muted); }
  .lab-group { margin: 0 0 36px; }.lab-group-head { display: grid; grid-template-columns: minmax(260px,.8fr) minmax(280px,1.2fr); gap: 32px; align-items: end; margin: 0 0 14px; }.lab-group-head h2 { margin: 0; font-size: 24px; letter-spacing: -.02em; }.lab-group-head p:last-child { margin: 0; color: var(--lab-muted); }.lab-kicker { margin: 0 0 4px !important; color: var(--lab-accent) !important; font-size: 11px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
  .lab-token-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(190px,1fr)); gap: 10px; }.lab-token-card, .lab-type-card { min-width: 0; padding: 12px; border: 1px solid var(--lab-border); border-radius: 10px; background: var(--lab-panel); }.lab-token-card strong,.lab-token-card code,.lab-token-card small,.lab-type-card strong,.lab-type-card code,.lab-type-card small { display: block; overflow-wrap: anywhere; }.lab-token-card code,.lab-type-card code { margin-top: 6px; }.lab-token-card small,.lab-type-card small { margin-top: 3px; color: var(--lab-muted); }.lab-swatch { height: 88px; margin: -4px -4px 12px; border: 1px solid rgba(0,0,0,.08); border-radius: 7px; }
  .lab-type-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(260px,1fr)); gap: 10px; }.lab-type-sample { min-height: 88px; display: flex; align-items: center; overflow: hidden; margin-bottom: 10px; border-bottom: 1px solid var(--lab-border); white-space: nowrap; }
  .lab-table-wrap { overflow: auto; border: 1px solid var(--lab-border); border-radius: 10px; background: var(--lab-panel); }.lab-token-table { width: 100%; border-collapse: collapse; }.lab-token-table th,.lab-token-table td { padding: 11px 13px; text-align: left; border-bottom: 1px solid var(--lab-border); }.lab-token-table th { color: var(--lab-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }.lab-token-table tr:last-child td { border-bottom: 0; }.lab-token-measure { display: block; max-width: 220px; min-width: 2px; height: 8px; border-radius: 20px; background: var(--lab-accent); }
  .lab-case-list { display: grid; gap: 12px; }.lab-case-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(280px,1fr)); gap: 10px; }.lab-case { min-width: 0; overflow: hidden; border: 1px solid var(--lab-border); border-radius: 10px; background: var(--lab-panel); }.lab-case-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 9px 12px; border-bottom: 1px solid var(--lab-border); background: var(--lab-bg); }.lab-case-head code { color: var(--lab-muted); }.lab-state-grid { display: grid; grid-template-columns: repeat(var(--lab-state-count), minmax(180px,1fr)); overflow-x: auto; }.lab-state-cell { min-width: 180px; border-right: 1px solid var(--lab-border); }.lab-state-cell:last-child { border-right: 0; }.lab-state-label { padding: 7px 10px; border-bottom: 1px solid var(--lab-border); color: var(--lab-muted); background: var(--lab-panel); }.lab-preview-surface { min-height: 128px; display: flex; align-items: center; padding: 24px; overflow: auto; background: var(--color-surface-default, white); color: var(--color-text-default, black); }.lab-ui-case .lab-preview-surface { justify-content: center; }.lab-ui-case [data-ui] { pointer-events: none !important; }.lab-slot-sample { padding: 8px; border: 1px dashed currentColor; }
  .lab-form-preview { padding: 24px; background: var(--color-surface-default, white); color: var(--color-text-default, black); }.lab-form-demo { width: min(100%, 760px); display: grid; gap: 18px; margin: 0 auto; }.lab-form-actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; }
    .lab-section-list { display: grid; gap: 12px; }.lab-section-preview { overflow: hidden; }.lab-section-preview > .lab-fixture > * { width: 100%; }.lab-fixture-error { padding: 24px; color: #8f1f1f; background: #fff3f3; font-family: ui-monospace, monospace; }
  [data-lab-stress="false"] [data-lab-fixture-mode="stress"], [data-lab-stress="true"] [data-lab-fixture-mode="normal"] { display: none !important; }
  .lab-pages-toolbar { display: grid; grid-template-columns: minmax(240px,1fr) auto; gap: 14px; align-items: end; margin-bottom: 14px; }.lab-pages-toolbar label { display: grid; gap: 5px; color: var(--lab-muted); }.lab-pages-toolbar select { width: 100%; padding: 9px 10px; border: 1px solid var(--lab-border); border-radius: 7px; background: var(--lab-panel); }.lab-viewport-buttons { display: flex; gap: 5px; }.lab-viewport-buttons button { padding: 8px 10px; border: 1px solid var(--lab-border); border-radius: 7px; background: var(--lab-panel); cursor: pointer; }.lab-viewport-buttons button[aria-pressed="true"] { border-color: var(--lab-accent); color: var(--lab-accent); }
  .lab-page-stage { min-height: 720px; overflow: auto; padding: 20px; border: 1px solid var(--lab-border); border-radius: 10px; background: #dcdcd7; }.lab-page-frame { display: block; width: 100%; min-height: 680px; margin: 0 auto; border: 0; background: white; box-shadow: 0 10px 35px rgba(0,0,0,.12); transition: width .18s ease; }.lab-page-frame[data-width="tablet"] { width: 768px; }.lab-page-frame[data-width="mobile"] { width: 375px; }
  .lab-empty { padding: 32px; border: 1px dashed var(--lab-border); border-radius: 10px; color: var(--lab-muted); text-align: center; }
  @media (max-width: 900px) { .lab-topbar { position: static; grid-template-columns: 1fr; }.lab-tabs { overflow-x: auto; }.lab-controls { flex-wrap: wrap; }.lab-main { width: min(100% - 24px,1500px); }.lab-summary { grid-template-columns: repeat(2,minmax(0,1fr)); }.lab-group-head { grid-template-columns: 1fr; gap: 6px; }.lab-page-stage { padding: 8px; }.lab-page-frame[data-width="tablet"], .lab-page-frame[data-width="mobile"] { max-width: 100%; } }
  `;
}

function labScript(): string {
  return String.raw`
  const root = document.documentElement;
  const body = document.body;
  const tabs = [...document.querySelectorAll('[data-lab-tab]')];
  const panels = [...document.querySelectorAll('[data-lab-panel]')];
  const activate = (name) => {
    tabs.forEach(button => button.setAttribute('aria-selected', String(button.dataset.labTab === name)));
    panels.forEach(panel => { panel.hidden = panel.dataset.labPanel !== name; });
    history.replaceState(null, '', '#' + name);
  };
  tabs.forEach(button => button.addEventListener('click', () => activate(button.dataset.labTab)));
  const initialTab = location.hash.slice(1);
  if (tabs.some(button => button.dataset.labTab === initialTab)) activate(initialTab);

  const theme = document.querySelector('[data-lab-theme]');
  const stress = document.querySelector('[data-lab-stress-toggle]');
  const pageSelect = document.querySelector('[data-lab-page-select]');
  const frame = document.querySelector('[data-lab-page-frame]');

  document.querySelectorAll('[data-lab-ui-state]').forEach(cell => {
    const state = cell.dataset.labUiState;
    cell.querySelectorAll('[data-ui]').forEach(target => {
      if (state && state !== 'default') target.setAttribute('data-sitespec-state', state);
      else target.removeAttribute('data-sitespec-state');
    });
  });

  const pagePreviewHref = () => {
    if (!pageSelect?.value || !theme?.value) return undefined;
    const base = body.dataset.labPreviewBase || '/sitespec-design-preview';
    const mode = body.dataset.labStress === 'true' ? 'stress' : 'normal';
    return [base.replace(/\/$/, ''), encodeURIComponent(theme.value), mode, encodeURIComponent(pageSelect.value)].join('/');
  };
  const syncPageFrame = () => {
    const href = pagePreviewHref();
    if (frame && href && frame.getAttribute('src') !== href) frame.setAttribute('src', href);
  };

  theme?.addEventListener('change', () => {
    root.dataset.siteTheme = theme.value;
    syncPageFrame();
  });

  stress?.addEventListener('click', () => {
    const next = body.dataset.labStress !== 'true';
    body.dataset.labStress = String(next);
    stress.setAttribute('aria-pressed', String(next));
    syncPageFrame();
  });

  pageSelect?.addEventListener('change', syncPageFrame);
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== frame?.contentWindow || !event.data) return;
    if (event.data.type === 'sitespec:design-lab-theme' && typeof event.data.theme === 'string') {
      if (theme && [...theme.options].some(option => option.value === event.data.theme)) {
        theme.value = event.data.theme;
        root.dataset.siteTheme = event.data.theme;
        syncPageFrame();
      }
      return;
    }
    if (event.data.type === 'sitespec:design-lab-state') {
      if (pageSelect && typeof event.data.page === 'string' && [...pageSelect.options].some(option => option.value === event.data.page)) pageSelect.value = event.data.page;
      if (theme && typeof event.data.theme === 'string' && [...theme.options].some(option => option.value === event.data.theme)) {
        theme.value = event.data.theme;
        root.dataset.siteTheme = event.data.theme;
      }
      const nextStress = event.data.stress === true;
      body.dataset.labStress = String(nextStress);
      stress?.setAttribute('aria-pressed', String(nextStress));
    }
  });
  document.querySelectorAll('[data-lab-viewport]').forEach(button => button.addEventListener('click', () => {
    const width = button.dataset.labViewport;
    document.querySelectorAll('[data-lab-viewport]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    if (frame) frame.dataset.width = width;
  }));
  syncPageFrame();
  `;
}

function designLabPageSource(
  site: ResolvedSite,
  manifest: NonNullable<Awaited<ReturnType<typeof loadDesignSystemContract>>["designSystem"]>["value"],
  design: Awaited<ReturnType<typeof inspectDesign>>["design"],
  ui: RegisteredUiPrimitive[],
  sections: RegisteredComponent[]
): string {
  const uiSource = uiMarkup(ui);
  const sectionSource = sectionMarkup(sections);
  const formBenchmark = formBenchmarkMarkup(ui);
  const themeOptions = design.themes.items.map(theme => `<option value=${JSON.stringify(theme.id)}${theme.id === design.themes.default ? " selected" : ""}>${astroText(theme.label)}</option>`).join("\n");
  const basePath = new URL(site.site.url).pathname.replace(/\/+$/, "");
  const routeHref = (route: string): string => {
    if (!basePath || basePath === "/") return route;
    return route === "/" ? `${basePath}/` : `${basePath}${route}`;
  };
  const pages = site.pages.filter(page => page.state === "published").map(page => ({ id: page.id, route: page.route, href: routeHref(page.route), title: page.seo.title }));
  const pageOptions = pages.map((page, index) => `<option value=${JSON.stringify(page.id)}${index === 0 ? " selected" : ""}>${astroText(`${page.title} — ${page.route}`)}</option>`).join("\n");
  const previewBase = `${basePath}/sitespec-design-preview`.replace(/\/+/g, "/");
  const firstPage = pages[0]?.id ?? "";
  const tokens = tokenMarkup(design.semantic, design.primitive);
  const diagnosticsCount = 0;

  return `---
export function getStaticPaths() {
  return [{ params: { designLab: "__sitespec/design" } }];
}

import "@site-generated/styles/fonts.css";
import "@site-generated/styles/tokens.css";
${uiSource.imports}
${sectionSource.imports}
${uiSource.constants}
${sectionSource.constants}
const lab = ${serialize({
    designSystem: manifest.designSystem,
    defaultTheme: design.themes.default,
    stats: { primitive: design.primitive.length, semantic: design.semantic.length, ui: ui.length, sections: sections.length, pages: pages.length, diagnostics: diagnosticsCount }
  })};
---
<!doctype html>
<html lang="en" data-site-theme={lab.defaultTheme}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>{lab.designSystem.name} — SiteSpec Design Lab</title>
  </head>
  <body data-lab-stress="false" data-lab-preview-base=${JSON.stringify(previewBase)}>
    <div class="lab-shell">
      <header class="lab-topbar">
        <div class="lab-brand"><strong>SiteSpec Design Lab</strong><span>{lab.designSystem.name} · {lab.designSystem.id} · v{lab.designSystem.version}</span></div>
        <nav class="lab-tabs" aria-label="Design Lab views">
          <button type="button" data-lab-tab="foundations" aria-selected="true">Foundations</button>
          <button type="button" data-lab-tab="ui" aria-selected="false">UI</button>
          <button type="button" data-lab-tab="sections" aria-selected="false">Sections</button>
          <button type="button" data-lab-tab="pages" aria-selected="false">Pages</button>
        </nav>
        <div class="lab-controls">
          <label class="lab-control">Theme <select data-lab-theme>${themeOptions}</select></label>
          <button class="lab-toggle" type="button" data-lab-stress-toggle aria-pressed="false">Stress</button>
        </div>
      </header>
      <main class="lab-main">
        <div class="lab-summary">
          <div class="lab-stat"><strong>{lab.stats.semantic}</strong><span>semantic tokens</span></div>
          <div class="lab-stat"><strong>{lab.stats.primitive}</strong><span>primitive tokens</span></div>
          <div class="lab-stat"><strong>{lab.stats.ui}</strong><span>UI primitives</span></div>
          <div class="lab-stat"><strong>{lab.stats.sections}</strong><span>sections</span></div>
          <div class="lab-stat"><strong>{lab.stats.pages}</strong><span>published pages</span></div>
        </div>

        <div data-lab-panel="foundations">${tokens}</div>
        <div data-lab-panel="ui" hidden>${uiSource.markup || '<div class="lab-empty">No exported UI primitives.</div>'}${formBenchmark}</div>
        <div data-lab-panel="sections" hidden>${sectionSource.markup || '<div class="lab-empty">No exported sections.</div>'}</div>
        <div data-lab-panel="pages" hidden>
          ${pages.length ? `<div class="lab-pages-toolbar">
            <label>Page<select data-lab-page-select>${pageOptions}</select></label>
            <div class="lab-viewport-buttons" aria-label="Preview width">
              <button type="button" data-lab-viewport="desktop" aria-pressed="true">Desktop</button>
              <button type="button" data-lab-viewport="tablet" aria-pressed="false">768</button>
              <button type="button" data-lab-viewport="mobile" aria-pressed="false">375</button>
            </div>
          </div><div class="lab-page-stage"><iframe class="lab-page-frame" data-lab-page-frame data-width="desktop" src=${JSON.stringify(`${previewBase}/${design.themes.default}/normal/${firstPage}`)} title="Site page preview"></iframe></div>` : '<div class="lab-empty">No published pages to preview.</div>'}
        </div>
      </main>
    </div>
    <script is:inline>${labScript()}</script>
  </body>
</html>
<style is:global>${labCss()}</style>
`;
}

export const DESIGN_LAB_PAGE_FILENAME = "[...designLab].astro";

export async function writeDesignLab(options: DesignLabOptions): Promise<void> {
  const [contract, designResult, uiResult, componentResult] = await Promise.all([
    loadDesignSystemContract(options.root),
    inspectDesign(options.root),
    buildUiRegistry(options.root),
    buildRegistry(options.root)
  ]);
  const manifest = contract.designSystem?.value;
  if (!manifest) return;

  const exportedUi = manifest.libraries.ui
    .map(id => uiResult.registry.get(id))
    .filter((item): item is RegisteredUiPrimitive => !!item);
  const exportedSections = manifest.libraries.sections
    .map(id => componentResult.registry.get(id))
    .filter((item): item is RegisteredComponent => !!item);

  const pageDir = join(options.generatedSrc, "pages");
  await mkdir(pageDir, { recursive: true });
  await writeFile(
    join(pageDir, DESIGN_LAB_PAGE_FILENAME),
    designLabPageSource(options.site, manifest, designResult.design, exportedUi, exportedSections),
    "utf8"
  );
}
