# Runner protocol, version 3

This is the whole contract between `yokka-runner` and a Yokka deployment. The runner calls Convex functions on
the server (`https://sync.yokka.ai` unless `login --server` or `YOKKA_SERVER` says otherwise) over the Convex
client: a websocket for the live subscription, plain calls for the rest. It only ever connects outward.

**What the server can ask for.** Nothing in this protocol carries a path, a shell command or anything to execute.
The server can say "run R: start card C with agent A", "pause run R", "resume run R", "hand run R over" and
"stop run R". Anything the agent needs a person for is answered in the agent's own app, never through this
protocol. Which folder a project lives in, how a run's folder is prepared and which flags an agent gets are
decided by the runner, from its local config (`~/.yokka/runner.json`).

Every call below except sign-in takes `token`, the runner's own token (`yr_` plus 40 characters). The server keeps
only its SHA-256 hash. A disconnected runner's calls fail with an app error (a `ConvexError` whose data is
`{ code, message }`) with code `unauthenticated` and a message that says so, and `work` returns
`{ revoked: true }`. The runner stops on either.

The deployment URL must be `https:`; plain `http:` is accepted only for a deployment on the same machine
(`localhost`, `127.0.0.1`, `[::1]`), for local development.

## Sign-in (device code)

| Call | Kind | Arguments | Returns |
| --- | --- | --- | --- |
| `runner:loginStart` | action | `name`, `machine`, `platform`, `version` | `userCode` (`ABCD-EFGH`), `deviceCode` (secret), `verifyUrl`, `intervalMs`, `expiresAt` |
| `runner:loginPoll` | action | `deviceCode` | `{ status: "pending" \| "denied" \| "expired" }` or `{ status: "approved", token, runnerId, workspace }` |

The runner shows `userCode` and opens `verifyUrl`, where a signed-in person checks the code and picks a
workspace. The first poll after approval returns the token, once; later polls say `expired`. Codes last ten
minutes.

## Session

| Call | Kind | Arguments | Returns |
| --- | --- | --- | --- |
| `runner:hello` | mutation | `version`, `protocol`, `agents?`, `projects`, `maxConcurrent` | runner and workspace names, `heartbeatMs`, the workspace's projects |
| `runner:work` | query (subscribe) | none | `{ revoked, runs }` |
| `runner:heartbeat` | mutation | `runs: [{ runId, attempt }]` | `{ stop: runId[] }` |

- `agents` lists `{ agent: "claude-code" | "codex", version?, problem? }`. A `problem` ("not signed in") makes the
  board offer the agent as unavailable instead of failing runs. Leave `agents` out to keep what's there.
- `projects` lists `{ projectId, mode: "in_place" | "worktree" }`: the projects this machine has a folder for. The
  folder itself is never sent.
- `hello` refuses a runner whose `protocol` is older than the server's minimum.
- `work` lists the runner's open runs: `runId`, `attempt`, `status`, `agent`, `projectId`, `ref`, `title`,
  `workspaceMode` (a one-run override), `clientSessionId`, `cancel`, `handOff`, `pause` (paused on the board;
  cleared to resume) and `uploads` (files the agent attached by path: `{ _id, path, uploadUrl }`).
- Heartbeat every `heartbeatMs` with every run the runner holds. The server loses open runs the runner no longer
  lists and returns runs it holds that ended or moved on (a newer attempt), so the runner stops them. A runner
  not heard from for a minute shows as offline; its runs are lost after five.

## Runs

