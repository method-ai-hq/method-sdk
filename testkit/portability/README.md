# Saved package on Mac and clean Linux

After `npm run build`, run the same frozen package with different local file bindings:

```sh
node testkit/portability/runtime-upgrade.mjs testkit/fixtures/runtime-upgrades/0.7.0.json
npm pack --workspace @withmethod/sdk --ignore-scripts --pack-destination .tmp
```

For Docker, substitute the tarball name from `npm pack` below:

```sh
docker run --rm \
  -v "$PWD/.tmp/withmethod-sdk-0.9.4.tgz:/tmp/sdk.tgz:ro" \
  -v "$PWD/testkit/portability/runtime-upgrade.mjs:/app/check.mjs:ro" \
  -v "$PWD/testkit/fixtures/runtime-upgrades/0.7.0.json:/app/fixture.json:ro" \
  -w /app node:22-bookworm sh -c 'npm install --ignore-scripts --no-audit --no-fund /tmp/sdk.tgz && node check.mjs fixture.json'
```

Only the SDK tarball, script, and fixture enter the new container. The host home, credentials, caches, and node_modules are not mounted. The test uses a local fake Method service for package downloads and run uploads. It makes no model calls.

A pass requires the original package and digest to stay unchanged, the supplied folder to receive exactly one ledger entry, the declared check to pass, state to become `{count:1}`, and the manifest to record the installed executor. This tests file and state portability. It does not test browser sessions or account transfer.
