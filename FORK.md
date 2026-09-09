# Fork Notes (Gaaaavin/openchamber)

Personal fork of [openchamber/openchamber](https://github.com/openchamber/openchamber)
for small, personal UX tweaks. Upstream stays the source of truth; this fork is a
thin, linear patch series on top of it.

This file is the hand-off document for humans and agents. Read it together with
`.claude/context/conventions.md` before doing anything in this repo. Upstream's
own `AGENTS.md`, `CONTRIBUTING.md`, and `.claude/skills/` still apply to code
changes.

## Why a fork, not PRs

Upstream is contribution-friendly but bottlenecked: one maintainer merges ~85% of
PRs, ~50+ PRs sit at `review:ready` waiting for a human, and the PR contract
(intent/non-goals/evidence/skills-read) costs ~15 min per PR. Our changes are
personal preferences (error wording, TPS readout, ...) that upstream may reject.
Rule: **bug fixes go upstream as PRs; preference features live here.** Anything
merged upstream is dropped from the patch series on the next rebase.

## Deployment model

Surfaces in use: **macOS Desktop (Apple Silicon)**, both for local projects and,
later, for remote servers via Settings -> Remote Instances.

Where the UI comes from (verified in source):

| Desktop mode | UI served by | Fork patches visible when |
|---|---|---|
| Local project | in-process `startWebUiServer()` serving the UI bundled in the app (`packages/electron/main.mjs:1576`) | the **desktop app** is a fork build |
| Remote Instance | window navigates to `http://127.0.0.1:<ssh-forwarded port>`; HTML/JS come from the **remote** `@openchamber/web` (`packages/ui/src/components/sections/remote-instances/RemoteInstancesPage.tsx:1267-1274`) | the **remote** `@openchamber/web` is the fork tgz, and the instance is in **external** mode (managed mode re-installs `@openchamber/web@<desktop version>`, `ssh-manager.mjs:1071-1073, 1234`) |

Therefore the fork ships two artifacts per release:

1. **Desktop**: ad-hoc-signed, un-notarized `OpenChamber-<ver>-mac-arm64.zip`,
   distributed through a personal Homebrew tap (`Gaaaavin/homebrew-tap`, cask
   `openchamber-xinhao`). No Apple Developer ID needed: the cask strips the
   quarantine attribute in `postflight_steps`, so Gatekeeper never evaluates
   the app, and `brew upgrade` replaces the whole `.app`, so Squirrel.Mac's
   signature check (which blocks unsigned `electron-updater` on macOS) is
   never involved.
2. **Web**: `openchamber-web.tgz` for remote servers.

Gatekeeper mechanics (verified against Homebrew 6.0.22 source, 2026-09-05):

- Homebrew 6 removed `--no-quarantine`; `HOMEBREW_CASK_OPTS=--no-quarantine`
  is silently ignored. A quarantined ad-hoc app shows "app is damaged, move
  to Trash" on first launch, fixable only via System Settings -> Privacy &
  Security -> Open Anyway.
- Homebrew's replacement is approval inheritance on `brew upgrade`: the
  user-approved bit (`0x0040` in `com.apple.quarantine`) is copied to the new
  version when it satisfies the old version's designated requirement. An
  ad-hoc signature's designated requirement is `cdhash H"..."`, new on every
  build, so inheritance always reports "signer changed" for this fork. Making
  the requirement stable (`--requirements '=designated => identifier
  "dev.openchamber.desktop"'` via an `afterSign` hook) would let inheritance
  work after one manual approval; not done, the postflight strip makes it moot.
- The strip runs on install and upgrade, and inside Homebrew's step sandbox
  (`/Applications` is writable there). Verified with a throwaway cask
  installing the same zip under another name: 0 quarantine attributes left,
  versus 1687 on an install done before the fix.

Known costs of ad-hoc signing: every build has a new code identity. Notification
permission (keyed by bundle id) persists; signature-keyed TCC grants
(Accessibility, Screen Recording) would reset per upgrade, but OpenChamber does
not appear to request them. No `safeStorage`/`keytar` use was found in
`packages/electron`, so the usual "Keychain prompt after every update" of
unsigned Electron apps is not expected (inferred, not tested).

Upgrade path to a fully silent in-app updater later: buy an Apple Developer ID,
restore the signing/notarize steps from upstream's
`.github/workflows/build-macos-arm64-dmg.yml` (secrets `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`),
and re-enable `autoUpdater` pointed at this fork. Nothing else changes.

## Branch layout

```
main    pure mirror of upstream/main   (bot: ff-only, never commit here)
xinhao  default branch; linear patch series rebased onto main
```

Local setup (already done on the dev Mac):

```bash
git remote -v
#   origin    https://github.com/Gaaaavin/openchamber.git
#   upstream  https://github.com/openchamber/openchamber.git
git switch xinhao
```

`origin` uses SSH (`git@github.com:Gaaaavin/openchamber.git`). The HTTPS
route through `gh auth` lacks the `workflow` scope and GitHub rejects pushes
that touch `.github/workflows/` over it. If SSH:22 is blocked on some network,
use `ssh.github.com:443` rather than switching back to HTTPS.

Manual sync (until the bot exists):

```bash
git fetch upstream main --tags
git switch main && git merge --ff-only upstream/main && git push origin main
git switch xinhao && git rebase main && git push --force-with-lease origin xinhao
```

Enable `git config rerere.enabled true` locally so recurring conflict
resolutions are remembered.

`README.md` is fork-owned: the fork replaces it with install instructions and
a link to upstream, and upstream edits it about weekly. To rebase without a
conflict every time, git needs a merge driver that keeps the fork version.
The sync workflow sets it up per run; on a local clone do it once:

```bash
echo 'README.md merge=fork-owned' >> "$(git rev-parse --git-common-dir)/info/attributes"
git config merge.fork-owned.driver 'cp %B %A'
```

It lives in `.git/info/attributes`, not in the versioned `.gitattributes`:
during a rebase git reads attributes from the upstream side, which has no
such entry, so a versioned attribute never fires (tested). Verified with a
simulated upstream README edit: rebase clean, fork README kept, unrelated
upstream changes kept, all patches replayed.

Discipline: commit directly to `xinhao`, `git pull --rebase` before starting
work, and do not leave unpushed commits on `xinhao` overnight once the sync
bot is live (it rewrites history).

## Patch series (keep in order; one commit per patch)

| # | Patch | Files | Status |
|---|-------|-------|--------|
| 0a | Fork workflow `fork-sync.yml` (sync + release + cask bump in one file) | `.github/workflows/fork-sync.yml` | DONE |
| 0b | Desktop seams: ad-hoc signed build (`--config.mac.identity=-`, `--config.mac.notarize=false`, `--config.extraMetadata.forkRelease=<tag>`); `electron-updater` off behind `ELECTRON_UPDATER_ENABLED`; update check reads this fork's GitHub releases. The Update button runs `brew update` and `brew fetch` with live status, then starts a detached `brew upgrade --cask openchamber-xinhao` that quits and reopens the app. Output from the detached phase goes to `brew-upgrade.log` beside `main.log`; the handoff confirms quit first so Homebrew's AppleScript quit bypasses the dialog while normal background-service cleanup still runs. | `packages/electron/fork-release.mjs`, `fork-brew-upgrade.mjs` (+ tests), narrow `// FORK:` seams in `packages/electron/main.mjs`, `packages/ui/src/lib/desktop.ts`, and `packages/ui/src/components/ui/UpdateDialog.tsx`; `packages/ui/src/components/ui/fork/HomebrewUpdatePanel.tsx` | DONE |
| 0c | Web seams: update check + `openchamber update` target this fork's release tgz instead of npm `@openchamber/web` | `packages/web/server/lib/package-manager.js:12-22, 123-161, 657-667, 684-702, 751-797` | TODO (needed only before the first remote server; until then README says to re-run `npm install -g <tgz url>`) |
| docs | `README.md` replaced with install instructions + link to upstream; fork-owned via merge driver (see Branch layout) | `README.md`, `fork-sync.yml` rebase step | DONE |
| 1 | Reply-wait notice: replaces the red "OpenCode did not start a reply" guess with a connection-aware waiting state (2 s muted spinner → 20 s server-confirmed warning with Send again / Check again / Status report). Fixes upstream's `completed ?? created` timestamp bug that made the 5 s grace 0 s for optimistic messages. Status report gains connection phase + viewed-session local/server status | `packages/ui/src/components/chat/fork/SessionErrorNotice.tsx` (+ test), `packages/ui/src/lib/i18n/messages/fork.i18n.ts`, one import seam in `ChatContainer.tsx:32`, 2 lines per locale file, `// FORK:` block in `lib/openCodeStatus.ts` | DONE |
| 2 | Live TPS readout in the floating "working" chip above the composer (`StatusRow`), shown only while the assistant works. Port of JDScript/opencode `fork-tps` (itself a port of the MIT `opencode-tps` TUI plugin, commit `3ecf08a82` there): 1.5 s burst gap, UTF-8 bytes / 5 estimate, dash when nothing is generating. Deviations from the plugin, both tuned after real use: 15 s window (not 5 s) and a 3 s time-constant EMA on the displayed value (`WINDOW_MS`, `SMOOTHING_TAU_MS` in `tps-math.ts`). Fed from sync-store text growth, no per-delta re-render, 1 Hz tick | `packages/ui/src/components/chat/fork/LiveTps.tsx`, `fork/tps-math.ts` (+ tests), 2 `// FORK:` lines in `StatusRow.tsx`, keys `fork.tps.*` in `fork.i18n.ts` | DONE |
| 3 | Revert gate: one revert/undo/redo mutation per session at a time. Upstream set the `session.revert` marker and the composer text optimistically with no pending state, so a second click (or a `session.updated` echo from the abort revert itself issues, which replaces the local session wholesale) bounced the reverted tail between the composer and the message list. Now every entrypoint (message button, timeline, dock restore/redo, `/undo`, `/redo`) is wrapped in `gatedRevert`; later calls during the window are dropped, the revert buttons are disabled with a spinner on the clicked one, the dock shows "Reverting…"/"Restoring…", and the event reducer keeps the local `revert` field while our own request is in flight (the SDK response or rollback ends the window) | `packages/ui/src/sync/fork/revert-gate.ts` (+ test); `// FORK` lines in `sync/session-ui-store.ts`, `sync/event-reducer.ts`, `chat/message/MessageBody.tsx`, `chat/ChatMessage.tsx`, `chat/TimelineDialog.tsx`, `chat/composer/ui/RevertedMessageDock.tsx`; keys `fork.revert.*` | DONE |
| 4 | Subagent sessions promptable by default (`allowPromptingSubagentSessions: true`). Lets the user open a child session and stop or steer it directly. Existing installs keep whatever value is already persisted (the whole settings slice is written on every change), so flip the checkbox once under Settings → OpenChamber on machines that ran the fork before this patch | one line in `packages/ui/src/stores/useUIStore.ts` | DONE |
| 5 | Qwen3-ASR 0.6B int8 is the default local dictation model. It runs through the existing sherpa-onnx worker, uses Apple Silicon performance cores, and keeps Parakeet and Whisper selectable | dictation catalog/recognizer/worker and docs in `packages/web`; Voice Settings model copy and default in `packages/ui`; `sherpa-onnx-node` 1.13.7 | DONE |
| 5b | Prevent long Qwen3-ASR transcript truncation with per-model 30/60 s segmentation and a 2048-token context; retain 200 ms relative-quiet pause detection | `packages/web/server/lib/dictation/` catalog, worker client, stream manager, audio helper, recognizer, tests, and docs | DONE |
| 5c | Committed segments shown live in the recording overlay; Qwen3 segments 15/30 s | `packages/ui/src/components/dictation/fork/DictationLiveTranscript.tsx` (+ test), `// FORK:` seams in `ComposerDictation.tsx`, comment updates in `packages/ui/src/hooks/useDictation.ts`; `packages/web/server/lib/dictation/local/model-catalog.js` (+ test), `packages/web/server/lib/dictation/DOCUMENTATION.md` | DONE |
| 6 | One OpenCode instance per project, not per directory OpenChamber has ever heard of. OpenCode keeps a ~1 GB in-process instance for every distinct directory it is asked about and never releases it; upstream bootstrapped every git worktree of every project at page load, plus a lowercase phantom of each path (case-sensitive Linux), plus the server's cwd. Now: worktrees are still discovered and shown, but only bootstrapped when a session in them is selected; paths keep their case; per-directory bootstrap reads pass `{ directory }` (upstream sent `config.get`/`path.get`/`session.status`/`command`/`mcp`/`lsp`/`vcs` bare, so every child store was actually reading the cwd instance); the proxy defaults `x-opencode-directory` to the active project when a request has neither header nor `?directory=` (the global session list can only be scoped that way — a query would filter it); permission auto-accept no longer lists `/permission` without a directory; closing a project or idle-evicting its child store calls `POST /instance/dispose` unless the directory is active or has a busy session. Verified against a real `opencode serve` with 7 projects + 2 worktrees: 7 instances, no worktree/cwd/phantom, `disposing instance` on project close | `packages/ui/src/sync/fork/instance-dispose.ts` (+ test); `// FORK:` seams in `sessionBootstrapDemands.ts`, `useSessionListSync.ts`, `sessionListDirectories.ts`, `sessionCollection.ts`, `SessionProjectCollection.tsx`, `sync/bootstrap.ts`, `sync/child-store.ts` (`evictDirectory`), `sync/sync-context.tsx`, `stores/useProjectsStore.ts`; server: `lib/opencode/proxy.js` default-directory middleware, `lib/permission-auto-accept/runtime.js`. Upstream PR candidates: the lowercase phantom, the bare bootstrap reads, the bare `/permission` list | DONE |
| 7 | Control mutations survive a dead link. Upstream gives POSTs no timeout at all (`lib/opencode/client.ts` only bounds non-POST reads at 30 s), so on a half-open SSH tunnel Stop did nothing visible and could be clicked N times (N abort requests, errors swallowed), a revert stayed "Reverting…" forever, and permission/question cards stayed disabled. The revert gate is now a per-session × per-kind gate (`revert`/`unrevert`/`abort`) that also owns a 20 s `AbortSignal` deadline (`CONTROL_MUTATION_DEADLINE_MS`; abort/revert are idempotent, so a client-side deadline is safe — the request may still land, and the next status/session event reconciles). Stop is gated: spinner + "Stopping…" in the button and the working chip, repeated clicks dropped, any rejection shows a neutral "Stop didn't get through" toast (upstream showed nothing). Revert/unrevert reject at the deadline → existing rollback runs + neutral toast. Permission and question replies get the same deadline (no gate; the cards already dedup) and a neutral toast on the deadline path. A send issued while a revert is pending now waits for the gate (`waitForPending`) instead of racing it server-side, and the send button is disabled meanwhile. `session.prompt`/`summarize` deliberately get no deadline (long-running; upstream has ambiguous-failure reconciliation). Client guesses are never styled as errors: all toasts are `toast.warning` | `packages/ui/src/sync/fork/revert-gate.ts` (+ test), `fork/control-mutation-toast.ts`; `// FORK` seams in `sync/session-ui-store.ts`, `sync/session-actions.ts`, `lib/opencode/client.ts` (optional `signal` on `getSessionMessages`/`revertSession`), `composer/ui/ComposerActionButtons.tsx`, `composer/ui/ComposerFooter.tsx`, `StatusRow.tsx`, `PermissionCard.tsx`, `QuestionCard.tsx`, `hooks/useKeyboardShortcuts.ts`, 2 lines in `ChatInput.tsx`; keys `fork.abort.*`, `fork.revert.timeout.*`, `fork.reply.timeout.*` | DONE |
| 8 | SSH keepalives on every long-lived ssh the desktop spawns (ControlMaster, forwarding connection, Windows independent connections): `ServerAliveInterval=15 ServerAliveCountMax=3 TCPKeepAlive=yes`. Without them a half-open tunnel sat until the OS TCP timeout (minutes) while the Electron monitor kept probing the *local* forwarded port, which ssh keeps accepting, so it reported healthy. Now ssh exits within ~45 s and the existing process-exit path reconnects. User-supplied options stay first in argv, so a user value wins (OpenSSH takes the first occurrence). Remote one-shot commands are untouched | `packages/electron/fork-ssh-keepalive.mjs` (+ test), one import + one call seam in `ssh-manager.mjs` (`spawnSsh`) | DONE |
| 9 | Connection indicator: a floating pill at the top of the chat column, "Connection lost · reconnecting… Ns", shown once the event stream has been down ≥ 1.5 s after a successful connection (`hasEverConnected && connectionPhase === 'reconnecting'`; never during initial `connecting`), 1 Hz elapsed counter while visible, "Reconnected" flash for 2 s on recovery, nothing for blips shorter than the delay. Upstream desktop/web had no global indicator — only the per-message reply-wait notice said "Reconnecting", and only when a message was waiting, so the rest of the UI looked healthy and the user kept clicking. Muted glass styling, not error-styled (transport state observed by the client). Zero layout shift (absolute over the `data-composer-bound` column, pointer-events pass through). The reply-wait notice now says "Your message is waiting for the connection" while disconnected instead of repeating "reconnecting" | `packages/ui/src/components/chat/fork/ConnectionIndicator.tsx` (+ test); one import + one JSX seam in `ChatContainer.tsx`; wording change in fork `SessionErrorNotice.tsx` (+ test); keys `fork.connection.*`, `fork.replyNotice.waitingForConnection` | DONE |

Keep patches out of hot files where possible; prefer new files and narrow,
`// FORK:`-marked seams (same approach as JDScript/opencode). Prefer build-time
`--config` overrides in the workflow over editing `packages/electron/package.json`.

## Release scheme

- Keep every `package.json` version identical to upstream (fewer conflicts).
- Tag fork releases `v<upstream>-xinhao.<yyyymmddHHMM>-<sha>` (JDScript style).
- Cask version `"<upstream>,<yyyymmddHHMM>"` so Homebrew's comparison stays
  monotonic; url built from `version.before_comma` / `version.after_comma`.
- Assets per release: `OpenChamber-<upstream>-mac-arm64.zip` (+ `.dmg` as a
  by-product), `openchamber-web.tgz` (stable name for
  `releases/latest/download/`), plus versioned copies.
- Fork release notes record the upstream merge-base commit and the fork HEAD.

## Homebrew tap

Repo `Gaaaavin/homebrew-tap`, file `Casks/openchamber-xinhao.rb`, modelled on
`Homebrew/homebrew-cask/Casks/o/openchamber.rb`:

- `url` -> this fork's release zip; `sha256` bumped by the release workflow
  (needs a PAT or deploy key with write access to the tap repo, stored as a
  secret in this repo).
- `app "OpenChamber.app"`, same `appId dev.openchamber.desktop`, so settings,
  Remote Instance config, and caches carry over from an upstream install.
- `conflicts_with cask: "openchamber"`.
- **No** `auto_updates true` (upstream has it), so plain `brew upgrade` picks
  the cask up without `--greedy`.
- `uninstall quit: "dev.openchamber.desktop"` so upgrades quit the app first
  (Homebrew 6 reopens it afterwards).
- `postflight_steps` runs `xattr -dr com.apple.quarantine` on the installed
  app (see "Gatekeeper mechanics" above). Legacy `postflight do ... end`
  blocks fail `brew style`; only the declarative `*_steps` form is accepted.
- The in-app Update button refreshes Homebrew, fetches the cask, and hands the
  install to a detached `brew upgrade` process. The first release containing
  this flow cannot test its own replacement until the tap publishes a newer
  release.

User-side install:

```bash
brew tap Gaaaavin/tap
brew trust --cask gaaaavin/tap/openchamber-xinhao   # Homebrew 6 refuses untrusted third-party casks
brew uninstall --cask openchamber   # if the upstream cask was installed; delete /Applications/OpenChamber.app if installed from DMG
brew install --cask openchamber-xinhao
brew upgrade                        # later; optional: `brew autoupdate start` for a launchd timer
```

Switching back to upstream: `brew uninstall --cask openchamber-xinhao && brew install --cask openchamber`.

## Automation to build (`.github/workflows/`)

Fork repos have Actions disabled by default; enable Actions, then
`gh workflow disable` every inherited upstream workflow (17 files) so
force-pushes to `xinhao` trigger nothing but ours. The fork is public, so
Actions minutes (including macOS runners) are free.

`fork-sync.yml`

- `on: schedule` (every 6h) + `push` to `xinhao` (ignoring `**.md`,
  `.claude/**`, `.agents/**`, so a fork patch ships without waiting for
  upstream) + `workflow_dispatch` (with a `force_release` input).
- Secret `TAP_PUSH_TOKEN` (fine-grained PAT, Contents: read/write on
  `Gaaaavin/homebrew-tap`) is required for the cask bump; without it the
  release still publishes and the run ends with a warning.
- Job `sync` (ubuntu): fetch upstream; ff `main`; `git rebase main` on `xinhao`
  (with `rerere` cache restored via `actions/cache`); on success
  `push --force-with-lease`; outputs `changed`, `upstream_version`, `sha`.
  On conflict: `rebase --abort`, create/update a single issue titled
  `rebase conflict` listing conflicting files, exit non-zero, leave `xinhao`
  untouched.
- Job `web` (ubuntu, `needs: sync`, `if: changed || force_release`):
  `bun install`, `bun run pack:web`, upload `openchamber-web.tgz` to the
  release (create the release as draft in `sync`, publish after both build jobs
  succeed).
- Job `mac` (macos-15 arm64, same condition): copy the steps of upstream
  `build-macos-arm64-dmg.yml` minus certificate import and notarization; env
  `CSC_IDENTITY_AUTO_DISCOVERY=false`; electron-builder overrides
  `--config.mac.identity=-` (ad-hoc; `null` skips signing and arm64 macOS then
  refuses to launch the app), `--config.mac.notarize=false`,
  `--config.extraMetadata.forkRelease=<tag>` (read by `fork-release.mjs` to
  compare against the latest fork release); upload zip + dmg to the release;
  compute sha256; check out `Gaaaavin/homebrew-tap`, rewrite
  `Casks/openchamber-xinhao.rb` (`version`, `sha256`), commit and push.
- Pushes by `GITHUB_TOKEN` do not trigger other workflows, so build jobs must
  live in this workflow (or be dispatched via the API), not in `on: push`.

## Open tasks (in order)

Done (2026-09-05): `xinhao` pushed and set as default branch; Actions enabled.
GitHub does not register workflows until a push touches `.github/workflows/`,
so `gh workflow disable` for the 17 inherited files runs right after
`fork-sync.yml` is pushed and before its first dispatch. Until then, never push
a `v*` tag (`release.yml`, `vscode-extension.yml`) or a commit to `main`
(`docs-source.yml`, `label-merge-conflict.yml`).

1. Create `Gaaaavin/homebrew-tap` with a first `Casks/openchamber-xinhao.rb`
   (can point at an upstream zip initially to validate the cask syntax with
   `brew audit --cask`/`brew style`).
2. Patch 0b: done. Local build verified (`codesign --verify --deep --strict`
   passes, `Signature=adhoc` with `runtime` flag, entitlements applied,
   `forkRelease` present in the packaged package.json). A live launch was not
   possible because the upstream app was running and holds the single-instance
   lock; the first `brew install` in step 3 is the launch test.
3. Patch 0a: done. First release `v1.22.2-xinhao.202609052033-f183e06`
   published with zip, dmg, and both tgz names; its cask bump was done by hand
   because `TAP_PUSH_TOKEN` did not exist yet. Remaining, in order:
   - Create the secret: fine-grained PAT, repository `Gaaaavin/homebrew-tap`,
     permission Contents: read and write, no expiry or a long one; then
     `gh secret set TAP_PUSH_TOKEN --repo Gaaaavin/openchamber`.
   - Done: `brew install --cask openchamber-xinhao` on the dev Mac; the app
     launched and settings carried over. It needed Open Anyway once because
     the cask still relied on `--no-quarantine` at the time; that install is
     approved and stays so. The next `brew upgrade` exercises the postflight
     strip for real.
   - Dispatch `fork-sync.yml` with `force_release` once and confirm the cask
     commit lands in the tap without manual help.
4. Patch 1 is done for the session-level notice. Root cause of the false
   alarm: upstream `SessionErrorNotice.tsx:41` reads
   `time.completed ?? time.created`, and the optimistic user message has
   `completed: 0`, so the 5 s grace was 0 s; the server also publishes the
   user `message.updated` before `session.status busy`, so a status blip
   right after send was enough to fire it. Still open: the inline
   `ChatMessage.tsx:681-698` wording for real assistant errors (the
   "Opencode failed to send message" catch-all) — capture real `detail`
   strings before touching it. Note `Event stream:` in the status report is
   a dead field (`setEventStreamStatus` has no callers); use the new
   `Connection phase:` line instead.
5. Patch 2 (TPS) is done; it lives in the `StatusRow` chip. Two placements
   were tried and rejected: `ComposerStatusBar` only renders with todos or
   pending changes, so a meter there would toggle a row on every turn; the
   composer footer beside the agent/model/effort controls was tested and
   felt crowded. The plugin's 5 s window read too jumpy at a 1 Hz redraw
   (the 0–1 s tail alone moved each tick by up to 20%), hence the 15 s
   window plus 3 s EMA. Not done: a settings toggle to hide it, and any visual check on
   mobile (the chip is `max-w-full`; the meter is `flex-none`, so on a very
   narrow chip the working text truncates first). Reference for the
   arithmetic: `git -C ../opencode show jdscript/jdscript:packages/app/src/components/fork-tps-math.ts`.
6. Before the first remote server: patch 0c; install the fork tgz on the
   remote; configure the Remote Instance as **external**.
7. Patch 3 (revert gate) is done; patch 7 closed its send/revert race (the
   send waits for the pending revert, the send button is disabled meanwhile).
   Other paths that replace `state.session` wholesale (bootstrap, reconnect
   recovery, cold `session.get`) are not guarded on purpose: none runs during
   a normal revert.
8. Interrupt stops background subagents too. Not fixable here: the UI sends a
   single `session.abort(parent)`; OpenCode's `SessionRunState.cancel()` then
   runs `cancelBackgroundJobs()`, which matches jobs by
   `metadata.parentSessionId` recursively (`packages/opencode/src/session/run-state.ts`,
   same in the jdscript 1.18.25 build). There is no "parent only" abort API.
   Fix belongs in the OpenCode fork: skip jobs with `metadata.background`
   when the cancel comes from the HTTP abort route. Patch 4 (subagent
   sessions promptable by default) is the workaround: open the child and stop
   it there.
