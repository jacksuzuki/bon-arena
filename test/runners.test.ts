import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createCustomRunner } from "../src/runners/custom.ts"
import { createAgyRunner, findAgyConversation } from "../src/runners/agy.ts"
import { createClaudeRunner } from "../src/runners/claude.ts"
import { createCodexRunner, findCodexThread } from "../src/runners/codex.ts"
import { BUILTIN_RUNNER_IDS, createRunnerRegistry } from "../src/runners/index.ts"
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
  assert.ok(codex.args.includes("sandbox_workspace_write.network_access=true"), "lets Codex start a local dev server")
  assert.equal(codex.args.at(-1), "-")
})

test("registry exposes built-ins plus custom runners, config overrides built-ins", () => {
  const reg = createRunnerRegistry({ runners: { claude: { label: "Claude Opus" }, gemini: { command: "gemini" } }, verify: {} })
  assert.deepEqual([...reg.keys()], ["claude", "codex", "agy", "gemini"])
  assert.equal(reg.get("claude")?.label, "Claude Opus")
  assert.deepEqual([...BUILTIN_RUNNER_IDS], ["claude", "codex", "agy"])
  assert.equal(reg.get("agy")?.label, "Antigravity")

  const over = createRunnerRegistry({ runners: { agy: { command: "/opt/agy", label: "Gemini 3", model: "gemini-3-pro", env: { X: "1" } } }, verify: {} })
  assert.deepEqual([...over.keys()], ["claude", "codex", "agy"])
  assert.equal(over.get("agy")?.label, "Gemini 3")
  const inv = over.get("agy")!.invocation(input)
  assert.equal(inv.command, "/opt/agy")
  assert.ok(inv.args.join(" ").includes("--model gemini-3-pro"))
  assert.deepEqual(inv.env, { X: "1" })
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

test("doctor lists agy and only requires claude and codex for its exit status", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "arena-doctor-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync("git", ["init", "-q", "-b", "main", dir])
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"])
  const present = { command: process.execPath }
  const absent = { command: join(dir, "missing-runner") }
  const doctor = (runners: Record<string, { command: string }>, json = false) => {
    writeFileSync(join(dir, ".arena.yaml"), JSON.stringify({ runners, integrations: { orca: false } }))
    return spawnSync(process.execPath, [fileURLToPath(new URL("../src/arena.ts", import.meta.url)), "doctor", "--repo", dir, ...(json ? ["--json"] : [])], {
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: dir, CLAUDE_CONFIG_DIR: dir },
    })
  }

  const listed = doctor({ claude: present, codex: present, agy: absent }, true)
  assert.equal(listed.status, 0, listed.stderr)
  assert.deepEqual(
    JSON.parse(listed.stdout).runners.find((r: { id: string }) => r.id === "agy"),
    { id: "agy", label: "Antigravity", command: absent.command, available: false },
  )
  // A missing agy never fails doctor; a missing claude or codex still does.
  assert.equal(doctor({ claude: present, codex: present, agy: absent }).status, 0)
  assert.equal(doctor({ claude: present, codex: present, agy: present }).status, 0)
  assert.equal(doctor({ claude: absent, codex: present, agy: present }).status, 1)
  assert.equal(doctor({ claude: present, codex: absent, agy: present }).status, 1)
})

test("agy runner works inside the worktree headlessly and passes the prompt as one -p= argument", () => {
  const runner = createAgyRunner({ extraArgs: ["--effort", "high"] })
  assert.equal(runner.id, "agy")
  assert.equal(runner.label, "Antigravity")
  const inv = runner.invocation(input)
  assert.equal(inv.command, "agy")
  assert.equal(inv.promptViaStdin, false)
  assert.equal(inv.sessionId, undefined, "agy cannot pin a conversation id at launch")
  assert.equal(inv.args[inv.args.indexOf("--add-dir") + 1], "/wt")
  assert.ok(inv.args.includes("--dangerously-skip-permissions"))
  assert.match(inv.args[inv.args.indexOf("--print-timeout") + 1]!, /^\d+h$/, "far beyond agy's 5 minute default")
  assert.equal(inv.args[inv.args.indexOf("--output-format") + 1], "stream-json", "the conversation id is read from stdout")
  assert.equal(inv.args[inv.args.indexOf("--effort") + 1], "high")
  assert.equal(inv.args.at(-1), "-p=PROMPT")
  assert.ok(!inv.args.includes("-p") && !inv.args.includes("--print"), "never the two-argument form")

  // Whatever the prompt looks like, it stays one argument and extraArgs cannot split it.
  for (const prompt of ["--help me\nwith this", "-p", "line 1\nline 2 with \"quotes\" and $VARS", ""]) {
    const args = createAgyRunner({ extraArgs: ["--sandbox"] }).invocation({ ...input, prompt }).args
    assert.deepEqual(args.filter((a) => a.startsWith("-p=")), [`-p=${prompt}`])
    assert.equal(args.filter((a) => !a.startsWith("-p=") && (a.includes("line 2") || a === "-p" || a.startsWith("--help"))).length, 0)
  }
})

