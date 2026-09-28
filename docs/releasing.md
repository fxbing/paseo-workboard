# Releasing

[中文](zh-CN/releasing.md) · [README](../README.md)

The published `paseo-workboard@0.1.0` targets Paseo **0.9.1**. This checkout has newer compatibility changes that are not published; use the manifest for the minimum version and [verification](verification.md) for tested hosts. Preparing a new candidate does not publish it or submit a Paseo Cafe listing.

## Package contract

Paseo loads the TypeScript client/server entries and their relative modules. All external runtime imports are supplied by Paseo or Node. Development dependencies stay in `devDependencies`; no manifest build command or compiled distribution is needed. See [Paseo's publishing guide](https://paseo.sh/docs/plugins/publishing).

The npm package includes the manifest, entries, `client/`, `server/`, `shared/`, both READMEs, both changelogs and the MIT license. Tests, development scripts, daemon data, logs, credentials and `node_modules` are excluded.

`npm run check:package` checks the package identity/version, manifest minimum, README sections used by Cafe and the complete npm file list. `prepublishOnly` also runs TypeScript, unit tests and formatting when publishing from the checkout. The CI workflow runs these checks and creates a downloadable tarball; it does not publish to npm or Cafe.

## Validate a release candidate

1. Update `package.json` and `package-lock.json` together. Use a new stable semantic version for every published change. Update both changelogs and keep the English and Chinese documentation aligned.
2. Keep `requirements.paseo` at the intended minimum version. Run host integration tests on the current target before widening the range; the internal bridge checks response shapes but cannot guarantee later Paseo versions.
3. From a clean checkout, run:

   ```sh
   mise install
   mise exec -- npm ci
   mise exec -- npm run check
   mise exec -- npm run format:check
   mise exec -- npm run check:package
   WORKBOARD_RELEASE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/workboard-release.XXXXXX")"
   mise exec -- npm pack --pack-destination "$WORKBOARD_RELEASE_DIR"
   ```

4. Follow the [isolated integration guide](../tests/integration/README.md) to start a marked, temporary Paseo home. Unpack the generated tarball into a separate temporary directory and install that directory into the isolated daemon. Do not install development dependencies in the unpacked package:

   ```sh
   WORKBOARD_PACKAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/workboard-package.XXXXXX")"
   tar -xzf "$WORKBOARD_RELEASE_DIR/paseo-workboard-0.1.0.tgz" -C "$WORKBOARD_PACKAGE_DIR"
   paseo plugin install "$WORKBOARD_PACKAGE_DIR/package" --home "$WORKBOARD_INTEGRATION_HOME"
   paseo plugin ls --home "$WORKBOARD_INTEGRATION_HOME" --json
   mise exec -- npm run test:integration
   ```

   Substitute the release version in the filename. Require plugin `running`, a connected board and passing integration tests. Check changed visual behavior only with disposable tasks. Stop the isolated daemon before deleting its home or the unpacked plugin.

5. Review the tarball and Git diff for accidental local data. Record the actual platform and checks in [verification](verification.md). A local check does not establish a successful GitHub Actions run or npm installation.

## Publish source and npm

Publishing requires access to the target GitHub repository and ownership of the npm package name. A name appearing unused is not proof of publishing permission. Complete those account checks when performing a release; this repository contains no publishing credentials.

Before building the final release tarball, check the README's installation instructions and date the changelog entry, then repeat the validation above. Make that reviewed source available on the public GitHub repository's default branch, and tag the same version, for example `v0.1.0`. Cafe checks the default-branch package and manifest, so a tag alone does not make an unpublished feature branch the catalog source. Publish the validated tarball to the public npm registry:

```sh
npm publish "$WORKBOARD_RELEASE_DIR/paseo-workboard-0.1.0.tgz" --access public --registry https://registry.npmjs.org/
npm view paseo-workboard@0.1.0 version dist.integrity --registry https://registry.npmjs.org/
```

Then verify the registry installation in the isolated daemon:

```sh
paseo plugin install npm:paseo-workboard@0.1.0 --home "$WORKBOARD_INTEGRATION_HOME"
paseo plugin ls --home "$WORKBOARD_INTEGRATION_HOME" --json
mise exec -- npm run test:integration
```

Do not reuse an existing npm version. Release metadata updates must not leave GitHub and npm versions or plugin IDs out of sync.

## Submit to Paseo Cafe

Cafe is a community directory. Its [submission requirements](https://paseo.cafe/submit/) currently require a public GitHub repository and a public npmjs package with matching plugin ID and version. A local package or GitHub repository alone is insufficient.

Use [paseo-cafe.json](paseo-cafe.json) as the prepared form data. It is a submission candidate, not a registration recognized automatically from this repository. The initial platform declaration is macOS, where the host integration was verified. Extend the declaration only after checking other platforms.

1. Open the submission page and enter registry ID `paseo-workboard`, repository `fxbing/paseo-workboard` and npm package `paseo-workboard`. There is no plugin subpath.
2. Copy the categories, platform and caveats from the prepared JSON. Review the exact GitHub issue generated by the form and its required confirmations before submitting.
3. The Cafe bot creates a registry PR. Admission checks verify the source, manifest, npm package and security scan; submission does not guarantee acceptance.
4. After merge, inspect the generated listing and its install command. Follow the same version and package validation process for later updates.

Cafe reads installation and limitation excerpts from the English README. The `## Installation` and `## Limitations` headings are intentional. Screenshots under `images/` and a demo video are optional; use only genuine product captures with public or fictional data.
