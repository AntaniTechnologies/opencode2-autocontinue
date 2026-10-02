import type { Plugin } from "@opencode/plugin"
import type { PluginConfig } from "./types.js"
import type { SessionStateStore } from "./session-state.js"

type Ctx = Plugin.Context
type SessionMessage = Awaited<ReturnType<Ctx["session"]["context"]>>[number]

export type PluginEvent = {
  type: string
  data?: {
    sessionID?: string
  }
}

type ResolvedContext = {
  messageId: string | undefined
  agent: string | undefined
  model: { providerID: string; id: string } | undefined
}

function resolveLastAssistantContext(messages: SessionMessage[]): ResolvedContext {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type !== "assistant") continue

    return {
      messageId: msg.id,
      agent: msg.agent,
      model: msg.model ? { providerID: msg.model.providerID, id: msg.model.id } : undefined,
    }
  }
  return { messageId: undefined, agent: undefined, model: undefined }
}

function resolveAgentFromUserMessages(messages: SessionMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type !== "user") continue
    const agents = msg.agents ?? []
    if (agents.length > 0) return agents[agents.length - 1].name
  }
  return undefined
}

function hasRealUserMessageAfterLastContinue(
  messages: SessionMessage[],
  continueText: string,
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type !== "user") continue

    const text = (msg.text ?? "").trim().toLowerCase()
    if (text === continueText.toLowerCase()) return false
    return true
  }
  return false
}

export function createIdleHandler(args: {
  ctx: Ctx
  getConfig: () => PluginConfig
  sessionStateStore: SessionStateStore
  isBusy: (sessionID: string) => boolean
}): (event: PluginEvent) => Promise<void> {
  const { ctx, getConfig, sessionStateStore, isBusy } = args

  async function injectContinuation(sessionID: string): Promise<void> {
    const config = getConfig()
    if (!config.enabled) return

    const state = sessionStateStore.getState(sessionID)

    if (state.inFlight) return
    if (state.consecutiveCount >= config.max_consecutive) return

    let messages: SessionMessage[]
    try {
      messages = [...(await ctx.session.context({ sessionID }))]
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

    // V2 has no session.status/active API on the plugin context, so the busy
    // set maintained from execution events is the idleness signal. This closes
    // the race window opened by cooldown deferral.
    if (isBusy(sessionID)) return

    state.inFlight = true
    try {
      if (agent) {
        try {
          await ctx.session.switchAgent({ sessionID, agent })
        } catch {
        }
      }
      if (assistantCtx.model) {
        try {
          await ctx.session.switchModel({ sessionID, model: assistantCtx.model })
        } catch {
        }
      }
      await ctx.session.prompt({ sessionID, text: config.message })

      state.lastAssistantMessageId = assistantCtx.messageId
      state.consecutiveCount += 1
      state.lastInjectedAt = Date.now()
    } catch {
    } finally {
      state.inFlight = false
    }
  }

  return async (event: PluginEvent): Promise<void> => {
    if (event.type === "session.deleted") {
      const sessionID = event.data?.sessionID
      if (sessionID) sessionStateStore.cleanup(sessionID)
      return
    }

    if (event.type !== "session.idle") return

    const config = getConfig()
    if (!config.enabled) return

    const sessionID = event.data?.sessionID
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
        void injectContinuation(sessionID)
      }, remaining)
      return
    }

    await injectContinuation(sessionID)
  }
}
