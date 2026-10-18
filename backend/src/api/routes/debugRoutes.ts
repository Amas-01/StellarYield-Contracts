import type { Express, Request, Response } from "express";

export interface RouteInfo {
  method: string;
  path: string;
}

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: RegExp & { fast_slash?: boolean };
  keys?: Array<{ name: string | number }>;
}

/** Recover the mount path of a router layer from Express's compiled regexp. */
function layerMountPath(layer: Layer): string {
  if (!layer.regexp || layer.regexp.fast_slash) return "";
  const source = layer.regexp.source
    .replace("^\\/", "/")
    .replace("\\/?(?=\\/|$)", "")
    .replace(/\\\//g, "/")
    .replace(/\(\?:\(\[\^\/\]\+\?\)\)/g, () => ":param");
  return source.startsWith("/") ? source.replace(/\$$/, "") : "";
}

function walk(stack: Layer[], prefix: string, out: RouteInfo[]): void {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
      }
    } else if (layer.name === "router" && layer.handle?.stack) {
      walk(layer.handle.stack, prefix + layerMountPath(layer), out);
    }
  }
}

/** List every route registered on the app, sorted by path then method (#1137). */
export function listRoutes(app: Express): RouteInfo[] {
  const out: RouteInfo[] = [];
  const router = (app as unknown as { _router?: { stack: Layer[] } })._router;
  if (router) walk(router.stack, "", out);
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** GET /_debug/routes handler. Only mount outside production. */
export function debugRoutesHandler(app: Express) {
  return (_req: Request, res: Response) => {
    const routes = listRoutes(app);
    res.json({ count: routes.length, routes });
  };
}
