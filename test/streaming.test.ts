import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  createStreamState,
  finalizeStream,
  pushStreamEvent,
  renderLog,
  stripDuplicateTail,
  type StreamHandle,
} from '../src/discord/streaming.js';

function makeHandle(edit: (content: string) => Promise<void>): StreamHandle {
  return {
    jid: 'dc:test',
    message: { edit: ({ content }: { content: string }) => edit(content) } as never,
    state: createStreamState(),
    lastEdit: 0,
    lastContent: '',
    editing: false,
    needsFlush: false,
    timer: undefined,
  };
}

describe('stripDuplicateTail', () => {
  it('text-only assistant messages never enter the log (no truncated dup of the delivered answer)', () => {
    const state = createStreamState();
    const longAnswer = 'Risposta finale abbastanza lunga. '.repeat(30); // ~1k chars
    applyEvent(state, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: longAnswer }] },
    });
    // The answer is delivered below as its own message; a 500-char flattened
    // copy in the activity log would be pure duplication.
    expect(renderLog(state)).toBe('');
    stripDuplicateTail(state, longAnswer);
    expect(renderLog(state)).toBe('');
  });

  it('strips multi-block answers whose LAST block is long (positional truncated match)', () => {
    const state = createStreamState();
    const shortBlock = 'Breve introduzione.';
    const longBlock = 'Conclusione dettagliata e molto lunga. '.repeat(30);
    applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
          { type: 'text', text: shortBlock },
          { type: 'text', text: longBlock },
        ],
      },
    });

    stripDuplicateTail(state, `${shortBlock}\n${longBlock}`);
    expect(renderLog(state)).not.toContain(shortBlock);
    expect(renderLog(state)).not.toContain('…');
  });

  it('preserves line structure of multi-line preamble text (no glued headers/tables)', () => {
    const state = createStreamState();
    applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
          { type: 'text', text: '# Titolo\n\n| a | b |\n|---|---|\n| 1 | 2 |' },
        ],
      },
    });
    expect(state.log.some((e) => e.text.includes('# Titolo\n| a | b |'))).toBe(true);
  });

  it('strips a line-preserved truncated entry against a flattened final answer', () => {
    const state = createStreamState();
    const longAnswer = '# Titolo\n\nRiga di risposta. '.repeat(30);
    applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
          { type: 'text', text: longAnswer },
        ],
      },
    });
    expect(state.log.some((e) => e.text.includes('\n'))).toBe(true);
    stripDuplicateTail(state, longAnswer);
    expect(renderLog(state)).not.toContain('Titolo');
  });

  it('strips a single-block final answer from the log tail', () => {
    const state = createStreamState();
    applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'La risposta completa.' }],
      },
    });

    stripDuplicateTail(state, 'La risposta completa.');
    expect(renderLog(state)).toBe('');
  });

  it('strips multi-block final answers without eating the preamble (regression: duplication)', () => {
    const state = createStreamState();
    applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
          { type: 'text', text: 'Preambolo del turno.' },
        ],
      },
    });
    applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Prima parte della risposta.' },
          { type: 'text', text: 'Seconda parte della risposta.' },
        ],
      },
    });

    stripDuplicateTail(state, 'Prima parte della risposta.\nSeconda parte della risposta.');
    const log = renderLog(state);
    expect(log).toContain('Preambolo del turno.');
    expect(log).not.toContain('Prima parte della risposta.');
    expect(log).not.toContain('Seconda parte della risposta.');
  });
});

describe('finalize vs flush race', () => {
  it('waits for an in-flight flush so the final log is never overwritten by a stale working footer', async () => {
    const contents: string[] = [];
    const pending: Array<{ content: string; resolve: () => void }> = [];
    let firstEdit = true;

    const handle = makeHandle(
      (content) =>
        new Promise<void>((resolve) => {
          contents.push(content);
          if (firstEdit) {
            firstEdit = false;
            pending.push({ content, resolve }); // flush edit stays in flight
          } else {
            resolve(); // finalize edit lands immediately
          }
        }),
    );

    await pushStreamEvent(handle, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }],
      },
    });
    // Let the throttled timer (wait=0) fire so flushNow issues its slow edit.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pending).toHaveLength(1); // flush edit in flight

    handle.needsFlush = true; // an event arrived during the in-flight edit

    const fin = finalizeStream(handle, 'RISPOSTA FINALE');
    await new Promise((resolve) => setTimeout(resolve, 5)); // finalize edit issued
    pending[0].resolve(); // the slow flush edit completes NOW, after finalize's
    await fin;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const final = contents[contents.length - 1];
    expect(final).toBe('💻 Running `ls`');
    expect(final).not.toMatch(/working/i);
  });
});

