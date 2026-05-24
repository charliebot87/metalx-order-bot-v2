# Security Policy

Metal X Order Bot v2 is read-only by design.

## Private keys

Do not add private keys, signing keys, seed phrases, wallet exports, or transaction-signing code to this repository.

The bot must never accept private keys in config, environment variables, tests, fixtures, docs, or examples. Any live transaction needed during development must be executed outside this process with the Proton CLI keychain.

## Required local checks

Run before pushing:

```bash
npm test
npm run smoke:proton
```

`npm test` includes a source guard for private-key/signing patterns. `npm run smoke:proton` is read-only and uses `proton table`.

## Reporting

If you find a security issue, open a private GitHub security advisory or contact the maintainer directly. Do not paste secrets into public issues.
