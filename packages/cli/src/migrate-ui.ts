import type { AuditLeafUiKind, AuditLeafUiObservation } from "./migrate-audit.js";

export type UiFamilyStatus = "core" | "supporting" | "local";
export type UiFamilyRole = "layout" | "action" | "content" | "navigation" | "feedback" | "media" | "typography";

export interface UiEvidencePage {
  page: string;
  sourceUrl: string;
  items: Array<AuditLeafUiObservation & { viewport?: string }>;
}

export interface UiFamilyVariantProposal {
  id: string;
  confidence: number;
  instances: number;
  reason: string;
}

export interface UiFamilyProposal {
  id: string;
  suggestedUiId: string;
  sourceKinds: AuditLeafUiKind[];
  role: UiFamilyRole;
  status: UiFamilyStatus;
  materialization: {
    eligibility: "auto" | "review-required";
    reason: string;
  };
  confidence: number;
  reason: string;
  evidence: {
    instances: number;
    viewportOccurrences: number;
    pages: string[];
    pageCoverage: number;
    manualLinkedInstances: number;
    manualLinkRatio: number;
    styleClusters: number;
    examples: Array<{
      page: string;
      viewport?: string;
      kind: AuditLeafUiKind;
      selector: string;
      segmentId?: string;
      text?: string;
    }>;
  };
  variants: UiFamilyVariantProposal[];
  contractHints: {
    props: Array<{ name: string; kind: "string" | "url" | "boolean"; required: boolean; confidence: number; reason: string }>;
  };
}

