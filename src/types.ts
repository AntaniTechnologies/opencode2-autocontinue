export type PluginConfig = {
  enabled: boolean
  message: string
  cooldown_ms: number
  max_consecutive: number
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
}
