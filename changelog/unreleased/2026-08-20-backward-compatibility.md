# Backward compatibility: protocol-v3 Trace cutover

- **Date:** 2026-08-20
- **Type:** process
- **Scope:** `core`, `server`, `web`

[中文版](2026-08-20-backward-compatibility.zh.md)

This batch introduced a new on-disk Trace protocol and made an explicit cutover instead of
guessing Goal or Task identity from older records.

## Legacy v1/v2 Trace files

**Old shape tolerated.** Existing date-sharded v1/v2 JSONL files were left byte-for-byte
untouched. Their physical file, raw event, performance-analysis, download, and explicit v2 Turn
read paths remain read-only. They do not appear as synthetic Goal Runs or Tasks.

**Scope.** Protocol-v3 Session recovery reads only the new Session bundle. It does not resume,
migrate, rewrite, or infer v1/v2 history. A Session that must continue executing after the upgrade
must be started anew; data that must remain portable should be downloaded or backed up first.

**Removal.** Server and Web maintainers keep the legacy shard readers and views together until a
future release explicitly ends v1/v2 inspection after providing a documented backup or bulk-export
path. That release must remove the v2 routes, projections, tests, and Web entry points as one change.
Removing compatibility code never authorizes deleting old files; only an explicit Session deletion
or user-directed cleanup may do that.