export interface UiFamilyModel {
  rule: string;
  families: UiFamilyProposal[];
  unresolved: Array<{ area: string; reason: string; families?: string[] }>;
  summary: {
    observed: number;
    total: number;
    core: number;
    supporting: number;
    local: number;
    variants: number;
    candidateFamilies: number;
  };
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function transparent(value: string | undefined): boolean {
  return !value || value === "transparent" || value === "rgba(0, 0, 0, 0)" || value === "rgba(0,0,0,0)";
}

function px(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function familyForKind(kind: AuditLeafUiKind): { id: string; role: UiFamilyRole; candidate?: boolean } {
  if (kind === "button") return { id: "button", role: "action" };
  if (kind === "link") return { id: "link", role: "navigation" };
  if (kind === "input") return { id: "text-input", role: "content" };
  if (kind === "textarea") return { id: "textarea", role: "content" };
  if (kind === "select") return { id: "select", role: "content" };
  if (kind === "checkbox" || kind === "radio") return { id: "choice", role: "content" };
  if (kind === "badge-candidate") return { id: "badge", role: "content", candidate: true };
  return { id: "card", role: "content", candidate: true };
}

function styleSignature(item: AuditLeafUiObservation): string {
  const style = item.style;
  return [
    item.kind,
    style.display,
    style.color,
    style.backgroundColor,
    style.borderTopWidth,
    style.borderTopColor,
    style.borderRadius,
    style.paddingTop,
    style.paddingRight,
    style.paddingBottom,
    style.paddingLeft,
    style.fontSize,
    style.fontWeight,
    style.lineHeight,
    style.boxShadow,
    item.box.height
  ].map(value => String(value ?? "")).join("|");
}

function buttonVariant(item: AuditLeafUiObservation): string {
  const style = item.style;
  const hasBackground = !transparent(style.backgroundColor);
  const hasBorder = px(style.borderTopWidth) > 0;
  if (hasBackground) return "solid";
  if (hasBorder) return "outline";
  return "ghost";
}

function variantFor(item: AuditLeafUiObservation, family: string): string {
  if (family === "button") return buttonVariant(item);
  if (family === "choice") return item.kind === "radio" ? "radio" : "checkbox";
  return "default";
}

function contractHints(family: string, items: AuditLeafUiObservation[]): UiFamilyProposal["contractHints"] {
  const every = (predicate: (item: AuditLeafUiObservation) => boolean) => items.length > 0 && items.every(predicate);
  if (family === "button") return {
    props: [
      { name: "label", kind: "string", required: every(item => Boolean(item.text || item.ariaLabel)), confidence: 0.94, reason: "Observed button-like controls expose visible or accessible labels." },
      { name: "href", kind: "url", required: every(item => Boolean(item.href)), confidence: 0.82, reason: "Link-backed buttons expose destination URLs; native buttons may keep this optional." },
      { name: "disabled", kind: "boolean", required: false, confidence: 0.72, reason: "Native button state is directly observable where present." }
    ]
  };
  if (family === "link") return {
    props: [
      { name: "label", kind: "string", required: true, confidence: 0.96, reason: "Navigation links are identified from visible/accessibility text." },
      { name: "href", kind: "url", required: true, confidence: 0.99, reason: "The family is sourced from anchors with href." }
    ]
  };
  if (["text-input", "textarea"].includes(family)) return {
    props: [
      { name: "name", kind: "string", required: false, confidence: 0.86, reason: "Form field names are directly observable when authored." },
      { name: "placeholder", kind: "string", required: false, confidence: 0.82, reason: "Placeholder text is direct DOM evidence, not inferred copy." },
      { name: "required", kind: "boolean", required: false, confidence: 0.9, reason: "Required state is directly observable." },
      { name: "disabled", kind: "boolean", required: false, confidence: 0.9, reason: "Disabled state is directly observable." }
    ]
  };
  if (family === "select") return {
    props: [
      { name: "name", kind: "string", required: false, confidence: 0.86, reason: "Select names are direct DOM evidence." },
      { name: "required", kind: "boolean", required: false, confidence: 0.9, reason: "Required state is directly observable." },
      { name: "disabled", kind: "boolean", required: false, confidence: 0.9, reason: "Disabled state is directly observable." }
    ]
  };
  return { props: [] };
}

export function buildUiFamilyModel(pages: UiEvidencePage[]): UiFamilyModel {
  const all = pages.flatMap(page => page.items.map(item => ({ page, item })));
  if (all.length === 0) {
    return {
      rule: "Leaf UI families require direct per-element audit evidence; section descendant counts are not sufficient.",
      families: [],
      unresolved: [{ area: "leaf-ui-evidence", reason: "No ui-inventory.json evidence is available. Re-run migrate audit with the leaf UI inventory enabled." }],
      summary: { observed: 0, total: 0, core: 0, supporting: 0, local: 0, variants: 0, candidateFamilies: 0 }
    };
  }

  const grouped = new Map<string, Array<{ page: UiEvidencePage; item: AuditLeafUiObservation & { viewport?: string } }>>();
  for (const entry of all) {
    const family = familyForKind(entry.item.kind).id;
    const list = grouped.get(family) ?? [];
    list.push(entry);
    grouped.set(family, list);
  }

  const families: UiFamilyProposal[] = [...grouped.entries()].map(([id, entries]) => {
    const mapped = familyForKind(entries[0]!.item.kind);
    const logicalKeys = new Set(entries.map(entry => `${entry.page.page}|${entry.item.kind}|${entry.item.selector}`));
    const pagesSet = [...new Set(entries.map(entry => entry.page.page))].sort();
    const manualKeys = new Set(entries.filter(entry => entry.item.segmentId).map(entry => `${entry.page.page}|${entry.item.kind}|${entry.item.selector}`));
    const styleClusters = new Set(entries.map(entry => styleSignature(entry.item))).size;
    const instances = logicalKeys.size;
    const pageCoverage = round(pagesSet.length / Math.max(1, pages.length));
    const manualLinkRatio = round(manualKeys.size / Math.max(1, instances));
    const candidatePenalty = mapped.candidate ? 0.13 : 0;
    const recurrence = Math.min(1, instances / 4);
    const confidence = round(clamp(0.42 + 0.22 * pageCoverage + 0.18 * recurrence + 0.12 * manualLinkRatio - candidatePenalty));
    const status: UiFamilyStatus = pagesSet.length >= 2 && instances >= 2 && confidence >= 0.72
      ? "core"
      : instances >= 2 && confidence >= 0.58
        ? "supporting"
        : "local";
    const variantGroups = new Map<string, Set<string>>();
    for (const entry of entries) {
      const variant = variantFor(entry.item, id);
      const set = variantGroups.get(variant) ?? new Set<string>();
      set.add(`${entry.page.page}|${entry.item.selector}`);
      variantGroups.set(variant, set);
    }
    const variants = [...variantGroups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([variant, keys]) => ({
      id: variant,
      confidence: round(clamp(0.62 + Math.min(0.28, keys.size * 0.06) - (mapped.candidate ? 0.08 : 0))),
      instances: keys.size,
      reason: id === "button"
        ? `Appearance is derived from direct background/border evidence (${variant}).`
        : id === "choice"
          ? `Native control type directly identifies the ${variant} variant.`
          : "No safe reusable visual variant vocabulary is inferred beyond the default presentation."
    }));
    const materialization: UiFamilyProposal["materialization"] = mapped.candidate
      ? {
          eligibility: "review-required",
          reason: `${id} is inferred from a visual/container heuristic. Reuse strength does not by itself prove the semantic UI boundary.`
        }
      : ["text-input", "textarea", "select", "choice"].includes(id)
        ? {
            eligibility: "review-required",
            reason: "The current SiteSpec UiRole vocabulary has no explicit form-control role; an explicit reviewer decision is required before materialization."
          }
        : {
            eligibility: "auto",
            reason: "The family is backed by direct native/semantic element evidence and may be auto-accepted when reuse evidence is core."
          };
    return {
      id,
      suggestedUiId: id,
      sourceKinds: [...new Set(entries.map(entry => entry.item.kind))].sort(),
      role: mapped.role,
      status,
      materialization,
      confidence,
      reason: mapped.candidate
        ? `Direct DOM/style evidence suggests a reusable ${id} surface, but this family remains candidate-weighted until repetition confirms the heuristic container classification.`
        : `Direct per-element DOM/style evidence supports the ${id} UI family; reuse status depends on distinct instances and page coverage.`,
      evidence: {
        instances,
        viewportOccurrences: entries.length,
        pages: pagesSet,
        pageCoverage,
        manualLinkedInstances: manualKeys.size,
        manualLinkRatio,
        styleClusters,
        examples: entries.slice(0, 16).map(entry => ({
          page: entry.page.page,
          viewport: entry.item.viewport,
          kind: entry.item.kind,
          selector: entry.item.selector,
          segmentId: entry.item.segmentId,
          text: entry.item.text
        }))
      },
      variants,
      contractHints: contractHints(id, entries.map(entry => entry.item))
    };
  }).sort((a, b) => {
    const order: Record<UiFamilyStatus, number> = { core: 0, supporting: 1, local: 2 };
    return order[a.status] - order[b.status] || b.confidence - a.confidence || a.id.localeCompare(b.id);
  });

  const candidateFamilies = families.filter(item => item.sourceKinds.some(kind => kind.endsWith("-candidate"))).map(item => item.id);
  return {
    rule: "Leaf UI families are based on direct per-element audit evidence across viewports. Native controls/links are higher-confidence evidence; Badge/Card remain conservative candidates because their semantic boundary is inferred from visual/container signals.",
    families,
    unresolved: [
      ...(candidateFamilies.length ? [{ area: "candidate-surfaces", reason: "Badge/Card boundaries are visual heuristics and require explicit review before generating ui.yaml contracts.", families: candidateFamilies }] : []),
      ...(families.some(item => ["text-input", "textarea", "select", "choice"].includes(item.id))
        ? [{ area: "form-control-role", reason: "The current SiteSpec UiRole vocabulary has no explicit form-control role. Form-control families remain proposals and must not be materialized to ui.yaml until that semantic role is reviewed." }]
        : []),
      { area: "interactive-states", reason: "The first leaf UI inventory captures default rendered state only. Hover/focus/active/disabled visual-state token mapping is not yet modeled." }
    ],
    summary: {
      observed: all.length,
      total: families.length,
      core: families.filter(item => item.status === "core").length,
      supporting: families.filter(item => item.status === "supporting").length,
      local: families.filter(item => item.status === "local").length,
      variants: families.reduce((sum, item) => sum + item.variants.length, 0),
      candidateFamilies: candidateFamilies.length
    }
  };
}
