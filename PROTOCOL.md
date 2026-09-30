# Runner protocol, version 1

This is the whole contract between `yokka-runner` and a Yokka deployment. The runner calls Convex functions on
the server (`https://sync.yokka.ai` unless `--server` says otherwise) over the Convex client: a websocket for the live
subscription, plain calls for the rest. It only ever connects outward.

**What the server can ask for.** Nothing in this protocol carries a path, a shell command or anything to execute.
The server can say "run R: start card C with agent A", "pause run R", "resume run R", "hand run R over" and
"stop run R". Anything the agent needs a person for is answered in the agent's own app, never through this
protocol. Which folder a project lives in, how a run's folder is prepared and
which flags an agent gets are decided by the runner, from its local config (`~/.yokka/runner.json`).

Every call below except sign-in takes `token`, the runner's own token (`yr_` plus 40 characters). The server keeps
only its SHA-256 hash. A disconnected runner's calls fail with an `unauthenticated` error that says so, and `work`
returns `{ revoked: true }`.

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
| `runner:attach` | mutation | `runId`, `attempt`, `filename`, `contentType?`, `caption?` | `{ ok, uploadUrl, … }` or `{ ok: false, error }` |

- **Claim** takes a queued run. It checks the runner's and the plan's concurrency limits and bumps `attempt`,
  which fences every later call: an update with an old attempt is ignored. It mints an MCP token for this run
  alone (write access, this project only), revoked when the run ends: `mcp` is `{ url, link, token }`, where
  `link` is the connector link (`null` when the workspace turned links off; send `Authorization: Bearer` then).
- **The prompt** names the card and a launch code and tells the agent to use the MCP tools. The agent passes the
  code to `claim_card`, which binds its MCP session to the run; from then on the agent's own calls move the run
  (`request_input` to waiting for input, `complete_card` to done, `release_card` to released).
- **Update** statuses a runner may set: `launched` (the session started), `running` (it moved again after being
  blocked, or resumed), `paused`, `waiting_approval`, `handed_off`, and the final `done`, `failed`, `cancelled`, `lost`. `openUrl` must
  be `https:`, `claude:` or `codex:`. After a run ended, only `git` is still accepted, for ten minutes.
- **Pause and resume**: when `pause` turns on, stop the agent's work without losing its conversation and report
  `paused`; when it turns off, wake the same session ("Continue where you left off.") and report `running`.
- **When the agent needs a person** (a permission prompt, a sign-in, a question), report `waiting_approval` with a
  `note`; the card flags the person, who answers in the agent's app. Report `running` when it moves again.
- **Uploads**: read `path` inside the run's folder only (resolve symlinks; refuse anything outside), PUT the bytes
  to `uploadUrl` with a `Content-Type`, then call `uploaded`, with `error` if it couldn't.

## Versioning

The server announces its protocol in `hello`. Additions that old runners can ignore (a new field in `work`, a new
optional argument) keep the version. Anything else bumps it, and the server keeps accepting the previous version
until the minimum is raised.