test("agy runner reads the conversation id from its stdout log", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agy-stdout-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = (name: string, content: string): string => {
    const path = join(dir, name)
    writeFileSync(path, content)
    return path
  }
  const stream = (id: string): string =>
    [
      `{"event":"init","conversation_id":"${id}","init":{"cwd":"/wt","tools":["run_command"],"permission_mode":"always-proceed"}}`,
      `{"event":"step_update","step_update":{"conversation_id":"${id}","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}`,
      `{"event":"result","result":{"conversation_id":"${id}","status":"SUCCESS","response":"OK\\n","duration_seconds":2.4,"num_turns":1,"usage":{}}}`,
    ].join("\n") + "\n"
  const a = "0b8e2c8a-5d0f-4f0e-9a51-0c1d2e3f4a5b"
  const b = "7f3d9c1e-2a4b-4c6d-8e0f-112233445566"

  assert.equal(findAgyConversation(log("stream.log", stream(a))), a)
  assert.equal(findAgyConversation(log("json.log", `{"conversation_id":"${a}","status":"SUCCESS","response":"OK","duration_seconds":2.4,"num_turns":1,"usage":{}}\n`)), a)
  assert.equal(findAgyConversation(log("killed.log", stream(a).split("\n")[0] + "\n")), a, "the init event alone is enough")
  assert.equal(findAgyConversation(log("appended.log", stream(a) + stream(b))), b, "the log is appended to: the last run wins")
  assert.equal(findAgyConversation(log("lost-init.log", stream(a) + stream(b).split("\n")[1] + "\n")), b)
  assert.equal(findAgyConversation(log("noisy.log", `warning: something\n{"event":"init","conversation_id":"${a}"\n${stream(b)}{"conversation_id": trunc`)), b, "broken lines are skipped")

  assert.equal(findAgyConversation(log("empty.log", "")), null)
  assert.equal(findAgyConversation(log("text.log", "OK\nconversation_id: nope\n")), null)
  assert.equal(findAgyConversation(log("no-id.log", '{"event":"init","init":{"cwd":"/wt"}}\n{"conversation_id":42}\n[1,2]\nnull\n')), null)
  assert.equal(findAgyConversation(join(dir, "missing.log")), null)

  const found = createAgyRunner().findSessionId?.({ cwd: "/wt", startedAt: "2026-09-17T02:00:00.000Z", stdoutPath: join(dir, "stream.log"), stderrPath: join(dir, "x"), resultsDir: dir })
  assert.equal(found, a)
})

test("agy runner resumes its conversation inside the worktree with a plain-text answer", () => {
  const ask: AskInput = { sessionId: "0b8e2c8a-5d0f-4f0e-9a51-0c1d2e3f4a5b", prompt: "-why?\nline 2", promptPath: "/r/q.md", cwd: "/wt/agy", resultsDir: "/r" }
  const inv = createAgyRunner({ command: "/opt/agy", model: "gemini-3-pro", extraArgs: ["--effort", "high"], env: { X: "1" } }).askInvocation!(ask)
  assert.equal(inv.command, "/opt/agy")
  assert.equal(inv.promptViaStdin, false)
  assert.equal(inv.args[inv.args.indexOf("--conversation") + 1], ask.sessionId)
  assert.equal(inv.args[inv.args.indexOf("--add-dir") + 1], "/wt/agy")
  assert.equal(inv.args[inv.args.indexOf("--output-format") + 1], "text", "stdout is the answer")
  assert.ok(inv.args.includes("--print-timeout"))
  assert.ok(inv.args.includes("--sandbox"), "the only restriction agy offers; read-only is best effort")
  assert.ok(inv.args.join(" ").includes("--model gemini-3-pro"))
  assert.equal(inv.args.at(-1), "-p=-why?\nline 2")
  assert.deepEqual(inv.env, { X: "1" })
})
