# yokka-runner

Starts Claude Code and Codex on your machine when you press **Start** on a card in Yokka, from the board or your
phone. The agents work the card over Yokka's MCP tools, and the sessions show up in your Claude and Codex apps.

- **Open source and small.** This repository is the whole runner. It's the only Yokka code that runs on your machine.
- **Outbound only.** It holds one connection to your Yokka deployment and opens no ports.
- **Your folders stay here.** Which folder a project lives in is in `~/.yokka/runner.json` and nowhere else. The
  server can't point the runner at a path or send it a command ([PROTOCOL.md](PROTOCOL.md)).
- **Your agents, your sign-ins.** It drives the `claude` and `codex` you already have installed and signed in.

Runs on macOS, Linux and Windows with Node 22 or newer.

## Start

```bash
npx yokka-runner login --server https://<deployment>.convex.cloud
```

The board shows the exact command under **Settings → Agents → Runners**. It prints a code and opens the board to
confirm it. Then, in each project's folder:

```bash
npx yokka-runner map
```

Pick the project, and whether runs work **in place** (in this folder, one run at a time) or in **a git worktree
per run** (in `.yokka-worktrees/` inside the folder, kept out of git through `.git/info/exclude`, so several cards
can run at once). Then leave it running:

```bash
npx yokka-runner
```

## What it does with a run

1. Takes the run and gets its folder ready. In place, it refuses to start over uncommitted changes it didn't make
   (unless the project allows it). A worktree gets a branch like `yokka/yk-12-add-checkout`.
2. Starts the agent with a short prompt: which card, and a launch code the agent passes to `claim_card`.
   - **Claude Code:** `claude --bg --remote-control` with the run's MCP server in `--mcp-config`. The session appears
     in the Claude desktop app by itself, updates live, and can be continued there or on your phone.
   - **Codex:** `codex app-server`, driven over JSON-RPC. The thread appears in the Codex app (open it from the card).
     Its permission requests appear on the card as Allow / Deny.
   - Either way the run's own Yokka tools are pre-approved: its token reaches that one project's board and nothing
     else. Everything else the agent does follows the permission mode you set.
3. Watches the session's real state and reports it. When the agent needs you (a question, a permission prompt),
   the card says so and you answer in the agent's own app: the live Claude session, on your computer or phone, or
   the Codex thread, which the runner hands over when you press **Continue in Codex**.
4. On **Pause**, stops the agent and keeps its conversation; **Resume** wakes the same session to carry on.
5. On **Stop**, stops the session.
6. When the run ends, reports the branch, commits and uncommitted files, and removes the worktree if you asked it to.

Claude sessions outlive the runner: restart it and it picks them back up. Codex threads live in the runner's
app-server, so stopping the runner ends them (the thread stays in the Codex app).

## Commands

| Command | |
| --- | --- |
| `yokka-runner` | Connect and take runs |
| `yokka-runner login` | Sign this machine in (`--server`, `--name`) |
| `yokka-runner map [folder]` | Link a folder to a project (`--project`, `--mode in-place\|worktree`, `--allow-dirty`) |
| `yokka-runner unmap [project]` | Forget a project's folder |
| `yokka-runner status` | Config, projects, and whether each agent is ready |
| `yokka-runner config [key value]` | Show or change a setting |
| `yokka-runner logout` | Forget the token |
| `yokka-runner verify` | Version and how to check where this build came from |

## Settings

`yokka-runner config <key> <value>`, or edit `~/.yokka/runner.json` (`YOKKA_HOME` moves the folder):

| Key | Default | |
| --- | --- | --- |
| `name` | the hostname | What the board calls this runner |
| `maxConcurrent` | `2` | Runs at once |
| `agents.claude-code.permissionMode` | `acceptEdits` | `default`, `acceptEdits`, `plan` or `auto`. Never `bypassPermissions` |
| `agents.claude-code.model` | Claude Code's | |
| `agents.codex.model` | Codex's | Set it if your Codex config names a model your login can't use |
| `agents.codex.sandbox` | `workspace-write` | or `read-only` |
| `agents.codex.approvalPolicy` | `never` | Keep it: a thread the runner holds can't be answered in the app, so Codex works inside its sandbox without asking |
| `agents.<agent>.enabled` | `true` | |
| `agents.<agent>.command` | `claude`, `codex` | |

Per project, in `projects.<id>`: `worktree.base` (branch to start from), `worktree.setup` (run once in each new
worktree, like `npm ci`), `worktree.cleanup` (`keep` until the card is done, or `delete` when the run ends clean).

## Checking where it came from

Published builds come from GitHub Actions with an npm provenance attestation tying the package to the commit and
workflow that built it (`npm audit signatures`, or `npm view yokka-runner dist.attestations`). A board's "verified"
badge could only show what a runner says about itself, so the check that counts is the one you run.

## Developing

`npm ci`, then `npm start -- <command>` runs the source directly (Node 22.18 or newer strips the types).
`npm run typecheck` checks it and `npm run build` compiles it to `dist/`.

## Releasing

Bump `version` in `package.json` and `VERSION` in `src/api.ts` together, merge, then push a matching tag
(`git tag v0.1.1 && git push origin v0.1.1`). The **Publish** workflow checks that the three agree, builds, and
publishes to npm with a provenance attestation. Nothing is published from a laptop.
