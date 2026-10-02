# opencode-auto-continue

OpenCode plugin that automatically sends a continuation prompt when agent sessions go idle, keeping long-running tasks moving without manual intervention.

> V2 plugin for OpenCode 2.x. (For OpenCode 1.x, use version 0.1.x.)

## Install

This plugin is not published to any package registry. Get a copy from git, build it, and point OpenCode at the checkout.

### 1. Get the code

```bash
git clone https://github.com/AntaniTechnologies/opencode2-autocontinue.git
cd opencode-auto-continue
```

### 2. Install dependencies and build

`dist/` is generated and gitignored, so a fresh clone must be built before OpenCode can load it:

```bash
npm install
npm run build
```

### 3. Register it in `opencode.json(c)`

Add the checkout path to `plugins`. Use an absolute path, or a path relative to the config file:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/path/to/opencode-auto-continue",
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

`auto-continue` should appear with `"source": { "type": "local" }` and `"status": "active"`. Note that `opencode plugin list` is not a reliable check here — it only reports registry-installed packages, so a correctly loaded local plugin does not appear in its output.

### After changing the source

The root `index.js` shim re-exports `dist/index.js` and does not trigger a build, so rebuild before restarting:

```bash
npm run build && opencode service restart
```

## How It Works

When an OpenCode session emits a `session.idle` event, the plugin automatically injects a continuation message (default: `"continue"`) to resume the agent. This is useful for multi-step tasks where the agent pauses between steps waiting for user input.

**Key behaviors:**
- Listens for `session.idle` events
- Resolves the last assistant's agent and model to maintain context continuity (via `switchAgent`/`switchModel` before prompting)
- Respects a cooldown period between consecutive injections
- Caps the maximum number of consecutive auto-continues to prevent infinite loops
- Resets the consecutive counter when the user sends a real (non-continue) message
- Tracks execution lifecycle events (`session.execution.started` vs `succeeded`/`failed`/`interrupted`/`idle`) and skips the injection if the session became busy again (closes the race window opened by cooldown deferral)
- Cleans up state when sessions are deleted

## Configuration

Pass options via the `plugins` entry in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    {
      "package": "C:/path/to/opencode-auto-continue",
      "options": {
        "enabled": true,
        "message": "continue",
        "cooldown_ms": 10000,
        "max_consecutive": 5
      }
    }
  ]
}
```

The legacy `.opencode/auto-continue.json` (or `.jsonc`) project file is still supported. Explicit plugin options take precedence over file values:

```json
{
  "enabled": true,
  "message": "continue",
  "cooldown_ms": 10000,
  "max_consecutive": 5
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Enable/disable the plugin. **Must be explicitly enabled.** |
| `message` | `string` | `"continue"` | The text injected as a user message |
| `cooldown_ms` | `number` | `10000` | Minimum ms between consecutive injections |
| `max_consecutive` | `number` | `5` | Max consecutive auto-continues before stopping |

## License

MIT
