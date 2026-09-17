import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeProjectDirName, detectHost, effortRank, findTranscript, modelTier, rateHost, readTranscriptTail } from "../src/host.ts"

test("model and effort tiers", () => {
  assert.equal(modelTier("claude-fable-5-1"), 2)
  assert.equal(modelTier("claude-mythos-5-1"), 2)
  assert.equal(modelTier("claude-opus-5"), 1)
  assert.equal(modelTier("claude-sonnet-5"), 0)
  assert.equal(modelTier("claude-haiku-4-5-20251001"), 0)
  assert.equal(modelTier("gpt-x"), -1)
  assert.equal(modelTier(undefined), -1)
  assert.equal(effortRank("HIGH"), 2)
  assert.equal(effortRank("medium"), 1)
  assert.equal(effortRank("bogus"), -1)
})

test("rateHost warns below Opus/medium and stays quiet above", () => {
  const ok = rateHost({ harness: "claude-code", model: "claude-opus-5", effort: "medium", sources: {} })
  assert.deepEqual(ok.warnings, [])
  const best = rateHost({ harness: "claude-code", model: "claude-fable-5-1", effort: "high", sources: {} })
  assert.deepEqual(best.warnings, [])
  const weak = rateHost({ harness: "claude-code", model: "claude-sonnet-5", effort: "low", sources: {} })
  assert.equal(weak.warnings.length, 2)
  assert.match(weak.warnings[0]!, /below the minimum \(Opus 5\)/)
  assert.match(weak.warnings[1]!, /below the minimum \(medium\)/)
  const unknown = rateHost({ harness: "claude-code", sources: {} })
  assert.match(unknown.warnings.join(" "), /model could not be detected/)
  const other = rateHost({ harness: "unknown", sources: {} })
  assert.deepEqual(other.warnings, [])
})

test("project dir naming and transcript tail parsing", () => {
  assert.equal(claudeProjectDirName("/Users/me/.superset/projects/x"), "-Users-me--superset-projects-x")
  const home = mkdtempSync(join(tmpdir(), "arena-host-"))
  const cwd = "/repo/app"
  const dir = join(home, "projects", claudeProjectDirName(cwd))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "sess-1.jsonl")
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "user", message: { role: "user" } }),
      JSON.stringify({ type: "assistant", effort: "medium", message: { model: "claude-opus-5", role: "assistant" } }),
      JSON.stringify({ type: "assistant", effort: "high", message: { model: "claude-fable-5-1", role: "assistant" } }),
      "{partial",
    ].join("\n"),
  )
  assert.equal(findTranscript("sess-1", cwd, home), path)
  assert.equal(findTranscript("sess-1", "/elsewhere", home), path) // fallback scan
  assert.equal(findTranscript("nope", cwd, home), null)
  assert.deepEqual(readTranscriptTail(path), { model: "claude-fable-5-1", effort: "high" })
  rmSync(home, { recursive: true })
})

test("detectHost outside Claude Code reports unknown harness without warnings", () => {
  const h = detectHost("/tmp", {})
  assert.equal(h.harness, "unknown")
  assert.deepEqual(h.warnings, [])
})

test("detectHost prefers CLAUDE_EFFORT and the live transcript over settings", () => {
  const home = mkdtempSync(join(tmpdir(), "arena-host-"))
  const cwd = "/repo/app"
  const dir = join(home, "projects", claudeProjectDirName(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "s.jsonl"), JSON.stringify({ type: "assistant", effort: "medium", message: { model: "claude-opus-5" } }) + "\n")
  writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "claude-sonnet-5[1m]", effortLevel: "low" }))
  const prev = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    const h = detectHost(cwd, { CLAUDE_CODE_SESSION_ID: "s", CLAUDE_EFFORT: "high" })
    assert.equal(h.model, "claude-opus-5")
    assert.equal(h.effort, "high")
    assert.equal(h.sources.effort, "CLAUDE_EFFORT")
    assert.deepEqual(h.warnings, [])
    const fallback = detectHost(cwd, { CLAUDECODE: "1" })
    assert.equal(fallback.model, "claude-sonnet-5")
    assert.equal(fallback.effort, "low")
    assert.equal(fallback.warnings.length, 2)
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prev
    rmSync(home, { recursive: true })
  }
})
