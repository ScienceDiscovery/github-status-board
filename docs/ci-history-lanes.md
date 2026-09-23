# CI 分层历史

## 功能

CI 页的「CI 分层历史」替代原来的单条「主干时间线」。四层与源仓 Actions 的触发方式一致，所有层共用一条日期横轴：

| 层 | 归入的 run |
| --- | --- |
| PR | 门禁工作流（默认名称 `^CI$`）的 `pull_request` / `pull_request_target` |
| 主干 | 门禁工作流在默认分支的 `push`，以及它自己的 `workflow_dispatch`（提示中标“手动”） |
| Daily | 名称匹配 daily 规则（Nightly）的 run，包括 `schedule` 和手动 `workflow_dispatch` |
| 版本 | 名称匹配 release 规则（Release）的 run，即版本 tag 推送 |

[分支线](branch-lines.md)的其他分支只画 PR（目标为该分支）与该分支 push / 手动两层，层名为分支线名称。

名称规则取 `board-config.json` 的 `workflows.gate` / `daily` / `release`，缺省时使用相同默认值。Nightly 与 Release 通过 `workflow_call` 调用 CI，被调用的 job 属于调用方的 run，只在 Daily / 版本层计一次。若出现 `event=workflow_call` 的 run，或门禁工作流带有自身没有的触发事件（如 `schedule`），均视为被调用的子 run，不在任何层画点，只在图下计数。其他工作流、门禁工作流在非默认分支的 push 计为“其他”，同样不画入。

## 使用

- 默认窗口为近 30 天，日期按 UTC+8 划分，最右列是快照生成当天。副标题写明起止日期。
- 每格一次 run，颜色表示该 run 最后一次尝试的结论：成功（绿）、失败 / 超时 / 启动失败（红色斜纹）、取消 / 跳过（浅灰）、运行中 / 排队（黄）、其他如待批准（深灰）。颜色沿用原时间线图例，斜纹使红绿色弱也能区分失败。
- 同一天同一层的多次 run 在该日格内按创建时间自上而下排列（上早下晚）。超过 10 次时该日格在层内滚动，底部显示当天总次数。
- 悬停或键盘聚焦显示工作流、事件（定时 / 手动）、PR 号、结论、尝试次数、时间、分支或标签与标题；点击打开对应 GitHub run。
- 层标签给出窗口内成功、失败、取消、运行中计数和成功率。成功率 = 成功 ÷（成功 + 失败/超时），取消、运行中与其他不计入。没有 run 的层显示“窗口内没有 run”，不计为失败。
- 窄屏时层标签固定在左侧，日期轴在卡片内横向滚动，默认停在最新一天；读者滚走后保持位置。
- 历史尚未回填完成，或兼容模式只读取一页 run 时，最早已采集日期之前的列显示斜纹“未采集”，不代表没有运行。

## 主要实现

- `gsb/ci_lanes.py`：`lane_of` 分层，`pr_number` 取 PR 号，`build_lanes` 生成 `sections.ci.data.lanes`。`days` 是共同日期轴，每层 `days[i]` 与之对齐，格内已按时间排序。前端 `static/app.js` 的 `ciLanes` 只负责渲染。
- PR 号优先使用 run 的 `pull_requests`。fork PR 的该字段为空，改为按 head 分支匹配当时开放的 PR，再用 head 仓库、SHA、标题排除歧义；仍不唯一时不显示号码。推断出的号码在提示中标“按分支推断”。
- 增量模式（`incremental_project.build_snapshot`）只为窗口内的 run 读取完整记录，并只读取窗口内开放过的 PR。兼容模式（`project.build_project`）使用本次读取的 run 页。
- run 与 PR 记录新增 `head_repo`，历史搜索索引新增 `event`。旧索引行缺少 `event` 时，快照从对应记录重建该行一次，不改记录、不删除历史；新字段随增量采集与每周对账补齐。既无触发事件又无关联 PR 的 run 计为“无法分层”。
- 已发布快照没有 `lanes` 时，下一轮采集会重建一次快照。

## 边界

- 只展示已采集的 Actions run，不触发、不执行测试，也不修改源仓工作流。
- 窗口天数与时区是代码常量（`WINDOW_DAYS`、`DISPLAY_ZONE`）。
- 位置按 run 创建时间；重跑后颜色更新，但不会移到重跑当天。
- 构建报告页的三张摘要卡与本图独立。

## 验证

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_ci_lanes.py' -v
node .e2e/node_modules/playwright/cli.js test --config test/playwright.config.cjs -g "CI trends"
```

单元测试覆盖分层归类（PR、主干 push、Nightly 定时与手动、Release tag、`workflow_call` 不重复计数）、同一天多次 run 的纵向顺序、各层日期对齐、PR 号推断以及旧索引缺字段降级。浏览器用例检查四层与 30 列对齐、同日纵向顺序、提示内容、空层、窄屏滚动与标签固定。
