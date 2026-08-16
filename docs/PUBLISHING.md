# Publishing `pi-smart-terminal`

Tag-driven CI publish with npm provenance.

## Bootstrap (one-time, first publish)

npm Trusted Publishing cannot create a new package — the very first publish
is manual:

1. Temporarily drop the `prepublishOnly` script from `package.json`
2. `npm publish --access public` (no `--provenance`)
3. npmjs.com → `pi-smart-terminal` → **Settings → Trusted Publisher**:
   - **Organization or user:** `pungggi`
   - **Repository:** `pi-smart-terminal`
   - **Workflow filename:** `release.yml`
4. Restore `prepublishOnly`, commit. Every later publish is CI-only via OIDC.

## Regular releases

```bash
# bump version in package.json, commit, then:
git tag v0.1.0
git push origin main --follow-tags
gh run watch
```

Releases go through a PR to `main` (see ../AGENTS.md); never push release
commits or tags straight to `main`.

Fallback: Classic **Automation** token as `NPM_TOKEN` repo secret
(not Granular/Publish — those hit `EOTP` in CI).
