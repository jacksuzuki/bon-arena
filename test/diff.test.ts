import { test } from "node:test"
import assert from "node:assert/strict"
import { parseNumstat, summarize } from "../src/git/diff.ts"

test("parseNumstat handles binary markers and tabs in paths", () => {
  const files = parseNumstat("3\t1\tsrc/a.ts\n-\t-\timg.png\n10\t0\tdir/with\ttab.txt\n")
  assert.deepEqual(files, [
    { path: "src/a.ts", additions: 3, deletions: 1 },
    { path: "img.png", additions: 0, deletions: 0 },
    { path: "dir/with\ttab.txt", additions: 10, deletions: 0 },
  ])
  const stats = summarize(files, 2)
  assert.equal(stats.changedFiles, 3)
  assert.equal(stats.additions, 13)
  assert.equal(stats.deletions, 1)
  assert.equal(stats.commits, 2)
})
