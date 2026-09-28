# Isolated Paseo integration tests

中文：[中文](README.zh-CN.md)

This suite is separate from `npm test`. It runs `*.integration.ts` files only
through `npm run test:integration` and requires an already-running, isolated
Paseo daemon whose version satisfies `paseo-plugin.json`.

## Prepare a temporary home

Create a disposable home beneath the system temporary directory, then write a
loopback-only daemon configuration. Change `6768` to an unused local port if
it is already occupied.

```sh
WORKBOARD_INTEGRATION_HOME="$(mktemp -d "${TMPDIR:-/tmp}/paseo-workboard.XXXXXX")"
export WORKBOARD_INTEGRATION_HOME
printf '%s\n' paseo-workboard-integration-v1 > "$WORKBOARD_INTEGRATION_HOME/.paseo-workboard-integration"
printf '%s\n' '{"daemon":{"listen":"127.0.0.1:6768"},"pluginsEnabled":true}' > "$WORKBOARD_INTEGRATION_HOME/config.json"
```

Start the target Paseo version with `PASEO_HOME` set to that exact home, then install the
checkout there and confirm it is running:

```sh
PASEO_HOME="$WORKBOARD_INTEGRATION_HOME" paseo daemon start --home "$WORKBOARD_INTEGRATION_HOME"
paseo plugin install --home "$WORKBOARD_INTEGRATION_HOME" .
paseo status --home "$WORKBOARD_INTEGRATION_HOME" --json
```

Run the suite from the repository root:

```sh
mise exec -- npm run test:integration
```

The harness rejects a home outside a system temporary directory, a missing or
incorrect marker, a non-loopback listener, an unreported daemon version, or a
non-running Workboard plugin. It does not start, stop, or fall back to another
daemon during the test run.

During setup the suite installs `fixture-provider` only into this marked home.
The provider supplies deterministic history and responses for the tests; it
does not make model requests. The suite creates test workspaces and changes
fixture-provider state, so never use a personal or shared daemon home.

## Stop and remove the temporary home

Stop the isolated daemon before removing its home. If the stop command fails,
keep the directory for diagnosis and do not remove it while a daemon may still
be using it.

```sh
if paseo daemon stop --home "$WORKBOARD_INTEGRATION_HOME"; then
  rm -rf "$WORKBOARD_INTEGRATION_HOME"
fi
```
