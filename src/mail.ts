import PostalMime from "postal-mime";
import { Parser } from "htmlparser2";
import { C, Env, digest, enc, now, readLimited, limit } from "./core";
export function safeUrl(s: string): string | null {
  if (s.length > 2048) return null;
  try {
    const u = new URL(s);
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function htmlText(html: string): string {
  let out = "",
    skip = 0;
  const stack: string[] = [];
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (["script", "style", "template", "head"].includes(name)) {
          skip++;
          return;
        }
        if (skip) return;
        if (
          ["p", "div", "br", "li", "tr", "h1", "h2", "h3", "table"].includes(
            name,
          )
        )
          out += "\n";
        if (name === "a") stack.push(safeUrl(attrs.href || "") || "");
      },
      ontext(t) {
        if (!skip) out += t;
      },
      onclosetag(name) {
        if (["script", "style", "template", "head"].includes(name)) {
          skip = Math.max(0, skip - 1);
          return;
        }
        if (skip) return;
        if (name === "a") {
          const url = stack.pop();
          if (url) out += ` (${url})`;
        }
        if (["p", "div", "li", "tr"].includes(name)) out += "\n";
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return out
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();
}
export function truncate(
  s: string,
  max = C.text,
): { text: string; truncated: boolean } {
  const b = enc.encode(s);
  if (b.length <= max) return { text: s, truncated: false };
  let end = max;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(b.slice(0, end)), truncated: true };
}
export function candidates(text: string, subject: string) {
  const source = subject + "\n" + text;
  const codes: Array<{ value: string; context: string; kind: string }> = [];
  const seen = new Set<string>();
  for (const m of source.matchAll(/\b\d{4,8}\b/g)) {
    if (codes.length >= 10) break;
    const i = m.index!;
    const context = source.slice(Math.max(0, i - 64), i + m[0].length + 64);
    if (
      !seen.has(m[0]) &&
      /code|otp|verify|verification|passcode|password|pin|security|authenticat|login|sign.in/i.test(
        context,
      )
    ) {
      seen.add(m[0]);
      codes.push({ value: m[0], context, kind: "numeric" });
    }
  }
  for (const m of source.matchAll(
    /(?:code|otp|passcode)\s*(?:is|:|=)?\s*([A-Z0-9]{4,10})\b/gi,
  )) {
    if (codes.length >= 10) break;
    const v = m[1];
    if (/\d/.test(v) && !seen.has(v)) {
      seen.add(v);
      codes.push({ value: v, context: m[0], kind: "alphanumeric" });
    }
  }
  const links: Array<{ url: string; likely_verification: boolean }> = [];
  const urls = new Set<string>();
  for (const m of source.matchAll(/https?:\/\/[^\s<>"\u0000-\u001f]+/g)) {
    if (links.length >= 20) break;
    const u = safeUrl(m[0].replace(/[).,;!?]+$/, ""));
    if (u && !urls.has(u)) {
      urls.add(u);
      links.push({
        url: u,
        likely_verification:
          /verif|confirm|activate|magic|token|auth|sign.?in|reset/i.test(u),
      });
    }
  }
  return { otp_codes: codes, links };
}
export async function receive(message: ForwardableEmailMessage, env: Env) {
  const address = message.to.toLowerCase();
  const t = now();
  if (message.rawSize > C.raw) {
    message.setReject(
      "Message exceeds 256 KiB limit. Attachments are not supported.",
    );
    return;
  }
  const box = await env.DB.prepare(
    "SELECT address,expires_at,retention_seconds,message_count,stored_bytes FROM inboxes WHERE address=? AND (expires_at IS NULL OR expires_at>?)",
  )
    .bind(address, t)
    .first<{
      address: string;
      expires_at: number | null;
      retention_seconds: number;
      message_count: number;
      stored_bytes: number;
    }>();
  if (!box) {
    message.setReject("Unknown or expired mailbox. Register before sending.");
    return;
  }
  if (box.message_count >= 100 || box.stored_bytes >= 2097152) {
    message.setReject("Mailbox storage limit reached.");
    return;
  }
  try {
    await limit(env.DB, "daily:mail", 1500, 86400);
    await limit(env.DB, `mail:${address}`, 30, 3600);
  } catch {
    message.setReject("Mail capacity reached. Please retry later.");
    return;
  }
  let raw: Uint8Array, parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    raw = await readLimited(message.raw, C.raw);
    parsed = await PostalMime.parse(raw, {
      maxNestingDepth: 12,
      maxHeadersSize: 16384,
    });
  } catch {
    message.setReject("Invalid or oversized email.");
    return;
  }
  const fingerprint = await digest(raw);
  const plain = parsed.text?.trim();
  const body = truncate(plain || htmlText(parsed.html || ""));
  const subject = truncate(parsed.subject || "", 1024).text;
  // Keep link destinations from HTML alternatives even when the plain-text part exists.
  const htmlLinks =
    plain && parsed.html ? candidates(htmlText(parsed.html), "").links : [];
  const extracted = candidates(body.text, subject);
  for (const l of htmlLinks) {
    if (extracted.links.length >= 20) break;
    if (!extracted.links.some((x) => x.url === l.url)) extracted.links.push(l);
  }
  const data = JSON.stringify(extracted);
  const sender = (parsed.from?.address || message.from || "")
    .toLowerCase()
    .slice(0, 320);
  const envelope = message.from.slice(0, 320);
  const bytes =
    enc.encode(body.text + data + subject + sender + envelope).length + 512;
  const expiry = Math.min(
    t + box.retention_seconds,
    box.expires_at ?? Number.MAX_SAFE_INTEGER,
  );
  try {
    await env.DB.prepare(
      `INSERT INTO messages(id,inbox,envelope_from,sender,subject,received_at,expires_at,text,candidates,truncated,attachments_removed,stored_bytes,fingerprint)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM inboxes WHERE address=? AND (expires_at IS NULL OR expires_at>?)) ON CONFLICT(inbox,fingerprint) DO NOTHING`,
    )
      .bind(
        crypto.randomUUID(),
        address,
        envelope,
        sender,
        subject,
        t,
        expiry,
        body.text,
        data,
        body.truncated ? 1 : 0,
        parsed.attachments?.length ? 1 : 0,
        bytes,
        fingerprint,
        address,
        t,
      )
      .run();
  } catch (e) {
    if (/capacity/.test(String(e))) {
      message.setReject("Mailbox or service storage capacity reached.");
      return;
    }
    throw e;
  }
}
