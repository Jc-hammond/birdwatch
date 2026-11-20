# Contributing to Birdwatch

Birdwatch tracks planned work and specifications in Linear. To pick up an issue, find the Birdwatch Analytics team and follow the repository’s working rules. [Linear](https://linear.app/birdwatch-analytics/team/BIR/all) · [Working rules](AGENTS.md)

## Build and test

Install the tools listed in the README, then run these commands from the repository root. [Development prerequisites](README.md#develop)

```sh
make build
make test
make lint
```

The build creates the dashboard, offline SDK downloads, and Go binary. The test target runs the server, JavaScript and native SDK checks.

## Report a bug or suggest a feature

Use the bug or feature form in GitHub Issues. For a security concern, follow the private reporting process. [Open an issue](https://github.com/Jc-hammond/birdwatch/issues/new/choose) · [Security policy](SECURITY.md)
