# Publishing sapper-iq to npm

This guide documents the current manual release flow for the published npm package `sapper-iq`.

The npm package name is `sapper-iq`.
The installed CLI commands remain:

- `sapper`
- `sapper-ui`

## Prerequisites

1. You have publish access to `sapper-iq` on npm.
2. You are logged in with `npm login`.
3. The working tree is in a state you are ready to release.
4. Node.js 16 or newer is available.

Helpful checks:

```bash
npm whoami
git status --short --branch
```

## Current package metadata

Release metadata currently lives in `package.json`:

```json
{
  "name": "sapper-iq",
  "version": "1.1.38",
  "bin": {
    "sapper": "sapper.mjs",
    "sapper-ui": "sapper-ui.mjs"
  },
  "files": [
    "sapper.mjs",
    "sapper-ui.mjs",
    "README.md"
  ]
}
```

Notes:

- The published package name is `sapper-iq`, not `sapper`.
- The global executable is still `sapper`.
- Package contents are controlled by the `files` whitelist in `package.json`.

## Release checklist

Run this sequence before every publish.

### 1. Verify the version you are about to publish

Check the local version:

```bash
node -p "require('./package.json').version"
```

Check the latest published version:

```bash
npm view sapper-iq version
```

If the local version already exists on npm, bump it before publishing.

### 2. Update version metadata

For a manual bump, update both files together:

- `package.json`
- `package-lock.json`

Or use npm versioning commands:

```bash
npm version patch
# or
npm version minor
# or
npm version major
```

If you use `npm version`, review the created commit and tag before pushing.

### 3. Sanity-check the CLI entrypoint

```bash
node --check sapper.mjs
chmod +x sapper.mjs
```

`chmod +x` is usually already satisfied in git, but it is worth confirming if execute bits changed.

### 4. Test the package contents

Always run a dry run before publishing:

```bash
npm pack --dry-run
```

Confirm the tarball contains only the intended release files. Right now that should be driven by the `files` whitelist and typically includes:

- `README.md`
- `package.json`
- `sapper.mjs`
- `sapper-ui.mjs`

If extra files appear, fix `package.json.files` before publishing.

### 5. Publish

```bash
npm publish
```

Successful output will look like:

```text
+ sapper-iq@1.1.38
```

### 6. Verify the published version

```bash
npm view sapper-iq version
```

The returned version should match the version you just published.

### 7. Verify install flow

Install the package by package name, then run the CLI by bin name:

```bash
npm install -g sapper-iq
sapper --version
```

If you want to test the local repo without publishing, `npm link` is optional, not required:

```bash
npm link
sapper --version
npm unlink -g sapper-iq
```

## Recommended git flow around a release

One practical sequence is:

```bash
git status --short --branch
git add README.md package.json package-lock.json sapper.mjs PUBLISHING.md
git commit -m "release: 1.1.39"
git push origin main
npm publish
git tag v1.1.39
git push origin v1.1.39
```

If you publish before pushing source changes, verify afterward that the published version and git history still match.

## Troubleshooting

### Authentication errors

```bash
npm logout
npm login
npm whoami
```

### Version already exists

If `npm publish` fails because the version already exists:

1. Bump the version in `package.json` and `package-lock.json`.
2. Re-run `npm pack --dry-run`.
3. Publish again.

### Wrong files in the tarball

If `npm pack --dry-run` includes extra files such as local state, backups, or old folders, fix the `files` array in `package.json` and rerun the dry run.

### Permission errors

Make sure the npm account you are logged into has publish rights for `sapper-iq`.

## Reference commands

```bash
npm whoami
npm view sapper-iq version
npm pack --dry-run
npm publish
npm install -g sapper-iq
npm deprecate sapper-iq@1.1.38 "reason"
npm owner ls sapper-iq
```

## Post-publish checks

1. Confirm the new version on `https://www.npmjs.com/package/sapper-iq`.
2. Confirm `npm view sapper-iq version` returns the expected version.
3. Confirm the repo contains the matching source changes.
4. Optionally create and push a matching git tag.