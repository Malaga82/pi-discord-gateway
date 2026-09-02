# Changelog

All notable changes to this project will be documented in this file.

## [1.8.4] - 2026-08-31

### Security

- `/pi` slash commands now default to `ManageMessages` permission (server admins can override per-channel; DMs unaffected) — `/pi new`, `/pi stop`, `/pi model` are no longer runnable by any member, and `/pi status` no longer leaks host paths to everyone.
- `piscord setup` writes the config file with `0600` permissions — it contains `DISCORD_BOT_TOKEN` (existing files: run `chmod 600` manually).
- `pi-spawn`: `where ${piBin}` shell interpolation replaced with `execFileSync('where', [piBin])` (Windows).
- `sanitizeFilename` rejects `.` and `..` so a crafted attachment name cannot escape the media directory on join.

### Fixed

- `--mode json` is pushed **before** the prompt: the debug log trims the last arg to hide the prompt, and the previous order hid only `'json'` — the user prompt was logged in clear at `LOG_LEVEL=debug` whenever streaming was on.
- `STREAMING=tools` (the documented default) no longer triggers the unknown-value warning.
- `purgeOldMessages`/archive cleanup now run once at startup, not only every 24h — a gateway restarted daily would never purge `message_queue`/`message_log`.
- `readSessionTokensFromJsonl` survives the session file vanishing between listing and reading (returns zeros instead of failing `/pi status`).
- `readLatestAgentErrorFromSession` reads only the last 64KB of the session file instead of the whole (potentially tens of MB) file on every failed invocation.
- UTF-16 surrogate-pair guard in `splitMessage` handles the `splitAt === 1` case (pair at the very start) without empty chunks or corrupted emoji.
- `/pi new` race: the queue is cleared **before** the processing re-check, closing the window where pi could claim a message and write into the just-archived session directory.
- `/pi` model-table parser skips separator rows (`────`) and truncated rows instead of creating ghost models like `────/────`.
- Multi-chunk responses that fail mid-send now notify the user the answer was truncated (with delivered/total parts) instead of silently marking the message failed.

### Performance

- `schedulePoll(0)` preempts a pending long timer instead of being ignored — the next queued message starts within the same tick after a task completes.
- `better-sqlite3` statements are cached per SQL text (`channelsWithPending` recompiled every 1s poll otherwise).
- Media cleanup walk is depth-bounded (3) instead of recursing the entire `sessionsDir` tree.

### Changed

- `MAX_SCHEDULED_CONCURRENCY` default raised 1 → 5: it only throttles enqueueing (execution is already serialized by `MAX_CONCURRENCY`), and the old default delayed a burst of due tasks by 30s each.
- CI matrix gains a non-blocking `windows-latest` job: the codebase has explicit win32 branches but 8 tests fail there today; failures are now visible without blocking merges.

## [1.8.3] - 2026-08-31

### Fixed — regressions introduced in 1.8.2

