# E2E 执行记录

## 功能

测试页的“E2E 执行记录”列出当前分支线上、看板窗口内仍在保留期的 `e2e-results` 产物。每次运行显示通过、失败、跳过、重试通过数；“查看 N 个用例”打开单条用例的 Playwright 步骤；“执行记录 HTML”在看板站点打开该运行各分片的 Playwright 报告。报告无法托管时，改为链接到该产物在 GitHub 上的下载页。

计数沿用[测试报告契约](test-reports.md)的 Playwright outcome 规则，测试页原有的 E2E 用例卡片不变。

## 使用方式

- **用例结果**：按结果分色的计数；尚未下载或无法读取的产物显示原因。
- **用例步骤**：弹窗默认筛出失败用例并展开，显示错误摘要和按执行顺序排列的步骤；嵌套步骤缩进显示，每步给出结果与耗时，失败的步骤附带自己的错误。可按结果筛选、按用例或文件搜索；重试后通过的用例显示重试前的失败。没有 `test.step` 的用例提示到 HTML 报告查看完整过程。
- **执行记录 HTML**：每个分片一个链接，在新标签页打开同站点的 `e2e/<artifact_id>/<分片>/index.html`。灰色的“GitHub 产物”表示本次没有托管 HTML，悬停可看原因。
- **保留至**：产物的 `expires_at`；过期后记录与 HTML 一起从看板消失。

## 主要实现

### 采集：每次有界替换

`publish.py --incremental` 生成快照后调用 `gsb/e2e_records.py` 的 `refresh()`：

1. 只请求一次 `GET /repos/{源仓}/actions/artifacts?name=e2e-results&per_page=100`。只读第一页，不带页码，也不保存游标，因此不会回扫更早的产物历史。
2. 只保留出现在本次快照中的运行，包括各分支线 CI 分层历史里的运行和最近 run。去掉 `expired` 为真或 `expires_at` 已过的产物，再按创建时间取最新 20 份。
3. 同一产物、同一记录版本的已有记录直接沿用。其余产物每次采集最多下载 2 份，并受整次采集 160 MiB 下载预算约束。运行详情在同一次采集里刚下载过的产物直接复用，不重复请求。
4. 未下载的产物标为等待，由后续采集补齐。列表请求失败时不下载，只按已保存的 `expires_at` 移除过期记录。下载失败、解析失败或超出预算都只影响该条记录，整次采集照常完成。
5. 每次都输出完整的记录集合：索引 `site/data/e2e/index.json`，以及每份产物的步骤文件 `site/data/e2e/<artifact_id>.json`。离开集合的记录，其步骤文件在同一个提交里删除。issue、PR、CI 的增量同步不受影响，`.sync/` 不保存任何执行记录状态。

### 步骤与错误摘要

每个分片取带 `suites` 的 Playwright JSON 报告（`results.json`／`report.json`）。每个测试使用最后一次尝试的 `results[].steps`，保留嵌套层级，最多 8 层。每份产物最多展示 3,000 个步骤和 500 个用例的明细，超出部分仍计入计数。

带 `error` 的步骤判为失败。用例的错误摘要取最后一次失败尝试的第一条错误，去掉终端颜色和 `at` 栈帧，最多保留 16 行、1,200 个字符。

### HTML：随 Actions 产物保存，不进 Git

一次运行的三个分片报告合计约 8 MiB。提交进 Git 会让历史永久增长，所以 HTML 只在 Actions 和 Pages 之间传递：

1. 采集把新下载、且允许托管的分片报告写到 `.tmp/e2e-html/<artifact_id>/<分片>/`，包括 `index.html` 和同目录资源（如 `data/`）。
2. `collect.yml` 用 `run_records.py retention` 从这些报告中最晚的 `expires_at` 算出保留天数（1–90 天），再把目录上传为本次运行的 `e2e-html` 产物。索引的 `bundle` 字段记录报告所在的采集 run。
3. `pages.yml` 上传站点前运行 `run_records.py attach site`。它用本 job 的 `GITHUB_TOKEN`（`actions: read`）读取索引中未过期记录所在的 `e2e-html` 产物，只接受本仓 main 分支上的 `collect.yml` 运行。采集先提交、后上传，因此 Pages 会等待该运行最多 5 分钟。
4. 取不到的报告在部署出的索引里改为 GitHub 链接。已过期的记录连同其步骤文件从部署内容中移除。这一步任何失败都不会阻止 Pages 部署。

## 边界与阈值

| 项 | 阈值 | 超出后 |
| --- | --- | --- |
| 看板上的记录 | 最新 20 份 | 更早的运行只在 GitHub 查看 |
| 每次采集新下载 | 2 份 | 标为等待，后续采集补齐 |
| 单个产物下载 | 80 MiB（`GSB_ARTIFACT_MAX_MB`） | 标为超过下载上限，无步骤，链接 GitHub 产物 |
| 单个分片的 `playwright-report/` | 16 MiB | 仍显示步骤，HTML 改为 GitHub 产物链接 |
| 看板上 HTML 总量 | 256 MiB | 同上 |

- 以当前源仓的 `e2e-results` 实测：每次运行 3 个分片，HTML 分别约 1.1、5.1、2.1 MiB，步骤 JSON 约 33 KB，都在阈值内。
- 保存期限以 GitHub 返回的 `expires_at` 和 `expired` 为准，不写死 14 天。过期后的下一次成功采集删除步骤文件；每次 Pages 部署也会按 `expires_at` 排除 HTML。看板自己的 `e2e-html` 产物在其中最后一个源产物过期后约一天内被 GitHub 清除。
- 来自 fork 的运行（产物的 `head_repository_id` 与源仓不同）只显示步骤，其 HTML 不在看板域名下托管。
- trace、截图、视频不另外归档。`playwright-report/data/` 里的附件随报告保留；`test-results/` 等其余内容请下载 GitHub 产物。
- 页面只把 `e2e/<数字>/<分片>/index.html` 形式的路径渲染为站内链接，其余一律链接到 GitHub。

## 验证

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.test_e2e_records tests.test_publish -v
node .e2e/node_modules/playwright/cli.js test --config test/playwright.config.cjs -g "E2E run records"
```

`tests/test_e2e_records.py` 覆盖以下内容：
- 嵌套步骤、失败摘要和重试前失败，计数与原解析器一致；
- 单次列表请求、无游标、下载上限；
- 过期记录的删除，以及 fork、超预算、GitHub 失败时的降级；
- Pages 只挂载未过期报告、会等待上传、拒绝非采集运行的产物；
- 保留天数计算。

`tests/test_publish.py` 验证只有执行记录文件可以在提交中删除。

浏览器夹具 `test/prepare-site.py` 用真实的 `refresh()` 和 `attach()` 生成三份记录：一份仍在保留期，一份在部署时已过期，一份来自 fork。旅程在桌面宽度和 390px 宽度下检查失败用例的有序步骤与错误摘要、未过期报告能打开，以及过期报告返回 404。
