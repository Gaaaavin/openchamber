// FORK: Detect half-open long-lived SSH connections before the OS TCP timeout.
const FORK_SSH_KEEPALIVE_OPTIONS = Object.freeze([
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'TCPKeepAlive=yes',
]);

export const buildForkLongLivedSshArgs = (parsed, preDestinationArgs = [], remoteCommand = null) => {
  // OpenSSH uses the first value set for an option, so user options stay first.
  const args = [...parsed.args, ...FORK_SSH_KEEPALIVE_OPTIONS, ...preDestinationArgs, parsed.destination];
  if (remoteCommand) args.push(remoteCommand);
  return args;
};