| Call | Kind | Arguments | Returns |
| --- | --- | --- | --- |
| `runner:claim` | action | `runId` | `{ ok: false, reason }` or `{ ok: true, attempt, prompt, launchCode, ref, projectId, agent, workspaceMode, mcp }` |
| `runner:update` | mutation | `runId`, `attempt`, and any of `status`, `clientSessionId`, `openUrl`, `note`, `summary`, `git` | `{ ok }` |
| `runner:uploaded` | mutation | `runId`, `attempt`, `uploadId`, `error?` | `{ ok }` |
| `runner:attach` | mutation | `runId`, `attempt`, `filename`, `contentType?`, `caption?` | `{ ok: false, error }` or `{ ok: true, uploadUrl, filename, contentType, maxBytes }` |
| `runner:usage` | mutation | `runId`, `attempt`, and any of `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `costUsd`, `durationMs` | `{ ok }` |

- **Claim** takes a queued run. It checks the runner's and the plan's concurrency limits and bumps `attempt`,
  which fences every later call: an update with an old attempt is ignored. It mints an MCP token for this run
  alone (write access, this project only), revoked when the run ends: `mcp` is `{ url, link, token }`, where
  `link` is the connector link (`null` when the workspace turned links off; send `Authorization: Bearer` then).
- **The prompt** names the card and a launch code and tells the agent to use the MCP tools. The agent passes the
  code to `claim_card`, which binds its MCP session to the run; from then on the agent's own calls move the run
  (`request_input` to waiting for input, `complete_card` to done, `release_card` to released).
- **Update** statuses a runner may set: `launched` (the session started), `running` (it moved again after being
  blocked, or resumed), `paused`, `waiting_approval`, `handed_off`, and the final `done`, `failed`, `cancelled`,
  `lost`. `openUrl` must be `https:`, `claude:` or `codex:`. After a run ended, only `git` is still accepted, for
  ten minutes.
- **Pause and resume**: when `pause` turns on, the runner stops the agent's work without losing its conversation
  and reports `paused`; when it turns off, it wakes the same session ("Continue where you left off.") and reports
  `running`. A run that is `paused` when a restarted runner picks it back up stays paused until `pause` clears.
  `cancel` wins over everything else, and `handOff` over `pause`.
- **When the agent needs a person** (a permission prompt, a sign-in, a question), the runner reports
  `waiting_approval` with a `note` saying where; the card flags the person, who answers in the agent's app. It
  reports `running` when the agent moves again. A run already `waiting_input` (the agent asked over MCP) isn't
  reported again.
- **Uploads**: for each entry in `uploads`, the runner reads `path` inside the run's folder (resolved with symlinks;
  anything outside is refused), PUTs it to `uploadUrl` with a `Content-Type` and reports with `uploaded` (an
  `error` when it couldn't). `uploadUrl` must be `https:` under `/mcp/upload/` on the deployment: its own origin,
  its `.convex.site` twin, or the origin of the run's `mcp.url`. Files over 20 MB are refused locally.
- **attach** mints an upload link for a file the runner found itself (a Codex image, say). The server offers it;
  this runner doesn't call it yet.
- **Usage** (version 3) is what the run's agent has spent so far: **running totals for the attempt, never
  increments**. Each report replaces the last one, so the runner sends it whenever it changes: at most once a
  minute while the agent works, and at once when it pauses, is handed over or ends. Tokens are whole counts:
  `inputTokens` is fresh input (cache reads not included), `cacheReadTokens` and `cacheWriteTokens` the prompt
  cache's. `costUsd` is the cost in US dollars as the agent counted it; leave it out when the agent doesn't say.
  `durationMs` is the time the agent spent working, not waiting. The server takes reports after the run ended
  too, and a runner's report wins over what the agent reports about the same run. Send it only to a server whose
  `hello` announces protocol 3 or later.
  - **Claude Code**: read from the session's transcript. Claude Code writes its own totals there (cost, tokens per
    model, API and tool time) whenever the session's process ends, so the runner takes the last of those and adds
    the tokens of model calls made since. The cost is final once nothing came after it. A finished run's session
    stays open to be continued in the app, so the runner keeps reading it, for up to a day, for the cost Claude
    Code writes when it closes.
  - **Codex**: the thread's running totals from the app-server's `thread/tokenUsage/updated` notifications, and
    the time its turns took. Codex reports no cost.

## What the runner checks

- **Every answer is checked** against the shapes above before the runner acts on it. Fields it doesn't know are
  dropped; a `status` or `agent` it doesn't know is kept as text and left alone (it only takes runs for agents it
  has). An answer that doesn't fit makes that call fail, or that `work` update be skipped, with a message naming
  the field.
- **Claims**: `launchCode` is `r_` plus letters and digits, and `mcp.url` and `mcp.link` are `https:` URLs. The
  worktree folder and branch are built from slugs of `ref`, `title` and `launchCode`, never from raw text.
- **Links it opens** on the person's machine (`verifyUrl`, session links) must be `https:`, `claude:` or `codex:`.
- **Deadlines and retries**: every call gets 30 s (claims 60 s). Network failures and timeouts are retried with
  exponential backoff and jitter for `hello` and final status updates (`done`, `failed`, `cancelled`, `lost`), so
  the server must keep those safe to repeat. Claims are never retried; a refused claim is tried again only on the
  next `work` update. A failed `work` query is subscribed again with backoff. App errors are never retried.
- **Secrets**: the runner token lives in `~/.yokka/runner.json` (mode 0600; on Windows, inherited access removed),
  the run token only in the run's MCP config file (Claude) or on the Codex app-server's stdin. Neither ever goes on
  a command line or into the runner's output.
- **The agent's permissions**: nothing the agent asks for is approved through this protocol. The run's own Yokka
  tools are pre-approved (its token reaches one project); a Codex request for anything else is declined.

## Versioning

The server announces its protocol in `hello`. Additions that old runners can ignore (a new field in `work`, a new
optional argument) keep the version. Anything else bumps it, and the server keeps accepting the previous version
until the minimum is raised.

Version 3 added `runner:usage`; servers still accept version 2 runners, which never call it.

Version 2 removed replies (`messages`, `delivered`), approvals on the card (`approvals`, `requestApproval`) and
plain-chat questions (`askedInChat`), and added `pause` and the `paused` status; the server refuses version 1.
