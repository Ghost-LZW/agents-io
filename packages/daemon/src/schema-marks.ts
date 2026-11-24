import type { TSchema } from '@sinclair/typebox';

/** The `x-credential` mark (`ChannelModule.entry`). */
const marked = (s: TSchema | undefined) => (s as { 'x-credential'?: unknown } | undefined)?.['x-credential'] === true;

/**
 * Whether the schema marks the value at `path` under `s` as a credential: a schema marked
 * `x-credential` at the path or above it (a map or array of secrets). Follows object properties,
 * maps (`Type.Record`), array items and every member of a union; a part it cannot follow
 * (`Type.Unknown`, free-form) marks nothing.
 */
export function credentialMark(s: TSchema | undefined, path: readonly string[]): boolean {
  if (!s) return false;
  if (marked(s)) return true;
  const [seg, ...rest] = path;
  if (seg === undefined) return false;
  const x = s as { anyOf?: TSchema[]; properties?: Record<string, TSchema>; patternProperties?: Record<string, TSchema>; additionalProperties?: unknown; items?: unknown };
  if (Array.isArray(x.anyOf)) return x.anyOf.some((m) => credentialMark(m, path));
  if (x.properties && Object.hasOwn(x.properties, seg)) return credentialMark(x.properties[seg], rest);
  if (x.patternProperties) {
    for (const [re, v] of Object.entries(x.patternProperties)) if (new RegExp(re).test(seg)) return credentialMark(v, rest);
  }
  if (x.additionalProperties && typeof x.additionalProperties === 'object') return credentialMark(x.additionalProperties as TSchema, rest);
  if (x.items && typeof x.items === 'object' && !Array.isArray(x.items) && /^\d+$/.test(seg)) return credentialMark(x.items as TSchema, rest);
  return false;
}
