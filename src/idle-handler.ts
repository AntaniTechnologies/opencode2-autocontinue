import type { Plugin } from "@opencode/plugin"
import type { PluginConfig } from "./types.js"
import type { SessionStateStore } from "./session-state.js"
import type { Logger } from "./logger.js"

type Ctx = Plugin.Context
type SessionMessage = Awaited<ReturnType<Ctx["session"]["context"]>>[number]

export type PluginEvent = {
  type: string
  data?: {
    sessionID?: string
  }
}

/**
 * What told us the session stopped working. `session.execution.succeeded` is the
 * reliable one: OpenCode's `session.idle` is published from the runner's
 * `onIdle` callback and does not reliably reach plugin subscribers, so a turn
 * can finish with no idle event at all. See "Why execution.succeeded" in README.
 */
export type IdleTrigger = "session.idle" | "session.execution.succeeded" | "cooldown-deferred"

type ResolvedContext = {
  messageId: string | undefined
  agent: string | undefined
  model: { providerID: string; id: string } | undefined
  /** Provider finish reason, e.g. "stop" or "length". */
  finish: string | undefined
  rawFinish: string | undefined
  /** Short excerpt of the last assistant text, for triage in the log. */
  excerpt: string | undefined
}

/**
 * Finish reasons that mean the model was cut off or left work queued, as
 * opposed to choosing to stop. `length` in particular is the signature of a
 * session that stalled on an output-token cap while still reporting
 * `session.execution.succeeded`.
 */
const UNFINISHED_FINISHES = new Set(["length", "unknown", "tool-calls", "max_output_tokens"])

const EXCERPT_LIMIT = 200

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const item of content) {
    if (item && typeof item === "object" && (item as { type?: unknown }).type === "text") {
      const text = (item as { text?: unknown }).text
      if (typeof text === "string") parts.push(text)
    }
  }
  return parts.join(" ")
}

function resolveLastAssistantContext(messages: SessionMessage[]): ResolvedContext {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type !== "assistant") continue

    const full = textFromContent(msg.content).trim()
    return {
      messageId: msg.id,
      agent: msg.agent,
      model: msg.model ? { providerID: msg.model.providerID, id: msg.model.id } : undefined,
      finish: typeof (msg as { finish?: unknown }).finish === "string" ? (msg as { finish: string }).finish : undefined,
      rawFinish:
        typeof (msg as { rawFinish?: unknown }).rawFinish === "string"
          ? (msg as { rawFinish: string }).rawFinish
          : undefined,
      excerpt: full.length > 0 ? full.slice(0, EXCERPT_LIMIT) : undefined,
    }
  }
  return { messageId: undefined, agent: undefined, model: undefined, finish: undefined, rawFinish: undefined, excerpt: undefined }
}

/**
 * Whether the last assistant turn looks interrupted. A turn that ended in a
 * plain "stop" is treated as finished work and not continued, which is what
 * separates a genuine stall from a task that completed normally.
 */
