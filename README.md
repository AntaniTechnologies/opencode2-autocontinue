# opencode-auto-continue

OpenCode plugin that automatically sends a continuation prompt when agent sessions go idle, keeping long-running tasks moving without manual intervention.

## Install

Add to `opencode.json`:

```json
{
  "plugin": [
    "opencode-auto-continue"
  ]
}
```

Or install from npm:

```bash
npm install opencode-auto-continue
```

## How It Works

When an OpenCode session emits a `session.idle` event, the plugin automatically injects a continuation message (default: `"continue"`) to resume the agent. This is useful for multi-step tasks where the agent pauses between steps waiting for user input.

**Key behaviors:**
- Listens for `session.idle` events
- Resolves the last assistant's agent and model to maintain context continuity
- Respects a cooldown period between consecutive injections
- Caps the maximum number of consecutive auto-continues to prevent infinite loops
- Resets the consecutive counter when the user sends a real (non-continue) message
- Re-checks session status immediately before sending and skips the injection if the session is no longer idle (closes the race window opened by cooldown deferral)
- Cleans up state when sessions are deleted

## Configuration

Create `.opencode/auto-continue.json` (or `.jsonc`) in your project root:

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
