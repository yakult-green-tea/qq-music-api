# Release process

Releases are maintainer-authorized operations. Merging a pull request, creating a tag, or updating `main` must not publish to npm automatically.

## Before changing the version

1. Confirm the release scope and intended semantic version.
2. Confirm `main` is clean and the existing npm version will not be republished.
3. Review production dependency and public/runtime API changes explicitly.
4. Run the authoritative verification chain:

   ```sh
   npm ci
   npm run lint
   npm run build
   npm test
   npm run build:js
   npm pack --dry-run
   ```

5. Inspect the generated package contents and verify `LICENSE`, `ATTRIBUTION.md`, `README.md`, and `dist/src/app.js` are present.

## Publishing

Only after explicit maintainer approval:

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` in one release commit.
2. Merge through the protected `main` branch after the required `verify` check passes.
3. Create one immutable `vX.Y.Z` tag at the release commit.
4. Publish that version to npm once.
5. Create GitHub release notes for the same tag.
6. Let downstream consumers, including Folia, update their dependency and lockfile in a separate change.

Never move an existing release tag or republish an existing npm version.
