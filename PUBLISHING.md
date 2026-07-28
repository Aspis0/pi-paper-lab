# Publishing pi-paper-lab to npm

This document is for maintainers. Users install via `pi install npm:pi-paper-lab` — see [README.md](./README.md).

## One-time setup

1. Create npm account at https://www.npmjs.com/.
2. Run `npm login` locally.
3. Claim the package name (first publish will create it).

## Trusted Publishing (recommended)

[Trusted Publishing](https://docs.npmjs.com/trusted-publishers) uses OIDC tokens from GitHub Actions — no long-lived npm tokens required. Required by npm v12 from January 2027 (deprecation of 2FA-bypass GATs).

### One-time setup on npmjs.com

1. Go to https://www.npmjs.com/package/pi-paper-lab/access.
2. "Publishing access" → "Add a trusted publisher".
3. Choose GitHub Actions.
4. Fill in:
   - Repository owner: `Aspis0`
   - Repository name: `pi-paper-lab`
   - Workflow filename: `publish.yml`
   - Environment name: (leave blank)
5. Save.

### Publishing a release

```bash
# Bump version in package.json
# (manual edit, or use `npm version patch|minor|major`)

git add package.json
git commit -m "chore: bump version to v0.6.1"
git tag v0.6.1
git push --follow-tags
```

GitHub Actions runs `publish.yml` automatically on tag push: typecheck → tests → `npm publish --provenance`. The workflow creates a GitHub release with auto-generated notes.

## Manual publish (fallback)

If you can't use Trusted Publishing:

```bash
npm login
npm publish --access public
```

For one-off releases without a GitHub release, do this locally after bumping `package.json` version.

## Pre-publish checks

The `prepack` script runs automatically before publish:

```bash
npm run typecheck   # tsc --noEmit
npm test            # 69 unit tests
```

Both must pass. CI runs the same checks on every PR.

## npm v12 compatibility

The package is already compatible:
- No lifecycle scripts (`preinstall`/`install`/`postinstall`)
- No git dependencies
- No remote tarball URLs
- `engines.node >= 20`

No `--allow-scripts` or `--allow-git` flags needed for installation.
