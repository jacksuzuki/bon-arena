import { test } from "node:test"
import assert from "node:assert/strict"
import { createCustomRunner } from "../src/runners/custom.ts"
import { createClaudeRunner } from "../src/runners/claude.ts"
import { createCodexRunner, findCodexThread } from "../src/runners/codex.ts"
import { createRunnerRegistry } from "../src/runners/index.ts"
import { buildArenaPrompt } from "../src/runners/prompt.ts"
import type { AskInput, RunnerInput } from "../src/runners/types.ts"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const input: RunnerInput = {
  prompt: "PROMPT",
  task: "do it",
  cwd: "/wt",
  branch: "arena/x/gemini",
  arenaId: "x",
  promptPath: "/wt/prompt.md",
  resultsDir: "/results",
}

test("custom runner substitutes template variables and skips stdin when prompt is inline", () => {
  const r = createCustomRunner("gemini", { args: ["--prompt", "{{prompt}}", "--dir", "{{cwd}}"], label: "Gemini" })
  const inv = r.invocation(input)
  assert.deepEqual(inv.args, ["--prompt", "PROMPT", "--dir", "/wt"])
  assert.equal(inv.promptViaStdin, false)
  assert.equal(r.label, "Gemini")
})

test("custom runner without prompt placeholder pipes prompt via stdin", () => {
  const inv = createCustomRunner("x", { command: "x-cli", args: ["run"] }).invocation(input)
  assert.equal(inv.command, "x-cli")
  assert.equal(inv.promptViaStdin, true)
})

test("built-in runners are headless and honour config", () => {
  const claude = createClaudeRunner({ model: "opus", extraArgs: ["--bare"] }).invocation(input)
  assert.ok(claude.args.includes("--dangerously-skip-permissions"))
  assert.ok(claude.args.includes("-p"))
  assert.ok(claude.args.join(" ").includes("--model opus --bare"))
  assert.equal(claude.promptViaStdin, true)
  assert.ok(claude.args.includes('{"autoMemoryEnabled":false}'))
  assert.equal(claude.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1")

  const codex = createCodexRunner({ command: "/opt/codex" }).invocation(input)
  assert.equal(codex.command, "/opt/codex")
  assert.equal(codex.args[0], "exec")
  assert.ok(codex.args.includes("workspace-write"))
  assert.equal(codex.args.at(-1), "-")
})

test("registry exposes built-ins plus custom runners, config overrides built-ins", () => {
  const reg = createRunnerRegistry({ runners: { claude: { label: "Claude Opus" }, gemini: { command: "gemini" } }, verify: {} })
  assert.deepEqual([...reg.keys()], ["claude", "codex", "gemini"])
  assert.equal(reg.get("claude")?.label, "Claude Opus")
})

test("arena prompt embeds the task verbatim after shared rules", () => {
  const p = buildArenaPrompt("Line 1\nLine 2")
  assert.ok(p.startsWith("You are participating in an implementation arena."))
  assert.ok(p.endsWith("TASK:\nLine 1\nLine 2\n"))
  assert.doesNotMatch(p, /refined together with the user/)
})

test("arena prompt marks a refined specification as authoritative", () => {
  const p = buildArenaPrompt("# Spec", { refined: true })
  assert.ok(p.endsWith("TASK:\n# Spec\n"))
  assert.match(p, /specification that was refined together with the user[\s\S]*Treat it as authoritative/)
  assert.equal(buildArenaPrompt("# Spec", { refined: false }), buildArenaPrompt("# Spec"))
})

const askInput: AskInput = { sessionId: "11111111-2222-4333-8444-555555555555", prompt: "Q", promptPath: "/q.md", cwd: "/wt", resultsDir: "/results" }

test("claude runner fixes its session id at launch and resumes it read-only for questions", () => {
  const runner = createClaudeRunner({ model: "opus" })
  const launch = runner.invocation(input)
  const idx = launch.args.indexOf("--session-id")
  assert.ok(idx > 0)
  assert.match(launch.args[idx + 1]!, /^[0-9a-f-]{36}$/)
  assert.equal(launch.sessionId, launch.args[idx + 1])
  assert.notEqual(runner.invocation(input).sessionId, launch.sessionId, "each launch gets its own conversation")
  assert.equal(runner.findSessionId, undefined)

  const ask = runner.askInvocation!(askInput)
  const joined = ask.args.join(" ")
  assert.ok(joined.includes(`-p --resume ${askInput.sessionId} --output-format text`))
  assert.ok(joined.includes("--permission-mode dontAsk"))
  assert.ok(joined.includes("--allowedTools Read,Glob,Grep,"))
  assert.ok(joined.includes("--disallowedTools Edit,Write,MultiEdit,NotebookEdit"))
  assert.ok(!joined.includes("--dangerously-skip-permissions"))
  assert.ok(ask.args.includes('{"autoMemoryEnabled":false}'))
  assert.equal(ask.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1")
  assert.ok(joined.includes("--model opus"))
  assert.equal(ask.promptViaStdin, true)
})

test("codex runner resumes a thread read-only and discovers the thread id from its session store", (t) => {
  const ask = createCodexRunner().askInvocation!(askInput)
  assert.deepEqual(ask.args, ["exec", "resume", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', askInput.sessionId, "-"])
  assert.equal(ask.promptViaStdin, true)

  const sessions = mkdtempSync(join(tmpdir(), "codex-sessions-"))
  t.after(() => rmSync(sessions, { recursive: true, force: true }))
  const day = join(sessions, "2026/09/17")
  mkdirSync(day, { recursive: true })
  const rollout = (name: string, id: string, cwd: string, at: string) =>
    writeFileSync(join(day, name), JSON.stringify({ timestamp: at, type: "session_meta", payload: { id, cwd, timestamp: at, originator: "codex_exec" } }) + "\n" + '{"type":"response_item"}\n')
  rollout("rollout-a.jsonl", "aaaa", "/wt/codex", "2026-09-17T01:00:00.000Z") // earlier run in the same worktree
  rollout("rollout-b.jsonl", "bbbb", "/wt/codex", "2026-09-17T02:00:00.000Z") // the arena run
  rollout("rollout-c.jsonl", "cccc", "/wt/other", "2026-09-17T03:00:00.000Z") // another worktree
  writeFileSync(join(day, "rollout-broken.jsonl"), "not json\n")
  assert.equal(findCodexThread(sessions, "/wt/codex", Date.parse("2026-09-17T01:59:30.000Z")), "bbbb")
  assert.equal(findCodexThread(sessions, "/wt/codex", Date.parse("2026-09-17T02:30:00.000Z")), null, "nothing started after the launch")
  assert.equal(findCodexThread(sessions, "/wt/none", 0), null)
  assert.equal(findCodexThread(join(sessions, "missing"), "/wt/codex", 0), null)

  const runner = createCodexRunner({ env: { CODEX_HOME: sessions.replace(/\/sessions$/, "") } })
  assert.equal(typeof runner.findSessionId, "function")
})

test("custom runner supports questions only when askArgs is configured", () => {
  const plain = createCustomRunner("x", { command: "x-cli", args: ["run"] })
  assert.equal(plain.askInvocation, undefined)
  const withAsk = createCustomRunner("x", { command: "x-cli", args: ["run"], askArgs: ["ask", "--session", "{{sessionId}}", "--prompt-file", "{{promptFile}}"] })
  const inv = withAsk.askInvocation!(askInput)
  assert.deepEqual(inv.args, ["ask", "--session", askInput.sessionId, "--prompt-file", "/q.md"])
  assert.equal(inv.promptViaStdin, false)
})
