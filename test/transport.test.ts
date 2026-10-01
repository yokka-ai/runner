import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const convex = vi.hoisted(() => ({
  ws: {
    mutation: vi.fn(),
    action: vi.fn(),
    onUpdate: vi.fn(),
    close: vi.fn(),
  },
  http: { action: vi.fn(), query: vi.fn() },
  wsOptions: [] as unknown[],
  httpOptions: [] as { fetch?: typeof fetch; logger?: Record<string, (...args: unknown[]) => void> }[],
}));

vi.mock("convex/browser", () => ({
  ConvexClient: class {
    constructor(_url: string, options: unknown) {
      convex.wsOptions.push(options);
    }
    mutation = convex.ws.mutation;
    action = convex.ws.action;
    onUpdate = convex.ws.onUpdate;
    close = convex.ws.close;
  },
  ConvexHttpClient: class {
    constructor(_url: string, options: { fetch?: typeof fetch }) {
      convex.httpOptions.push(options);
    }
    action = convex.http.action;
    query = convex.http.query;
  },
}));

const { httpTransport, websocketTransport } = await import("../src/api.ts");
const { captureOutput } = await import("./helpers.ts");

function nameOf(ref: unknown) {
  return getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
}

describe("websocketTransport", () => {
  beforeEach(() => {
    convex.wsOptions.length = 0;
  });

  it("calls runner:* functions by name over the Convex client", async () => {
    convex.ws.mutation.mockResolvedValue("m");
    convex.ws.action.mockResolvedValue("a");
    const unsubscribe = vi.fn();
    convex.ws.onUpdate.mockReturnValue(unsubscribe);
    convex.ws.close.mockResolvedValue(undefined);
    const t = websocketTransport("https://x.convex.cloud");
    await expect(t.mutation("hello", { a: 1 })).resolves.toBe("m");
    await expect(t.action("claim", { b: 2 })).resolves.toBe("a");
    expect(nameOf(convex.ws.mutation.mock.calls[0]?.[0])).toBe("runner:hello");
    expect(nameOf(convex.ws.action.mock.calls[0]?.[0])).toBe("runner:claim");
    const stop = t.subscribe("work", { token: "t" }, vi.fn(), vi.fn());
    expect(nameOf(convex.ws.onUpdate.mock.calls[0]?.[0])).toBe("runner:work");
    stop();
    expect(unsubscribe).toHaveBeenCalled();
    await t.close();
    expect(convex.ws.close).toHaveBeenCalled();
  });

  it("routes Convex's own logging through the redacting log", () => {
    websocketTransport("https://x.convex.cloud");
    const options = convex.wsOptions[0] as { logger: Record<string, (...args: unknown[]) => void> };
    const output = captureOutput();
    options.logger.log?.("hello", `yr_${"a".repeat(40)}`);
    options.logger.warn?.("careful");
    options.logger.error?.(new Error("bad"));
    options.logger.logVerbose?.("noise");
    expect(output.text()).toContain("hello yr_…");
    expect(output.errors()).toContain("careful");
    expect(output.errors()).toContain("bad");
    expect(output.text()).not.toContain("noise");
  });
});

describe("httpTransport", () => {
  it("gives every request a deadline", async () => {
    convex.http.action.mockResolvedValue("done");
    const t = httpTransport("https://x.convex.cloud", 1_234);
    await expect(t.action("loginStart", {})).resolves.toBe("done");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await convex.httpOptions.at(-1)?.fetch?.("https://x.convex.cloud/api/action", { method: "POST" });
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    fetchSpy.mockRestore();
  });

  it("asks runner:* queries by name, and POSTs JSON without following redirects", async () => {
    convex.http.query.mockResolvedValue({ siteUrl: "https://api.yokka.ai" });
    const t = httpTransport("https://x.convex.cloud", 1_234);
    await expect(t.query?.("site", {})).resolves.toEqual({ siteUrl: "https://api.yokka.ai" });
    expect(nameOf(convex.http.query.mock.calls[0]?.[0])).toBe("runner:site");

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ userCode: "X" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("not json", { status: 502 }));
    await expect(t.post?.("https://api.yokka.ai/runner/login", { name: "n" })).resolves.toEqual({
      status: 200,
      body: { userCode: "X" },
    });
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init).toMatchObject({ method: "POST", redirect: "error", body: '{"name":"n"}' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    await expect(t.post?.("https://api.yokka.ai/runner/login", {})).resolves.toEqual({
      status: 502,
      body: null,
    });
    fetchSpy.mockRestore();
  });
});
