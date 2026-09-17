import { test } from "node:test"
import assert from "node:assert/strict"
import { createCustomRunner } from "../src/runners/custom.ts"
import { createClaudeRunner } from "../src/runners/claude.ts"
import { createCodexRunner } from "../src/runners/codex.ts"
import { createRunnerRegistry } from "../src/runners/index.ts"
import { buildArenaPrompt } from "../src/runners/prompt.ts"
import type { RunnerInput } from "../src/runners/types.ts"

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
})
