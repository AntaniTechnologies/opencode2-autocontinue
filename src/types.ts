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
}

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  message: "continue",
  cooldown_ms: 10_000,
  max_consecutive: 5,
}
