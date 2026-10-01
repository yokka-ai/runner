import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import {
  errorCode,
  errorMessage,
  isAgentId,
  isRevoked,
  isTransient,
  type LoginTransport,
  liveClient,
  loginClient,
  type Work,
} from "../src/api.ts";
import { SchemaError } from "../src/schema.ts";
import { PROTOCOL, VERSION } from "../src/version.ts";
import { claimOk, hello, workRun } from "./fixtures.ts";
import { captureOutput, fakeTransport } from "./helpers.ts";

const TOKEN = `yr_${"abcd".repeat(10)}`;
const NO_RETRY = { attempts: 1, baseMs: 1, maxMs: 1, retryable: () => false };
const QUICK_RETRY = { attempts: 3, baseMs: 1, maxMs: 1, retryable: isTransient };

describe("liveClient", () => {
  it("sends the token, version and protocol with hello and checks the answer", async () => {
    const fake = fakeTransport({ hello: () => hello });
    const live = liveClient(fake.transport, TOKEN, NO_RETRY);
    await expect(live.hello({ projects: [], maxConcurrent: 2 })).resolves.toEqual(hello);
    expect(fake.calls[0]).toEqual({
      kind: "mutation",
      name: "hello",
      args: { token: TOKEN, version: VERSION, protocol: PROTOCOL, projects: [], maxConcurrent: 2 },
    });
  });

  it("refuses an answer that doesn't match the protocol", async () => {
    const fake = fakeTransport({ hello: () => ({ ...hello, heartbeatMs: 5 }) });
    const live = liveClient(fake.transport, TOKEN, QUICK_RETRY);
    await expect(live.hello({ projects: [], maxConcurrent: 2 })).rejects.toThrow(
      "hello.heartbeatMs: expected between 1 s and 10 min",
    );
    // A protocol mismatch isn't worth retrying.
    expect(fake.callsTo("hello")).toHaveLength(1);
  });

  it("retries hello through a network failure", async () => {
    let calls = 0;
    const fake = fakeTransport({
      hello: () => {
        calls++;
        if (calls === 1) throw new Error("fetch failed");
        return hello;
      },
    });
    captureOutput();
    const live = liveClient(fake.transport, TOKEN, QUICK_RETRY);
    await expect(live.hello({ projects: [], maxConcurrent: 2 })).resolves.toEqual(hello);
    expect(calls).toBe(2);
  });

  it("doesn't retry an error the server raised on purpose", async () => {
    const fake = fakeTransport({
      hello: () => {
        throw new ConvexError({ code: "invalid", message: "This runner is too old for Acme." });
      },
    });
    const live = liveClient(fake.transport, TOKEN, QUICK_RETRY);
    const err = await live.hello({ projects: [], maxConcurrent: 2 }).catch((e: unknown) => e);
    expect(errorMessage(err)).toBe("This runner is too old for Acme.");
    expect(fake.callsTo("hello")).toHaveLength(1);
  });

  it("parses claims, both kinds", async () => {
    const answers = [claimOk, { ok: false, reason: "no longer queued" }];
    const fake = fakeTransport({ claim: () => answers.shift() });
    const live = liveClient(fake.transport, TOKEN, NO_RETRY);
    await expect(live.claim("run1")).resolves.toEqual({ ...claimOk, workspaceMode: undefined });
    await expect(live.claim("run1")).resolves.toEqual({ ok: false, reason: "no longer queued" });
    expect(fake.calls[0]).toEqual({ kind: "action", name: "claim", args: { token: TOKEN, runId: "run1" } });
  });

  it("refuses a claim whose launch code or MCP URL looks wrong", async () => {
    const answers = [
      { ...claimOk, launchCode: "../../etc" },
      { ...claimOk, mcp: { ...claimOk.mcp, url: "file:///etc/passwd" } },
    ];
    const fake = fakeTransport({ claim: () => answers.shift() });
    const live = liveClient(fake.transport, TOKEN, NO_RETRY);
    await expect(live.claim("run1")).rejects.toThrow("expected a launch code");
    await expect(live.claim("run1")).rejects.toThrow("claim.mcp.url: expected an https:// URL");
  });

  it("retries final status reports only", async () => {
    let fail = true;
    const fake = fakeTransport({
      update: () => {
        if (fail) {
          fail = false;
          throw new Error("socket closed");
        }
        return { ok: true };
      },
    });
    captureOutput();
    const live = liveClient(fake.transport, TOKEN, QUICK_RETRY);
    await expect(live.update("run1", 1, { status: "running" })).rejects.toThrow("socket closed");
    fail = true;
    await expect(live.update("run1", 1, { status: "done", note: "ok" })).resolves.toEqual({ ok: true });
    expect(fake.callsTo("update")).toHaveLength(3);
    expect(fake.calls.at(-1)?.args).toEqual({
      token: TOKEN,
      runId: "run1",
      attempt: 1,
      status: "done",
      note: "ok",
    });
  });

  it("makes the rest of the calls with the token", async () => {
    const fake = fakeTransport({
      heartbeat: () => ({ stop: ["run9"] }),
      uploaded: () => ({ ok: true }),
    });
    const live = liveClient(fake.transport, TOKEN, NO_RETRY);
    await expect(live.heartbeat([{ runId: "run1", attempt: 1 }])).resolves.toEqual({ stop: ["run9"] });
    await expect(live.uploaded("run1", 1, "u1")).resolves.toEqual({ ok: true });
    await live.uploaded("run1", 1, "u2", "too big");
    expect(fake.calls.map((c) => c.name)).toEqual(["heartbeat", "uploaded", "uploaded"]);
    expect(fake.calls.every((c) => c.args.token === TOKEN)).toBe(true);
    expect(fake.callsTo("uploaded").map((c) => c.args.error)).toEqual([undefined, "too big"]);
    await live.close();
    expect(fake.isClosed()).toBe(true);
  });

  it("fails a call that gets no answer in time", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeTransport({ heartbeat: () => new Promise(() => undefined) });
      const live = liveClient(fake.transport, TOKEN, NO_RETRY);
      const beat = live.heartbeat([]);
      const check = expect(beat).rejects.toThrow("runner:heartbeat got no answer within 30 s");
      await vi.advanceTimersByTimeAsync(30_000);
      await check;
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands work updates on only once they pass the schema", () => {
    const fake = fakeTransport();
    const live = liveClient(fake.transport, TOKEN, NO_RETRY);
    const updates: Work[] = [];
    const errors: Error[] = [];
    const unsubscribe = live.onWork(
      (w) => updates.push(w),
      (e) => errors.push(e),
    );
    fake.push({ revoked: false, runs: [workRun], extra: "ignored" });
    fake.push({ revoked: false, runs: [{ ...workRun, attempt: "one" }] });
    fake.fail(new Error("query failed"));
    unsubscribe();
    fake.push({ revoked: true, runs: [] });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.runs[0]).toMatchObject({ runId: "run1", status: "queued", agent: "claude-code" });
    expect(updates[0]?.runs[0]).not.toHaveProperty("workspaceMode");
    expect(errors.map((e) => e.message)).toEqual([
      'work.runs[0].attempt: expected a number, got "one"',
      "query failed",
    ]);
    expect(errors[0]).toBeInstanceOf(SchemaError);
  });

  it("reads protocol 2 runs: pause is required, paused is a status, v1's replies and approvals are dropped", () => {
    const fake = fakeTransport();
    const live = liveClient(fake.transport, TOKEN, NO_RETRY);
    const updates: Work[] = [];
    const errors: Error[] = [];
    live.onWork(
      (w) => updates.push(w),
      (e) => errors.push(e),
    );
    fake.push({
      revoked: false,
      runs: [
        {
          ...workRun,
          status: "paused",
          pause: true,
          messages: [{ _id: "m1", body: "hi" }],
          approvals: [{ key: "k", status: "allowed" }],
        },
      ],
    });
    const { pause: _pause, ...withoutPause } = workRun;
    fake.push({ revoked: false, runs: [withoutPause] });
    fake.push({ revoked: false, runs: [{ ...workRun, pause: "yes" }] });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.runs[0]).toMatchObject({ status: "paused", pause: true });
    expect(updates[0]?.runs[0]).not.toHaveProperty("messages");
    expect(updates[0]?.runs[0]).not.toHaveProperty("approvals");
    expect(errors.map((e) => e.message)).toEqual([
      "work.runs[0].pause: expected true or false, got undefined",
      'work.runs[0].pause: expected true or false, got "yes"',
    ]);
  });

  it("keeps a run whose status the runner doesn't know yet", () => {
    const fake = fakeTransport();
    const live = liveClient(fake.transport, TOKEN, NO_RETRY);
    const updates: Work[] = [];
    live.onWork(
      (w) => updates.push(w),
      () => undefined,
    );
    fake.push({ revoked: false, runs: [{ ...workRun, status: "paused_by_admin", agent: "cursor" }] });
    expect(updates[0]?.runs[0]?.status).toBe("paused_by_admin");
  });
});

