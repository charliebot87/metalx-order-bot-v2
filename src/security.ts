const CHAIN_PRIVATE_KEY_PREFIX = ['P', 'V', 'T'].join('') + '_';
const PRIVATE_KEY_PATTERN = new RegExp(`${CHAIN_PRIVATE_KEY_PREFIX}[A-Za-z0-9_]+`);
const DANGEROUS_KEY_NAMES = [
  ['private', 'key'].join('_'),
  ['private', 'key'].join(''),
  ['xpr', 'private', 'key'].join('_'),
  ['proton', 'private', 'key'].join('_'),
  ['wallet', 'private', 'key'].join('_'),
  ['signing', 'key'].join('_'),
];
const DANGEROUS_KEY_NAME_PATTERN = new RegExp(`(^|_)(${DANGEROUS_KEY_NAMES.join('|')})(_|$)`, 'i');

/**
 * This project is read-only. It must never receive, store, or parse private keys.
 *
 * Live transaction tests, when needed, must be run outside the bot through the
 * Proton CLI keychain, e.g. `proton action ... charliebot`. The bot process
 * should only ever need Telegram, database, Hyperion, and RPC configuration.
 */
export function assertNoPrivateKeyConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  const offenders: string[] = [];

  for (const [name, value] of Object.entries(env)) {
    if (DANGEROUS_KEY_NAME_PATTERN.test(name)) {
      offenders.push(name);
      continue;
    }

    if (typeof value === 'string' && PRIVATE_KEY_PATTERN.test(value)) {
      offenders.push(name);
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      [
        'Refusing to start: this is a read-only notification bot and must not be configured with private keys.',
        `Remove these environment variables: ${offenders.sort().join(', ')}`,
        'If a live transaction is needed for testing, use the Proton CLI keychain outside this process.',
      ].join(' '),
    );
  }
}
