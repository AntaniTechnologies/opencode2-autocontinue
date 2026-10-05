# opencode2-autocontinue

An OpenCode 2 plugin that automatically sends a continuation prompt when an agent session finishes a turn without completing its work, keeping long-running tasks moving without manual intervention.

Inspired by [opencode-auto-continue](https://github.com/hjzccc/opencode-auto-continue), an Opencode 1.x plugin by [hjzccc](https://github.com/hjzccc).

> This plugin is designed specifically for OpenCode 2.x.

## Install

This plugin is not published to any package registry. Get a copy from git, build it, and point OpenCode at the checkout.

### 1. Get the code

```bash
git clone https://github.com/AntaniTechnologies/opencode2-autocontinue.git
cd opencode2-autocontinue
```

### 2. Install dependencies and build

`dist/` is generated and gitignored, so a fresh clone must be built before OpenCode can load it:

```bash
npm install
npm run build
```

`dist/` is self-contained: the built plugin imports nothing outside Node's own `fs`/`os`/`path`, so OpenCode can load it with no `node_modules` present.

**If you want a lean checkout**, `npm run build:lean` builds and then deletes `node_modules` — you will need `npm install` again before the next build, test or typecheck.

### 3. Register it in `opencode.json(c)`

Add the checkout path to `plugins`. Use an absolute path, or a path relative to the config file:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/path/to/opencode2-autocontinue",
      "options": { "enabled": true }
    }
  ]
}
```

Then restart the service so the plugin is picked up:

```bash
opencode service restart
```

The path **must point at the repository root, not at `dist/index.js`.** OpenCode resolves a plugin directory by looking for `<dir>/server.js`, then `<dir>/index.js`, and does not read `main` or `exports` from `package.json`. The root `index.js` shim exists for exactly this reason. Pointing at a file, or at a directory without one of those entrypoints, fails with `configured plugin path must be a directory` or is silently ignored.

Verify it loaded:

```bash
opencode api plugin.list
```

`opencode2-autocontinue` should appear with `"source": { "type": "local" }` and `"status": "active"`. Note that `opencode plugin list` is not a reliable check here — it only reports registry-installed packages, so a correctly loaded local plugin does not appear in its output.

### After changing the source

The root `index.js` shim re-exports `dist/index.js` and does not trigger a build, so rebuild before restarting:

```bash
npm run build && opencode service restart
```

## Verifying

```bash
npm test
```

This drives the real `setup()` with a mock plugin context and real-shaped V2 events. It covers injection after a completed turn (including the case where no `session.idle` is ever delivered), duplicate suppression, the no-assistant-message case, the disabled case, agent/model continuity, the `max_consecutive` cap, cooldown deferral, `finish`-reason gating for both trigger policies, cross-project isolation, and the activity log.

Failed-compaction recovery is covered against a message shape lifted from a real session row (`status: "failed"`, `error.type: "compaction.failed"`, 44K in / 96 out): injection on an auto summary failure, recovery with no assistant message present, the manual-`/compact` and interrupted exclusions, the deterministic failures that are left alone, non-compaction execution failures staying ignored, deduplication on the failed compaction's id, a retry that fails again counting as a fresh stall, `max_consecutive` still applying, a user message after the failure blocking injection, and a *completed* compaction being treated as history rather than a stall.

The tests mock the event stream, so they do not prove a live server emits the trigger events you expect. To confirm that end to end, run a real session and check the activity log:

```bash
tail -f ~/.local/share/opencode/log/opencode2-autocontinue.log
```

Every skip reason is recorded there, so if opencode2-autocontinue did not fire, the log says which guard stopped it.

## How It Works

When a session's turn completes, the plugin injects a continuation message (default: `"continue"`) to resume the agent. This is useful for multi-step tasks where the agent pauses between steps waiting for user input.

**Key behaviors:**
- Triggers on `session.execution.succeeded`, **not** on `session.idle` (see below)
- Only continues turns that look cut short, based on the assistant's finish reason
- Recovers sessions stranded by a failed compaction (see below)
- Resolves the last assistant's agent and model to maintain context continuity (via `switchAgent`/`switchModel` before prompting)
- Respects a cooldown period between consecutive injections
- Caps the maximum number of consecutive continuations to prevent infinite loops
- Resets the consecutive counter when the user sends a real (non-continue) message
- Ignores sessions belonging to other projects
- Tracks execution lifecycle events (`session.execution.started` vs `succeeded`/`failed`/`interrupted`) and skips the injection if the session became busy again (closes the race window opened by cooldown deferral)
- Logs every decision, skip reason, and failure to a JSON activity log (see [Logging](#logging))
- Cleans up state when sessions are deleted

### Why execution.succeeded and not session.idle

Earlier versions triggered on `session.idle`. In practice that event does not reach plugin subscribers: across 8360 events in a 48-minute debug capture, `session.idle` was delivered **zero** times, including for a session that demonstrably completed its turn (`ses_f03e1d…` emitted `session.execution.succeeded` at 11:56:16 and then simply stopped). The plugin therefore never ran its trigger at all — not a guard, not a cooldown, not a bad config.

`session.idle` is published by OpenCode from its runner's `onIdle` callback (`session/run-state.ts` → `SessionStatus.set({ type: "idle" })`), and it is not reaching V2 plugin subscribers. `session.execution.succeeded` is delivered reliably, carries the same `sessionID`, and is still emitted when a session stalls mid-task. It is now the primary trigger; `session.idle` is still handled so the plugin keeps working if that event ever becomes reliable.

In V2 `session.idle` is in fact not an event at all: idleness is recorded as an `Idle` *message* (`type: "idle"`, `outcome: "succeeded" | "failed" | "interrupted"`) written when a terminal execution event is projected. That is why the plugin treats the execution lifecycle events as its trigger surface.

### Why execution.failed is also a trigger

`session.execution.failed` was previously ignored outright, on the reasonable assumption that a failure should not be retried blindly. That assumption holds for provider and tool errors, but not for one case: a compaction summary that comes back unusable fails the step (`Session.StepFailedError`) and ends the turn without ever producing an assistant message. Since the compaction sits on top of the agent's own output, retrying it is retrying a summary pass, not a failed model call.

The event is used only as a cheap pre-filter — its `error.type` must start with `compaction.` — and the actual decision is made from the session state, so a provider failure carrying an unrelated error never reaches the continuation path. See [Failed compaction](#failed-compaction-compaction-produced-no-summary) for which compaction failures qualify.

### Distinguishing a stall from finished work

`session.execution.succeeded` fires both when a task completes normally and when a session stalls, and the event carries no work-remaining signal — only `sessionID`. The plugin instead reads the **finish reason** of the last assistant message:

| `finish` | Meaning | Continue? |
|---|---|---|
| `stop` | model chose to stop | no |
| `length` / `max_output_tokens` | truncated at the output cap | **yes** |
| `unknown` | ambiguous | **yes** |
| `tool-calls` | tool work still queued | **yes** |
| `content-filter` / `error` | blocked or failed | no |

`length` is the signature of the stall this plugin exists to catch: e.g. for a provider configured with `"output": 8192`, a long turn that gets truncated still reports success. A message with **no** finish reason is not assumed to be a stall: the plugin first waits up to `settle_ms` for the host to write it (the execution event can arrive before the message is fully recorded), and if it still never appears the turn is continued only when a tool call was left unresolved. Set `continue_on_missing_finish: true` for providers that never report one. Messages carrying an `error` are never continued, and neither is a session that already has a user message queued after the last assistant reply. A `stop` that produced no text and no tool call is treated as a stall.

Known blind spot: a stall where the model emits a clean `stop` while work remains is indistinguishable from finishing, and will not be continued. Set `trigger_policy: "always"` if you would rather have full recall and accept the extra round-trips.

## Failed compaction: "Compaction produced no summary"

A session can stop on a stall that never produces an assistant message at all. When the context crosses the compaction threshold, OpenCode runs a separate summarization pass, and if that pass returns nothing usable it fails the whole turn:

```
Compaction · 98.5K in · 96 out
Compaction produced no summary
```

96 output tokens is the tell: reasoning models often spend their entire output budget thinking and never write the summary text ([#41571](https://github.com/anomalyco/opencode/issues/41571), [#44080](https://github.com/anomalyco/opencode/issues/44080), [#42371](https://github.com/anomalyco/opencode/issues/42371)). Nothing is lost — the transcript is left intact — but the session is stranded, and since the context is still over the threshold, every future turn hits the same wall.

This is a genuinely different shape from a normal stall, and the plugin treats it separately:

- The failure is recorded as a `type: "compaction"`, `status: "failed"` message, **not** an assistant message. There is no finish reason to read, so the table above does not apply.
- It surfaces as `session.execution.failed`, not `succeeded` — so it would otherwise be skipped along with genuine failures.
- The assistant message that *did* exist before it usually ended in a clean `stop`, so judging that message would read "finished, leave it alone".

The plugin therefore checks the failed-compaction message first, and recovers only when the failure is plausibly transient:

| Compaction failure | Continue? |
|---|---|
| `compaction.failed` — no summary, or template not filled | **yes** |
| `compaction.interrupted` — you pressed Esc | no |
| `reason: "manual"` — a `/compact` you ran | no |
| reached the output token limit | no |
| "cannot be reduced further" | no |
| `provider.unsupported-operation` | no |

A retry is worth it because the fault is the model's behaviour on one pass, not a property of the conversation — the same session frequently compacts successfully moments later. The deterministic rows above would fail identically forever, so they are left alone rather than burning tokens. A manual `/compact` reports its own outcome to you and is never second-guessed.

Retries are bounded by the usual `cooldown_ms` and `max_consecutive`, and deduplicated on the failed compaction's message id, so one failure produces one continuation. Set `continue_on_compaction_failure: false` to disable this path entirely.

## Configuration

### The two places options can be set

**1. Plugin `options` in `opencode.json(c)`** — where you registered the plugin. Usually global at `~/.config/opencode/opencode.jsonc`, which means it applies to every project:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/path/to/opencode2-autocontinue",
      "options": {
        "enabled": true,
        "trigger_policy": "unfinished",
        "cooldown_ms": 10000,
        "max_consecutive": 5
      }
    }
  ]
}
```

