# hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/StarsN/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/StarsN/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line tool that applies AI-written edits in four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — to a tree of text files, to one written specification (SPEC.md). It finds the lines an edit names even when whitespace or indentation drifted, through three matching tiers (exact, trailing whitespace, both ends), and writes every change or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

Reads the patch from the file given, or from standard input when no file is given (or `-`). `--format` picks one of `unified`, `search-replace`, `v4a`, `json` (default `auto` detects it); `--check` prints what would change without writing; `--strict` matches exact lines only. Exit 0 lists the changed files, exit 1 reports failed edits, exit 2 reports usage, parse, or format faults.

---

<sub>Entered on [make.fun](https://make.fun/?ref=e7twrv07&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
