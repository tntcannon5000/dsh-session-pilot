# Fork notes — `tntcannon5000/dsh-session-pilot`

This is a fork of [ruby1304/dsh-session-pilot](https://github.com/ruby1304/dsh-session-pilot)
(MIT). It exists to add one thing, and it is written to be disposable: if upstream
ever ships the same capability, delete this fork.

## What the fork adds

`new_conversation` can start the new conversation in a **chosen agent preset** (mode),
instead of always inheriting the caller's preset:

```jsonc
// new_conversation tool arguments
{
  "prompt": "…self-contained first user message…",
  "title": "optional",
  "preset": "daily"   // optional preset id; omitted = inherit the caller's preset
}
```

Behavior:

- `preset` is optional. Omitted, the tool keeps upstream behavior exactly: the new
  conversation inherits the calling session's latest `agent-preset/selected`, falling
  back to the session header.
- Inheritance is the intended default, on purpose. A new conversation should look like
  the chat it came from; a preset is an explicit, warranted deviation — handing work to
  an autonomous or otherwise specialized mode — and the tool text says so.
- When a preset is given, it is validated against the live `agentPresets` roster before
  creating anything. An unknown id fails the call with the list of valid ids rather
  than silently creating a conversation in the wrong mode. If the deployment mounts no
  roster, the id is passed through to `sessionController.create({ agentPreset })`.
- The tool result now also reports `agentPreset`, so the model can tell the user which
  mode the new conversation runs in.
- Ids must match the DSH preset-id shape (lowercase letters, digits, hyphens).

Everything else is upstream's code: creation still goes through the official
`sessionController.create` → `rename` → `prompt` path, so created conversations are
ordinary durable Sessions. The picker is model-facing only; the Client half keeps
"⧉" only (see below).

## Header button removed

The `＋ New chat` button in the conversation header is gone. `src/client/index.ts` no
longer registers `SessionPilotHeaderAction` (`session-pilot-open`) on
`conversation.session.header.actions`; the header slot is left untouched for other
plugins. Nothing else changed: the Host `POST /session-pilot` route and all five model
tools stay, and the `⧉` action (`session-pilot-continue` on
`conversation.chat.assistant-actions`) still calls the same route, so blank creation is
still reachable — by the model, by the route, and by this deployment's own tooling.
`src/client/SessionPilotHeaderAction.tsx` is intentionally kept as dead source (upstream
still owns it) to keep the upstream-sync merge trivial; it is no longer imported, so it
is absent from the built `client.js`.

## Permissions are inherited too

A spawned conversation is a *fresh* session, so the Host applied the deployment's
default permission preset (`workspace-write`) even when the parent ran with Full access —
silently narrowing what the new chat could do. The fork now carries the source
conversation's permission preset onto the new one:

- `inheritPermissionPreset()` reads the source session's effective preset through
  `ctx.permissionPresets.current(session)` and applies it with `set(targetSession, name)`,
  resolving both through `ctx.sessions.get(id)`.
- It runs between `sessionController.create` and the first `prompt`, so the opening turn
  already runs under the inherited access. In a real child log the permission events land
  before `turn/start`.
- Best effort by design: no `permissionPresets` service (headless), a session not yet
  registered, an unmatched `custom` knob combination, or a throwing `set()` all leave the
  fresh-session default in place rather than failing conversation creation.
- `custom` is the one real gap: knob values no configured preset matches cannot be
  selected by name. Inheriting those would mean copying sandbox mode and approval policy
  through their own setters.

## Extra fix

`scripts/build.mjs` looks for `node_modules/.bin/tsc` without an extension, which
cannot be spawned on Windows; the fork resolves the `.cmd` shim there. No behavior
change on POSIX.

## Keeping up to date

`.github/workflows/sync-upstream.yml`:

- **On a schedule (and on demand)** merges `ruby1304/dsh-session-pilot:main` into this
  fork's `main`, then runs install → build → tests. A clean sync is pushed; a conflict
  fails the job loudly instead of leaving a half-merged branch.
- **Detects the upstream-equivalent feature.** A separate job inspects upstream's tool
  schema and `new_conversation` argument parser. When upstream accepts a preset
  argument on its own, the job opens (or refreshes) an issue titled
  *"Upstream supports preset selection — retire this fork"*.

To take upstream's changes locally: `git pull` in your clone, then repack and reinstall (below).

## Installing this plugin

The plugin is installed from a **packed tarball**, not a `link:` to the clone:

```
~/.dsh/profiles/desktop/package.json
  "dsh-session-pilot": "file:C:/Users/niran/.dsh/packages/dsh-session-pilot-0.1.0.tgz"
```

That matters. With a `link:` install the running Host serves whatever build sits in the
clone's working tree, so checking out another branch (or leaving a PR branch built)
silently swaps the live plugin — which happened once: the host served upstream's client
bundle and the header button reappeared. A packed snapshot cannot be affected by anything
done in the working tree, including branch switches and partial builds.

To ship a change to the running Host:

```bash
cd <clone>
git checkout main && git pull          # the build must come from the branch you want live
node ./scripts/build.mjs               # writes index.mjs / testing.mjs / client.js / client.js.map
pnpm pack --pack-destination ~/.dsh/packages   # produces dsh-session-pilot-<version>.tgz
```

then install that tarball through the plugin manager (`install_bundle` with the tarball
path) and reload the `session-pilot` row.

Two gotchas, both hit for real:

- pnpm reports "Already up to date" when the packed version number is unchanged, leaving
  the previous install (or a stale `link:` junction) in place. `remove_bundle` first, and
  if `node_modules/dsh-session-pilot` is still a junction, remove the reparse point with
  `cmd /c rmdir <path>` — never a recursive delete, which can reach through the junction.
- `~/.dsh/packages` is the local package store; keep the same filename so the profile spec
  stays stable, and reinstall after every repack.

## Layout of the delta

| Path | Change |
| --- | --- |
| `src/host/core.ts` | `preset` argument parsing + `availablePresetIds()` roster read; result carries `agentPreset` |
| `src/index.ts` | tool schema/description/execute changes |
| `src/shared.ts` | `SessionPilotResult.agentPreset` |
| `src/client/index.ts` | `＋ New chat` header action unregistered (⧉ kept) |
| `tests/core.test.mjs` | preset parsing tests |
| `scripts/build.mjs` | portable bin shim |
| `.github/workflows/` | upstream sync + feature detection |
