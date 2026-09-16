// Install the actual npm archive into an isolated consumer and verify its public surface.
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const dir = await mkdtemp(join(tmpdir(), "agent-temp-mail-package-"));
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
try {
  const [pack] = JSON.parse(
    run("npm", [
      "pack",
      join(root, "sdk"),
      "--pack-destination",
      dir,
      "--json",
    ]),
  );
  const allowed = new Set([
    "LICENSE",
    "README.md",
    "package.json",
    "index.mjs",
    "index.d.mts",
    "client.mjs",
    "client.d.mts",
    "tools.mjs",
    "tools.d.mts",
    "cli.mjs",
    "mcp.mjs",
  ]);
  assert.deepEqual(new Set(pack.files.map((f) => f.path)), allowed);
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(dir, pack.filename),
  ]);
  const consumer = `import { generateIdentity, loadIdentity, MailClient, AgentMailTools } from 'agent-temp-mail';
import { MailClient as DirectClient } from 'agent-temp-mail/client';
import { AgentMailTools as DirectTools } from 'agent-temp-mail/tools';
const mail = new MailClient(generateIdentity());
if (!mail.address.endsWith('@agent-temp-mail.com') || MailClient !== DirectClient || AgentMailTools !== DirectTools) throw new Error('Bad public exports');
const identity = await loadIdentity('./persistent.key.json', {create:true});
const resumed = await loadIdentity('./persistent.key.json');
if (identity.public_key !== resumed.public_key) throw new Error('Identity changed');
console.log('Installed package imports and identity persistence passed');`;
  await writeFile(join(dir, "consumer.mjs"), consumer);
  process.stdout.write(run(process.execPath, ["consumer.mjs"]));
  assert.equal(
    (await stat(join(dir, "persistent.key.json"))).mode & 0o777,
    0o600,
  );
  const cli = JSON.parse(
    run(process.execPath, ["node_modules/.bin/agent-temp-mail", "keygen"], {
      env: { ...process.env, MAIL_KEY_FILE: join(dir, "cli.key.json") },
    }),
  );
  assert.ok(cli.address.endsWith("@agent-temp-mail.com"));
  assert.ok(!JSON.stringify(cli).includes("private_key_pkcs8"));
  let refused = false;
  try {
    run(process.execPath, ["node_modules/.bin/agent-temp-mail-mcp"], {
      env: {
        ...process.env,
        MAIL_KEY_FILE: join(dir, "absent.key.json"),
        MAIL_REQUIRE_EXISTING_KEY: "1",
      },
    });
  } catch {
    refused = true;
  }
  assert.ok(refused, "MCP must fail when an existing identity is required");
  const types = `import { generateIdentity, MailClient, AgentMailTools, type Inbox } from 'agent-temp-mail';
import { MailClient as DirectClient } from 'agent-temp-mail/client';
const mail = new MailClient(generateIdentity());
const other: DirectClient = mail;
const box: Inbox = await other.create({persistent:true});
const data = await mail.get('message');
const text: string = data.text;
const definitions = await new AgentMailTools(mail).definitions('mcp');
const name: string = definitions[0].name;
// @ts-expect-error persistence is boolean
await mail.create({persistent:'yes'});
`;
  await writeFile(join(dir, "consumer.mts"), types);
  run(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--strict",
    "--module",
    "NodeNext",
    "--target",
    "ES2022",
    "--lib",
    "ES2022,DOM",
    "--skipLibCheck",
    "consumer.mts",
  ]);
  console.log(
    `Package archive: ${pack.entryCount} allowlisted files; CLI, types and missing-key guard passed`,
  );
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout.toString());
  if (error.stderr) process.stderr.write(error.stderr.toString());
  throw error;
} finally {
  await rm(dir, { recursive: true, force: true });
}