function looksUnfinished(ctx: ResolvedContext, policy: "always" | "unfinished"): boolean {
  if (policy === "always") return true
  // No finish reason at all is ambiguous; treat it as unfinished so a stall
  // from a provider that omits it is still recovered.
  if (!ctx.finish) return true
  return UNFINISHED_FINISHES.has(ctx.finish.toLowerCase())
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

/** Windows paths arrive with either separator and inconsistent casing. */
function normalizeDir(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

export function createIdleHandler(args: {
  ctx: Ctx
  getConfig: () => PluginConfig
  sessionStateStore: SessionStateStore
  isBusy: (sessionID: string) => boolean
  logger: Logger
}): {
  onBecameIdle: (sessionID: string, trigger: IdleTrigger) => Promise<void>
  onSessionDeleted: (sessionID: string) => void
} {
  const { ctx, getConfig, sessionStateStore, isBusy, logger } = args

  // The event stream is not scoped per project: every plugin instance observes
  // every session. Without this guard each open project would inject its own
  // "continue" into the same session.
  const ownDirectories = new Set<string>()
  for (const dir of [
    ctx.location.directory,
    ctx.location.project?.directory,
    ctx.location.project?.canonical,
  ]) {
    if (typeof dir === "string" && dir.length > 0) ownDirectories.add(normalizeDir(dir))
  }
  const ownership = new Map<string, boolean>()

  async function ownsSession(sessionID: string): Promise<boolean> {
    const cached = ownership.get(sessionID)
    if (cached !== undefined) return cached

    let owned = false
    try {
      const info = await ctx.session.get({ sessionID })
      const dir = info.location?.directory
      // Without a directory on the session, fall back to the project id so a
      // single-directory setup still works.
      owned =
        typeof dir === "string" && dir.length > 0
          ? ownDirectories.has(normalizeDir(dir))
          : info.projectID === ctx.location.project?.id
    } catch (error) {
      logger.warn("session lookup failed", { sessionID, error })
      ownership.set(sessionID, false)
      return false
    }
    ownership.set(sessionID, owned)
    return owned
  }

  async function injectContinuation(sessionID: string, trigger: IdleTrigger): Promise<void> {
    const config = getConfig()
    const log = logger.child({ sessionID })
    if (!config.enabled) {
      log.debug("skip: disabled")
      return
    }

    if (!(await ownsSession(sessionID))) {
      log.debug("skip: session belongs to another project", { trigger })
      return
    }

    const state = sessionStateStore.getState(sessionID)
    const snapshot = {
      trigger,
      consecutiveCount: state.consecutiveCount,
      lastInjectedAt: state.lastInjectedAt,
    }

    if (state.inFlight) {
      log.info("skip: injection already in flight", snapshot)
      return
    }
    if (state.consecutiveCount >= config.max_consecutive) {
      log.info("skip: consecutive cap reached", { ...snapshot, max_consecutive: config.max_consecutive })
      return
    }

    let messages: SessionMessage[]
    try {
      messages = [...(await ctx.session.context({ sessionID }))]
    } catch (error) {
      log.warn("skip: session.context failed", { ...snapshot, error })
      return
    }

    const assistantCtx = resolveLastAssistantContext(messages)
    if (!assistantCtx.messageId) {
      log.info("skip: no assistant message in context", { ...snapshot, messageCount: messages.length })
      return
    }
    if (state.lastAssistantMessageId === assistantCtx.messageId) {
      log.info("skip: already continued past this assistant message", {
        ...snapshot,
        assistantMessageId: assistantCtx.messageId,
      })
      return
    }

    if (hasRealUserMessageAfterLastContinue(messages, config.message)) {
      if (state.consecutiveCount > 0) {
        log.info("real user message seen, resetting consecutive counter", {
          ...snapshot,
          previousConsecutiveCount: state.consecutiveCount,
        })
      }
      sessionStateStore.resetConsecutive(sessionID)
    }
    if (state.consecutiveCount >= config.max_consecutive) {
      log.info("skip: consecutive cap reached after reset", {
        ...snapshot,
        max_consecutive: config.max_consecutive,
      })
      return
    }

    const agent = assistantCtx.agent ?? resolveAgentFromUserMessages(messages)

    // Distinguish a genuine stall from a task that finished normally. See
    // looksUnfinished; "always" restores the trigger-everything behaviour.
    if (!looksUnfinished(assistantCtx, config.trigger_policy)) {
      log.info("skip: last assistant turn looks finished", {
        ...snapshot,
        finish: assistantCtx.finish,
        rawFinish: assistantCtx.rawFinish,
        trigger_policy: config.trigger_policy,
      })
      return
    }

    // The busy set is maintained from execution events on the same ordered
    // stream. It closes the race window opened by cooldown deferral.
    if (isBusy(sessionID)) {
      log.info("skip: session became busy again before injection", snapshot)
      return
    }

    state.inFlight = true
    log.info("injecting continuation", {
      ...snapshot,
      message: config.message,
      agent,
      model: assistantCtx.model ? `${assistantCtx.model.providerID}/${assistantCtx.model.id}` : undefined,
      assistantMessageId: assistantCtx.messageId,
      finish: assistantCtx.finish,
      rawFinish: assistantCtx.rawFinish,
      lastAssistantText: assistantCtx.excerpt,
    })
    try {
      if (agent) {
        try {
          await ctx.session.switchAgent({ sessionID, agent })
        } catch (error) {
          log.warn("switchAgent failed, continuing anyway", { agent, error })
        }
      }
      if (assistantCtx.model) {
        try {
          await ctx.session.switchModel({ sessionID, model: assistantCtx.model })
        } catch (error) {
          log.warn("switchModel failed, continuing anyway", { model: assistantCtx.model, error })
        }
      }
      await ctx.session.prompt({ sessionID, text: config.message })

      state.lastAssistantMessageId = assistantCtx.messageId
      state.consecutiveCount += 1
      state.lastInjectedAt = Date.now()
      log.info("continuation injected", {
        consecutiveCount: state.consecutiveCount,
        max_consecutive: config.max_consecutive,
        cooldownMs: config.cooldown_ms,
      })
    } catch (error) {
      log.error("injection failed", { error, message: config.message })
    } finally {
      state.inFlight = false
    }
  }

  return {
    async onBecameIdle(sessionID: string, trigger: IdleTrigger): Promise<void> {
      const config = getConfig()
      if (!config.enabled) {
        logger.debug("idle signal ignored: plugin disabled", { sessionID, trigger })
        return
      }

      const log = logger.child({ sessionID })
      const state = sessionStateStore.getState(sessionID)

      if (state.deferredTimer) {
        clearTimeout(state.deferredTimer)
        state.deferredTimer = undefined
        log.debug("cleared pending cooldown timer", { trigger })
      }

      if (state.lastInjectedAt && Date.now() - state.lastInjectedAt < config.cooldown_ms) {
        const remaining = config.cooldown_ms - (Date.now() - state.lastInjectedAt)
        log.info("within cooldown, deferring injection", {
          trigger,
          cooldownMs: config.cooldown_ms,
          sinceLastInjectionMs: Date.now() - state.lastInjectedAt,
          deferMs: remaining,
        })
        state.deferredTimer = setTimeout(() => {
          state.deferredTimer = undefined
          void injectContinuation(sessionID, "cooldown-deferred")
        }, remaining)
        return
      }

      await injectContinuation(sessionID, trigger)
    },

    onSessionDeleted(sessionID: string): void {
      logger.info("session deleted, clearing state", { sessionID })
      ownership.delete(sessionID)
      sessionStateStore.cleanup(sessionID)
    },
  }
}