describe("loginClient over HTTP", () => {
  const started = {
    userCode: "ABCD-EFGH",
    deviceCode: "secret",
    verifyUrl: "https://yokka.ai/runner",
    intervalMs: 2_000,
    expiresAt: 1,
  };
  const args = { name: "n", machine: "m", platform: "p", version: "v" };

  /** A sign-in transport whose `runner:site` answers `site` (or fails) and whose POST answers `post`. */
  function httpFake(site: unknown, post: (url: string) => { status: number; body: unknown }) {
    const fake = fakeTransport({ loginStart: () => started });
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const transport: LoginTransport = {
      action: fake.transport.action,
      query: async (name) => {
        if (name !== "site" || site instanceof Error) throw site instanceof Error ? site : new Error(name);
        return site;
      },
      post: async (url, body) => {
        posts.push({ url, body });
        return post(url);
      },
    };
    return { transport, posts, actions: () => fake.callsTo("loginStart") };
  }

  it("starts the sign-in on the deployment's HTTP site, not through the action", async () => {
    const f = httpFake({ siteUrl: "https://api.yokka.ai" }, () => ({ status: 200, body: started }));
    await expect(loginClient(f.transport, NO_RETRY).loginStart(args)).resolves.toEqual(started);
    expect(f.posts).toEqual([{ url: "https://api.yokka.ai/runner/login", body: args }]);
    expect(f.actions()).toHaveLength(0);
  });

  it("uses the action on a server without runner:site or without the route", async () => {
    const noQuery = httpFake(new Error("Could not find public function"), () => ({
      status: 200,
      body: started,
    }));
    await expect(loginClient(noQuery.transport, NO_RETRY).loginStart(args)).resolves.toEqual(started);
    expect(noQuery.posts).toHaveLength(0);
    expect(noQuery.actions()).toHaveLength(1);

    const noRoute = httpFake({ siteUrl: "https://old.convex.site" }, () => ({ status: 404, body: null }));
    await expect(loginClient(noRoute.transport, NO_RETRY).loginStart(args)).resolves.toEqual(started);
    expect(noRoute.actions()).toHaveLength(1);
  });

  it("reports the server's refusal and doesn't go round it through the action", async () => {
    const f = httpFake({ siteUrl: "https://api.yokka.ai" }, () => ({
      status: 429,
      body: { error: "Too many sign-ins started. Try again in 30s." },
    }));
    const err = await loginClient(f.transport, NO_RETRY)
      .loginStart(args)
      .catch((e: unknown) => e);
    expect(errorMessage(err)).toBe("Too many sign-ins started. Try again in 30s.");
    expect(isTransient(err)).toBe(false);
    expect(f.actions()).toHaveLength(0);
  });

  it("ignores a site URL that isn't https", async () => {
    const f = httpFake({ siteUrl: "http://evil.example" }, () => ({ status: 200, body: started }));
    await loginClient(f.transport, NO_RETRY).loginStart(args);
    expect(f.posts).toHaveLength(0);
    expect(f.actions()).toHaveLength(1);
  });
});

