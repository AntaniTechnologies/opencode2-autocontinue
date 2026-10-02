import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const calls: string[] = []
let prompts: Array<Record<string, unknown>> = []

// Real context order is chronological: the user prompt, then the assistant
// reply. `finish` defaults to "length" (a stall); pass null to omit it.
function makeMessages(withAssistant: boolean, lastUserText: string, finish: string | null = "length", extra: Record<string, unknown> = {}) {
  const msgs: Array<Record<string, unknown>> = [{ type: "user", id: "msg_user_1", text: lastUserText }]
  if (withAssistant) {
    msgs.push({
      type: "assistant",
      id: "msg_assistant_1",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
      content: [{ type: "text", text: "done" }],
      ...(finish ? { finish } : {}),
      ...extra,
    })
  }
  return msgs
}

function makeCtx(directory: string, messages: Array<Record<string, unknown>>, options: Record<string, unknown> = {}) {
  const queue: any[] = []
  const controller = new AbortController()
  let notify: (() => void) | undefined

  // Keep test output readable and stop tests from writing into the real log.
  const opts: Record<string, unknown> = {
    log_console: false,
    log_path: join(directory, "opencode2-autocontinue.log"),
    ...options,
  }

  const session: any = {
    async context() {
      calls.push("session.context")
      return messages
    },
    // Sessions carry the directory they belong to; the handler uses it to
    // avoid injecting into another project's session.
    async get(i: any) {
      calls.push(`session.get:${i.sessionID}`)
      return { id: i.sessionID, projectID: "p", location: { directory } }
    },
    async switchAgent(i: any) {
      calls.push(`switchAgent:${i.agent}`)
    },
    async switchModel(i: any) {
      calls.push(`switchModel:${i.model?.providerID}/${i.model?.id}`)
    },
    async prompt(i: any) {
      calls.push(`prompt:${i.text}`)
      prompts.push(i)
      return {}
    },
  }

  const ctx: any = {
    app: { version: "2.0.22" },
    location: { directory, project: { id: "p", directory, canonical: directory } },
    options: opts,
    session,
    event: {
      subscribe() {
        return {
          [Symbol.asyncIterator]() {
            let i = 0
            return {
              async next() {
                while (i >= queue.length) {
                  await new Promise<void>((r) => {
                    notify = r
                    controller.signal.addEventListener("abort", () => r(), { once: true })
                  })
                }
                return { value: queue[i++], done: false }
              },
              async return() {
                return { value: undefined, done: true }
              },
            }
          },
        }
      },
    },
  }

  return {
    ctx,
    session,
    push(...events: any[]) {
      queue.push(...events)
      notify?.()
    },
    async cleanup() {
      controller.abort()
    },
  }
}

const enabledDir = mkdtempSync(join(tmpdir(), "ac-on-"))
mkdirSync(join(enabledDir, ".opencode"), { recursive: true })
writeFileSync(join(enabledDir, ".opencode", "opencode2-autocontinue.json"), JSON.stringify({ enabled: true }))

const disabledDir = mkdtempSync(join(tmpdir(), "ac-off-"))
mkdirSync(join(disabledDir, ".opencode"), { recursive: true })
writeFileSync(join(disabledDir, ".opencode", "opencode2-autocontinue.json"), JSON.stringify({ enabled: false }))

const plugin = (await import("../dist/index.js")).default
const tick = () => new Promise((r) => setTimeout(r, 250))
const reset = () => {
  calls.length = 0
  prompts = []
}
let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

