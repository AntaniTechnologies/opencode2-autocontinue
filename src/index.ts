import { Plugin } from "@opencode/plugin"
import { loadConfig } from "./config.js"
import { createSessionStateStore } from "./session-state.js"
import { createIdleHandler, type PluginEvent } from "./idle-handler.js"

export default Plugin.define({
  id: "auto-continue",
  setup(ctx) {
    const sessionStateStore = createSessionStateStore()
    const getConfig = () => loadConfig(ctx.location.directory, ctx.options)

    // V2 does not expose session.status/active on the plugin context, so
    // idleness between the session.idle event and injection time is tracked
    // from execution lifecycle events on the same ordered event stream.
    const busy = new Set<string>()
    const idleHandler = createIdleHandler({
      ctx,
      getConfig,
      sessionStateStore,
      isBusy: (sessionID) => busy.has(sessionID),
    })

    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const typed = event as unknown as PluginEvent
          const sessionID = typed.data?.sessionID
          switch (typed.type) {
            case "session.execution.started":
              if (sessionID) busy.add(sessionID)
              break
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted":
              if (sessionID) busy.delete(sessionID)
              break
            case "session.idle":
              if (sessionID) busy.delete(sessionID)
              await idleHandler(typed)
              break
            case "session.deleted":
              if (sessionID) busy.delete(sessionID)
              await idleHandler(typed)
              break
            default:
              break
          }
        }
      } catch {
        // Aborted on unload.
      }
    })()

    return () => {
      controller.abort()
      sessionStateStore.dispose()
      busy.clear()
    }
  },
})
