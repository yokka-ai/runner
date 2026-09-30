/** Answers a deployment gives, shaped like the runner protocol (PROTOCOL.md). */

export const hello = {
  runnerId: "r1",
  name: "laptop",
  owner: "ada@example.com",
  workspace: { name: "Acme", slug: "acme" },
  appUrl: "https://yokka.ai",
  protocol: 2,
  heartbeatMs: 20_000,
  projects: [{ _id: "p1", name: "Web", slug: "web", cardPrefix: "WEB" }],
};

export const workRun = {
  runId: "run1",
  attempt: 0,
  status: "queued",
  agent: "claude-code",
  projectId: "p1",
  ref: "WEB-1",
  title: "Fix the thing",
  workspaceMode: null,
  clientSessionId: null,
  cancel: false,
  handOff: false,
  pause: false,
  uploads: [],
};

export const claimOk = {
  ok: true,
  attempt: 1,
  prompt: "Work on WEB-1 in Yokka (launch r_abc123).",
  launchCode: "r_abc123",
  ref: "WEB-1",
  projectId: "p1",
  agent: "claude-code",
  workspaceMode: null,
  mcp: { url: "https://x.convex.site/mcp", link: null, token: "wb_secret" },
};
