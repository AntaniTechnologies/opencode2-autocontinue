import type { PluginInput } from "@opencode-ai/plugin"
import type { PluginConfig } from "./types"
import type { SessionStateStore } from "./session-state"

type EventInput = {
  event: { type: string; properties?: unknown }
}

type SessionMessage = {
  info?: {
    id?: string
    role?: string
  }
  parts?: Array<{ type?: string; text?: string }>
}

function getLastAssistantMessageId(messages: SessionMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info?.role === "assistant") {
      return messages[i].info?.id
    }
  }
  return undefined
}

function hasRealUserMessageAfterLastContinue(
  messages: SessionMessage[],
  continueText: string,
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role !== "user") continue

    const text = (msg.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text?.trim() ?? "")
      .join("")
      .toLowerCase()

    if (text === continueText.toLowerCase()) return false
    return true
  }
  return false
}

export function createIdleHandler(args: {
  ctx: PluginInput
  config: PluginConfig
  sessionStateStore: SessionStateStore
}): (input: EventInput) => Promise<void> {
  const { ctx, config, sessionStateStore } = args

  return async ({ event }: EventInput): Promise<void> => {
    if (event.type === "session.deleted") {
      const props = event.properties as Record<string, unknown> | undefined
      const info = props?.info as { id?: string } | undefined
      if (info?.id) sessionStateStore.cleanup(info.id)
      return
    }

    if (event.type !== "session.idle") return
    if (!config.enabled) return

    const props = event.properties as Record<string, unknown> | undefined
    const sessionID = props?.sessionID as string | undefined
    if (!sessionID) return

    const state = sessionStateStore.getState(sessionID)

    if (state.inFlight) return

    if (state.lastInjectedAt && Date.now() - state.lastInjectedAt < config.cooldown_ms) {
      return
    }

    if (state.consecutiveCount >= config.max_consecutive) {
      return
    }

    let messages: SessionMessage[] = []
    try {
      const response = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      })
      messages = (response?.data ?? response ?? []) as SessionMessage[]
    } catch {
      return
    }

    const lastAssistantId = getLastAssistantMessageId(messages)
    if (!lastAssistantId) return

    if (state.lastAssistantMessageId === lastAssistantId) return

    if (hasRealUserMessageAfterLastContinue(messages, config.message)) {
      sessionStateStore.resetConsecutive(sessionID)
    }

    if (state.consecutiveCount >= config.max_consecutive) return

    state.inFlight = true
    try {
      await ctx.client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: config.message }],
        },
        query: { directory: ctx.directory },
      })

      state.lastAssistantMessageId = lastAssistantId
      state.consecutiveCount += 1
      state.lastInjectedAt = Date.now()
    } catch {
    } finally {
      state.inFlight = false
    }
  }
}