- **`stripDuplicateTail` again strips long (>500 char) answers**: condense() truncates log entries to a 500-char prefix, so a suffix-only check never matched them and every long answer appeared twice (truncated copy in the log + full answer below). Truncated entries now match positionally at their block's start (first occurrence); complete entries keep the suffix match; multi-block answers with repetitive content and the preamble-preservation case are covered by tests.
- **Plain-text fallback restored in streaming mode**: stdout is buffered until the first valid JSON event arrives (then buffering stops), so a pi that ignores `--mode json` (old binary, format change) is answered from its plain output instead of failing with "empty stdout".
- **Fence-aware `splitMessage` respects the 2000-char budget**: the closing `\n``` ` is reserved 4 chars of budget, the reopened fence reuses the original tag line (language preserved), and a degenerate split at the fence line itself can no longer make the remainder grow — which previously looped forever (OOM) on long fence-less-newline code blocks.

### Fixed / changed — follow-ups

- Agent timeout (`AGENT_TIMEOUT_MS`) reports a dedicated `timedOut` result; the queue preserves the activity log and posts an explicit ⚠️ timeout message instead of cancelling the placeholder.
- The empty first-load catalog placeholder is no longer cached, and the queue awaits the first async catalog load for a brand-new cwd — thinking clamping and model validation are no longer skipped on the very first message.
- The attachment stall watchdog is a pipeline transform stage instead of a `data` listener (no flowing-mode fragility).
- `flushNow`'s deferred reschedule now arms the timer after `editing` clears (the in-loop `scheduleFlush` call was a no-op while editing), so a late event batch during throttling is eventually rendered.
- `sendChunkWithRetry` retries only transient failures (429 / 5xx / network); 400/403 fail fast.

## [1.8.2] - 2026-08-31

### Fixed — response correctness

- **UTF-8-safe JSONL parsing**: pi subprocess output is decoded through `StringDecoder`, so a multibyte sequence split across chunk boundaries no longer corrupts the delivered answer with U+FFFD (agent streaming path and RPC stats path).
- **Stale preamble no longer delivered as the answer**: `message_end` events containing toolCall blocks are never treated as the final answer, so a run closing on a toolCall-only message can't resurrect the previous turn's preamble.
- **Streaming race fixed**: `finalizeStream`/`cancelStream` set a done flag and await any in-flight flush, and the flush loop stops once done — the final activity log can no longer be buried under a permanent "⏳ working" footer when an edit is in flight at completion time.
- **Multi-block final answers no longer duplicated**: `stripDuplicateTail` pops trailing text entries while their concatenation remains a suffix of the final answer, instead of requiring a single-block prefix match.
- **Empty catalog no longer cached on table-format changes**: `parsePiModelList` returns `undefined` when no table header is recognized (falls back to the SDK catalog); a valid header with zero rows stays authoritative-empty.

### Fixed — availability & robustness

- **Agent invocation timeout** (`AGENT_TIMEOUT_MS`, default 30 min, 0 disables): a hung pi is killed and reported as an error instead of holding the channel lock, a concurrency slot and the typing loop forever. Killing also destroys the stdio pipes so grandchildren holding them can't delay resolution.
- **No more event-loop blocking catalog loads**: the first load for a cwd serves an empty placeholder and fills asynchronously (the model ref still passes through raw); slash-command refreshes use the async loader instead of `setImmediate`+sync spawn; startup warming runs in parallel.
- **Failed catalog refresh backs off**: a broken `pi --list-models` keeps the previous models and bumps `loadedAt`, retrying at most once per TTL instead of once per message.
- **Bot-peer loop guard no longer self-aliments**: dropped messages are not recorded, so the ban decays once the recorded (accepted) timestamps age out of the window.
- Self-message guard: the bot never processes its own messages, even if its own ID is misconfigured into `ALLOW_BOT_PEERS`.
- SIGKILL escalation timers are cleared on process close (no lingering 5s event-loop holds after aborts).
- Reply-context REST fetch happens only when it can affect the outcome (trigger bypass) or the message is enqueued anyway — no wasted API call per reply in unregistered/non-triggered channels.
- Attachment downloads use a 30s stall watchdog (progress resets it) instead of a total-duration timeout, so slow-but-flowing transfers are no longer aborted.
- `piscord daemon install` generates `rm -rf` before each `ln -sfn`, so a pre-existing real directory at the peer-symlink path is replaced instead of nesting the symlink inside itself.
- `piscord register` rejects unknown options (consistent with `task add`) instead of ignoring them silently.
- `DISCORD_BOT_TOKEN` is stripped from the environment of every spawned pi subprocess (pi can run `bash`).
- `engines` raised to `>=20.3` (`AbortSignal.any` requirement).

### Changed — performance & hygiene

- Streaming mode no longer double-buffers stdout (the plain-text fallback buffer is skipped when JSON events are consumed).
- Windows `.cmd` shim resolution is cached per `piBin`.
- pi `enabledModels` patterns are cached per cwd with the catalog TTL instead of reading settings on every autocomplete keystroke.
- `message_queue` (done/failed) and `message_log` rows are purged daily after `ARCHIVE_RETENTION_DAYS` (0 = never), keeping the per-second pending group-by bounded.
- `STREAMING_UPDATE_MS` minimum raised to 1200ms (Discord allows ~5 edits/5s per channel; lower values just earned silent 429s).
- Unknown `STREAMING` values now log a warning instead of silently falling back to `tools`.
- Multi-chunk responses retry a failed chunk once after a pause (rate-limit recovery) before surfacing the error.
- `splitMessage` keeps ``` fences balanced across chunk boundaries.
- `finalizeStream` is now `Promise<void>` (the boolean return was always false and unused).

### Tests

