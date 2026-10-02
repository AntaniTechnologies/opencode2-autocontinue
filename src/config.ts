import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { type PluginConfig, DEFAULT_CONFIG } from "./types.js"

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

function normalizeOptions(options?: { readonly [key: string]: unknown }): Partial<PluginConfig> {
  if (!options) return {}
  const out: Partial<PluginConfig> = {}
  if (typeof options.enabled === "boolean") out.enabled = options.enabled
  if (typeof options.message === "string") out.message = options.message
  if (typeof options.cooldown_ms === "number") out.cooldown_ms = options.cooldown_ms
  if (typeof options.max_consecutive === "number") out.max_consecutive = options.max_consecutive
  return out
}

export function loadConfig(
  directory: string,
  options?: { readonly [key: string]: unknown },
): PluginConfig {
  let fileConfig: Partial<PluginConfig> = {}
  const configPath = findConfigFile(directory)
  if (configPath) {
    try {
      fileConfig = parseConfigFile(configPath)
    } catch {
      fileConfig = {}
    }
  }

  const optionOverrides = normalizeOptions(options)

  return {
    enabled: optionOverrides.enabled ?? fileConfig.enabled ?? DEFAULT_CONFIG.enabled,
    message: optionOverrides.message ?? fileConfig.message ?? DEFAULT_CONFIG.message,
    cooldown_ms:
      optionOverrides.cooldown_ms ?? fileConfig.cooldown_ms ?? DEFAULT_CONFIG.cooldown_ms,
    max_consecutive:
      optionOverrides.max_consecutive ??
      fileConfig.max_consecutive ??
      DEFAULT_CONFIG.max_consecutive,
  }
}
