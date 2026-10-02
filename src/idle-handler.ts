import type { Plugin } from "@opencode/plugin"
import type { PluginConfig, SessionState } from "./types.js"
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
  /** Set when the assistant message carries an error (failed turn). */
  error: string | undefined
  /** True once the host has stamped the message as completed. */
  completed: boolean
  /** A tool call that never reached completed/error, i.e. work left hanging. */
  hasUnresolvedTool: boolean
  /** Any visible text or tool call; reasoning alone does not count. */
  hasOutput: boolean
  /** A user message sits after the last assistant message (a turn is queued). */
  userMessagePending: boolean
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

/** How often to re-read the session while waiting for `finish` to appear. */
const SETTLE_POLL_MS = 100

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

function hasToolCall(content: unknown): boolean {
  return Array.isArray(content) && content.some((p) => (p as { type?: unknown })?.type === "tool")
}

function hasUnresolvedToolCall(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some((p) => {
    if ((p as { type?: unknown })?.type !== "tool") return false
    const status = (p as { state?: { status?: unknown } }).state?.status
    return status !== "completed" && status !== "error"
  })
}

function errorText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  const message = (value as { message?: unknown }).message
  return typeof message === "string" ? message : "error"
}

const EMPTY_CONTEXT: ResolvedContext = {
  messageId: undefined,
  agent: undefined,
  model: undefined,
  finish: undefined,
  rawFinish: undefined,
  error: undefined,
  completed: false,
  hasUnresolvedTool: false,
  hasOutput: false,
  userMessagePending: false,
  excerpt: undefined,
}

function resolveLastAssistantContext(messages: SessionMessage[]): ResolvedContext {
  let userMessagePending = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type === "user") userMessagePending = true
    if (msg.type !== "assistant") continue

    const full = textFromContent(msg.content).trim()
    const raw = msg as unknown as {
      finish?: unknown
      rawFinish?: unknown
      error?: unknown
      time?: { completed?: unknown }
    }
    return {
      messageId: msg.id,
      agent: msg.agent,
      model: msg.model ? { providerID: msg.model.providerID, id: msg.model.id } : undefined,
      finish: typeof raw.finish === "string" && raw.finish.length > 0 ? raw.finish : undefined,
      rawFinish: typeof raw.rawFinish === "string" ? raw.rawFinish : undefined,
      error: errorText(raw.error),
      completed: typeof raw.time?.completed === "number",
      hasUnresolvedTool: hasUnresolvedToolCall(msg.content),
      hasOutput: full.length > 0 || hasToolCall(msg.content),
      userMessagePending,
      excerpt: full.length > 0 ? full.slice(0, EXCERPT_LIMIT) : undefined,
    }
  }
  return EMPTY_CONTEXT
}

/**
 * Whether the host has finished writing the last assistant message. The
 * execution event can be delivered before the message projection catches up,
 * in which case `finish` is still absent even though the turn ended with a
 * clean stop. Judging that snapshot is what made finished sessions look
 * stalled.
 */
function isSettled(ctx: ResolvedContext): boolean {
  return ctx.finish !== undefined || ctx.error !== undefined || ctx.completed
}

type Verdict = { continue: boolean; reason: string }

/**
 * Decide whether the last assistant turn is a genuine stall. Anything that is
 * not positively identified as a stall is left alone: a spurious "continue"
 * on a finished task is worse than a missed recovery.
 */
