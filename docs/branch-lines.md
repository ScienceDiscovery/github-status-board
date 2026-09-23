# 分支线

## 功能

源仓除默认分支外还有长期开发分支（如 `feat/jiuwenswarm`），它有自己的 PR 门禁和手动运行。CI、测试、Coverage 三页在页首提供“分支线”切换，每次只显示一条分支线的数据，各线互不混合：

- 每个 run 归入它的工作所针对的分支：PR 运行归入 PR 的目标分支，push、手动、定时运行归入运行所在分支。
- 目标分支不是任何已配置分支线的 run（版本 tag、Nightly、其他分支的 push、无法匹配 PR 的运行）归入默认分支线，因此每个 run 只计一次。
- 默认分支线保持原有全部内容；其他分支线只有 PR 与该分支两层 CI 分层历史，没有 Daily 与版本层。

## 使用

在 `board-config.json` 中配置：

```json
"branch_lines": [
  { "key": "main", "label": "main", "ref": "main" },
  { "key": "jiuwen", "label": "jiuwen", "ref": "feat/jiuwenswarm" }
]
```

- `key` 用于页面状态，只能是小写字母、数字和连字符；`label` 是切换按钮文字；`ref` 是分支名。
- 默认分支总是第一条线，即使未列出；重复的 key 或分支会被忽略。未配置 `branch_lines` 时不显示切换控件。
- 页面选择保存在本浏览器，三页共用；切换时重置“最近 run”的分支筛选与覆盖率周次。

各页在非默认分支线上的内容：

| 页面 | 内容 |
| --- | --- |
| CI | 该分支 push / 手动运行（标为“<label> 分支”）和目标为它的 PR 的成功率、分层历史、Workflow 与 Job 健康、最近 run |
| 测试 | 最近用例数，以及该分支最新 push / 手动运行冻结的[标签化测试](tagged-tests.md)目录和规则；没有运行过的组合不显示 |
| Coverage | 只用该分支线运行上传的覆盖率摘要；完整基线来自该分支完整通过的 push 或手动门禁；PR 列表只含目标为它的 PR |

总览仍以默认分支线为准，同时把其他分支线最近一次 push / 手动运行的失败列入“需要处理的问题”。

## 主要实现

- `gsb/lines.py`：`configured_lines` 读取配置，`target_of` 求 run 的目标分支，`line_of` 映射到分支线。
- run 记录新增 `base_branch`（同仓 PR 的目标分支，来自 run 的 `pull_requests`）。fork PR 的 run 没有关联 PR，沿用 [CI 分层历史](ci-history-lanes.md)的按 head 分支匹配 PR，再取 PR 的 `base`。
- 历史索引新增 run 的 `pull_requests`、`base_branch`、`head_repo` 与 PR 的 `head`、`base`、`head_sha`、`head_repo`。早期索引行缺少这些字段时，快照从记录重建一次索引行，不改记录与计数。
- `incremental_project.build_snapshot` 按分支线分别计算 CI、分层历史、测试补充数据和覆盖率：`sections.ci` / `sections.tests` 是默认分支线，`line_sections.<key>` 是其他分支线，`lines` 列出全部分支线。Actions 产物列表每次构建只读取一次；覆盖率产物按所属 run 归线，run 不在历史中时按其分支。
- `.sync/supplements.json` 的 `lines.<key>` 缓存各分支线的测试补充数据，随该线 run 集合变化刷新。
- `.sync/tagged.json` 版本 2 按分支保存标签化测试的组合与目录；版本 1（只有默认分支）自动迁移。
- 覆盖率基线接受 `*-coverage-summary-push-*` 与 `*-coverage-summary-workflow_dispatch-*`，前提是该分支、且各层均完整成功。
- 分支线配置变化时，下一轮采集重建快照。

## 边界

- 分支线只影响 CI、测试、Coverage 三页的展示与归类，不改变采集范围、历史记录和 Bot 触发策略。
- `feat/jiuwenswarm` 的 CI 没有 push 触发：该分支的标签化目录和完整覆盖率基线来自手动运行；目标为它的 PR 可能修改规则，不作为依据。
- 已归档到默认分支、后来才配置分支线的历史 run 会在重建快照时按目标分支重新归类；标签化目录只从配置后的新运行读取。

## 验证

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_lines.py' -v
node .e2e/node_modules/playwright/cli.js test --config test/playwright.config.cjs -g "branch line"
```

单元测试覆盖配置校验、同仓 / fork / 手动 / tag 运行的归线、各线分层与成功率、覆盖率产物归线、标签化目录分线与迁移、配置变化触发重建。浏览器用例在桌面和窄屏验证切换、跨页与刷新后保持、各线数据不混合，以及总览列出其他分支线的失败。
