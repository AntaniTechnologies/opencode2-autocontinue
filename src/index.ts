import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "./config"
import { createSessionStateStore } from "./session-state"
import { createIdleHandler } from "./idle-handler"

const AutoContinuePlugin: Plugin = async (ctx) => {
  const sessionStateStore = createSessionStateStore()
  const getConfig = () => loadConfig(ctx.directory)
  const idleHandler = createIdleHandler({ ctx, getConfig, sessionStateStore })

  return {
    event: idleHandler,
  }
}

export default AutoContinuePlugin
