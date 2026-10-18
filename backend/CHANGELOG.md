# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Maintainers:** as you merge PRs, add an entry under `[Unreleased]` in the
> matching category below (skip categories with nothing to report). When
> cutting a release, rename `[Unreleased]` to the new version and date (e.g.
> `## [1.2.0] - 2026-07-26`), then add a fresh `[Unreleased]` section above it
> with all six empty headings restored.

## [Unreleased]

### Added

- Outbound HTTP client (`backend/src/services/apiClient.ts`) with retry using
  exponential backoff, a per-request timeout, and automatic `Authorization:
  Bearer` API key attachment. Defaults come from the new `API_CLIENT_BASE_URL`,
  `API_CLIENT_API_KEY`, `API_CLIENT_TIMEOUT_MS` and `API_CLIENT_MAX_RETRIES`
  env vars.

### Changed

- `GET /api/v1/vaults/simulate/translate-error` now returns the error names and
  numbers defined by the `#[contracterror]` enum in
  `soroban-contracts/contracts/single_rwa_vault/src/errors.rs` instead of a
  hand-maintained approximation.

### Deprecated

### Removed

### Fixed

### Security
