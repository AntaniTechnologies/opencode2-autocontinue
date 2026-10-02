import { Plugin } from "@opencode/plugin"
import { resolveConfig } from "./config.js"
import { createSessionStateStore } from "./session-state.js"
import { createIdleHandler, type PluginEvent } from "./idle-handler.js"
import { createLogger, type Logger } from "./logger.js"

export default Plugin.define({
  id: "auto-continue",
  setup(ctx) {
    const sessionStateStore = createSessionStateStore()

    const getResolved = () => resolveConfig(ctx.location.directory, ctx.options)
    const getConfig = () => getResolved().config

    // Config is re-read on every event so edits to .opencode/auto-continue.json
    // take effect without a restart. Logging settings are sampled once, at
    // startup, because the logger owns a file handle.
    const initial = getResolved()
    const logger: Logger = createLogger({
      directory: ctx.location.directory,
      ...(ctx.location.project?.id ? { projectId: String(ctx.location.project.id) } : {}),
      level: initial.config.log_level,
      ...(initial.config.log_path ? { file: initial.config.log_path } : {}),
      console: initial.config.log_console,
      maxBytes: initial.config.log_max_bytes,
    })

    // V2 does not expose session.status/active on the plugin context, so
    // idleness between the turn ending and injection time is tracked from
    // execution lifecycle events on the same ordered event stream.
    const busy = new Set<string>()
    const handler = createIdleHandler({
      ctx,
      getConfig,
      sessionStateStore,
      isBusy: (sessionID) => busy.has(sessionID),
      logger,
    })

    logger.info("plugin loaded", {
      app: `${ctx.app?.name ?? "opencode"} ${ctx.app?.version ?? "unknown"}`,
      enabled: initial.config.enabled,
      config: initial.config,
      sources: initial.sources,
      configFile: initial.configFile,
      ...(initial.configParseError === undefined ? {} : { configParseError: initial.configParseError }),
      logFile: logger.path ?? "disabled",
      triggers: ["session.execution.succeeded", "session.idle"],
    })
    if (initial.configParseError) {
      logger.error("config file could not be parsed, using defaults", {
        configFile: initial.configFile,
        error: initial.configParseError,
      })
    }
    if (!initial.config.enabled) {
      logger.warn("plugin is disabled; set enabled: true to activate auto-continue")
    }

    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const typed = event as unknown as PluginEvent
          const sessionID = typed.data?.sessionID
          switch (typed.type) {
            case "session.execution.started":
              if (sessionID) {
                busy.add(sessionID)
                logger.debug("execution started", { sessionID })
              }
              break
            case "session.execution.succeeded":
              // Primary trigger. The turn completed, so the session is free to
              // accept more work. session.idle is unreliable here, see README.
              if (sessionID) {
                busy.delete(sessionID)
                logger.debug("execution succeeded", { sessionID })
                await handler.onBecameIdle(sessionID, "session.execution.succeeded")
              }
              break
            case "session.execution.failed":
            case "session.execution.interrupted":
              // Busy is cleared, but these do not trigger a continuation: a
              // failure should not be retried blindly, and an interrupt is the
              // user deliberately stopping work.
              if (sessionID) {
                busy.delete(sessionID)
                logger.debug("execution ended without success, not continuing", {
                  sessionID,
                  outcome: typed.type,
                })
              }
              break
            case "session.idle":
              if (!sessionID) {
                logger.warn("session.idle without sessionID")
                break
              }
              busy.delete(sessionID)
              logger.debug("session idle", { sessionID })
              await handler.onBecameIdle(sessionID, "session.idle")
              break
            case "session.deleted":
              if (sessionID) {
                busy.delete(sessionID)
                handler.onSessionDeleted(sessionID)
              }
              break
            default:
              logger.debug("event ignored", { type: typed.type, sessionID })
              break
          }
        }
      } catch (error) {
        // Aborted on unload is the expected path; anything else means the
        // subscription died and auto-continue is now inert.
        if (!controller.signal.aborted) {
          logger.error("event subscription failed, auto-continue is no longer running", { error })
        }
      }
    })()

    return () => {
      logger.info("plugin unloading")
      controller.abort()
      sessionStateStore.dispose()
      busy.clear()
    }
  },
})