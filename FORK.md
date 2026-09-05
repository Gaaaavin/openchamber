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

Discipline: commit directly to `xinhao`, `git pull --rebase` before starting
work, and do not leave unpushed commits on `xinhao` overnight once the sync
bot is live (it rewrites history).

## Patch series (keep in order; one commit per patch)

| # | Patch | Files | Status |
|---|-------|-------|--------|
| 0a | Fork workflow `fork-sync.yml` (sync + release + cask bump in one file) | `.github/workflows/fork-sync.yml` | DONE |
| 0b | Desktop seams: ad-hoc signed build (`--config.mac.identity=-`, `--config.mac.notarize=false`, `--config.extraMetadata.forkRelease=<tag>`); `electron-updater` off behind `ELECTRON_UPDATER_ENABLED`; update check reads this fork's GitHub releases and the dialog shows `brew upgrade --cask openchamber-xinhao` | `packages/electron/fork-release.mjs` (+ test), 4 `// FORK:` seams in `packages/electron/main.mjs`, 3 in `packages/ui/src/components/ui/UpdateDialog.tsx` | DONE |
| 0c | Web seams: update check + `openchamber update` target this fork's release tgz instead of npm `@openchamber/web` | `packages/web/server/lib/package-manager.js:12-22, 123-161, 657-667, 684-702, 751-797` | TODO (needed only before the first remote server) |
| 1 | Clearer wording for assistant-turn errors | `packages/ui/src/components/chat/ChatMessage.tsx:681-698` | TODO |
| 2 | Live TPS readout in composer status bar (streamed-delta estimate, modelled on JDScript/opencode) | `packages/ui/src/components/chat/ComposerStatusBar.tsx` (via `leftAccessory` or a sibling component; avoid editing `ChatInput.tsx` body, it is a 3000-line conflict hot spot) | TODO |

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
4. Patch 1 (error wording). Before changing text, capture a few real
   occurrences of the `detail` string to learn the actual root cause; the
   prefix "Opencode failed to send message" is a catch-all around
   `message.info.error` from OpenCode, not a transport failure.
5. Patch 2 (TPS). Decided: live estimate from streamed text deltas, modelled
   on JDScript/opencode's implementation (read it first; do not reinvent the
   window/decay). The per-message `tokens.output / wall-time` average was
   rejected because wall time includes tool execution. Consider a settings
   toggle.
6. Before the first remote server: patch 0c; install the fork tgz on the
   remote; configure the Remote Instance as **external**.
