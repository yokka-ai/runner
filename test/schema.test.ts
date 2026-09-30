import { describe, expect, it } from "vitest";
import {
  absent,
  anything,
  array,
  boolean,
  literal,
  nullable,
  number,
  object,
  optional,
  parse,
  record,
  refine,
  SchemaError,
  string,
  union,
} from "../src/schema.ts";

describe("schema", () => {
  it("accepts values of the right type and names the path of a wrong one", () => {
    expect(parse(string, "a", "x")).toBe("a");
    expect(parse(number, 3, "x")).toBe(3);
    expect(parse(boolean, false, "x")).toBe(false);
    expect(() => parse(string, 3, "x")).toThrow("x: expected a string, got number");
    expect(() => parse(number, Number.NaN, "x")).toThrow("x: expected a number, got number");
    expect(() => parse(boolean, "yes", "x")).toThrow('x: expected true or false, got "yes"');
    expect(() => parse(string, null, "x")).toThrow("got null");
    expect(() => parse(string, [], "x")).toThrow("got an array");
    expect(() => parse(string, "y".repeat(50), "x")).not.toThrow();
    expect(() => parse(number, "y".repeat(50), "x")).toThrow(`got "${"y".repeat(40)}…"`);
  });

  it("checks literals, nullables, optionals and absent values", () => {
    const mode = literal("a", "b");
    expect(mode("a", "m")).toBe("a");
    expect(() => mode("c", "m")).toThrow("m: expected one of a, b");
    expect(nullable(string)(null, "n")).toBeNull();
    expect(optional(string)(undefined, "o")).toBeUndefined();
    expect(() => optional(string)(null, "o")).toThrow(SchemaError);
    expect(absent(string)(null, "a")).toBeUndefined();
    expect(absent(string)("v", "a")).toBe("v");
    expect(anything({ any: 1 }, "u")).toEqual({ any: 1 });
  });

  it("refines a value with a check", () => {
    const even = refine(number, (n) => n % 2 === 0, "an even number");
    expect(even(2, "e")).toBe(2);
    expect(() => even(3, "e")).toThrow("e: expected an even number, got number");
  });

  it("checks arrays and records item by item", () => {
    expect(array(number)([1, 2], "a")).toEqual([1, 2]);
    expect(() => array(number)([1, "2"], "a")).toThrow("a[1]: expected a number");
    expect(() => array(number)({}, "a")).toThrow("a: expected an array, got object");
    expect(record(number)({ x: 1 }, "r")).toEqual({ x: 1 });
    expect(() => record(number)({ x: "1" }, "r")).toThrow("r.x: expected a number");
    expect(() => record(number)([], "r")).toThrow("r: expected an object, got an array");
  });

  it("keeps only the keys an object declares, and leaves out absent optional ones", () => {
    const s = object({ a: string, b: optional(number) });
    expect(s({ a: "x", extra: true }, "o")).toEqual({ a: "x" });
    expect(s({ a: "x", b: 2 }, "o")).toEqual({ a: "x", b: 2 });
    expect(() => s({ b: 2 }, "o")).toThrow("o.a: expected a string, got undefined");
    expect(() => s("x", "o")).toThrow("o: expected an object");
  });

  it("tries each side of a union and reports both when neither fits", () => {
    const s = union(object({ ok: literal(false) }), object({ ok: literal(true), n: number }));
    expect(s({ ok: false }, "u")).toEqual({ ok: false });
    expect(s({ ok: true, n: 1 }, "u")).toEqual({ ok: true, n: 1 });
    expect(() => s({ ok: true }, "u")).toThrow(
      "u.ok: expected one of false, got boolean; or u.n: expected a number, got undefined",
    );
  });

  it("passes on an error from a union member that isn't a schema error", () => {
    const boom = () => {
      throw new TypeError("boom");
    };
    expect(() => union(string, boom)(1, "u")).toThrow(TypeError);
  });
});
