# Publishing pi-paper-lab to npm

This document is for maintainers. Users install via `pi install npm:pi-paper-lab` — see [README.md](./README.md).

## One-time setup

1. Create npm account at https://www.npmjs.com/.
2. Run `npm login` locally.
3. Claim the package name (first publish will create it).

## Publishing a release

Manual publish (the GitHub Actions workflow was removed — it never worked, see
CHANGELOG v0.7.10):

```bash
# 1. Bump version in package.json (+ package-lock.json, "version" at top and
#    in the root package entry)
# 2. Add a CHANGELOG section
# 3. Commit + tag + push
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v0.7.x"
git tag v0.7.x
git push --follow-tags

# 4. Publish
npm publish --access public
```

`prepack` runs automatically before publish (typecheck + full test suite +
smoke tests). `npm audit` is NOT part of prepack — run it standalone with
`npm run audit` if you want a security check before publishing.

## npm v12 compatibility

The package is already compatible:
- No lifecycle scripts (`preinstall`/`install`/`postinstall`)
- No git dependencies
- No remote tarball URLs
- `engines.node >= 22.7`

No `--allow-scripts` or `--allow-git` flags needed for installation.
