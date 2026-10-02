import { existsSync, readFileSync } from "fs"
import { isAbsolute, join, resolve } from "path"
import { type PluginConfig, type TriggerPolicy, DEFAULT_CONFIG } from "./types.js"
import { DEFAULT_LOG_FILENAME, LEGACY_LOG_FILENAME, isLogLevel, normalizeLogLevel } from "./logger.js"

// New names first; legacy pre-rename names are still honored so existing
// checkouts keep working without any change.
const CONFIG_FILENAMES = [
  "opencode2-autocontinue.json",
  "opencode2-autocontinue.jsonc",
  "auto-continue.json",
  "auto-continue.jsonc",
]

function normalizeTriggerPolicy(value: unknown, fallback: TriggerPolicy): TriggerPolicy {
  return value === "always" || value === "unfinished" ? value : fallback
}

function isTriggerPolicy(value: unknown): value is TriggerPolicy {
  return value === "always" || value === "unfinished"
}

/** Where each setting came from, so the log can explain why a value was chosen. */
export type ConfigSource = "options" | "file" | "default"

export type ResolvedConfig = {
  config: PluginConfig
  /** The `.opencode/opencode2-autocontinue.json(c)` that was read, if any. */
  configFile: string | null
  sources: Record<keyof PluginConfig, ConfigSource>
  /** Set when the config file existed but could not be parsed. */
  configParseError?: string
}

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
  return JSON.parse(stripJsonComments(readFileSync(filePath, "utf-8"))) as Partial<PluginConfig>
}

/**
 * A project-local log file is honoured when present, so a repo can keep its own
 * history. Otherwise records go to the shared host log.
 */
function findLocalLogFile(directory: string): string | undefined {
  const candidate = join(directory, ".opencode", DEFAULT_LOG_FILENAME)
  if (existsSync(candidate)) return candidate
  // Pre-rename log, honored so an existing repo keeps its own history.
  const legacy = join(directory, ".opencode", LEGACY_LOG_FILENAME)
  return existsSync(legacy) ? legacy : undefined
}

function normalizeOptions(options?: { readonly [key: string]: unknown }): Partial<PluginConfig> {
  if (!options) return {}
  const out: Partial<PluginConfig> = {}
  if (typeof options.enabled === "boolean") out.enabled = options.enabled
  if (typeof options.message === "string") out.message = options.message
  if (typeof options.cooldown_ms === "number") out.cooldown_ms = options.cooldown_ms
  if (typeof options.max_consecutive === "number") out.max_consecutive = options.max_consecutive
  if (typeof options.settle_ms === "number" && Number.isFinite(options.settle_ms)) out.settle_ms = options.settle_ms
  if (typeof options.continue_on_missing_finish === "boolean") {
    out.continue_on_missing_finish = options.continue_on_missing_finish
  }
  // Enumerated options are only recorded when actually valid. Coercing a bad
  // value to the default here would let it override a good value from the
  // project file, since precedence is decided by presence.
  if (isTriggerPolicy(options.trigger_policy)) out.trigger_policy = options.trigger_policy
  if (isLogLevel(options.log_level)) out.log_level = options.log_level
  if (typeof options.log_path === "string" && options.log_path.length > 0) {
    out.log_path = options.log_path
  }
  if (typeof options.log_console === "boolean") out.log_console = options.log_console
  if (typeof options.log_max_bytes === "number") out.log_max_bytes = options.log_max_bytes
  return out
}

export function resolveConfig(
  directory: string,
  options?: { readonly [key: string]: unknown },
): ResolvedConfig {
  let fileConfig: Partial<PluginConfig> = {}
  let configParseError: string | undefined
  const configFile = findConfigFile(directory)
  if (configFile) {
    try {
      fileConfig = parseConfigFile(configFile)
    } catch (error) {
      fileConfig = {}
      configParseError = error instanceof Error ? error.message : String(error)
    }
  }

  const overrides = normalizeOptions(options)

  const pick = <K extends keyof PluginConfig>(key: K): PluginConfig[K] => {
    if (overrides[key] !== undefined) return overrides[key] as PluginConfig[K]
    if (fileConfig[key] !== undefined) return fileConfig[key] as PluginConfig[K]
    return DEFAULT_CONFIG[key]
  }

  const sourceFor = (key: keyof PluginConfig): ConfigSource => {
    if (overrides[key] !== undefined) return "options"
    if (fileConfig[key] !== undefined) return "file"
    return "default"
  }

  const logPathRaw = pick("log_path")
  const config: PluginConfig = {
    enabled: pick("enabled"),
    message: pick("message"),
    cooldown_ms: pick("cooldown_ms"),
    max_consecutive: pick("max_consecutive"),
    settle_ms: pick("settle_ms"),
    continue_on_missing_finish: pick("continue_on_missing_finish"),
    trigger_policy: normalizeTriggerPolicy(pick("trigger_policy"), DEFAULT_CONFIG.trigger_policy),
    log_level: normalizeLogLevel(pick("log_level"), DEFAULT_CONFIG.log_level),
    log_path:
      logPathRaw === undefined
        ? findLocalLogFile(directory)
        : isAbsolute(logPathRaw)
          ? logPathRaw
          : resolve(directory, logPathRaw),
    log_console: pick("log_console"),
    log_max_bytes: pick("log_max_bytes"),
  }

  const sources = Object.fromEntries(
    (Object.keys(DEFAULT_CONFIG) as Array<keyof PluginConfig>).map((key) => [
      key,
      sourceFor(key),
    ]),
  ) as Record<keyof PluginConfig, ConfigSource>

  return {
    config,
    configFile,
    sources,
    ...(configParseError === undefined ? {} : { configParseError }),
  }
}

export function loadConfig(
  directory: string,
  options?: { readonly [key: string]: unknown },
): PluginConfig {
  return resolveConfig(directory, options).config
}