**2. `.opencode/opencode2-autocontinue.json` (or `.jsonc`) in a project** — the reliable way to set options **per project**:

```jsonc
{
  "trigger_policy": "unfinished",
  "max_consecutive": 3
}
```

`.jsonc` files may contain `//` and `/* */` comments. Only `enabled` is required, and only once, somewhere.

Checkouts from before the rename may still use `.opencode/auto-continue.json(c)`; it is still honored when the new name is absent, but prefer the new name going forward.

**Precedence is per key**, highest first:

1. explicit plugin `options`
2. the project file for the directory the session is running in
3. built-in defaults

So in the common setup — plugin registered globally with `{"enabled": true}` — a project can override any *other* key without touching global config, because `options` only pins the keys it actually names. A global `options` block that pins everything cannot be overridden per project.

Startup logs a `sources` map (`options` / `file` / `default`) for every key, so you can confirm which layer won:

```bash
grep '"msg":"plugin loaded"' ~/.local/share/opencode/log/opencode2-autocontinue.log | tail -1
```

### All options

| Option | Type | Default | Reload | Description |
|---|---|---|---|---|
| `enabled` | `boolean` | `false` | live | Master switch. **Nothing happens until this is explicitly `true`.** |
| `message` | `string` | `"continue"` | live | Text injected as a user message to resume the agent. |
| `cooldown_ms` | `number` | `10000` | live | Minimum ms between consecutive injections. A trigger inside the window is deferred, not dropped. |
| `max_consecutive` | `number` | `5` | live | Max consecutive continuations before the plugin stops until the counter resets. |
| `trigger_policy` | `"unfinished"` \| `"always"` | `"unfinished"` | live | `"unfinished"` continues only turns whose finish reason looks cut short; `"always"` continues after every completed turn. See [below](#distinguishing-a-stall-from-finished-work). |
| `settle_ms` | `number` | `2000` | live | Max time to wait for the last assistant message to receive its finish reason before judging it. |
| `continue_on_missing_finish` | `boolean` | `false` | live | Continue even when no finish reason ever appears and nothing else proves a stall. |
| `continue_on_compaction_failure` | `boolean` | `true` | live | Continue a session that ended because an automatic compaction produced no usable summary. See [Failed compaction](#failed-compaction-compaction-produced-no-summary). |
| `log_level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` \| `"off"` | `"info"` | **restart** | Verbosity. `"debug"` also records every ignored event. `"off"` writes nothing at all. |
| `log_path` | `string` | see [log resolution](#log-file-resolution) | **restart** | Log file path. Relative paths resolve against the project directory. |
| `log_console` | `boolean` | `false` | **restart** | Also echo records to the plugin process's stderr. |
| `log_max_bytes` | `number` | `5242880` (5 MB) | **restart** | Rotate once the log passes this size, keeping one `.1` generation. |

`live` means the value is re-read on every event, so editing the project file takes effect on the next turn with no restart. The four `log_*` options are sampled **once at plugin load** because the logger holds a resolved file path — changing them needs `opencode service restart`.

### Value validation

Bad values never crash the plugin. An unrecognised value is **ignored at that layer**, so a lower-precedence layer (the project file, then the defaults) still gets its turn — a typo in your global `options` cannot shadow a valid per-project setting:

| Input | Result |
|---|---|
| `enabled` not a boolean | ignored at this layer; if no layer sets it, stays `false` (plugin off) |
| `message` not a string, or empty | ignored |
| `cooldown_ms` / `max_consecutive` / `log_max_bytes` not a number | ignored |
| `cooldown_ms` / `max_consecutive` negative or zero | accepted as-is — `0` effectively disables that gate, and a negative `max_consecutive` suppresses injection entirely |
| `trigger_policy` not `"unfinished"`/`"always"` | ignored |
| `log_level` not a recognised level | ignored |
| `log_path` empty string | ignored |
| Unrecognised keys | ignored |
| Config file is malformed JSON | whole file ignored, resolution continues to defaults, and the parse error is logged as `"config file could not be parsed, using defaults"` |

### How the consecutive counter resets

The counter increments on each injection and resets when the plugin sees a **real** user message — one whose text, trimmed and lowercased, is not equal to `message`. That comparison is what makes it tell an injected `"continue"` apart from something you typed.

Consequence worth knowing: if you manually type exactly `continue` (any casing, with surrounding whitespace), it is treated as an injected prompt and will **not** reset the counter. Any other message will.

### Log file resolution

`log_path` is resolved in this order, highest first:

1. `log_path` from plugin `options`
2. `log_path` from the project file
3. `<project>/.opencode/opencode2-autocontinue.log`, if that file already exists — so a repo can keep its own history just by creating the file
4. the shared host log: `$XDG_DATA_HOME/opencode/log/opencode2-autocontinue.log`, falling back to `~/.local/share/opencode/log/opencode2-autocontinue.log`

Setting `log_level: "off"` short-circuits all of this and opens no file.

## Logging

The plugin writes newline-delimited JSON so any activity can be traced back to the project, session, and decision that produced it. Every record carries `time`, `level`, `msg`, `plugin`, `project` (absolute path), and `projectId`; session-scoped records add `sessionID`.

By default all projects share one file next to the host's own log, so they land in a single timeline; see [log file resolution](#log-file-resolution) for how to redirect or split it.

Two records bracket every injection, which is what you want when a continuation "didn't happen":

- `"injecting continuation"` — the decision was made, with `trigger`, `message`, `agent`, `model`, `assistantMessageId`, the `finish`/`rawFinish` reason, and a short `lastAssistantText` excerpt

- `"continuation injected"` — the prompt was accepted, with the new `consecutiveCount`

Every path that does *not* inject logs a `"skip: ..."` record naming the reason, so a silent no-op is always explained:

| `msg` | Meaning |
|---|---|
| `skip: injection already in flight` | A previous injection for this session has not finished |
| `skip: consecutive cap reached` | `max_consecutive` reached |
| `skip: no assistant message in context` | The session has no assistant reply to continue past |
| `skip: already continued past this assistant message` | Duplicate suppression; the last assistant message is unchanged |
| `skip: session became busy again before injection` | The session restarted work during the race window |
| `skip: last assistant turn is not a stall` | The turn finished normally, errored, or lacks proof of a stall; `reason` says which |
| `skip: user message is already waiting after the last assistant message` | A turn is already queued, so the session is not stalled |
| `skip: session belongs to another project` | Every plugin instance sees every session; this one is not yours |
| `within cooldown, deferring injection` | Deferred by `deferMs`; the follow-up records `trigger: "cooldown-deferred"` |

Failures that used to be swallowed by empty `catch` blocks now log: `session.context failed`, `switchAgent failed`, `switchModel failed`, `injection failed`, and `event subscription failed, opencode2-autocontinue is no longer running` — the last one means the plugin has gone inert until the next restart.

Startup is recorded too, as `"plugin loaded"` with the resolved config and a `sources` map saying whether each value came from plugin `options`, the project config `file`, or a `default`. If `enabled` is false the plugin logs a warning explaining it is inactive.

To trace one project:

```bash
grep '"project":"C:/path/to/project"' ~/.local/share/opencode/log/opencode2-autocontinue.log
```

`log_console` is off by default because the host does not route plugin stderr into its own log file; enable it only if something else captures the plugin process output.

## License

MIT
