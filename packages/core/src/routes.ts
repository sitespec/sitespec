import type { RouteParams } from "./types.js";

const PARAM_PATTERN = /\[([a-z][a-z0-9-]*)\]/g;

export function routeParamNames(route: string): string[] {
  return [...route.matchAll(PARAM_PATTERN)].map(match => match[1]!).filter((value, index, all) => all.indexOf(value) === index);
}

export function isDynamicRoute(route: string): boolean {
  return routeParamNames(route).length > 0;
}

export function materializeRoute(route: string, params: RouteParams): string {
  return route.replace(PARAM_PATTERN, (_match, name: string) => params[name] ?? `[${name}]`);
}

export function resolvedPageId(id: string, paramNames: string[], params: RouteParams): string {
  if (paramNames.length === 0) return id;
  return `${id}--${paramNames.map(name => params[name]).join("--")}`;
}
