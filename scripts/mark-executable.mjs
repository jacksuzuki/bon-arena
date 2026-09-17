// tsc writes dist/arena.js without the executable bit; a linked checkout (`npm link`) runs that file directly.
import { chmodSync } from "node:fs"

chmodSync(new URL("../dist/arena.js", import.meta.url), 0o755)
