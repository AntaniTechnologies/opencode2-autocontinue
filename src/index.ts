import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "./config"
import { createSessionStateStore } from "./session-state"
import { createIdleHandler } from "./idle-handler"

const AutoContinuePlugin: Plugin = async (ctx) => {
  const config = loadConfig(ctx.directory)
  const sessionStateStore = createSessionStateStore()
  const idleHandler = createIdleHandler({ ctx, config, sessionStateStore })

  return {
    event: idleHandler,
  }
}

export default AutoContinuePlugin
