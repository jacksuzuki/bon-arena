import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectVerifyCommands, resolveVerifyCommands } from "../src/verification/detect.ts"

function tmpRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "arena-detect-"))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

test("detects npm scripts and skips the npm placeholder test", () => {
  const dir = tmpRepo({
    "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: "eslint ." } }),
  })
  const v = detectVerifyCommands(dir)
  assert.equal(v.test, undefined)
  assert.equal(v.lint, "npm run lint")
  rmSync(dir, { recursive: true })
})

test("detects bun via lockfile and tsc via tsconfig + typescript dependency", () => {
  const dir = tmpRepo({
    "package.json": JSON.stringify({ scripts: { test: "bun test" }, devDependencies: { typescript: "^5" } }),
    "bun.lock": "",
    "tsconfig.json": "{}",
  })
  const v = detectVerifyCommands(dir)
  assert.equal(v.test, "bun test")
  assert.equal(v.typecheck, "bunx tsc --noEmit -p tsconfig.json")
  rmSync(dir, { recursive: true })
})

test("prefers explicit typecheck-like scripts", () => {
  const dir = tmpRepo({
    "package.json": JSON.stringify({ scripts: { "type-check": "tsc --noEmit" } }),
    "pnpm-lock.yaml": "",
  })
  assert.equal(detectVerifyCommands(dir).typecheck, "pnpm run type-check")
  rmSync(dir, { recursive: true })
})

test("detects cargo and go projects", () => {
  const rust = tmpRepo({ "Cargo.toml": "[package]" })
  assert.deepEqual(detectVerifyCommands(rust), { test: "cargo test", typecheck: "cargo check" })
  const go = tmpRepo({ "go.mod": "module x" })
  assert.deepEqual(detectVerifyCommands(go), { test: "go test ./...", lint: "go vet ./..." })
  rmSync(rust, { recursive: true })
  rmSync(go, { recursive: true })
})

test("resolve precedence: override > config > detected, false disables", () => {
  const dir = tmpRepo({ "package.json": JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } }) })
  const v = resolveVerifyCommands(dir, { test: "npm run test:ci", lint: false }, { test: "make test" })
  assert.deepEqual(v, { test: "make test" })
  const v2 = resolveVerifyCommands(dir, { lint: false }, {})
  assert.deepEqual(v2, { test: "npm test" })
  rmSync(dir, { recursive: true })
})

import { detectSetupCommands, resolveSetupCommands } from "../src/verification/detect.ts"

test("detects setup command from lockfile", () => {
  const npm = tmpRepo({ "package.json": "{}", "package-lock.json": "{}" })
  assert.deepEqual(detectSetupCommands(npm), ["npm ci"])
  const bare = tmpRepo({ "package.json": "{}" })
  assert.deepEqual(detectSetupCommands(bare), ["npm install"])
  const pnpm = tmpRepo({ "package.json": "{}", "pnpm-lock.yaml": "" })
  assert.deepEqual(detectSetupCommands(pnpm), ["pnpm install --frozen-lockfile"])
  const none = tmpRepo({ "Cargo.toml": "" })
  assert.deepEqual(detectSetupCommands(none), [])
  for (const d of [npm, bare, pnpm, none]) rmSync(d, { recursive: true })
})

test("resolveSetupCommands precedence and false", () => {
  const dir = tmpRepo({ "package.json": "{}", "package-lock.json": "{}" })
  assert.deepEqual(resolveSetupCommands(dir, undefined, undefined), ["npm ci"])
  assert.deepEqual(resolveSetupCommands(dir, "make deps", undefined), ["make deps"])
  assert.deepEqual(resolveSetupCommands(dir, ["a", " b "], undefined), ["a", "b"])
  assert.deepEqual(resolveSetupCommands(dir, "make deps", "npm install"), ["npm install"])
  assert.deepEqual(resolveSetupCommands(dir, "make deps", false), [])
  assert.deepEqual(resolveSetupCommands(dir, false, undefined), [])
  rmSync(dir, { recursive: true })
})
