// Pure checks for the /pi status upgrades: context column parsing, JSONL
// usage tail, and the new status rows. Run from /root/pidiscord-fork:
//   node test/status.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'piscord-status-test-'));

const { parsePiModelList, parseContextWindow } = await import('../dist/agent/model-catalog.js');
const { readSessionUsageFromJsonl, getStickyFallback } = await import('../dist/agent/invoke.js');
const { buildStatusMessage } = await import('../dist/discord/slash-commands.js');

let failures = 0;
const check = (name, cond) => {
  console.log(cond ? `PASS ${name}` : `FAIL ${name}`);
  if (!cond) failures++;
};

// 1. pi --list-models table WITH context column.
const table = [
  'provider       model                context  max-out  thinking  images',
  'magpie         workbuddy-ai/x       1M       384K     yes       yes',
  'kiosapi        flash-2.5            128K     16.4K    no        no',
  'zai-coding-cn  glm-5.3-flash        131072   32K      yes       yes',
].join('\n');
const parsed = parsePiModelList(table);
check('1a table parsed', Array.isArray(parsed) && parsed.length === 3);
check('1b 1M window', parsed[0].contextWindow === 1_000_000);
check('1c 128K window', parsed[1].contextWindow === 128_000);
check("1d max-out column not mistaken for context", parsed[1].contextWindow !== 16_400 && parseContextWindow('16.4K') === 16_400);
check('1e raw window', parsed[2].contextWindow === 131_072);
check('1f ref intact', parsed[0].ref === 'magpie/workbuddy-ai/x' && parsed[0].reasoning === true);

// 2. Table WITHOUT context column (older pi): contextWindow stays undefined.
const parsedOld = parsePiModelList(
  'provider model thinking\nmagpie workbuddy-ai/x yes',
);
check('2 legacy table without context column', parsedOld?.length === 1 && parsedOld[0].contextWindow === undefined);

// 3. parseContextWindow edges.
check('3a empty', parseContextWindow(undefined) === undefined);
check('3b garbage', parseContextWindow('n/a') === undefined);
check('3c 200k lowercase', parseContextWindow('200k') === 200_000);

// 4. JSONL usage tail: totals + last assistant turn.
const sessionFile = join(process.env.SESSIONS_DIR, 'fake.jsonl');
writeFileSync(
  sessionFile,
  [
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({
      type: 'message',
      message: { role: 'assistant', model: 'magpie/workbuddy-ai/x', thinkingLevel: 'max', usage: { input: 100, output: 50, cacheRead: 850, totalTokens: 1000 } },
    }),
    JSON.stringify({
      type: 'message',
      message: { role: 'assistant', model: 'magpie/workbuddy-ai/x', thinkingLevel: 'high', usage: { input: 200, output: 30, cacheRead: 970, totalTokens: 1200 } },
    }),
    '',
  ].join('\n'),
);
const usage = await readSessionUsageFromJsonl(sessionFile);
check('4a totals sum all turns', usage.totals.input === 300 && usage.totals.output === 80 && usage.totals.total === 2200);
check('4b last turn context', usage.last?.contextTokens === 1200);
check('4c last thinking level', usage.last?.thinkingLevel === 'high');
check('4d last model', usage.last?.model === 'magpie/workbuddy-ai/x');

// 5. Status rows: Thinking shows session effort, Fallback model row exists.
const effective = {
  modelSource: 'default',
  displayModel: 'magpie/workbuddy-ai/deepseek-v4.1-flash',
  hasManagedThinking: false,
  thinkingSource: 'pi runtime default',
  effectiveThinking: 'off',
  requestedThinking: 'off',
  thinkingAdjusted: false,
  modelInfo: { reasoning: true, supportsXhigh: true },
  effectiveCwd: '/root',
  cwdSource: 'default',
};
const msg = buildStatusMessage(
  effective,
  { statsSource: 'jsonl', thinkingLevel: 'max', contextUsage: { tokens: 40230, contextWindow: 1000000, percent: 4.023 } },
  { channelFolder: 'ch_test' },
);
check('5a thinking shows session effort', /Thinking\s+max \(session\)/.test(msg));
check('5b fallback row with strategy', /Fallback model\s+sticky: |Fallback model\s+per-message: /.test(msg));
check('5c context renders numbers', /Context\s+40,230 \/ 1,000,000 \(4%/.test(msg));
check('5d no sticky on unknown channel', !/active:/.test(msg));

check('5e getStickyFallback empty on unknown channel', getStickyFallback('ch_unknown') === undefined);

process.exit(failures ? 1 : 0);
