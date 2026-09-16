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
