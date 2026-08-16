# Publishing `pi-smart-terminal`

Tag-driven CI publish with npm provenance.

## Bootstrap (one-time, first publish) — ✅ DONE 2026-08-16

0.1.0 published manually from `de014f7` (no provenance — Trusted Publisher
didn't exist yet). Smart-terminal-mcp ≥ 1.2.37 (marker-race fix) is on npm
as required.

## Regular releases

Note: npm ≥ 11.6 blocks dependency install scripts by default. This package
allows `node-pty` via the top-level `allowScripts` field in package.json —
node-pty ships prebuilds for darwin/win32 only; Linux compiles from source
(needs python3 + make + g++).

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
