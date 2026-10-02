import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "fs"
import { homedir } from "os"
import { dirname, join } from "path"

export type LogLevel = "debug" | "info" | "warn" | "error" | "off"

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 100,
}

export type LogFields = Record<string, unknown>

export type Logger = {
  /** Resolved log file, or undefined when logging is off. */
  readonly path: string | undefined
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** Derive a logger that stamps extra fields onto every record. */
  child(fields: LogFields): Logger
}

export type LoggerOptions = {
  /** Absolute path the project is rooted at. */
  directory: string
  /** Stable project id, when the host exposes one. */
  projectId?: string
  level: LogLevel
  /** Explicit log file path from plugin options or `.opencode/auto-continue.json`. */
  file?: string
  /** Also echo records to stderr. Off by default: the host does not route
   * plugin stderr into its own log, so this only helps when something else is
   * capturing the plugin process output. */
  console: boolean
  /** Rotate once the file passes this size, keeping one previous generation. */
  maxBytes: number
}

export const DEFAULT_LOG_FILENAME = "auto-continue.log"

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && value in LEVEL_RANK
}

export function normalizeLogLevel(value: unknown, fallback: LogLevel = "info"): LogLevel {
  return isLogLevel(value) ? value : fallback
}

function normalizeMaxBytes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 5 * 1024 * 1024
}

/**
 * Records land next to the host's own log when that location can be derived, so
 * they sit alongside the rest of the session history instead of inside the
 * project repo. A project-local `.opencode/auto-continue.log`, when it exists,
 * wins over this; see resolveConfig.
 */
export function defaultLogPath(): string {
  const dataHome = process.env.XDG_DATA_HOME
  const base = dataHome && dataHome.length > 0 ? dataHome : join(homedir(), ".local", "share")
  return join(base, "opencode", "log", DEFAULT_LOG_FILENAME)
}

function rotateIfNeeded(path: string, incomingBytes: number, maxBytes: number): void {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return
  }
  if (size + incomingBytes <= maxBytes) return
  try {
    unlinkSync(`${path}.1`)
  } catch {
    // No previous generation to drop.
  }
  renameSync(path, `${path}.1`)
}

function serializeValue(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  return value
}

function build(
  target: string | undefined,
  rank: number,
  toConsole: boolean,
  maxBytes: number,
  base: LogFields,
): Logger {
  function log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < rank) return

    const record = { time: new Date().toISOString(), level, msg, ...base, ...(fields ?? {}) }
    let line: string
    try {
      line = JSON.stringify(record, serializeValue)
    } catch {
      line = JSON.stringify({ time: record.time, level, msg, note: "unserializable fields" })
    }

    if (target) {
      // Synchronous so records survive the abrupt exits this plugin is meant to
      // help diagnose. Failures are swallowed: logging must not break a session.
      try {
        mkdirSync(dirname(target), { recursive: true })
        rotateIfNeeded(target, line.length + 1, maxBytes)
        appendFileSync(target, `${line}\n`, "utf-8")
      } catch {
        // Ignore unwritable log destinations.
      }
    }
    if (toConsole) {
      try {
        process.stderr.write(`[auto-continue] ${line}\n`)
      } catch {
        // Ignore console write failures.
      }
    }
  }

  const child = (extra: LogFields): Logger =>
    build(target, rank, toConsole, maxBytes, { ...base, ...extra })

  return {
    path: target,
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
    child,
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const rank = LEVEL_RANK[normalizeLogLevel(options.level)]
  const level = normalizeLogLevel(options.level)

  let target: string | undefined
  if (rank < LEVEL_RANK.off) {
    target = options.file && options.file.length > 0 ? options.file : defaultLogPath()
  }

  return build(target, rank, options.console, normalizeMaxBytes(options.maxBytes), {
    plugin: "auto-continue",
    project: options.directory,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  })
}