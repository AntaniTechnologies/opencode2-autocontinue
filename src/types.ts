import { DEFAULT_LOG_FILENAME, type LogLevel } from "./logger.js"

export type TriggerPolicy = "unfinished" | "always"

export type PluginConfig = {
  enabled: boolean
  message: string
  cooldown_ms: number
  max_consecutive: number
  /**
   * "unfinished" only continues a turn that looks cut short (finish reasons
   * length/unknown/tool-calls). "always" continues after every completed turn.
   */
  trigger_policy: TriggerPolicy
  /**
   * How long to wait for the last assistant message to receive its finish
   * reason before judging it. The execution event can outrun the message
   * projection.
   */
  settle_ms: number
  /**
   * When no finish reason ever appears, continue anyway. Off by default: an
   * unknown turn is not proof of a stall.
   */
  continue_on_missing_finish: boolean
  /**
   * Continue a session that ended because an automatic compaction produced no
   * usable summary ("Compaction produced no summary"). The turn dies on that
   * failure and nothing re-drives it, while the context is still over the
   * compaction threshold, so the next prompt retries the summary. Only
   * `reason: "auto"` is retried: a manual /compact shows its error to the user
   * and retrying it would start a turn nobody asked for.
   */
  continue_on_compaction_failure: boolean
  log_level: LogLevel
  log_path: string | undefined
  log_console: boolean
  log_max_bytes: number
}

export type SessionState = {
  lastInjectedAt: number | undefined
  consecutiveCount: number
  lastAssistantMessageId: string | undefined
  /**
   * Id of the last failed compaction we injected against. A retried compaction
   * fails onto a fresh message id, so this is what stops one recovery from
   * re-firing on the same failure.
   */
  lastCompactionMessageId: string | undefined
  inFlight: boolean
  deferredTimer: ReturnType<typeof setTimeout> | undefined
}

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: false,
  message: "continue",
  cooldown_ms: 10_000,
  max_consecutive: 5,
  trigger_policy: "unfinished",
  settle_ms: 2_000,
  continue_on_missing_finish: false,
  continue_on_compaction_failure: true,
  log_level: "info",
  log_path: undefined,
  log_console: false,
  log_max_bytes: 5 * 1024 * 1024,
}

export { DEFAULT_LOG_FILENAME }