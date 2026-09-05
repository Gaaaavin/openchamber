# OpenChamber, xinhao fork

Personal fork of [OpenChamber](https://github.com/openchamber/openchamber) with
a few UX changes on top of upstream. Upstream is the source of truth; for what
OpenChamber is and how to use it, read the upstream
[README](https://github.com/openchamber/openchamber#readme) and
[guides](https://github.com/openchamber/openchamber/tree/main/packages/docs/content/docs).
What this fork changes and how it is maintained: [FORK.md](FORK.md).

## Desktop (macOS, Apple Silicon)

```bash
brew tap Gaaaavin/tap
brew trust --cask gaaaavin/tap/openchamber-xinhao
brew install --cask openchamber-xinhao
```

Upgrade with `brew upgrade --cask openchamber-xinhao`. Settings -> About ->
Check for updates tells you when a newer fork release exists and shows that
command; the in-app updater is off in this build.

If upstream OpenChamber is installed, remove it first: `brew uninstall --cask
openchamber`, or delete `/Applications/OpenChamber.app` for a DMG install.
Settings and sessions carry over, both builds share the bundle id.

The build is ad-hoc signed and not notarized. The cask removes the quarantine
attribute after install and upgrade, so macOS opens it without a Gatekeeper
prompt. Install only if you trust this repository's CI.

## CLI for Web and PWA

Requires Node.js 22+ and the installed [OpenCode CLI](https://opencode.ai).

```bash
npm install -g https://github.com/Gaaaavin/openchamber/releases/latest/download/openchamber-web.tgz
openchamber --ui-password be-creative-here
```

Common operations:

```bash
openchamber status
openchamber connect-url --qr
openchamber tunnel start --provider cloudflare --mode quick --qr
openchamber startup enable
openchamber logs
openchamber stop
```

To upgrade, run the `npm install -g` line again. `openchamber update` still
targets the upstream npm package and would replace this build.

OpenChamber binds to localhost by default. Use `--lan` only on a trusted
network and protect browser access with `--ui-password`.

## License

MIT, same as upstream.
