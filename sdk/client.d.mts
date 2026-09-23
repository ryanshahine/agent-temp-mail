export interface Identity {
  public_key: string;
  private_key_pkcs8: string;
}
export interface InboxOptions {
  persistent?: boolean;
  ttl_seconds?: number;
  retention_seconds?: number;
}
export interface Filters {
  after?: string;
  limit?: number;
  since?: string;
  sender?: string;
}
export interface Inbox {
  address: string;
  created_at: string | null;
  expires_at: string | null;
  persistent: boolean;
  accepting_mail: boolean;
  storage_initialized: boolean;
  retention_seconds: number;
  stored_message_count: number;
  stored_bytes: number;
  limits: { messages: number; bytes: number };
  poll_after_seconds: number;
  note: string;
}
export interface MessageSummary {
  id: string;
  inbox: string;
  sender: string;
  envelope_from: string;
  subject: string;
  received_at: string;
  expires_at: string;
  truncated: boolean;
  attachments_removed: boolean;
}
export interface Candidates {
  source_message_id: string;
  otp_codes: Array<{ value: string; context: string; kind: string }>;
  links: Array<{ url: string; likely_verification: boolean }>;
}
export interface Message extends MessageSummary {
  text: string;
  candidates: Candidates;
  untrusted: true;
  warning: string;
}
export interface Page<T = MessageSummary> {
  messages: T[];
  after: string;
  has_more: boolean;
  poll_after_seconds: number;
  untrusted: true;
  warning: string;
}
export interface MailboxSnapshot {
  address: string;
  messages: Message[];
  poll_after_seconds: number;
  capability_expires_at: string;
  untrusted: true;
  warning: string;
}
export interface Deletion {
  deleted: boolean;
  address?: string;
  id?: string;
}
export interface MailError extends Error {
  status?: number;
  code?: string;
  retry_after_seconds?: number;
}
export function base32(bytes: Uint8Array): string;
export function generateIdentity(): Identity;
export function validateIdentity(identity: Identity): Identity;
export function loadIdentity(
  path: string,
  options?: { create?: boolean },
): Promise<Identity>;
export function signedHeaders(
  identity: Identity,
  method: string,
  url: string,
  body?: string,
  options?: { timestamp?: string; nonce?: string },
): Record<string, string>;
/** @deprecated Use readUrl() for a reusable GET-only mailbox snapshot. */
export function signedUrl(
  identity: Identity,
  url: string,
  options?: { timestamp?: string; nonce?: string },
): string;
export interface ReadCapability {
  public_key: string;
  expires: string;
  signature: string;
  capability: string;
}
export function readCapability(
  identity: Identity,
  options?: { origin?: string; ttlSeconds?: number; now?: number },
): ReadCapability;
export function readUrl(
  identity: Identity,
  options?: { origin?: string; ttlSeconds?: number; now?: number },
): string;
export function signedToolArguments<T extends Record<string, unknown>>(
  identity: Identity,
  name: string,
  args?: T,
  options?: { origin?: string; timestamp?: string; nonce?: string },
): T & {
  _auth: {
    public_key: string;
    timestamp: string;
    nonce: string;
    signature: string;
  };
};
export class MailClient {
  constructor(
    identity: Identity,
    options?: { baseUrl?: string; domain?: string; fetchImpl?: typeof fetch },
  );
  identity: Identity;
  baseUrl: string;
  address: string;
  request<T = unknown>(
    method: string,
    path: string,
    data?: unknown,
  ): Promise<T>;
  box(address?: string): string;
  create(options?: InboxOptions): Promise<Inbox>;
  configure(options?: Pick<InboxOptions, "retention_seconds">): Promise<Inbox>;
  inspect(address?: string): Promise<Inbox>;
  extend(options?: InboxOptions, address?: string): Promise<Inbox>;
  deleteInbox(address?: string): Promise<Deletion>;
  purge(address?: string): Promise<Deletion>;
  /** @deprecated Use readUrl() for a reusable GET-only mailbox snapshot. */
  signedUrl(path: string): string;
  readUrl(options?: { ttlSeconds?: number; now?: number }): string;
  list(filters?: Filters, address?: string): Promise<Page>;
  candidates(
    filters?: Filters,
    address?: string,
  ): Promise<Page<MessageSummary & { candidates: Candidates }>>;
  get(id: string, address?: string): Promise<Message>;
  deleteMessage(id: string, address?: string): Promise<Deletion>;
  wait(
    options?: Filters & { timeoutSeconds?: number; signal?: AbortSignal },
  ): Promise<Page | { messages: []; after?: string; timed_out: true }>;
}
