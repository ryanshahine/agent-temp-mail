#!/usr/bin/env node
import { loadIdentity, MailClient } from "./client.mjs";
const [command, ...args] = process.argv.slice(2);
const path =
  process.env.MAIL_KEY_FILE ||
  args.find((a) => a.startsWith("--key="))?.slice(6);
if (!path) {
  console.error(
    "Set MAIL_KEY_FILE to a private file path (or --key=/path/identity.key.json). Commands: keygen, create, inspect, list, candidates, get ID, delete-message ID, extend, delete-inbox. Optional JSON arguments for create/list/candidates/extend.",
  );
  process.exit(1);
}
try {
  const identity = await loadIdentity(path, { create: command === "keygen" });
  const client = new MailClient(identity, {
    baseUrl: process.env.MAIL_BASE_URL,
    domain: process.env.MAIL_DOMAIN,
  });
  const values = args.filter((a) => !a.startsWith("--key="));
  let result;
  switch (command) {
    case "keygen":
      result = {
        public_key: identity.public_key,
        address: client.address,
        key_file: path,
      };
      break;
    case "create":
      result = await client.create(JSON.parse(values[0] || "{}"));
      break;
    case "inspect":
      result = await client.inspect(values[0]);
      break;
    case "list":
      result = await client.list(JSON.parse(values[0] || "{}"));
      break;
    case "candidates":
      result = await client.candidates(JSON.parse(values[0] || "{}"));
      break;
    case "get":
      result = await client.get(values[0]);
      break;
    case "delete-message":
      result = await client.deleteMessage(values[0]);
      break;
    case "extend":
      result = await client.extend(JSON.parse(values[0] || "{}"));
      break;
    case "delete-inbox":
      result = await client.deleteInbox();
      break;
    default:
      throw new Error("Unknown command.");
  }
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(
    JSON.stringify({
      error: {
        message: e.message,
        code: e.code,
        status: e.status,
        retry_after_seconds: e.retry_after_seconds,
      },
    }),
  );
  process.exitCode = 1;
}
