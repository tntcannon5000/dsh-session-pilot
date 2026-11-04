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
- When a preset is given, it is validated against the live `agentPresets` roster before
  creating anything. An unknown id fails the call with the list of valid ids rather
  than silently creating a conversation in the wrong mode. If the deployment mounts no
  roster, the id is passed through to `sessionController.create({ agentPreset })`.
- The tool result now also reports `agentPreset`, so the model can tell the user which
  mode the new conversation runs in.
- Ids must match the DSH preset-id shape (lowercase letters, digits, hyphens).

Everything else is upstream's code: creation still goes through the official
`sessionController.create` → `rename` → `prompt` path, so created conversations are
ordinary durable Sessions. The picker is model-facing only; the Client half's
"+ New chat" and "⧉" buttons are unchanged.

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

To take upstream's changes locally: `git pull` in your clone, then `pnpm install &&
pnpm run build`.

## Layout of the delta

| Path | Change |
| --- | --- |
| `src/host/core.ts` | `preset` argument parsing + `availablePresetIds()` roster read; result carries `agentPreset` |
| `src/index.ts` | tool schema/description/execute changes |
| `src/shared.ts` | `SessionPilotResult.agentPreset` |
| `tests/core.test.mjs` | preset parsing tests |
| `scripts/build.mjs` | portable bin shim |
| `.github/workflows/` | upstream sync + feature detection |
