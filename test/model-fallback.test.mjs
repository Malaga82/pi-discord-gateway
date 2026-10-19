// Self-check for the PI_MODEL_FALLBACKS chain in invokeAgent.
// Run from /root/pidiscord-fork:  env -u PI_MODEL -u PI_PROVIDER node test/model-fallback.test.mjs
process.env.PI_MODEL = 'nonexistent-provider/bogus-model';
process.env.PI_MODEL_FALLBACKS = 'zai-coding-cn/glm-5.3-flash';
process.env.AGENT_TIMEOUT_MS = '120000';

const { invokeAgent, clearStickyFallback } = await import('../dist/agent/invoke.js');
const { config } = await import('../dist/config.js');

const FOLDER = 'zz-fallback-test';
const BOGUS = 'nonexistent-provider/bogus-model';
let failures = 0;
const check = (name, cond) => {
  console.log(cond ? `PASS ${name}` : `FAIL ${name}`);
  if (!cond) failures++;
};

// A. per-message: bogus primary → fallback answers + notice.
config.fallbackStrategy = 'per-message';
clearStickyFallback(FOLDER);
const ra = await invokeAgent(FOLDER, 'Reply with exactly: OK', { model: BOGUS });
check('A fallback answers after bogus primary', ra.ok === true && /ok/i.test(ra.text));
check('A fallback notice names the fallback model', !!ra.modelFallbackNotice && ra.modelFallbackNotice.includes('zai-coding-cn/glm-5.3-flash'));

// B. sticky: with the fallback list emptied, the sticky fallback still answers.
config.fallbackStrategy = 'sticky';
config.fallbackStickyHours = 6;
clearStickyFallback(FOLDER);
const rb1 = await invokeAgent(FOLDER, 'Reply with exactly: OK', { model: BOGUS });
check('B1 sticky set on fallback success', rb1.ok === true);
config.piModelFallbacks.splice(0, config.piModelFallbacks.length);
const rb2 = await invokeAgent(FOLDER, 'Reply with exactly: OK', { model: BOGUS });
check('B2 sticky fallback answers with empty fallback list', rb2.ok === true);
check('B2 sticky answer still carries notice', !!rb2.modelFallbackNotice);

// E. sticky idle expiry: after AUTO_ROTATE_IDLE_HOURS of channel silence the
// sticky lapses and the primary is retried. Idle = gap between invokes.
config.autoRotateIdleHours = 1e-6; // ≈3.6ms
await new Promise((r) => setTimeout(r, 50));
const re = await invokeAgent(FOLDER, 'Reply with exactly: OK', { model: BOGUS });
check('E idle-expired sticky → primary retried and fails', re.ok === false && !!re.error && /bogus|not found/i.test(re.error));
config.autoRotateIdleHours = 6;

// C. clearStickyFallback (what /new and /model call): back to bogus → fails.
clearStickyFallback(FOLDER);
const rc = await invokeAgent(FOLDER, 'Reply with exactly: OK', { model: BOGUS });
check('C sticky cleared → fails cleanly', rc.ok === false && !!rc.error && /bogus|not found/i.test(rc.error));

// D. success on the requested primary → no notice, no sticky set.
config.piModelFallbacks.splice(0, config.piModelFallbacks.length, 'zai-coding-cn/glm-5.3-flash');
const rd = await invokeAgent(FOLDER, 'Reply with exactly: OK', { model: 'openmodel/deepseek-v4.1-flash' });
check('D primary success has no fallback notice', rd.ok === true && rd.modelFallbackNotice === undefined);
config.piModelFallbacks.splice(0, config.piModelFallbacks.length);
const rd2 = await invokeAgent(FOLDER, 'Reply with exactly: OK', { model: BOGUS });
check('D no sticky was set by primary success', rd2.ok === false);

process.exit(failures ? 1 : 0);
