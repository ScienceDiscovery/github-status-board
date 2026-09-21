# GitHub 项目交付看板

部署在 GitHub Pages 的静态看板，以项目管理者的视角查看 Issue、PR、合并门禁、每日构建和版本测试，重点显示 E2E 的用例数与稳定通过率。页面只读取同站点的 `data/snapshot.json`，无需登录、后端服务或浏览器 Token。

线上站点：<https://sciencediscovery.github.io/github-status-board/>。默认数据源为公开仓库 `ScienceDiscovery/sciencediscovery`。

## 看板内容

- 项目总览：开放 Issue、待合入 PR、最近 E2E 报告、最近版本；优先提示无人认领、长期无更新、评审积压和失败检查。
- Issue 与 PR：按类型、编号、标题、负责人和标签检索；展示 PR 当前提交检查、评审、草稿、负责人及工作项年龄。
- 构建与测试：分合并门禁、每日构建、版本验证，展示运行、任务、失败步骤、提交 SHA、run ID 和重跑 attempt。逐层列出 UT / ST / E2E 用例及通过、失败、跳过、重试通过数量；可打开用例明细和原始 GitHub 证据。
- 版本验证：根据版本标签解析的提交 SHA 关联版本验证运行；发布成功不会自动标记为测试通过。

所有时间按浏览器时区显示。快照超过两小时会提示过期；“刷新视图”只重新读取已发布快照。

## 生成与预览

Python 3.10+，采集器只用标准库。凭据仅来自 `GITHUB_TOKEN` / `GH_TOKEN` 或已登录的 `gh`。禁止将真实 Token 放入命令行参数、仓库、页面、日志或测试数据。

```bash
python3 publish.py --repo ScienceDiscovery/sciencediscovery
python3 server.py                 # http://127.0.0.1:8790/
# 或 ./run.sh once；./run.sh start|status|stop
```

生成目录 `dist/` 已忽略。预览服务只提供静态文件，不再提供旧版 `/api/*` 或本地看板字段编辑。

## GitHub Pages 发布

```bash
python3 publish.py --repo ScienceDiscovery/sciencediscovery \
  --publish-repo ScienceDiscovery/github-status-board
```

发布器通过 Git Data API 原子提交五个文件到 `gh-pages`：`index.html`、`app.js`、`style.css`、`data/snapshot.json`、`.nojekyll`。首次在仓库 Settings → Pages 选择 `Deploy from a branch`、`gh-pages`、`/ (root)`。提交使用非强制更新；并发冲突会失败并保留上一版站点。

`main` 保存源码；`gh-pages` 保存站点。浏览器只下载静态资源；不访问 GitHub API，不连接 bot 管理端口。发布仅接受公开源仓库和公开目标仓库，不导出旧采集器的权限、流量、安全告警、原始日志、截图或 trace。

## bot 自动更新

使用 `sciencediscovery_bot` 的可选 `docker-compose.board.yml`。bot 收到已验签且属于跟踪仓库的 Issue、PR、评审、push、workflow_run、workflow_job、check_run、check_suite、status、release 和标签变化事件时入队，后台运行本项目 `publish.py`；20 秒合并事件，发布间隔至少 60 秒，失败按 30～600 秒退避。启动及每小时兜底采集；队列状态持久化，容器重启后继续。

在 bot 的本地 `.env` 配置（真实凭据只填本地，不提交）：

```dotenv
SDBOT_BOARD_REPO=ScienceDiscovery/github-status-board
SDBOT_BOARD_TRACK_REPO=ScienceDiscovery/sciencediscovery
SDBOT_BOARD_SOURCE_DIR_HOST=../github_status_board
SDBOT_BOARD_GITHUB_TOKEN=
```

```bash
# 在 bot 目录运行
docker compose -f docker-compose.yml -f docker-compose.board.yml up -d --build
```

凭据需要源仓库的 Metadata / Issues / Pull requests / Actions 读取权限、目标看板仓库的 Contents 写权限。配置 Pages 是一次性的管理员操作；日常发布不需管理权限。bot 还必须配置 GitHub webhook secret，未配置则拒绝启用发布功能。优先使用专用、限定仓库且可轮换的凭据。管理员可在 bot 的 loopback `/api/status` 查看 `board.pending`、`running`、`last_success`、`commit` 和错误类别；公开 webhook 不返回这些信息。API 提交成功到 Pages 可见仍有部署延迟。

## 工作流与报告契约

看板读取现有 CI 证据，不替源仓库执行测试，也不会将缺失证据当成成功。默认按 `release` 事件／版本工作流归为版本验证、`schedule`／daily/nightly 归为每日构建，其余为门禁；可在 `board-config.json` 配置名称正则。

Actions 产物名使用 `ut-results`、`st-results`、`e2e-results`（分片可追加后缀）。支持：

1. Playwright `results.json` / `report.json`：优先使用最终 outcome，重试不增加用例数；预期失败按框架结果处理。
2. JUnit XML：从 testcase 或最内层 testsuite 计数，避免父子汇总重复。
3. `dashboard-summary.json`：字段 `tests`、`passed`、`failed`、`skipped`、`flaky` 均为非负整数，后四项之和必须等于 tests。
4. `run.log`：兼容现有 CI 的 TAP / unittest / pytest 汇总，作为没有结构化报告时的后备来源。

同一产物内只取一种报告格式，优先级为 summary、Playwright、JUnit、log。分片产物必须互不重叠，避免同时上传同一层的合并报告和分片。稳定通过率 = passed / tests；skipped 和 flaky 单列，不计稳定通过。零用例不显示 100%。

报告只关联当前 run、SHA 和 attempt；重跑前的产物不会挪用。过期、下载失败、解析失败和未上传均显示未知数量。每个产物最多下载 80 MiB，展开内容最多 160 MiB / 3000 个条目，不解压到磁盘。明细最多 500 条，汇总保留完整数量。

采集边界：开放 Issue 最多 500、开放 PR 最多 200、最近 100 个 Actions run、优先各工作流／阶段最新报告共 12 个 run、15 个 Release。PR 检查汇总受 GitHub GraphQL 分页限制，缺失时展示未知并提供原页面链接。列表上限不等于仓库总量；统计仅用于此快照范围内的管理判断。

## 验证

```bash
python3 -m unittest discover -s tests -v
node test/sync-e2e.mjs
node .e2e/node_modules/playwright/cli.js test --config test/playwright.config.cjs
```

浏览器用例使用仓库固定 Playwright 版本和独立临时目录／端口，覆盖真实静态子路径、筛选、测试明细、缺失证据、过期状态、刷新、浏览器时区和窄屏布局。测试 fixture 只用于本地验收，不发布成项目运行结果。
