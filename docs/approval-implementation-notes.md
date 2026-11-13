# Approval implementation notes

The approval gate uses the pinned `sh-syntax@0.8.4` parser for POSIX shell
structure. Its runtime requires the package's JavaScript files and
`main.wasm`; the package lock, third-party notice, and bundled mvdan/sh license
record the dependency. See `approval-context-review.md` for the reviewer
boundary, provider requirements, and runtime configuration.

During dependency installation, npm removed 28 packages that were present as
extraneous local dependencies. The npm log at
`G:/AgentoC/tmp/npm-cache/_logs/2026-11-13T13_10_10_727Z-debug-0.log`, entries
52–79, records their paths but not their original versions or integrity hashes.
Exact recovery requires independently verified package metadata or a backup.
The current restoration state must be checked separately.

Static inspection and syntax checks establish that the modified files parse;
they do not establish provider compatibility, policy correctness, or operation
in a deployed service. Runtime verification must use representative evidence.
