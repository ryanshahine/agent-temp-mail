// Outputs public provisioning SQL only. Redirect it to a temporary file for Wrangler.
import { readFile } from "node:fs/promises";
const config = JSON.parse(
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
const { DOMAIN, ADMIN_PUBLIC_KEY } = config.vars;
if (!/^[a-z2-7]{52}$/.test(ADMIN_PUBLIC_KEY) || !/^[-a-z0-9.]+$/.test(DOMAIN))
  throw new Error("Set DOMAIN and ADMIN_PUBLIC_KEY first.");
for (const name of ["hi", "feedback"])
  console.log(
    `INSERT INTO inboxes(address,owner,created_at,expires_at,retention_seconds) VALUES('${name}@${DOMAIN}','${ADMIN_PUBLIC_KEY}',unixepoch(),NULL,604800) ON CONFLICT(address) DO UPDATE SET owner=excluded.owner,expires_at=NULL,retention_seconds=604800;`,
  );