- New suites: streaming (race, duplicate-tail, render), invoke (UTF-8 reader, stale-preamble guard, timeout, sanitized env), bot-peer loop guard, DB retention, fence-aware splitting; model-catalog gains first-load/backoff/patterns-cache cases. 87 tests passing.

## [1.8.1] - 2026-08-31

### Fixed

- **Model catalog no longer blocks the event loop on the message path**: an expired catalog cache is now served stale while `pi --list-models` revalidates in a background subprocess, and the async `ModelRuntime` initialization no longer drops warmed caches (previously it cleared them, forcing the next message into a ~3s blocking sync load and risking Discord heartbeat stalls).
- **`piscord daemon install` regenerates the `ExecStartPre` peer symlinks**: the generated systemd unit now (re)creates the `@earendil-works/pi-coding-agent` / `pi-ai` symlinks with absolute paths, so a pi upgrade no longer breaks the service on restart when piscord is installed under `~/.pi/agent/npm/node_modules`.
- Slash command failures no longer leak raw error messages (which could contain absolute host paths) to Discord users; details stay in the gateway log.
- `piscord task add` rejects schedules for unregistered channels instead of silently failing on every run.
- Long responses are split at chunk boundaries without cutting UTF-16 surrogate pairs in half (no more corrupted emoji at the 2000-char split point).
- `piscord register --folder` / `--cwd` without a value now fail loudly instead of being silently ignored.
- Bot-peer loop guard state map is swept once it grows past 1000 peer×channel keys (slow memory growth).
- Live status footer says `iteration N` instead of the hardcoded Italian `turno N`.

### Changed

- Unit tests for the model catalog migrated to the `ModelRuntime` test hook (`__setCachedModelRuntimeForTests`); the old `AuthStorage.create` / `ModelRegistry.create` spies no longer exist in current pi releases (10 tests were failing).

## [1.8.0] - 2026-08-30

### Added

- **Live activity streaming** — while pi works, the gateway posts a live message showing a Hermes-style chronological activity log (tool calls with emoji + verb + short arg, interleaved interstitial commentary) and optionally the streamed response tail. Modes via `STREAMING`: `off` (classic single-shot), `tools` (activity log, default), `full` (log + thinking + streamed text). Throttle via `STREAMING_UPDATE_MS` (default 2000). The final answer is always delivered as its own message below the log; on `pi` shutdown/restart the activity log is preserved instead of showing an error.
- **Bot-to-bot communication** — whitelisted peer bots can trigger the agent by @mentioning it, enabling multi-agent workflows (e.g. pi ↔ Hermes agent). Config: `ALLOW_BOT_PEERS` (comma-separated Discord user IDs; empty = ignore all bots, upstream default). Follows the `allowBots=mentions` pattern established by OpenClaw and Hermes-agent.
- **Bot-peer loop guard** — two chatting bots can no longer ping-pong indefinitely: a sliding window per (peer, channel) drops messages once `BOT_LOOP_MAX` (default 10) exchanges occur within `BOT_LOOP_WINDOW_MS` (default 5 minutes). Pattern from OpenClaw's bot loop protection.
- Reply-to-bot now counts as a trigger in `open-trigger` channels, so replying to a bot message continues the conversation without re-mentioning.

### Changed

- pi is invoked with `--mode json` when a streaming consumer is attached; the JSONL event stream is parsed incrementally and falls back to legacy plain-text handling when no valid events are produced.
- `AgentResult` gained a `killed` flag: SIGTERM/SIGKILL exits (143/137) during shutdown/restart are no longer reported as agent errors.
- Model catalog rewritten around pi's `ModelRuntime` API (pi ≥ 0.84.4) with graceful fallback when the SDK runtime is unavailable; dev dependencies bumped accordingly.

## [1.7.0] - 2026-07-17

### Changed

- Discord `/pi model` now reads the model catalog from the configured pi binary (`PI_BIN --list-models`) and honors pi's configured `enabledModels` scope, including glob patterns and configured order. The bundled SDK catalog is used only as a fallback when the command fails.
- Model catalogs are prewarmed at startup for all registered channel working directories. `/pi model` autocomplete responds from the cache to stay inside Discord's response deadline and refreshes expired catalogs in the background.
- `PI_EXTRA_FLAGS` is now passed to model discovery as well, so models registered by pi extensions appear in the catalog.

### Fixed

