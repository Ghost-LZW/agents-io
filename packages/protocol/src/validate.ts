import type { TSchema, Static } from '@sinclair/typebox';
import { TypeCompiler, type TypeCheck } from '@sinclair/typebox/compiler';

const cache = new WeakMap<TSchema, TypeCheck<TSchema>>();

function compiled<S extends TSchema>(schema: S): TypeCheck<S> {
  let c = cache.get(schema);
  if (!c) {
    c = TypeCompiler.Compile(schema);
    cache.set(schema, c);
  }
  return c as TypeCheck<S>;
}

export function check<S extends TSchema>(schema: S, value: unknown): value is Static<S> {
  return compiled(schema).Check(value);
}

/** Human-readable validation errors; empty when valid. */
export function errors(schema: TSchema, value: unknown): string[] {
  return [...compiled(schema).Errors(value)].map((e) => `${e.path || '/'}: ${e.message}`);
}

export function assertValid<S extends TSchema>(schema: S, value: unknown, what = 'value'): asserts value is Static<S> {
  const errs = errors(schema, value);
  if (errs.length) throw new TypeError(`invalid ${what}: ${errs.slice(0, 5).join('; ')}`);
}
