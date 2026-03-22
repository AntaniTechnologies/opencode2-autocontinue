import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { type PluginConfig, DEFAULT_CONFIG } from "./types"

const CONFIG_FILENAMES = [
  "auto-continue.json",
  "auto-continue.jsonc",
]

function stripJsonComments(text: string): string {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
}

function findConfigFile(directory: string): string | null {
  for (const filename of CONFIG_FILENAMES) {
    const filePath = join(directory, ".opencode", filename)
    if (existsSync(filePath)) return filePath
  }
  return null
}

function parseConfigFile(filePath: string): Partial<PluginConfig> {
  const raw = readFileSync(filePath, "utf-8")
  const cleaned = stripJsonComments(raw)
  return JSON.parse(cleaned) as Partial<PluginConfig>
}

export function loadConfig(directory: string): PluginConfig {
  const configPath = findConfigFile(directory)
  if (!configPath) return { ...DEFAULT_CONFIG }

  try {
    const parsed = parseConfigFile(configPath)
    return {
      enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
      message: parsed.message ?? DEFAULT_CONFIG.message,
      cooldown_ms: parsed.cooldown_ms ?? DEFAULT_CONFIG.cooldown_ms,
      max_consecutive: parsed.max_consecutive ?? DEFAULT_CONFIG.max_consecutive,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}
