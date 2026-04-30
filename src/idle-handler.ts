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
    agent?: string
    modelID?: string
    providerID?: string
    model?: {
      providerID?: string
      modelID?: string
    }
  }
  parts?: Array<{ type?: string; text?: string }>
}

type ResolvedContext = {
  messageId: string | undefined
  agent: string | undefined
  model: { providerID: string; modelID: string } | undefined
}

function resolveLastAssistantContext(messages: SessionMessage[]): ResolvedContext {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (info?.role !== "assistant") continue

    const providerID = info.model?.providerID ?? info.providerID
    const modelID = info.model?.modelID ?? info.modelID

    return {
      messageId: info.id,
      agent: info.agent,
      model: providerID && modelID ? { providerID, modelID } : undefined,
    }
  }
  return { messageId: undefined, agent: undefined, model: undefined }
}

function resolveAgentFromUserMessages(messages: SessionMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (info?.role === "user" && info.agent) return info.agent
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

type SessionStatusEntry = { type?: string }

async function isSessionIdle(
  ctx: PluginInput,
  sessionID: string,
): Promise<boolean> {
  try {
    const response = await ctx.client.session.status({
      query: { directory: ctx.directory },
    })
    const map = ((response as { data?: unknown })?.data ?? response ?? {}) as Record<
      string,
      SessionStatusEntry
    >
    return !map[sessionID]
  } catch {
    return true
  }
}

export function createIdleHandler(args: {
  ctx: PluginInput
  getConfig: () => PluginConfig
  sessionStateStore: SessionStateStore
}): (input: EventInput) => Promise<void> {
  const { ctx, getConfig, sessionStateStore } = args

  async function injectContinuation(sessionID: string): Promise<void> {
    const config = getConfig()
    if (!config.enabled) return

    const state = sessionStateStore.getState(sessionID)

    if (state.inFlight) return
    if (state.consecutiveCount >= config.max_consecutive) return

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

    const assistantCtx = resolveLastAssistantContext(messages)
    if (!assistantCtx.messageId) return
    if (state.lastAssistantMessageId === assistantCtx.messageId) return

    if (hasRealUserMessageAfterLastContinue(messages, config.message)) {
      sessionStateStore.resetConsecutive(sessionID)
    }
    if (state.consecutiveCount >= config.max_consecutive) return

    const agent = assistantCtx.agent ?? resolveAgentFromUserMessages(messages)

    if (!(await isSessionIdle(ctx, sessionID))) return

    state.inFlight = true
    try {
      const payload = {
        path: { id: sessionID },
        body: {
          ...(agent ? { agent } : {}),
          ...(assistantCtx.model ? { model: assistantCtx.model } : {}),
          parts: [{ type: "text" as const, text: config.message }],
        },
        query: { directory: ctx.directory },
      }

      if (typeof (ctx.client.session as any).promptAsync === "function") {
        await (ctx.client.session as any).promptAsync(payload)
      } else {
        await ctx.client.session.prompt(payload)
      }

      state.lastAssistantMessageId = assistantCtx.messageId
      state.consecutiveCount += 1
      state.lastInjectedAt = Date.now()
    } catch {
    } finally {
      state.inFlight = false
    }
  }

  return async ({ event }: EventInput): Promise<void> => {
    if (event.type === "session.deleted") {
      const props = event.properties as Record<string, unknown> | undefined
      const info = props?.info as { id?: string } | undefined
      if (info?.id) sessionStateStore.cleanup(info.id)
      return
    }

    if (event.type !== "session.idle") return

    const config = getConfig()
    if (!config.enabled) return

    const props = event.properties as Record<string, unknown> | undefined
    const sessionID = props?.sessionID as string | undefined
    if (!sessionID) return

    const state = sessionStateStore.getState(sessionID)

    if (state.deferredTimer) {
      clearTimeout(state.deferredTimer)
      state.deferredTimer = undefined
    }

    if (state.lastInjectedAt && Date.now() - state.lastInjectedAt < config.cooldown_ms) {
      const remaining = config.cooldown_ms - (Date.now() - state.lastInjectedAt)
      state.deferredTimer = setTimeout(() => {
        state.deferredTimer = undefined
        injectContinuation(sessionID)
      }, remaining)
      return
    }

    await injectContinuation(sessionID)
  }
}
