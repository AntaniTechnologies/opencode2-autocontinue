# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.3] - 2026-10-02

### Changed

- Runtime identifiers now present as `opencode2-autocontinue`: plugin `id`, log `plugin` field and console prefix, default log file `opencode2-autocontinue.log`, and project config file `opencode2-autocontinue.json(c)`. The legacy project config `auto-continue.json(c)` — and an existing project-local `auto-continue.log` — is still honored when the new name is absent.

## [0.4.2] - 2026-10-02

### Fixed

- Improved stability and responsiveness in all conditions.

### Changed

- Unified package presentation as `opencode2-autocontinue` (`package.json` name/keywords, `package-lock.json`, README install paths).

## [0.4.1] - 2026-10-02

### Fixed

- **Auto-continue fired on correctly finished sessions.** Root causes, all in the "is this a stall?" decision:
  - A last assistant message with **no `finish` field was treated as unfinished**. `session.execution.succeeded` can be delivered before the message projection records the finish reason, so a cleanly completed turn was read as stalled. The handler now waits (bounded by `settle_ms`, default 2000) for `finish`/`error`/`time.completed` to appear before judging, and a turn whose finish reason never appears is **left alone** unless it has an unresolved tool call. `continue_on_missing_finish: true` restores the old behaviour.
  - Assistant messages carrying an `error` are never continued, under any `trigger_policy`.
  - A user message already queued after the last assistant message (a new or injected turn is starting) now blocks injection.
  - The event loop awaited the idle handler, so `session.execution.started` could not mark the session busy while a decision was in flight. Handlers are now dispatched without blocking the loop, and busy is re-checked after every await before the prompt is sent.
  - The in-flight guard covered only the prompt call; it now covers the whole evaluation, so overlapping triggers cannot both inject.

### Added

- `settle_ms` and `continue_on_missing_finish` options.
- A `finish=stop` turn that produced no text and no tool call is now treated as a stall (an empty completion is not a deliberate end of work).
- Skip log record `skip: last assistant turn is not a stall` now carries a `reason`; new records for pending user messages.
- Tests 16-25 covering the above; existing tests now use realistic chronological message order.

## [0.4.0] - 2026-10-02

### Fixed

- **Auto-continue never triggered.** The plugin's only trigger was `session.idle`, which does not reach V2 plugin subscribers. Across an 8360-event debug capture, `session.idle` was delivered zero times — including for a session that demonstrably completed its turn — so the handler never ran at all. The trigger is now `session.execution.succeeded`, which is delivered reliably and is still emitted when a session stalls mid-task. `session.idle` is still handled in case it becomes reliable.
- **Invalid enumerated option values clobbered lower-precedence config.** A typo like `"trigger_policy": "sometimes"` in global plugin `options` was coerced to the default and, because precedence is decided by presence, overrode a valid value in the project file. Invalid values for `trigger_policy` and `log_level` are now dropped at that layer, matching the other options.

### Added

- **Finish-reason gating** (`trigger_policy`, default `"unfinished"`) so genuinely completed work is not continued. Continues only turns finishing with `length`, `unknown`, or `tool-calls`; skips clean `stop`. This is what separates a token-cap stall from a task that finished. Set `"always"` for the old trigger-everything behaviour.
- **Cross-project isolation.** The event stream is not scoped per project, so every plugin instance observed every session and each would have injected its own `continue` into the same session. Sessions are now matched against the plugin's own directory.
- **JSON activity log** with `log_level`, `log_path`, `log_console`, and `log_max_bytes` options. Records the project, session, trigger, finish reason, last assistant text, and every skip reason, so a silent no-op is always explained.
- `session.execution.failed` and `session.execution.interrupted` no longer trigger continuation — retrying a failure blindly and overriding an explicit interrupt are both wrong.

### Changed

- **The plugin no longer needs `node_modules` to load.** `@opencode/plugin` was imported as a value for `Plugin.define`, which is only `(plugin) => plugin`, but that pulled its whole runtime closure (effect, zod, ai-sdk, …) into every checkout. `dist/` now imports nothing outside Node's own `fs`/`os`/`path`, and `npm run build:lean` builds and then removes `node_modules` for a lean plugin directory.
- Failures previously swallowed by empty `catch` blocks are now logged (`session.context failed`, `switchAgent`/`switchModel failed`, `injection failed`, and event-subscription death).
- README documents all options, their precedence, reload behaviour, validation rules, and log file resolution.

## [0.3.0] - 2026-10-02

### Changed

- **Migrated to OpenCode V2 plugin API** — replaced the V1 `export default async () => ({ event })` shape with the V2 `Plugin.define({ id, setup })` contract.
- **Switched to local-path loading** — the plugin is now loaded from a git checkout via absolute path in `opencode.json(c)` instead of registry distribution.
- **Build toolchain updated** — switched from `bun build` to `tsc` for compilation; added explicit `.js` extensions to all relative imports for ESM compatibility.
- **Added root `index.js` shim** — required because OpenCode resolves plugins via `<dir>/server.js` then `<dir>/index.js` and does not consult `package.json` `main`/`exports`.

### Added

- **Race-condition fix** — re-checks session status via `GET /session/status` immediately before sending the continuation prompt, closing the window where a busy session could receive a `'continue'` prompt mid-turn (from `ed14280`).
- **Functional tests** — added `test/functional.ts` that drives the real `setup()` with a mock plugin context and real-shaped V2 events. Covers injection on `session.idle`, duplicate suppression, no-assistant-message and disabled cases, agent/model continuity, and the `max_consecutive` cap.

### Removed

- Dropped npm registry publishing; the plugin is now distributed via git checkout only.

## [0.2.1] - 2026-04-30

### Added

- Functional tests for auto-continue logic.

## [0.1.1] - 2026-04-30

### Changed

- Updated npm publishing metadata.

## [0.1.0] - 2026-04-30

### Added

- Initial release: auto-continue plugin that sends a `'continue'` prompt when OpenCode sessions go idle.
- README documentation.