console.log("case 1: assistant replied then session.idle -> expect 1 injection")
{
  reset()
  const h = makeCtx(enabledDir, makeMessages(true, "do the thing"), { enabled: true })
  const cleanup = await plugin.setup(h.ctx)
  h.push(
    { type: "session.execution.started", data: { sessionID: "ses_1" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
    { type: "session.idle", data: { sessionID: "ses_1" } },
  )
  await tick()
  console.log("  calls:", JSON.stringify(calls))
  check("injections", prompts.length, 1)
  check("prompt text", prompts[0]?.text, "continue")
  check("sessionID", prompts[0]?.sessionID, "ses_1")
  await cleanup?.()
}

console.log("case 2: repeated idle, unchanged assistant msg -> expect no duplicate")
{
  reset()
  const h = makeCtx(enabledDir, makeMessages(true, "do the thing"), { enabled: true })
  const cleanup = await plugin.setup(h.ctx)
  h.push(
    { type: "session.execution.started", data: { sessionID: "ses_2" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_2" } },
    { type: "session.idle", data: { sessionID: "ses_2" } },
  )
  await tick()
  h.session.context = async () => [...makeMessages(true, "do the thing"), { type: "user", id: "u2", text: "continue" }]
  h.push({ type: "session.idle", data: { sessionID: "ses_2" } })
  await tick()
  check("injections after 2nd idle", prompts.length, 1)
  await cleanup?.()
}

console.log("case 3: no assistant message -> expect 0 injections")
{
  reset()
  const h = makeCtx(enabledDir, [{ type: "user", id: "u1", text: "hi" }])
  const cleanup = await plugin.setup(h.ctx)
  h.push({ type: "session.idle", data: { sessionID: "ses_3" } })
  await tick()
  check("injections", prompts.length, 0)
  await cleanup?.()
}

console.log("case 4: disabled in config file -> expect 0 injections")
{
  reset()
  const h = makeCtx(disabledDir, makeMessages(true, "go"), {})
  const cleanup = await plugin.setup(h.ctx)
  h.push(
    { type: "session.execution.started", data: { sessionID: "ses_4" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_4" } },
    { type: "session.idle", data: { sessionID: "ses_4" } },
  )
  await tick()
  check("injections", prompts.length, 0)
  await cleanup?.()
}

console.log("case 5: agent/model continuity -> expect switchAgent+switchModel before prompt")
{
  reset()
  const h = makeCtx(enabledDir, makeMessages(true, "go"), { enabled: true })
  const cleanup = await plugin.setup(h.ctx)
  h.push(
    { type: "session.execution.started", data: { sessionID: "ses_5" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_5" } },
    { type: "session.idle", data: { sessionID: "ses_5" } },
  )
  await tick()
  console.log("  call order:", JSON.stringify(calls))
  check("switchAgent", calls.includes("switchAgent:build"), true)
  check("switchModel", calls.includes("switchModel:anthropic/claude-sonnet-4-5"), true)
  await cleanup?.()
}

console.log("case 6: max_consecutive cap -> expect injection to stop at cap")
{
  reset()
  const dir3 = mkdtempSync(join(tmpdir(), "ac-cap-"))
  mkdirSync(join(dir3, ".opencode"), { recursive: true })
  writeFileSync(
    join(dir3, ".opencode", "opencode2-autocontinue.json"),
    JSON.stringify({ enabled: true, cooldown_ms: 0, max_consecutive: 2 }),
  )
  const h = makeCtx(dir3, makeMessages(true, "go"), {})
  const cleanup = await plugin.setup(h.ctx)
  for (let n = 1; n <= 5; n++) {
    const id = `msg_assistant_${n}`
    h.session.context = async () => [
      { type: "user", id: "u_0", text: "go" },
      { type: "assistant", id: "a_0", agent: "build", model: { providerID: "anthropic", id: "claude-sonnet-4-5" }, content: [{ type: "text", text: "x" }], finish: "length" },
      { type: "user", id: `u_${n}`, text: "continue" },
      {
        type: "assistant",
        id,
        agent: "build",
        model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
        content: [{ type: "text", text: "x" }],
        finish: "length",
      },
    ]
    h.push({ type: "session.idle", data: { sessionID: "ses_6" } })
    await tick()
  }
  check("injections with max_consecutive=2", prompts.length, 2)
  await cleanup?.()
}

console.log("case 7: logging records project, session, and injection -> expect readable log lines")
{
  reset()
  const dir4 = mkdtempSync(join(tmpdir(), "ac-log-"))
  mkdirSync(join(dir4, ".opencode"), { recursive: true })
  writeFileSync(
    join(dir4, ".opencode", "opencode2-autocontinue.json"),
    JSON.stringify({ enabled: true, cooldown_ms: 0, log_level: "debug" }),
  )
  const h = makeCtx(dir4, makeMessages(true, "go"), {})
  const cleanup = await plugin.setup(h.ctx)
  h.push(
    { type: "session.execution.started", data: { sessionID: "ses_7" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_7" } },
    { type: "session.idle", data: { sessionID: "ses_7" } },
  )
  await tick()
  await cleanup?.()

  const logFile = join(dir4, "opencode2-autocontinue.log")
  const lines = existsSync(logFile)
    ? readFileSync(logFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l))
    : []
  check("log file created", existsSync(logFile), true)
  check("every line is JSON", lines.every((l) => typeof l.msg === "string"), true)
  check("lines carry the project directory", lines.every((l) => l.project === dir4), true)

  const injected = lines.find((l) => l.msg === "continuation injected")
  check("injection logged", injected !== undefined, true)
  check("injection records sessionID", injected?.sessionID, "ses_7")
  check("injection records consecutive count", injected?.consecutiveCount, 1)
  check("injection records trigger on the preceding record", lines.find((l) => l.msg === "injecting continuation")?.trigger, "session.execution.succeeded")
  check("startup records the resolved log file", lines[0]?.logFile, logFile)
}

console.log("case 8: log_level off -> expect no log file written")
{
  reset()
  const dir5 = mkdtempSync(join(tmpdir(), "ac-quiet-"))
  mkdirSync(join(dir5, ".opencode"), { recursive: true })
  writeFileSync(
    join(dir5, ".opencode", "opencode2-autocontinue.json"),
    JSON.stringify({ enabled: true, cooldown_ms: 0, log_level: "off" }),
  )
  const h = makeCtx(dir5, makeMessages(true, "go"), {})
  const cleanup = await plugin.setup(h.ctx)
  h.push({ type: "session.idle", data: { sessionID: "ses_8" } })
  await tick()
  await cleanup?.()
  check("injection still happens while logging is off", prompts.length, 1)
  check("no log file", existsSync(join(dir5, "opencode2-autocontinue.log")), false)
}

console.log("case 9: execution.succeeded alone -> expect injection (the session.idle regression)")
{
  reset()
  const dir6 = mkdtempSync(join(tmpdir(), "ac-exec-"))
  mkdirSync(join(dir6, ".opencode"), { recursive: true })
  writeFileSync(
    join(dir6, ".opencode", "opencode2-autocontinue.json"),
    JSON.stringify({ enabled: true, cooldown_ms: 0 }),
  )
  const h = makeCtx(dir6, makeMessages(true, "go"), {})
  const cleanup = await plugin.setup(h.ctx)
  // No session.idle at all: this is exactly what a live stalled session did.
  h.push(
    { type: "session.execution.started", data: { sessionID: "ses_9" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_9" } },
  )
  await tick()
  check("injections", prompts.length, 1)
  check("prompt text", prompts[0]?.text, "continue")
  await cleanup?.()
}

console.log("case 10: execution.failed / interrupted -> expect no injection")
{
  reset()
  const dir7 = mkdtempSync(join(tmpdir(), "ac-fail-"))
  mkdirSync(join(dir7, ".opencode"), { recursive: true })
  writeFileSync(
    join(dir7, ".opencode", "opencode2-autocontinue.json"),
    JSON.stringify({ enabled: true, cooldown_ms: 0 }),
  )
  const h = makeCtx(dir7, makeMessages(true, "go"), {})
  const cleanup = await plugin.setup(h.ctx)
  h.push(
    { type: "session.execution.started", data: { sessionID: "ses_10" } },
    { type: "session.execution.failed", data: { sessionID: "ses_10" } },
    { type: "session.execution.interrupted", data: { sessionID: "ses_11" } },
  )
  await tick()
  check("injections", prompts.length, 0)
  await cleanup?.()
}

console.log("case 11: session from another project -> expect no injection")
{
  reset()
  const dir8 = mkdtempSync(join(tmpdir(), "ac-owner-"))
  mkdirSync(join(dir8, ".opencode"), { recursive: true })
  writeFileSync(
    join(dir8, ".opencode", "opencode2-autocontinue.json"),
    JSON.stringify({ enabled: true, cooldown_ms: 0 }),
  )
  const h = makeCtx(dir8, makeMessages(true, "go"), {})
  // Every plugin instance sees every session, so a session living in another
  // directory must be ignored rather than continued by this instance.
  h.session.get = async (i: any) => ({
    id: i.sessionID,
    projectID: "other",
    location: { directory: "C:\\somewhere\\else" },
  })
  const cleanup = await plugin.setup(h.ctx)
  h.push(
    { type: "session.execution.started", data: { sessionID: "ses_12" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_12" } },
  )
  await tick()
  check("injections", prompts.length, 0)
  await cleanup?.()
}

console.log("case 12: finish=stop -> expect NO injection (task completed normally)")
{
  reset()
  const dir9 = mkdtempSync(join(tmpdir(), "ac-stop-"))
  mkdirSync(join(dir9, ".opencode"), { recursive: true })
  writeFileSync(
    join(dir9, ".opencode", "opencode2-autocontinue.json"),
    JSON.stringify({ enabled: true, cooldown_ms: 0 }),
  )
  const h = makeCtx(dir9, makeMessages(true, "go", "stop"), {})
  const cleanup = await plugin.setup(h.ctx)
  h.push(
    { type: "session.execution.started", data: { sessionID: "ses_13" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_13" } },
  )
  await tick()
  check("injections", prompts.length, 0)
  await cleanup?.()
}

console.log("case 13: finish=length -> expect injection (stalled on token cap)")
{
  reset()
  const dir10 = mkdtempSync(join(tmpdir(), "ac-len-"))
  mkdirSync(join(dir10, ".opencode"), { recursive: true })
  writeFileSync(
    join(dir10, ".opencode", "opencode2-autocontinue.json"),
    JSON.stringify({ enabled: true, cooldown_ms: 0 }),
  )
  const h = makeCtx(dir10, makeMessages(true, "go", "length"), {})
  const cleanup = await plugin.setup(h.ctx)
  h.push(
    { type: "session.execution.started", data: { sessionID: "ses_14" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_14" } },
  )
  await tick()
  check("injections", prompts.length, 1)

  const logFile = join(dir10, "opencode2-autocontinue.log")
  const lines = readFileSync(logFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l))
  const rec = lines.find((l) => l.msg === "injecting continuation")
  check("finish logged", rec?.finish, "length")
  check("last assistant text logged", rec?.lastAssistantText, "done")
  await cleanup?.()
}

console.log("case 14: trigger_policy=always -> expect injection even on finish=stop")
{
  reset()
  const dir11 = mkdtempSync(join(tmpdir(), "ac-always-"))
  mkdirSync(join(dir11, ".opencode"), { recursive: true })
  writeFileSync(
    join(dir11, ".opencode", "opencode2-autocontinue.json"),
    JSON.stringify({ enabled: true, cooldown_ms: 0, trigger_policy: "always" }),
  )
  const h = makeCtx(dir11, makeMessages(true, "go", "stop"), {})
  const cleanup = await plugin.setup(h.ctx)
  h.push(
    { type: "session.execution.started", data: { sessionID: "ses_15" } },
    { type: "session.execution.succeeded", data: { sessionID: "ses_15" } },
  )
  await tick()
  check("injections", prompts.length, 1)
  await cleanup?.()
}

console.log("case 15: invalid option value must not clobber the project file")
{
  const dir12 = mkdtempSync(join(tmpdir(), "ac-precedence-"))
  mkdirSync(join(dir12, ".opencode"), { recursive: true })
  writeFileSync(
    join(dir12, ".opencode", "opencode2-autocontinue.json"),
    JSON.stringify({ enabled: true, trigger_policy: "always" }),
  )
  // A bad value in the higher-precedence layer must be ignored outright, not
  // coerced to the default, or it would override the project file.
  const { resolveConfig } = await import("../dist/config.js")
  const r = resolveConfig(dir12, { enabled: true, trigger_policy: "sometimes", log_level: "loud" })
  check("project file policy survives bad option", r.config.trigger_policy, "always")
  check("policy source", r.sources.trigger_policy, "file")
  check("bad log_level falls back to default", r.config.log_level, "info")

  // A valid explicit option must still win over the project file.
  const r2 = resolveConfig(dir12, { enabled: true, trigger_policy: "unfinished" })
  check("valid option wins over file", r2.config.trigger_policy, "unfinished")
  check("policy source", r2.sources.trigger_policy, "options")

  // Wrong-typed scalars are ignored rather than coerced.
  const r3 = resolveConfig(dir12, { enabled: true, cooldown_ms: "fast", message: 5 })
  check("bad cooldown ignored", r3.config.cooldown_ms, 10000)
  check("bad message ignored", r3.config.message, "continue")
}


function mkDir(cfg: Record<string, unknown>, tag: string) {
  const d = mkdtempSync(join(tmpdir(), `ac-${tag}-`))
  mkdirSync(join(d, ".opencode"), { recursive: true })
  writeFileSync(join(d, ".opencode", "opencode2-autocontinue.json"), JSON.stringify({ enabled: true, cooldown_ms: 0, ...cfg }))
  return d
}
async function runTurn(dir: string, messages: any, sid: string, wait = 600, mutate?: (h: any) => void) {
  reset()
  const h = makeCtx(dir, messages, {})
  mutate?.(h)
  const cleanup = await plugin.setup(h.ctx)
  h.push(
    { type: "session.execution.started", data: { sessionID: sid } },
    { type: "session.execution.succeeded", data: { sessionID: sid } },
  )
  await new Promise((r) => setTimeout(r, wait))
  await cleanup?.()
  return h
}

console.log("case 16: finish never present (cleanly ended turn, no finish field) -> expect NO injection")
{
  await runTurn(mkDir({ settle_ms: 200 }, "nofin"), makeMessages(true, "go", null), "ses_16")
  check("injections", prompts.length, 0)
}

console.log("case 17: finish arrives late as stop (event outran projection) -> expect NO injection")
{
  let reads = 0
  await runTurn(mkDir({ settle_ms: 1500 }, "late-stop"), [], "ses_17", 1200, (h) => {
    h.session.context = async () => (++reads < 4 ? makeMessages(true, "go", null) : makeMessages(true, "go", "stop"))
  })
  check("injections", prompts.length, 0)
  check("it did wait and re-read", reads >= 4, true)
}

console.log("case 18: finish arrives late as length -> expect injection")
{
  let reads = 0
  await runTurn(mkDir({ settle_ms: 1500 }, "late-len"), [], "ses_18", 1200, (h) => {
    h.session.context = async () => (++reads < 3 ? makeMessages(true, "go", null) : makeMessages(true, "go", "length"))
  })
  check("injections", prompts.length, 1)
}

console.log("case 19: assistant message with error + finish=length -> expect NO injection")
{
  await runTurn(mkDir({}, "err"), makeMessages(true, "go", "length", { error: { message: "boom" } }), "ses_19")
  check("injections", prompts.length, 0)
}

console.log("case 20: no finish but a tool call left running -> expect injection")
{
  const msgs = makeMessages(true, "go", null, { content: [{ type: "tool", id: "t1", name: "bash", state: { status: "running" } }] })
  await runTurn(mkDir({ settle_ms: 200 }, "tool"), msgs, "ses_20")
  check("injections", prompts.length, 1)
}

console.log("case 21: continue_on_missing_finish=true and no finish -> expect injection")
{
  await runTurn(mkDir({ settle_ms: 200, continue_on_missing_finish: true }, "miss"), makeMessages(true, "go", null), "ses_21")
  check("injections", prompts.length, 1)
}

console.log("case 22: finish=stop with an empty turn -> expect injection; stop with text -> none")
{
  await runTurn(mkDir({}, "empty"), makeMessages(true, "go", "stop", { content: [] }), "ses_22")
  check("empty stop injected", prompts.length, 1)
  await runTurn(mkDir({}, "textstop"), makeMessages(true, "go", "stop"), "ses_22b")
  check("stop with text not injected", prompts.length, 0)
}

console.log("case 23: execution.succeeded + session.idle for one turn -> expect exactly 1 injection")
{
  reset()
  const d = mkDir({ settle_ms: 500 }, "dup")
  const h = makeCtx(d, makeMessages(true, "go"), {})
  const cleanup = await plugin.setup(h.ctx)
  h.push(
    { type: "session.execution.succeeded", data: { sessionID: "ses_23" } },
    { type: "session.idle", data: { sessionID: "ses_23" } },
  )
  await new Promise((r) => setTimeout(r, 600))
  await cleanup?.()
  check("injections", prompts.length, 1)
}

console.log("case 24: user message already queued after last assistant -> expect NO injection")
{
  const msgs = [...makeMessages(true, "go"), { type: "user", id: "u_next", text: "also do X" }]
  await runTurn(mkDir({}, "queued"), msgs, "ses_24")
  check("injections", prompts.length, 0)
}

console.log("case 25: session goes busy during the settle wait -> expect NO injection")
{
  reset()
  const d = mkDir({ settle_ms: 800 }, "busy")
  const h = makeCtx(d, makeMessages(true, "go", null), {})
  const cleanup = await plugin.setup(h.ctx)
  h.push({ type: "session.execution.succeeded", data: { sessionID: "ses_25" } })
  await new Promise((r) => setTimeout(r, 150))
  h.session.context = async () => makeMessages(true, "go", "length")
  h.push({ type: "session.execution.started", data: { sessionID: "ses_25" } })
  await new Promise((r) => setTimeout(r, 1000))
  await cleanup?.()
  check("injections", prompts.length, 0)
}

console.log("case 26: legacy auto-continue.json config is still honored, new name wins")
{
  reset()
  const d = mkdtempSync(join(tmpdir(), "ac-legacy-"))
  mkdirSync(join(d, ".opencode"), { recursive: true })
  writeFileSync(join(d, ".opencode", "auto-continue.json"), JSON.stringify({ enabled: true }))
  const { resolveConfig } = await import("../dist/config.js")
  const r = resolveConfig(d, {})
  check("legacy config enables plugin", r.config.enabled, true)
  check("legacy config file detected", r.configFile?.endsWith("auto-continue.json"), true)
  writeFileSync(join(d, ".opencode", "opencode2-autocontinue.json"), JSON.stringify({ enabled: false }))
  const r2 = resolveConfig(d, {})
  check("new config name wins over legacy", r2.config.enabled, false)
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)