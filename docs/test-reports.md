# 测试报告契约

看板读取现有 CI 证据，不替源仓库执行测试，也不会将缺失证据当成成功。默认按 `release` 事件／版本工作流归为版本验证、`schedule`／daily/nightly 归为每日构建，其余为门禁；可在 `board-config.json` 配置名称正则。

Actions 产物名使用 `ut-results`、`st-results`、`e2e-results`（分片可追加后缀）。支持：

1. Playwright `results.json` / `report.json`：优先使用最终 outcome，重试不增加用例数；预期失败按框架结果处理。
2. JUnit XML：从 testcase 或最内层 testsuite 计数，避免父子汇总重复。
3. `dashboard-summary.json`：字段 `tests`、`passed`、`failed`、`skipped`、`flaky` 均为非负整数，后四项之和必须等于 tests。
4. `run.log`：兼容现有 CI 的 TAP / unittest / pytest 汇总，作为没有结构化报告时的后备来源。

同一产物内只取一种报告格式，优先级为 summary、Playwright、JUnit、log。分片产物必须互不重叠，避免同时上传同一层的合并报告和分片。用例数按报告中的测试实例（包含浏览器项目）计数，不是测试文件数；重试不重复计数。稳定通过率 = passed / tests；skipped 和 flaky 单列，不计稳定通过。零用例不显示 100%。

覆盖率支持 Actions 产物中的 lcov、Istanbul summary 和 Cobertura；若只能读取 Codecov 公共汇总，会明确标记未关联本次构建。测试文件比值不当作行覆盖率；包级用例只来自完整可定位的结构化报告或日志中的包级计数，原始日志与命令不发布。

报告只关联当前 run、SHA 和 attempt；重跑前的产物不会挪用。过期、下载失败、解析失败和未上传均显示未知数量。每个产物最多下载 80 MiB，下载受整次读取时间预算约束；持续缓慢传输也会中止并标记不可读取，不阻断整站更新。展开内容最多 160 MiB / 3000 个条目，不解压到磁盘。公开历史只保留指标；原始详情在 GitHub 查看。

