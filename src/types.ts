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
  log_level: LogLevel
  log_path: string | undefined
  log_console: boolean
  log_max_bytes: number
}

export type SessionState = {
  lastInjectedAt: number | undefined
  consecutiveCount: number
  lastAssistantMessageId: string | undefined
  inFlight: boolean
  deferredTimer: ReturnType<typeof setTimeout> | undefined
}

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: false,
  message: "continue",
  cooldown_ms: 10_000,
  max_consecutive: 5,
  trigger_policy: "unfinished",
  log_level: "info",
  log_path: undefined,
  log_console: false,
  log_max_bytes: 5 * 1024 * 1024,
}

export { DEFAULT_LOG_FILENAME }