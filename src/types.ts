/** Supported pi thinking levels */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** A registered channel the gateway will respond in */
export interface RegisteredChannel {
  jid: string;
  name: string;
  folder: string;
  requiresTrigger: boolean;
  isMain: boolean;
  modelOverride: string;
  thinkingOverride: ThinkingLevel | '';
  cwdOverride: string;
  parentJid?: string;
  threadMode?: 'off' | 'auto';
  managedThread?: boolean;
  deletedAt?: string;
}

/** Queued message row from SQLite */
export interface QueuedMessage {
  rowid: number;
  channel_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  status:
    | 'pending'
    | 'routing'
    | 'processing'
    | 'delivering'
    | 'done'
    | 'failed'
    | 'interrupted'
    | 'cancelled'
    | 'delivery_failed'
    | 'delivery_uncertain';
  source_message_id: string | null;
  origin_jid: string | null;
  route_thread: number;
  anchor_message_id: string | null;
  response_text: string | null;
  delivery_attempts: number;
  next_attempt_at: number;
  /** Pending user-facing notice (interrupted / delivery_uncertain / …) */
  notice_text: string | null;
  /** JSON array of attachment metadata, or null */
  attachments: string | null;
  /** Invocation attempts so far (incremented at claim; recovery gives up at max) */
  attempts: number;
}

/** Agent invocation result */
export interface AgentResult {
  ok: boolean;
  text: string;
  error?: string;
  /** pi was SIGTERM'd/SIGKILL'd (shutdown/restart/abort) — not a real failure */
  killed?: boolean;
  /** Invocation exceeded AGENT_TIMEOUT_MS (error reported, activity log preserved) */
  timedOut?: boolean;
  /** Upstream runProcess semantics (mapped from killed/timedOut equivalents) */
  reason?: 'cancelled' | 'timeout';
}
