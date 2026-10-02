import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const calls: string[] = []
let prompts: Array<Record<string, unknown>> = []

function makeMessages(withAssistant: boolean, lastUserText: string) {
  const msgs: Array<Record<string, unknown>> = []
  if (withAssistant) {
    msgs.push({
      type: "assistant",
      id: "msg_assistant_1",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
      content: [{ type: "text", text: "done" }],
    })
  }
  msgs.push({ type: "user", id: "msg_user_1", text: lastUserText })
  return msgs
}

function makeCtx(directory: string, messages: Array<Record<string, unknown>>, options: Record<string, unknown> = {}) {
  const queue: any[] = []
  const controller = new AbortController()
  let notify: (() => void) | undefined

  const session: any = {
    async context() {
      calls.push("session.context")
      return messages
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
    options,
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
writeFileSync(join(enabledDir, ".opencode", "auto-continue.json"), JSON.stringify({ enabled: true }))

const disabledDir = mkdtempSync(join(tmpdir(), "ac-off-"))
mkdirSync(join(disabledDir, ".opencode"), { recursive: true })
writeFileSync(join(disabledDir, ".opencode", "auto-continue.json"), JSON.stringify({ enabled: false }))

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
  h.session.context = async () => makeMessages(true, "continue")
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
    join(dir3, ".opencode", "auto-continue.json"),
    JSON.stringify({ enabled: true, cooldown_ms: 0, max_consecutive: 2 }),
  )
  const h = makeCtx(dir3, makeMessages(true, "continue"), {})
  const cleanup = await plugin.setup(h.ctx)
  for (let n = 1; n <= 5; n++) {
    const id = `msg_assistant_${n}`
    h.session.context = async () => [
      {
        type: "assistant",
        id,
        agent: "build",
        model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
        content: [{ type: "text", text: "x" }],
      },
      { type: "user", id: `u_${n}`, text: "continue" },
    ]
    h.push({ type: "session.idle", data: { sessionID: "ses_6" } })
    await tick()
  }
  check("injections with max_consecutive=2", prompts.length, 2)
  await cleanup?.()
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)