describe('renderLog', () => {
  it('collapses consecutive identical tool lines with a counter', () => {
    const state = createStreamState();
    const event = {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'read', arguments: { path: '/a' } }],
      },
    };
    applyEvent(state, event);
    applyEvent(state, event);
    expect(renderLog(state)).toBe('📖 Reading `/a` (×2)');
  });
});

describe('finalizeStream return', () => {
  it('resolves without a value (void contract)', async () => {
    const handle = makeHandle(async () => {});
    await expect(finalizeStream(handle, 'x')).resolves.toBeUndefined();
  });
});

describe('renderToolLine redaction', () => {
  it('redacts credentials inside tool arguments before they reach the channel', () => {
    const state = createStreamState();
    applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            name: 'bash',
            arguments: {
              command:
                'curl -H "Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456" https://api.example.com --data api_key=AIzaSyAbcdefGHIJKLMNOPQRSTUVWXYZ1234567',
            },
          },
        ],
      },
    });

    const log = renderLog(state);
    expect(log).not.toMatch(/ghp_[A-Za-z0-9_-]{8,}/);
    expect(log).not.toMatch(/AIza[A-Za-z0-9_-]{8,}/);
    expect(log).toContain('[REDACTED]');
    expect(log).toContain('💻');
  });

  it('redacts opaque bearer tokens after the scheme word (JWT regression)', () => {
    const state = createStreamState();
    applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            name: 'bash',
            arguments: {
              command:
                'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.abc123" https://api.example.com',
            },
          },
        ],
      },
    });

    const log = renderLog(state);
    expect(log).not.toMatch(/eyJ[A-Za-z0-9._-]{10,}/);
    expect(log).toMatch(/Authorization:\s*\[REDACTED\]/);
  });

  it('redacts space-separated secret flags and URL credentials', () => {
    const state = createStreamState();
    applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            name: 'bash',
            arguments: {
              command:
                'aws s3 ls --secret-access-key wJalrXUtnFEMIverysecretkey123 && psql postgres://admin:hunter2secret@db.host/app',
            },
          },
        ],
      },
    });

    const log = renderLog(state);
    expect(log).not.toContain('wJalrXUtnFEMIverysecretkey123');
    expect(log).not.toContain('hunter2secret');
    expect(log).toContain('secret-access-key [REDACTED]');
    expect(log).toContain('postgres://admin:[REDACTED]@');
  });

  it('leaves innocuous commands untouched', () => {
    const state = createStreamState();
    applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            name: 'bash',
            arguments: { command: 'npm run build && node dist/index.js' },
          },
        ],
      },
    });

    expect(renderLog(state)).toBe('💻 Running `npm run build && node dist/index.js`');
  });

  it('redacts secret-keyed fields in JSON-serialized object args (quoted separator regression)', () => {
    const state = createStreamState();
    applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            name: 'mcp_tool',
            arguments: { api_key: 'hunter2supersecretvalue', region: 'eu' },
          },
        ],
      },
    });
    const log = renderLog(state);
    expect(log).not.toContain('hunter2supersecretvalue');
    expect(log).toContain('[REDACTED]');
  });

  it('renders the first STRING among command/path/query/url, never [object Object]', () => {
    const state = createStreamState();
    applyEvent(state, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            name: 'custom_tool',
            arguments: { command: { nested: true }, path: '/tmp/ok.txt' },
          },
        ],
      },
    });
    expect(renderLog(state)).toContain('/tmp/ok.txt');
    expect(renderLog(state)).not.toContain('[object Object]');
  });

  it('caps accumulated thinking deltas', () => {
    const state = createStreamState();
    for (let i = 0; i < 500; i++) {
      applyEvent(state, {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'x'.repeat(100) },
      });
    }
    expect(state.thinking.length).toBeLessThanOrEqual(4000);
  });
});
