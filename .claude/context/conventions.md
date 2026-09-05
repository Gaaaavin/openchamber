# Context

## Project decisions

- **2026-09-04**: Started as `wuicode`, an idea for a UX-native coding client on top of `opencode serve`. Requirements gathered: chat-centric but robust; remote-first (ssh/tunnel), phone check-in, multi-user server; reliability (per-action state machine, offline queue, reconcile after reconnect, multi-device consistency, auto-recover after server restart); multi-agent (parallel sessions with worktrees, subagent visibility, multi-model comparison, long-task notifications).
- **2026-09-05**: Evaluated OpenChamber (MIT, React 19 + zustand + `@opencode-ai/sdk`) as an existing solution. After real use: it satisfies the requirements. `wuicode` is abandoned; its GitHub repo was deleted. This repo is now a personal fork of OpenChamber.
- **2026-09-05**: Fork strategy (see `FORK.md`): `main` mirrors upstream, `xinhao` is the default branch holding a linear patch series. Bug fixes go upstream as PRs; personal-preference features stay in the fork. Feature patches live in `packages/ui` and `packages/web`; `packages/electron` gets only the narrow `// FORK:` seams needed to build unsigned and to swap `autoUpdater` for a Homebrew notice (patch 0b).
- **2026-09-05**: Agents may run git/`gh` in this repo without asking (commit/push `xinhao`, manage `Gaaaavin/*` repos, releases, workflows). `AGENTS.md` carries the FORK override.
- **2026-09-05**: TPS readout (patch 2) is a live estimate from streamed text deltas, modelled on JDScript/opencode's implementation, not the per-message `tokens/wall-time` average.
- **2026-09-05**: Surface is macOS Desktop (Apple Silicon), mostly local projects now, remote servers later. Local mode serves the UI bundled in the app, so the desktop itself must be a fork build. Remote Instance mode serves the UI from the remote `@openchamber/web`, so remotes get the fork tgz and must be in **external** mode.
- **2026-09-05**: Desktop distribution: no Apple Developer ID. Build ad-hoc-signed, un-notarized arm64 zip; distribute via personal Homebrew tap `Gaaaavin/homebrew-tap` cask `openchamber-xinhao`, which strips the quarantine attribute in `postflight_steps` (Homebrew 6 removed `--no-quarantine`); disable in-app `autoUpdater` (unsigned electron-updater cannot install on macOS) and show a `brew upgrade` notice instead. Running a local fork CLI as a Direct Instance was rejected as inelegant.
- **2026-09-05**: Fork releases: keep `package.json` versions equal to upstream; tag `v<upstream>-xinhao.<yyyymmddHHMM>-<sha>`; cask version `<upstream>,<yyyymmddHHMM>`; assets = mac arm64 zip (+dmg) and `openchamber-web.tgz`; release workflow bumps the cask.

## Working conventions

- Follow upstream `AGENTS.md` and `.claude/skills/` for any code change; read the nearest `DOCUMENTATION.md`.
- Keep patches out of `packages/ui/src/components/chat/ChatInput.tsx` (3000+ lines, high churn) where possible; prefer new files and `// FORK:`-marked seams.
- Fork-owned UI replacements live in a `fork/` subdirectory next to the upstream file they replace and export the same component name, so the seam is a single import-path change (see `components/chat/fork/SessionErrorNotice.tsx`). Fork UI strings go in `lib/i18n/messages/fork.i18n.ts` (`fork.*` keys, all 12 locales, real translations) and are spread into each locale file with one import + one spread line, the same way `linear-panel.i18n.ts` is.
- OpenChamber's own guesses about session state (no reply yet, waiting) are never styled as errors; only errors OpenCode reports (`session.error`, `message.info.error`) use `--status-error*`. Escalate a guess only after an authoritative server check.
- One commit per patch on `xinhao`; `git pull --rebase` before work; no unpushed commits left on `xinhao` once the sync bot exists.
- `origin` uses HTTPS because SSH port 22 to GitHub was blocked on the setup network.
