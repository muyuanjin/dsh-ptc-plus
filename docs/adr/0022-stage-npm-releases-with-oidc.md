# Stage npm Releases With OIDC

## Problem

The npm registry is retiring long-lived bypass-2FA credentials as a direct publication mechanism and now supports workflow-bound OIDC identities plus staged publication. PTC Plus needs a release path that proves the package came from an already verified Git commit, does not place reusable npm write authority in GitHub secrets, preserves maintainer proof-of-presence, and publishes the exact artifact that was inspected. Running the complete platform matrix again for a tag wastes CI capacity without strengthening identity when the same commit already has a successful required CI run.

## Decision

The `Release` GitHub Actions workflow is the only automated npm publication path. A maintainer explicitly dispatches it from an annotated `v<package.version>` tag ref; there is no independent tag input. Before obtaining npm authority, the workflow proves that its `GITHUB_REF`, provenance-bearing `GITHUB_SHA`, annotated tag target, checked-out commit, manifest version, and the successful `main` push run of `.github/workflows/ci.yml` all identify the same commit. Normal CI does not run for tag pushes.

The npm Trusted Publisher is bound to the exact repository, `release.yml` workflow filename, and `npm-release` GitHub environment. Its allowed action is only `npm stage publish`; direct `npm publish` and reusable npm write tokens are absent from the workflow. The package uses npm's most restrictive recommended publishing-access policy even when npm documentation and the live UI use different labels for it. After the OIDC staging path is proven, maintainers revoke every remaining reusable token capable of publishing or staging this package rather than treating the selected UI label as evidence that those credentials no longer exist. The release job receives only `contents: read` and `id-token: write`, uses a GitHub-hosted runner without a package-manager cache, revalidates the dispatch ref and SHA after the environment boundary, builds and smoke-tests one tarball, and sends that same file to npm staging with provenance.

Promotion is separate from staging. A maintainer reviews the staged metadata and downloadable tarball, then approves or rejects it through npm with interactive 2FA. A successful approval is not treated as immediate availability because npm publish-time scanning may delay or block registry visibility. GitHub Release publication follows observed availability of the exact npm version.

npm 12 install-time restrictions remain enabled for the release job. The manifest explicitly denies the unnecessary `esbuild` install script, and release installation replaces registry hosts with the explicitly selected npm registry without enabling Git dependencies, arbitrary remote tarball dependencies, or all install scripts.

## Alternatives considered

**Store a granular bypass-2FA npm token in GitHub secrets.** This leaves reusable write authority available to workflow code and depends on a credential class whose direct-publish capability is being retired. It also provides weaker provenance and audit boundaries than a workflow-specific OIDC exchange.

**Publish directly with OIDC after a GitHub Environment approval.** This removes long-lived credentials but substitutes a GitHub approval for npm proof-of-presence. Stage-only authority keeps CI compromise from making a version public and remains compatible with npm's dual-use publication requirements if they apply.

**Run the full platform matrix again inside the release workflow.** Revalidation of an immutable SHA repeats expensive deterministic work without changing the artifact identity. The release workflow instead verifies the successful CI run for that exact SHA, then performs npm 12 installation, build, package lint, audit, pack, checksum, and clean-consumer smoke on the release artifact.

**Publish a locally generated tarball after CI.** Interactive local publishing provides 2FA but separates the published bytes from the workflow identity and makes provenance, repeatability, and artifact review depend on workstation state.

**Automatically stage every unpublished manifest version pushed to `main`.** This removes one maintainer action but turns an ordinary merge into a release request and can reserve a semver version in npm staging before its annotated release identity exists.

## Consequences

An npm release requires a successful immutable CI identity, an explicit workflow dispatch, a narrowly scoped OIDC exchange, and a separate npm 2FA promotion. Once the proven migration removes legacy package-capable tokens, no npm write secret needs rotation, and a compromised release job can at most create a staged candidate under the configured package and workflow relationship. The trade-off is an intentional manual promotion step and a possible registry scanning delay. Maintainers must configure the npm Trusted Publisher, package publishing access, GitHub environment, tag protection, and post-verification token revocation outside the repository; those deployment facts cannot be inferred or silently created by source code.
