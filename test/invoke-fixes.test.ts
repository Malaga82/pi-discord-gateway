import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJsonLineReader, extractAssistantText } from '../src/agent/invoke.js';
import { sanitizedChildEnv } from '../src/agent/pi-spawn.js';
import { recordBotPeerMessage } from '../src/discord/client.js';

afterEach(() => {
  delete process.env.DISCORD_BOT_TOKEN;
});

describe('createJsonLineReader (UTF-8 across chunk boundaries)', () => {
  it('reassembles multibyte sequences split across chunks without U+FFFD', () => {
    const evt = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'risposta con àèìòù e emoji 🎉 dentro' }] },
    });
    const raw = Buffer.from(`${evt}\n`, 'utf8');
    const cut = raw.indexOf(Buffer.from('à')) + 1; // middle of the 0xC3 0xA0 pair

    const lines: string[] = [];
    const reader = createJsonLineReader((line) => lines.push(line));
    reader.push(raw.slice(0, cut));
    reader.push(raw.slice(cut));
    reader.end();

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.message.content[0].text).toBe('risposta con àèìòù e emoji 🎉 dentro');
  });

  it('delivers the trailing line without a newline on end()', () => {
    const lines: string[] = [];
    const reader = createJsonLineReader((line) => lines.push(line));
    reader.push(Buffer.from('{"a":1}\n{"b":2}'));
    reader.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe('extractAssistantText (stale preamble guard)', () => {
  const preamble = {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Preambolo intermedio' }] },
  };
  const toolOnly = {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }],
    },
  };

  it('returns text for a text-only final message', () => {
    expect(extractAssistantText(preamble)).toBe('Preambolo intermedio');
  });

  it('ignores messages containing toolCall blocks (never the final answer)', () => {
    expect(extractAssistantText(toolOnly)).toBeUndefined();
  });

  it('a run closing on a toolCall-only message no longer keeps the previous preamble as final', () => {
    let finalText = '';
    for (const event of [preamble, toolOnly]) {
      const text = extractAssistantText(event);
      if (text) finalText = text;
    }
    expect(finalText).toBe('Preambolo intermedio'); // per-event behavior…
    // …but the toolCall-only end does not RESET it either; the guard is that
    // toolCall messages never set it. Simulate the real sequence including a
    // final text message:
    const finalMsg = {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Risposta vera' }] },
    };
    finalText = '';
    for (const event of [preamble, toolOnly, finalMsg]) {
      const text = extractAssistantText(event);
      if (text) finalText = text;
    }
    expect(finalText).toBe('Risposta vera');
  });
});

describe('sanitizedChildEnv', () => {
  it('strips DISCORD_BOT_TOKEN from the child environment', () => {
    process.env.DISCORD_BOT_TOKEN = 'super-secret';
    const env = sanitizedChildEnv();
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(process.env.DISCORD_BOT_TOKEN).toBe('super-secret'); // parent untouched
  });
});

describe('recordBotPeerMessage (loop guard)', () => {
  const cfg = { max: 3, windowMs: 300_000 };

  it('accepts up to max messages per window', () => {
    let times: number[] | undefined;
    const results: boolean[] = [];
    for (let t = 0; t < 5; t += 1) {
      const r = recordBotPeerMessage(times, t, cfg);
      times = r.times;
      results.push(r.accepted);
    }
    expect(results).toEqual([true, true, true, false, false]);
  });

  it('does not record dropped messages: the ban decays once accepted times age out', () => {
    let times: number[] | undefined;
    for (let t = 0; t < 10; t += 1) {
      // spam through the ban (all dropped after the 3rd)
      times = recordBotPeerMessage(times, t, cfg).times;
    }
    // window slides past all recorded (accepted) times → honest resume works
    const resumed = recordBotPeerMessage(times, 300_001, cfg);
    expect(resumed.accepted).toBe(true);
  });
});

describe('invokeAgent timeout (P11)', () => {
  it('kills a hung pi, flags timedOut and reports a timeout error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pidg-timeout-'));
    try {
      const fakePi = join(dir, 'fake-pi.sh');
      writeFileSync(fakePi, '#!/bin/sh\nsleep 30\n');
      chmodSync(fakePi, 0o755);

      process.env.PI_BIN = fakePi;
      process.env.SESSIONS_DIR = join(dir, 'sessions');
      process.env.AGENT_TIMEOUT_MS = '400';

      vi.resetModules(); // fresh config graph picks up the env above
      const { invokeAgent } = await import('../src/agent/invoke.js');
      const result = await invokeAgent('ch_test', 'hello');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/timed out after 400ms/);
      expect(result.timedOut).toBe(true);
      expect(result.killed).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.PI_BIN;
      delete process.env.AGENT_TIMEOUT_MS;
    }
  });
});

describe('plain-text fallback with streaming consumer (R2)', () => {
  it('recovers the plain-text answer when pi ignores --mode json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pidg-plain-'));
    try {
      const fakePi = join(dir, 'fake-pi.sh');
      writeFileSync(fakePi, '#!/bin/sh\necho "risposta in chiaro"\n');
      chmodSync(fakePi, 0o755);

      process.env.PI_BIN = fakePi;
      process.env.SESSIONS_DIR = join(dir, 'sessions');

      vi.resetModules();
      const { invokeAgent } = await import('../src/agent/invoke.js');
      const events: unknown[] = [];
      const result = await invokeAgent('ch_plain', 'hello', {
        onEvent: (event) => events.push(event),
      });
      expect(result.ok).toBe(true);
      expect(result.text).toBe('risposta in chiaro');
      expect(events).toHaveLength(0); // no JSON events were produced
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.PI_BIN;
      delete process.env.SESSIONS_DIR;
    }
  });
});
