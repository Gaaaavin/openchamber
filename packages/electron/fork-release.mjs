// FORK: Gaaaavin/openchamber ships ad-hoc-signed macOS builds through the
// Homebrew cask `openchamber-xinhao`. electron-updater cannot verify or install
// an unsigned payload on macOS, so the desktop update check reads this fork's
// GitHub releases and hands the user a `brew upgrade` command instead of
// downloading anything. Flip ELECTRON_UPDATER_ENABLED once builds are signed
// and notarized again; every upstream updater path stays intact behind it.
import fs from 'node:fs';

export const ELECTRON_UPDATER_ENABLED = false;

const FORK_REPO = 'Gaaaavin/openchamber';
const FORK_RELEASES_URL = `https://github.com/${FORK_REPO}/releases`;
const FORK_PACKAGE_MANAGER = 'homebrew';
export const FORK_UPDATE_COMMAND = 'brew upgrade --cask openchamber-xinhao';

const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${FORK_REPO}/releases/latest`;

// v<upstream>-xinhao.<yyyymmddHHMM>-<sha>; the stamp alone orders releases.
const RELEASE_TAG_PATTERN = /^v?(\d+(?:\.\d+)+)-xinhao\.(\d{12})-([0-9a-f]{7,40})$/i;

export const parseForkReleaseTag = (tag) => {
  const match = RELEASE_TAG_PATTERN.exec(String(tag || '').trim());
  if (!match) return null;
  return {
    version: match[0].replace(/^v/, ''),
    upstreamVersion: match[1],
    stamp: match[2],
    sha: match[3].toLowerCase(),
  };
};

/**
 * The release workflow passes `--config.extraMetadata.forkRelease=<tag>` to
 * electron-builder, which writes the tag into the packaged app's package.json.
 * Development and hand-packaged builds carry no tag and resolve to null.
 */
export const readForkRelease = ({ packageJsonPath, readFile = fs.readFileSync }) => {
  try {
    const parsed = JSON.parse(readFile(packageJsonPath, 'utf8'));
    return parseForkReleaseTag(parsed?.forkRelease);
  } catch {
    return null;
  }
};

const noUpdate = (currentVersion) => ({
  available: false,
  currentVersion,
  version: null,
  body: null,
  date: null,
  releaseUrl: FORK_RELEASES_URL,
  packageManager: FORK_PACKAGE_MANAGER,
  updateCommand: FORK_UPDATE_COMMAND,
});

/**
 * Desktop update check for fork builds. Returns the shared `UpdateInfo` shape;
 * `updateCommand` tells the UI to show the Homebrew command instead of the
 * in-app installer. A build without a release tag has nothing to compare
 * against and reports no update.
 */
export const checkForkRelease = async ({ currentRelease, appVersion, fetchImpl = globalThis.fetch }) => {
  if (!currentRelease) return noUpdate(appVersion);

  let response;
  try {
    response = await fetchImpl(LATEST_RELEASE_API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openchamber-xinhao' },
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
    throw new Error(`Unable to check for updates${detail}. Check your network connection and try again.`, { cause: error });
  }

  // No release published yet is authoritative "nothing newer", not a failure.
  if (response.status === 404) return noUpdate(currentRelease.version);
  if (!response.ok) {
    throw new Error(`Unable to check for updates: GitHub responded with HTTP ${response.status}.`);
  }

  const release = await response.json();
  const latest = parseForkReleaseTag(release?.tag_name);
  if (!latest || latest.stamp <= currentRelease.stamp) return noUpdate(currentRelease.version);

  return {
    ...noUpdate(currentRelease.version),
    available: true,
    version: latest.version,
    body: nonEmptyText(release.body),
    date: nonEmptyText(release.published_at),
    releaseUrl: nonEmptyText(release.html_url) ?? FORK_RELEASES_URL,
  };
};

// GitHub's release JSON is the I/O boundary: fields are strings or absent.
const nonEmptyText = (value) => {
  const text = String(value ?? '').trim();
  return text ? text : null;
};