- Model discovery via `pi --list-models` is bounded by a 15s timeout, so a hung pi install can no longer block gateway startup or slash commands.
- The model list parser now locates the table header instead of assuming it is the first output line, so banners printed by pi extensions no longer result in an empty catalog.
- `/pi model` autocomplete in unregistered channels returns no choices without spawning pi.

## [1.6.1] - 2026-06-15

### Fixed

- Remove stale hardcoded README current-version text so npm/GitHub documentation does not show an outdated release number.

## [1.6.0] - 2026-06-15

### Changed

- Discord attachments are now passed to `pi` by local file path instead of being injected with `@file`. This keeps binary and structured files such as DOCX, XLSX, PDFs, and images out of the model context while still letting the agent inspect or convert them with tools.
- Downloaded attachment media is retained for a configurable period so path-based agent workflows can continue after the initial message. New config: `MEDIA_RETENTION_HOURS` (default: `168`, one week).

### Fixed

- Empty stdout from `pi` no longer becomes an unhelpful `(empty response)` Discord reply. piscord now reports the recorded agent/session error when available, including context-window errors such as `context_length_exceeded`.
- Prevent large or binary attachments from flooding the model context and causing repeated empty responses in the affected channel session.

## [1.5.3] - 2026-05-19

### Fixed

- Fix false `Required peer dependency @earendil-works/pi-ai is not installed` startup error when resolving ESM-only pi packages — thanks @kojira (#10), @hritique (#8)
- Fix cross-platform test failures: config path assertions now use platform-aware defaults instead of hardcoded Linux/XDG paths — thanks @hritique (#9)

## [1.5.2] - 2026-05-16

### Changed

- Refresh README presentation for npm/GitHub with banner, badges, and updated project summary

## [1.5.1] - 2026-05-15

### Added

- Startup check for legacy `@mariozechner/pi-ai` — users on the old package now get a clear upgrade message instead of a module-not-found crash

## [1.5.0] - 2026-05-15

### Added

- macOS launchd support for `piscord daemon` commands — thanks @that-yolanda (#6)
- Windows compatibility for pi subprocess spawning (dynamic .cmd shim resolution)
- Windows `SIGBREAK` signal handling for graceful shutdown
- Cross-platform executable lookup (`where` on Windows, `which` on Linux/macOS)

### Changed

- Migrate pi dependencies from `@mariozechner/*` to `@earendil-works/*` scope (pi v0.74.0+)
- Platform-aware default paths: XDG on Linux, `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows
- Build script now works cross-platform (replaced `rm -rf` with Node.js `fs.rmSync`)
- Help text uses platform-neutral wording for daemon commands

### Fixed

- `piscord status` no longer crashes on macOS/Windows (removed unconditional systemctl dependency)
- `which` command replaced with cross-platform executable lookup in setup and status

## [1.4.3] - 2026-05-03

### Fixed

- Restore startup compatibility with @mariozechner/pi-ai 0.72.x thinking level APIs
- Keep legacy @mariozechner/pi-ai compatibility by falling back to the older `supportsXhigh` helper when available

## [1.4.2] - 2026-04-06

### Fixed

- Align default runtime XDG data directory with setup and docs to use `~/.local/share/piscord-gateway`
- Add regression coverage for default `DB_PATH` and `SESSIONS_DIR` resolution

## [1.4.1] - 2026-04-06

### Fixed

- Support text-only sends via `piscord send` without requiring file attachment

## [1.4.0] - 2026-04-06

### Added

- Per-channel working directories - override `PI_CWD` for specific channels without changing the global default

### Changed

- Group task and file relay tools documentation for pi users

## [1.3.0] - 2026-04-04

### Added

- Improved setup UX with faster install and default trigger

### Fixed

- Remove JSON.stringify quoting in systemd service file

## [1.2.0] - 2026-04-04

### Added

- Channel access policy (open / open-trigger / allowlist)
- `/pi stop` command to abort active task and clear queue
- Archived session auto-cleanup with configurable retention
- Scheduled tasks via CLI and scheduler engine
- Direct send-file CLI tool for Discord channels
- Per-channel model override via `/pi model`
- Thinking level control via `/pi thinking`
- Fresh session via `/pi new`

## [1.1.0] - 2026-03-31

### Changed

- Renamed package and CLI to piscord

## [1.0.0] - 2026-03-28

### Added

- Initial release
- Discord message to pi subprocess bridging
- Per-channel persistent sessions
- SQLite message queue
- Discord slash commands
- Attachment relay
- systemd integration