function classify(
  ctx: ResolvedContext,
  policy: "always" | "unfinished",
  continueOnMissingFinish: boolean,
): Verdict {
  // A failed turn is never retried blindly, whatever the policy.
  if (ctx.error) return { continue: false, reason: "assistant message carries an error" }
  if (policy === "always") return { continue: true, reason: "trigger_policy=always" }

  if (ctx.finish) {
    const finish = ctx.finish.toLowerCase()
    if (UNFINISHED_FINISHES.has(finish)) return { continue: true, reason: `finish=${finish}` }
    // A clean stop with nothing produced is not a deliberate end of work.
    if (finish === "stop" && !ctx.hasOutput) {
      return { continue: true, reason: "finish=stop but the turn produced no output" }
    }
    return { continue: false, reason: `finish=${finish}` }
  }

  // No finish reason, even after waiting for the host to write it.
  if (ctx.hasUnresolvedTool) return { continue: true, reason: "tool call left unresolved" }
  if (continueOnMissingFinish) return { continue: true, reason: "no finish reason (continue_on_missing_finish)" }
  return { continue: false, reason: "no finish reason; not provably stalled" }
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

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  /**
   * Read the session and wait (bounded) for the last assistant message to be
   * fully written. Returns the freshest snapshot, settled or not.
   */
  async function readSettled(
    sessionID: string,
    settleMs: number,
  ): Promise<{ messages: SessionMessage[]; assistant: ResolvedContext; waitedMs: number }> {
    const started = Date.now()
    for (;;) {
      const messages = [...(await ctx.session.context({ sessionID }))]
      const assistant = resolveLastAssistantContext(messages)
      const waitedMs = Date.now() - started
      if (!assistant.messageId || isSettled(assistant) || waitedMs >= settleMs) {
        return { messages, assistant, waitedMs }
      }
      await sleep(Math.min(SETTLE_POLL_MS, Math.max(settleMs - waitedMs, 1)))
    }
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

    // Held for the whole evaluation, not just the prompt call, so two triggers
    // for the same turn (execution.succeeded + session.idle, or a deferred
    // timer) cannot both pass the checks while one is still waiting on I/O.
    if (state.inFlight) {
      log.info("skip: injection already in flight", snapshot)
      return
    }
    state.inFlight = true
    try {
      await evaluateAndInject(sessionID, trigger, config, state, snapshot, log)
    } finally {
      state.inFlight = false
    }
  }

  async function evaluateAndInject(
    sessionID: string,
    trigger: IdleTrigger,
    config: PluginConfig,
    state: SessionState,
    snapshot: { trigger: IdleTrigger; consecutiveCount: number; lastInjectedAt: number | undefined },
    log: Logger,
  ): Promise<void> {
    if (state.consecutiveCount >= config.max_consecutive) {
      log.info("skip: consecutive cap reached", { ...snapshot, max_consecutive: config.max_consecutive })
      return
    }

    let messages: SessionMessage[]
    let assistantCtx: ResolvedContext
    try {
      const read = await readSettled(sessionID, Math.max(0, config.settle_ms))
      messages = read.messages
      assistantCtx = read.assistant
      if (read.waitedMs > 0) {
        log.debug("waited for assistant message to settle", {
          waitedMs: read.waitedMs,
          settled: isSettled(assistantCtx),
        })
      }
    } catch (error) {
      log.warn("skip: session.context failed", { ...snapshot, error })
      return
    }

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

    // A user message after the last assistant reply means a turn is already
    // queued or starting (including our own earlier "continue"). The session
    // is not stalled, it is about to work.
    if (assistantCtx.userMessagePending) {
      log.info("skip: user message is already waiting after the last assistant message", {
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

    // Distinguish a genuine stall from a task that finished normally.
    const verdict = classify(assistantCtx, config.trigger_policy, config.continue_on_missing_finish)
    if (!verdict.continue) {
      log.info("skip: last assistant turn is not a stall", {
        ...snapshot,
        reason: verdict.reason,
        finish: assistantCtx.finish,
        rawFinish: assistantCtx.rawFinish,
        completed: assistantCtx.completed,
        trigger_policy: config.trigger_policy,
      })
      return
    }

    // The busy set is maintained from execution events on the same ordered
    // stream. It closes the race window opened by cooldown deferral and by
    // the settle wait above.
    if (isBusy(sessionID)) {
      log.info("skip: session became busy again before injection", snapshot)
      return
    }

    log.info("injecting continuation", {
      ...snapshot,
      message: config.message,
      agent,
      model: assistantCtx.model ? `${assistantCtx.model.providerID}/${assistantCtx.model.id}` : undefined,
      assistantMessageId: assistantCtx.messageId,
      reason: verdict.reason,
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
      // The switch calls above yield; a turn the user started meanwhile must
      // not receive a stray "continue".
      if (isBusy(sessionID)) {
        log.info("skip: session became busy again before injection", snapshot)
        return
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