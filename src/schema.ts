/**
 * A small runtime schema check for what crosses a trust boundary: the server's answers (PROTOCOL.md) and
 * the local files the runner reads back (config, ledger). Each schema returns the value typed, or throws a
 * `SchemaError` naming the path that's wrong. Objects keep only the keys they declare, so a newer server's
 * extra fields are dropped rather than trusted, which is what lets additions keep the protocol version.
 */

export class SchemaError extends Error {
  override name = "SchemaError";
}

export type Schema<T> = (value: unknown, path: string) => T;
export type Infer<S> = S extends Schema<infer T> ? T : never;

function describe(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  return typeof value;
}

function fail(path: string, expected: string, value: unknown): never {
  throw new SchemaError(`${path}: expected ${expected}, got ${describe(value)}`);
}

export const string: Schema<string> = (v, p) => (typeof v === "string" ? v : fail(p, "a string", v));

export const number: Schema<number> = (v, p) =>
  typeof v === "number" && Number.isFinite(v) ? v : fail(p, "a number", v);

export const boolean: Schema<boolean> = (v, p) => (typeof v === "boolean" ? v : fail(p, "true or false", v));

/** Accepts anything; for fields the runner passes along without reading. */
export const anything: Schema<unknown> = (v) => v;

export function literal<const T extends readonly (string | number | boolean)[]>(
  ...values: T
): Schema<T[number]> {
  return (v, p) =>
    (values as readonly unknown[]).includes(v) ? (v as T[number]) : fail(p, `one of ${values.join(", ")}`, v);
}

export function nullable<T>(schema: Schema<T>): Schema<T | null> {
  return (v, p) => (v === null ? null : schema(v, p));
}

export function optional<T>(schema: Schema<T>): Schema<T | undefined> {
  return (v, p) => (v === undefined ? undefined : schema(v, p));
}

/** Like `optional`, and also takes a `null` as "not there" (Convex returns null for a missing optional). */
export function absent<T>(schema: Schema<T>): Schema<T | undefined> {
  return (v, p) => (v === undefined || v === null ? undefined : schema(v, p));
}

/** A value that passes `schema` and then `check`; `expected` says what `check` wants. */
export function refine<T>(schema: Schema<T>, check: (value: T) => boolean, expected: string): Schema<T> {
  return (v, p) => {
    const value = schema(v, p);
    return check(value) ? value : fail(p, expected, v);
  };
}

export function array<T>(item: Schema<T>): Schema<T[]> {
  return (v, p) => (Array.isArray(v) ? v.map((x, i) => item(x, `${p}[${i}]`)) : fail(p, "an array", v));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An object whose keys are free-form (ids) and whose values all pass `value`. */
export function record<T>(value: Schema<T>): Schema<Record<string, T>> {
  return (v, p) => {
    if (!isRecord(v)) return fail(p, "an object", v);
    const out: Record<string, T> = {};
    for (const [k, x] of Object.entries(v)) out[k] = value(x, `${p}.${k}`);
    return out;
  };
}

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: undefined extends Infer<S[K]> ? K : never;
}[keyof S];
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type ObjectOf<S extends Shape> = Simplify<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

export function object<S extends Shape>(shape: S): Schema<ObjectOf<S>> {
  return (v, p) => {
    if (!isRecord(v)) return fail(p, "an object", v);
    const out: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(shape)) {
      const value = schema(v[key], `${p}.${key}`);
      if (value !== undefined) out[key] = value;
    }
    return out as ObjectOf<S>;
  };
}

/** The first schema that accepts the value; the error lists what each one wanted. */
export function union<A, B>(a: Schema<A>, b: Schema<B>): Schema<A | B> {
  return (v, p) => {
    try {
      return a(v, p);
    } catch (first) {
      try {
        return b(v, p);
      } catch (second) {
        if (first instanceof SchemaError && second instanceof SchemaError)
          throw new SchemaError(`${first.message}; or ${second.message}`);
        throw second;
      }
    }
  };
}

/** Checks `value` against `schema`, naming `what` in the error. */
export function parse<T>(schema: Schema<T>, value: unknown, what: string): T {
  return schema(value, what);
}
