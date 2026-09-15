// Use Wrangler's atomic SQL-file importer: the remote query endpoint can split
// trigger bodies incorrectly. Keep the normal d1_migrations registry compatible.
import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const config = JSON.parse(
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
const database = config.d1_databases[0].database_name;
const cli = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)
  .pathname;
const base = ["d1", "execute", database, "--remote"];
function wrangler(args, json = false) {
  return execFileSync(
    process.execPath,
    [cli, ...base, ...args, ...(json ? ["--json"] : [])],
    {
      encoding: "utf8",
      stdio: json ? ["ignore", "pipe", "inherit"] : "inherit",
    },
  );
}
wrangler([
  "--command",
  "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
]);
const result = JSON.parse(
  wrangler(["--command", "SELECT name FROM d1_migrations"], true),
);
const applied = new Set(
  result.flatMap((r) => r.results ?? []).map((r) => r.name),
);
const folder = new URL("../migrations/", import.meta.url);
for (const name of (await readdir(folder))
  .filter((n) => /^\d+_[a-z0-9_]+\.sql$/.test(n))
  .sort()) {
  if (applied.has(name)) continue;
  const directory = await mkdtemp(join(tmpdir(), "agent-temp-mail-migration-"));
  try {
    const file = join(directory, name);
    const sql = await readFile(new URL(name, folder), "utf8");
    await writeFile(
      file,
      sql + `\nINSERT INTO d1_migrations(name) VALUES('${name}');\n`,
    );
    wrangler(["--file", file]);
    console.log(`Applied ${name}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
console.log("Remote migrations are up to date.");
