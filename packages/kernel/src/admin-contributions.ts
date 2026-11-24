import { ADMIN_ENDPOINTS, type AdminContribution } from '@agents-io/protocol';
import type { ChannelRegistry } from './channel-registry.js';
import type { HarnessRegistry } from './harness-registry.js';

/*
 * What modules contribute to the admin API and console (`AdminContribution`, core-slimming G5): the
 * checks every registry runs on a contribution, and the list a daemon serves, its channel types'
 * then its harness kinds' (`ChannelModule.admin`, `HarnessModule.admin`).
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const ROUTE_METHODS: readonly unknown[] = ['GET', 'PUT', 'POST'];

/** The first member of an `AdminContribution` that is not what it says, described (`admin.…`). */
export function badAdmin(a: unknown): string | undefined {
  if (!isObject(a)) return 'admin (an object when present)';
  for (const k of ['console', 'schemas'] as const) if (a[k] !== undefined && !(isObject(a[k]) && Object.values(a[k]).every(isObject))) return `admin.${k} (an object of schemas when present)`;
  if (a.mount !== undefined && typeof a.mount !== 'function') return 'admin.mount (a function when present)';
  if (a.routes === undefined) return undefined;
  if (!Array.isArray(a.routes)) return 'admin.routes (an array when present)';
  for (const [i, r] of a.routes.entries()) {
    const bad = badRoute(r);
    if (bad) return `admin.routes[${i}]${bad}`;
  }
  return undefined;
}

/** What is wrong with one `AdminRoute` (`.member (what it must be)`), if anything. */
function badRoute(r: unknown): string | undefined {
  if (!isObject(r)) return ' (an object)';
  if (!ROUTE_METHODS.includes(r.method)) return '.method (GET, PUT or POST)';
  if (typeof r.path !== 'string' || !r.path.startsWith('/api/')) return '.path (a path under /api/)';
  if (r.status !== 200 && r.status !== 202) return '.status (200 or 202)';
  if (!isObject(r.response)) return '.response (a schema)';
  if (r.body !== undefined && !isObject(r.body)) return '.body (a schema when present)';
  if (r.public !== undefined && r.public !== false) return '.public (a module route always needs credentials)';
  if (typeof r.handle !== 'function') return '.handle (a function)';
  return undefined;
}

/** A route's method and path with its parameters unnamed: two routes with the same key are one. */
const routeKey = (e: { method: string; path: string }) => `${e.method} ${e.path.replace(/:[^/]*/g, ':')}`;

/** A route's method and path as the messages name it. */
const routeName = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

/** Whose an admin contribution is: a channel type's or a harness kind's, and its name. */
export interface AdminOwner {
  readonly owner: 'channel type' | 'harness kind';
  /** The type or kind (a module channel file's descriptor: what `ChannelRegistryOptions.admins` names it). */
  readonly name: string;
}

/** One admin contribution, with whose it is. */
export interface OwnedAdmin extends AdminOwner {
  readonly admin: AdminContribution;
}

/** How messages name a contribution's owner: `channel type "lark-bot"`. */
export const ownerName = (o: AdminOwner) => `${o.owner} ${JSON.stringify(o.name)}`;

/** Two owners, as one message names them: `channel types "a" and "b"`, `channel type "a" and harness kind "b"`. */
const bothNames = (a: AdminOwner, b: AdminOwner) => (a.owner === b.owner ? `${a.owner}s ${JSON.stringify(a.name)} and ${JSON.stringify(b.name)}` : `${ownerName(a)} and ${ownerName(b)}`);

/**
 * What admin contributions claim, one at a time: a route (method and path, parameters unnamed), a
 * console key or a schema name belongs to one owner, and no route is a core endpoint
 * (`ADMIN_ENDPOINTS`). The console's own keys are config.ts's to check, when it builds the section.
 */
export class AdminClaims {
  /** By kind and name: the owner that claimed it, or null for the core's. */
  private readonly claimed = new Map<string, AdminOwner | null>(ADMIN_ENDPOINTS.map((e) => [`route ${routeKey(e)}`, null]));

  /** Claim what `admin` contributes for `by`, after the contributions claimed before it (throws on a clash). */
  claim(by: AdminOwner, admin: AdminContribution): void {
    const claim = (what: string, name: string) => {
      const other = this.claimed.get(what);
      if (other === null) throw new Error(`${ownerName(by)}: admin ${name} is the console's own`);
      if (other !== undefined) throw new Error(`${bothNames(other, by)} both contribute admin ${name}`);
      this.claimed.set(what, by);
    };
    for (const r of admin.routes ?? []) claim(`route ${routeKey(r)}`, `route ${routeName(r)}`);
    for (const k of Object.keys(admin.console ?? {})) claim(`console ${k}`, `setting console.${k}`);
    for (const k of Object.keys(admin.schemas ?? {})) claim(`schema ${k}`, `schema ${k}`);
  }
}

const served = new WeakMap<HarnessRegistry, WeakMap<ChannelRegistry, readonly OwnedAdmin[]>>();

/**
 * The admin contributions a daemon over these registries serves, in order: its channel types'
 * (`ChannelRegistry.adminContributions`: the types', then those of the module channel files'
 * descriptors), then its harness kinds' (`HarnessRegistry.adminContributions`), each in
 * registration order. Each registry checked its own against one another; these are checked across
 * the two (a channel type and a harness kind contributing one route, console key or schema name
 * throws, as registration does). Built once per pair of registries.
 */
export function adminContributions(harnesses: HarnessRegistry, channels: ChannelRegistry): readonly OwnedAdmin[] {
  let byChannels = served.get(harnesses);
  if (!byChannels) served.set(harnesses, (byChannels = new WeakMap()));
  let list = byChannels.get(channels);
  if (!list) {
    list = Object.freeze([
      ...channels.adminContributions.map(({ type, admin }): OwnedAdmin => ({ owner: 'channel type', name: type, admin })),
      ...harnesses.adminContributions.map(({ kind, admin }): OwnedAdmin => ({ owner: 'harness kind', name: kind, admin })),
    ]);
    const claims = new AdminClaims();
    for (const c of list) claims.claim(c, c.admin);
    byChannels.set(channels, list);
  }
  return list;
}
