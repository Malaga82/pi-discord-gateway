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
}

/** Queued message row from SQLite */
export interface QueuedMessage {
  rowid: number;
  channel_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
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
}
