import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { installSkill } from "../src/install.ts"

const bundled = readFileSync(new URL("../.claude/skills/arena/SKILL.md", import.meta.url), "utf8")

function fixture(t: TestContext): string {
  const directory = mkdtempSync(new URL("../.arena-install-test-", import.meta.url))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test("installs the bundled skill into a fresh config directory and is idempotent", (t) => {
  const configDir = join(fixture(t), "config with spaces")
  const result = installSkill({ configDir })
  assert.equal(result.path, join(configDir, "skills/arena/SKILL.md"))
  assert.equal(result.changed, true)
  assert.equal(readFileSync(result.path, "utf8"), bundled)
  assert.deepEqual(installSkill({ configDir }), { path: result.path, changed: false })
})

test("preserves a custom skill unless force is explicitly requested", (t) => {
  const configDir = fixture(t)
  const { path } = installSkill({ configDir })
  writeFileSync(path, "custom skill")
  const extra = join(configDir, "skills/arena/notes.md")
  writeFileSync(extra, "keep me")
  assert.throws(() => installSkill({ configDir }), /Use --force/)
  assert.equal(readFileSync(path, "utf8"), "custom skill")
  assert.equal(installSkill({ configDir, force: true }).changed, true)
  assert.equal(readFileSync(path, "utf8"), bundled)
  assert.equal(readFileSync(extra, "utf8"), "keep me")
})

test("migrates a legacy directory symlink without changing the original checkout", (t) => {
  const root = fixture(t)
  const original = join(root, "original")
  const configDir = join(root, "config")
  mkdirSync(original)
  writeFileSync(join(original, "SKILL.md"), "original skill")
  mkdirSync(join(configDir, "skills"), { recursive: true })
  symlinkSync(original, join(configDir, "skills/arena"), "dir")
  assert.throws(() => installSkill({ configDir }), /Use --force/)
  installSkill({ configDir, force: true })
  assert.equal(lstatSync(join(configDir, "skills/arena")).isSymbolicLink(), false)
  assert.equal(readFileSync(join(original, "SKILL.md"), "utf8"), "original skill")
})

test("does not follow an existing skill file symlink, including dangling links", (t) => {
  const configDir = fixture(t)
  mkdirSync(join(configDir, "skills/arena"), { recursive: true })
  const path = join(configDir, "skills/arena/SKILL.md")
  const target = join(configDir, "missing.md")
  symlinkSync(target, path)
  assert.throws(() => installSkill({ configDir }), /Use --force/)
  installSkill({ configDir, force: true })
  assert.equal(lstatSync(path).isSymbolicLink(), false)
  assert.equal(lstatSync(target, { throwIfNoEntry: false }), undefined)
})

test("honours CLAUDE_CONFIG_DIR while explicit configDir takes precedence", (t) => {
  const root = fixture(t)
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, "environment")
  try {
    assert.equal(installSkill().path, join(root, "environment/skills/arena/SKILL.md"))
    assert.equal(installSkill({ configDir: join(root, "explicit") }).path, join(root, "explicit/skills/arena/SKILL.md"))
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})