describe("loginClient", () => {
  it("starts and polls a device-code sign-in", async () => {
    const fake = fakeTransport({
      loginStart: () => ({
        userCode: "ABCD-EFGH",
        deviceCode: "secret",
        verifyUrl: "https://yokka.ai/runner?device=ABCD-EFGH",
        intervalMs: 2_000,
        expiresAt: 1,
      }),
      loginPoll: () => ({
        status: "approved",
        token: TOKEN,
        runnerId: "r1",
        workspace: { name: "Acme", slug: "acme" },
      }),
    });
    const api = loginClient(fake.transport, NO_RETRY);
    const started = await api.loginStart({ name: "n", machine: "m", platform: "p", version: "v" });
    expect(started.userCode).toBe("ABCD-EFGH");
    await expect(api.loginPoll("secret")).resolves.toMatchObject({ status: "approved", token: TOKEN });
    expect(fake.callsTo("loginPoll")[0]?.args).toEqual({ deviceCode: "secret" });
  });

  it("refuses a token that isn't a runner token", async () => {
    const fake = fakeTransport({
      loginPoll: () => ({
        status: "approved",
        token: "sk_live_x",
        runnerId: "r1",
        workspace: { name: "A", slug: "a" },
      }),
    });
    await expect(loginClient(fake.transport, NO_RETRY).loginPoll("d")).rejects.toThrow(
      "expected a runner token",
    );
  });
});

describe("errors", () => {
  it("reads app error codes and messages", () => {
    const revoked = new ConvexError({ code: "unauthenticated", message: "This runner was disconnected." });
    expect(errorCode(revoked)).toBe("unauthenticated");
    expect(isRevoked(revoked)).toBe(true);
    expect(errorMessage(revoked)).toBe("This runner was disconnected.");
    expect(errorMessage(new ConvexError("plain"))).toBe("plain");
    expect(errorCode(new ConvexError("plain"))).toBeUndefined();
    expect(errorCode(new Error("x"))).toBeUndefined();
    expect(errorMessage(new ConvexError({ other: 1 }))).toContain("other");
    expect(isRevoked(new Error("disconnected"))).toBe(false);
  });

  it("retries network trouble, not answers", () => {
    expect(isTransient(new Error("fetch failed"))).toBe(true);
    expect(isTransient(new ConvexError({ code: "invalid", message: "no" }))).toBe(false);
    expect(isTransient(new SchemaError("x"))).toBe(false);
  });

  it("knows the agents it has adapters for", () => {
    expect(isAgentId("codex")).toBe(true);
    expect(isAgentId("cursor")).toBe(false);
    expect(isAgentId(undefined)).toBe(false);
  });
});
