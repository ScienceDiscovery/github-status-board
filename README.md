# GitHub 项目状态看板

静态 GitHub Pages 看板，展示 Issue、PR、门禁、每日构建、版本验证、UT / ST / E2E 及 Node.js / Python 覆盖率指标。采集由看板仓 GitHub Actions 执行；Bot 负责接收 Webhook 和触发刷新。

| 用途 | 数据源 | 站点 |
| --- | --- | --- |
| 正式 | openJiuwen-ai/sciencediscovery | https://sciencediscovery.github.io/github-status-board/ |
| 测试 | ScienceDiscovery/sciencediscovery | https://sciencediscovery.github.io/github-status-board-test/ |

## 使用

在目标仓 Actions 手动运行 **Collect dashboard data**，或由 Bot 触发；每小时第 17、47 分钟自动续跑。采集提交 `site/` 后，**Deploy dashboard Pages** 发布站点。首次配置见 [Actions 采集](docs/actions-collection.md)。

本地快速预览（Python 3.10+，凭据来自环境或已登录的 gh）：

```bash
python3 publish.py --repo openJiuwen-ai/sciencediscovery
python3 server.py
```

此兼容命令生成有限近期快照；完整历史由 `--incremental` 模式基于目标仓自己的 `.sync/` 续跑。两种模式不要同时写同一站点。

Coverage 页从源仓 GitHub Actions 产物中读取 `node-coverage-summary-*` 和 `python-coverage-summary-*` JSON 摘要，分语言展示整仓汇总、趋势、路径指标与最近 PR 结果；看板本身不运行测试。

## 文档

[文档目录](docs/README.md) · [增量同步与历史](docs/incremental-history.md) · [Actions 配置](docs/actions-collection.md) · [测试报告契约](docs/test-reports.md)

看板的状态、优先级、迭代、备注与列设置保存在本浏览器，按源仓隔离；可导入／导出字段。浏览器不持有 GitHub 凭据，不连接 Bot，也不写回 GitHub。

## 验证

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
node test/sync-e2e.mjs
node .e2e/node_modules/playwright/cli.js test --config test/playwright.config.cjs
```

修改功能时同步更新对应文档。测试使用独立临时数据，禁止将 fixture 发布为真实看板数据。
