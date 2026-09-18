# 勘误记录

## E01 — 数据卷归档 SHA-256

- 受影响的原始记录：总控发布回执，以及提交 `924bef390ad2847f00da8a47feb95363cd9ec24a` 中的 `docs/qa/P1A-release-2026-09-18.md`。
- 原始错误值（原样保留）：`E63D9B28CE8AF54199E332397AAB3B3DCFEC51D87F0CF945E0B8B6169189F71A`。
- 服务器实际值：`E63D9B28CE8AF54199E332397AAB3B3DC1B6A0A8B8EC26BAA4A0D6C0E7585A28`。
- 复核命令：`sha256sum /opt/ecop/.rollback/p1a-5effd72-20260918T134252Z/ecop_runs.tar.gz`。
- 可读性验证：`gzip -t` 返回成功；`tar -tzf` 可列出 36 项，前缀为 `./runs/`。
- 处置：不改写原提交与原回执；当前文档、发布归档和校验表均显式记录正确值及本勘误。

