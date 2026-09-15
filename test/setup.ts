import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM inboxes"),
    env.DB.prepare("DELETE FROM nonces"),
    env.DB.prepare("DELETE FROM limits"),
  ]);
});
