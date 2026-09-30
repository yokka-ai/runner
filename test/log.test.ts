import { describe, expect, it } from "vitest";
import { log, messageOf, print, printError, redact, warn } from "../src/log.ts";
import { captureOutput } from "./helpers.ts";

const RUNNER_TOKEN = `yr_${"a1B2".repeat(10)}`;
const RUN_TOKEN = `wb_${"Z9y8".repeat(10)}`;

describe("redact", () => {
  it("masks runner and run tokens wherever they appear", () => {
    expect(redact(`token ${RUNNER_TOKEN} and ${RUN_TOKEN}.`)).toBe("token yr_… and wb_….");
  });

  it("masks connector and upload links' secrets", () => {
    expect(redact("https://x.convex.site/mcp/c/SECRET123?x=1")).toBe("https://x.convex.site/mcp/c/…?x=1");
    expect(redact("PUT https://x.convex.site/mcp/upload/abcDEF failed")).toBe(
      "PUT https://x.convex.site/mcp/upload/… failed",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(redact("YK-12: yr_ is a prefix, wb_short too")).toBe("YK-12: yr_ is a prefix, wb_short too");
  });
});

describe("output", () => {
  it("prints plain and timestamped lines, redacted, to the right stream", () => {
    const output = captureOutput();
    print(`hello ${RUNNER_TOKEN}`);
    print();
    printError("oops");
    log("working");
    warn(`careful ${RUN_TOKEN}`);
    expect(output.out[0]).toBe("hello yr_…\n");
    expect(output.out[1]).toBe("\n");
    expect(output.out[2]).toMatch(/^\d\d:\d\d:\d\d working\n$/);
    expect(output.err[0]).toBe("oops\n");
    expect(output.err[1]).toMatch(/^\d\d:\d\d:\d\d careful wb_…\n$/);
  });
});

describe("messageOf", () => {
  it("describes anything thrown", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
    expect(messageOf("plain")).toBe("plain");
    expect(messageOf({ code: 1 })).toBe('{"code":1}');
    expect(messageOf(undefined)).toBe("undefined");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(messageOf(cyclic)).toBe("[object Object]");
  });
});
