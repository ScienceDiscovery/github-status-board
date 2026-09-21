# GitHub 状态看板（本地）

跟踪一个 GitHub 仓库的 Issue、PR、CI、测试分布/覆盖与一般开源运维视图的本地 Web 面板。
纯 Python 3 标准库 + 原生 JS，无第三方依赖，无构建步骤，只读，不写任何 GitHub 数据。

> A local, self-hosted dashboard for one GitHub repository: issues, pull requests,
> CI health, test distribution/coverage and general open-source operations.
> Python 3 standard library only — no dependencies, no build step, read-only against
> the GitHub API. Everything runs on your own machine and binds to `127.0.0.1`.

## 环境要求

Python 3.10 或更新版本。可选装 [`gh`](https://cli.github.com/) 以复用它已登录的凭据。

## 启动

```bash
git clone https://github.com/ScienceDiscovery/github-status-board.git
cd github-status-board

GSB_REPO=<owner>/<repo> ./run.sh start   # 后台启动，默认 http://127.0.0.1:8790/
./run.sh status|logs|restart|stop
python3 server.py       # 前台运行（Ctrl-C 退出）
python3 server.py --once   # 只采集一次并打印各区块状态，不起服务
```

不带 `GSB_REPO` 时跟踪默认仓库（见下表）。跟踪自己的仓库只需覆盖这一个变量。

## 认证

按以下顺序查找 token，任选一种即可：

1. 环境变量 `GITHUB_TOKEN`；
2. 环境变量 `GH_TOKEN`；
3. `gh auth token`（已登录的 `gh` CLI）。

```bash
export GITHUB_TOKEN=<你的 personal access token>   # 或先执行 gh auth login
```

公开仓库只读所需权限：classic token 勾选 `public_repo`（要读 Actions 测试产物还需 `workflow` 对应的读取范围），fine-grained token 授予目标仓库的 Contents / Issues / Pull requests / Actions 只读权限；私有仓库需要完整 `repo`。

未认证也能跑，但匿名限额 60 次/小时，而一次完整采集约 50 次调用，因此几乎必然触发限流。

token 只在内存中使用：不写入缓存、不写入日志、不出现在页面上，也不会随快照落盘。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `GSB_REPO` | `openJiuwen-ai/sciencediscovery` | 跟踪的 owner/repo |
| `GSB_HOST` / `GSB_PORT` | `127.0.0.1` / `8790` | 绑定地址；拒绝 4310/4311 |
| `GSB_REFRESH_INTERVAL` | `600` | 自动刷新间隔（秒），0 关闭 |
| `GSB_TEST_ARTIFACTS` | `ut-results,st-results,e2e-results` | 要解析的 Actions 测试产物名 |
| `GSB_ARTIFACT_MAX_MB` | `80` | 单个产物下载上限 |
| `GSB_REVIEW_SLA_DAYS` | `3` | 超过此天数无人评审的 PR 计为「等待过久」 |
| `GSB_STALE_DAYS` | `30` | Issue 无更新超过此天数计为陈旧 |
| `GSB_JOB_HISTORY_RUNS` | `12` | 逐 job 统计的主干 run 数 |
| `GSB_LOCAL_CHECKOUT` | 无 | 文件树 API 失败时用本地 clone 统计测试分布 |
| `GSB_CACHE_DIR` | `./.cache` | 快照与已解析产物的缓存目录 |
| `GSB_DISK_CACHE` | `1` | 设为 `0` 时快照只在内存，不写磁盘 |
| `GSB_DATA_DIR` | `./.data` | 看板本地字段 / 列配置 / 规则 / 别名（`board.json`） |

## 看板

「看板」标签页把仓库的开放 Issue、开放 PR 和最近关闭 / 合并的条目做成 GitHub Projects 风格的项目板：本地自定义字段（状态列可增删改排序并设 WIP 上限、优先级 P0–P3、迭代、备注），看板 / 表格两种视图，按状态 / 优先级 / 迭代 / 负责人 / 标签 / 里程碑 / 类型 / 作者分组，状态 / 优先级 / 迭代分组可拖拽，自动化规则（加入→待处理、指派→进行中、关联 PR→评审中、关闭或合并→已完成、重开→待处理）只会把卡片往后推、不会降级手动状态，详情抽屉按需读正文与交叉引用。全部字段只存本地 `.data/board.json`，不写回 GitHub；`POST /api/board/*` 需带 `X-Requested-With: github-status-board` 且同源。

安全告警、流量、账号权限/登录名、仓库安全特性开关属于内存态数据：写入 `.cache/snapshot.json` 前会替换为 `{"redacted": true}` 标记（见 `gsb/snapshot.py` 的 `MEMORY_ONLY_PATHS`），重启后立即重新采集补齐。token 从不落盘。

## 结构

```
server.py          HTTP 服务与路由（/, /static, /api/snapshot, /api/status, POST /api/refresh）
gsb/github.py      GitHub REST/GraphQL 客户端、token 发现、错误分类（unauthorized/forbidden/rate_limited/...）
gsb/collectors.py  五个区块采集器：issues / prs / ci / tests / ops
gsb/testparse.py   测试树分类；run.log(TAP/unittest/pytest)、Playwright results.json、JUnit、覆盖率文件解析
gsb/snapshot.py    并行采集、区块级错误封装、磁盘缓存、后台刷新
static/            单页前端（index.html / app.js / style.css）
run.sh             start/stop/restart/status/logs/once
```

`.cache/`、`.data/`、`.run/`、`.tmp/` 为运行时目录，只存在于本地，已在 `.gitignore` 中，不会进入版本库。

## 许可证

[Apache License 2.0](LICENSE)。
