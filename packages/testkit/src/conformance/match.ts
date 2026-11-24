/*
 * Matching for the conformance fixtures (docs/design/conformance-fixtures): one matcher for the
 * outbound frames a harness transcript expects (L1) and the expectations of a kernel scenario (L2).
 *
 *  - Objects match as a subset: every key of the pattern is in the value and matches; with `exact`
 *    the value has no other key.
 *  - Arrays match element by element and have the same length.
 *  - Other values are equal (`===`; JSON has no other kinds).
 *  - `"<any>"` matches any value that is there.
 *  - `"<$name>"` binds `name` to the value the first time it matches; afterwards it matches only a
 *    value equal to that one (JSON equality).
 *  - A string with placeholders inside other text (`"echo: <$text>"`, `"<$workspace>/a.txt"`) is a
 *    template: the literal parts must be there, each placeholder stands for a substring (a bound
 *    one for its value as text).
 *
 * A failed match leaves the bindings as they were.
 */

export type Bindings = Map<string, unknown>;

export interface MatchOptions {
  /** No keys beyond the pattern's, at any depth. */
  exact?: boolean;
}

const TOKEN = /<\$([A-Za-z0-9_.:-]+)>|<any>/g;
const WHOLE = /^(?:<\$([A-Za-z0-9_.:-]+)>|<any>)$/;

/** `<$name>` or `<any>` as the whole string: `{ name }` (`name` undefined for `<any>`). */
export function placeholder(v: unknown): { name: string | undefined } | undefined {
  if (typeof v !== 'string') return undefined;
  const m = WHOLE.exec(v);
  return m ? { name: m[1] } : undefined;
}

const isTemplate = (s: string) => {
  TOKEN.lastIndex = 0;
  return TOKEN.test(s);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON equality: key order does not count. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => jsonEqual(a[k], b[k]));
  }
  return false;
}

const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s === undefined ? 'nothing' : s.length > 160 ? `${s.slice(0, 157)}...` : s;
};

const textOf = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matchTemplate(pattern: string, actual: unknown, b: Bindings, path: string): string | undefined {
  if (typeof actual !== 'string') return `${path || 'value'}: expected a string like ${show(pattern)}, got ${show(actual)}`;
  const names: (string | undefined)[] = [];
  let re = '^';
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(pattern); m; m = TOKEN.exec(pattern)) {
    re += escape(pattern.slice(last, m.index));
    last = m.index + m[0].length;
    const name = m[1];
    const bound = name !== undefined && b.has(name) ? textOf(b.get(name)) : undefined;
    if (name !== undefined && b.has(name) && bound === undefined) return `${path || 'value'}: <$${name}> is bound to ${show(b.get(name))}, which is not text`;
    if (bound !== undefined) re += escape(bound);
    else {
      re += '([\\s\\S]*?)';
      names.push(name);
    }
  }
  re += escape(pattern.slice(last)) + '$';
  const m = new RegExp(re).exec(actual);
  if (!m) return `${path || 'value'}: expected ${show(pattern)}, got ${show(actual)}`;
  for (const [i, name] of names.entries()) {
    if (name === undefined) continue;
    const got = m[i + 1]!;
    if (b.has(name) && b.get(name) !== got) return `${path || 'value'}: <$${name}> is ${show(b.get(name))} here and ${show(got)} in ${show(actual)}`;
    b.set(name, got);
  }
  return undefined;
}

function walk(pattern: unknown, actual: unknown, b: Bindings, o: MatchOptions, path: string): string | undefined {
  const ph = placeholder(pattern);
  if (ph) {
    if (actual === undefined) return `${path || 'value'}: expected ${pattern as string}, got nothing`;
    if (ph.name === undefined) return undefined;
    if (b.has(ph.name)) return jsonEqual(b.get(ph.name), actual) ? undefined : `${path || 'value'}: <$${ph.name}> is ${show(b.get(ph.name))}, got ${show(actual)}`;
    b.set(ph.name, actual);
    return undefined;
  }
  if (typeof pattern === 'string' && isTemplate(pattern)) return matchTemplate(pattern, actual, b, path);
  if (Array.isArray(pattern)) {
    if (!Array.isArray(actual)) return `${path || 'value'}: expected an array, got ${show(actual)}`;
    if (actual.length !== pattern.length) return `${path || 'value'}: expected ${pattern.length} elements, got ${actual.length}: ${show(actual)}`;
    for (const [i, p] of pattern.entries()) {
      const r = walk(p, actual[i], b, o, `${path}[${i}]`);
      if (r) return r;
    }
    return undefined;
  }
  if (isObject(pattern)) {
    if (!isObject(actual)) return `${path || 'value'}: expected an object, got ${show(actual)}`;
    for (const [k, p] of Object.entries(pattern)) {
      if (p === undefined) continue;
      if (!(k in actual) || actual[k] === undefined) return `${path ? `${path}.` : ''}${k}: missing (expected ${show(p)})`;
      const r = walk(p, actual[k], b, o, path ? `${path}.${k}` : k);
      if (r) return r;
    }
    if (o.exact) {
      const extra = Object.keys(actual).filter((k) => actual[k] !== undefined && !(k in pattern));
      if (extra.length) return `${path || 'value'}: unexpected ${extra.map((k) => `${k}=${show(actual[k])}`).join(', ')}`;
    }
    return undefined;
  }
  return pattern === actual ? undefined : `${path || 'value'}: expected ${show(pattern)}, got ${show(actual)}`;
}

/**
 * Matches `actual` against `pattern`. Returns `undefined` on a match (and the bindings it made are in
 * `bindings`), else why not (and `bindings` is unchanged).
 */
export function match(pattern: unknown, actual: unknown, bindings: Bindings, o: MatchOptions = {}): string | undefined {
  const trial: Bindings = new Map(bindings);
  const why = walk(pattern, actual, trial, o, '');
  if (why === undefined) for (const [k, v] of trial) bindings.set(k, v);
  return why;
}

export interface SubstituteOptions {
  /**
   * An unbound `<$name>` (default `error`): `name` binds it to the string `name` (what a replayed
   * peer does with an id it makes up: `"<$thread-1>"` is sent as `"thread-1"`).
   */
  unbound?: 'error' | 'name';
}

/** `value` with every placeholder replaced by what it is bound to (frames a fixture sends). `<any>` cannot be sent. */
export function substitute(value: unknown, b: Bindings, o: SubstituteOptions = {}, path = ''): unknown {
  const bind = (name: string) => {
    if (b.has(name)) return b.get(name);
    if (o.unbound === 'name') {
      b.set(name, name);
      return name;
    }
    throw new Error(`${path || 'value'}: <$${name}> is not bound`);
  };
  const ph = placeholder(value);
  if (ph) {
    if (ph.name === undefined) throw new Error(`${path || 'value'}: <any> cannot be sent`);
    return bind(ph.name);
  }
  if (typeof value === 'string' && isTemplate(value)) {
    TOKEN.lastIndex = 0;
    return value.replace(TOKEN, (_m, name: string | undefined) => {
      if (name === undefined) throw new Error(`${path || 'value'}: <any> cannot be sent`);
      const v = bind(name);
      const s = textOf(v);
      if (s === undefined) throw new Error(`${path || 'value'}: <$${name}> is bound to ${show(v)}, which is not text`);
      return s;
    });
  }
  if (Array.isArray(value)) return value.map((x, i) => substitute(x, b, o, `${path}[${i}]`));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, substitute(x, b, o, path ? `${path}.${k}` : k)]));
  return value;
}
