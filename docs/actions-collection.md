# Actions 看板采集

## 功能

`.github/workflows/collect.yml` 将已有 Python 采集器放到 GitHub Actions 运行。Cloudflare Worker 只接收／记录 Webhook、合并更新并触发该工作流；采集后的 App 提交继续触发 `pages.yml` 发布 GitHub Pages。现有本机 `publish.py` 用法保持兼容。

正式仓和测试仓使用相同工作流及脚本，保留各自的站点快照。`collection_context.py` 从本仓 `board-config.json` 按当前 `GITHUB_REPOSITORY` 反查唯一源仓。正式对应 `openJiuwen-ai/sciencediscovery`，测试对应 `ScienceDiscovery/sciencediscovery`。未知目标仓、跨站源仓参数和非法请求编号会在申请凭据前被拒绝。

## 配置和运行

在两个看板仓各自配置变量 `SDBOT_GITHUB_APP_ID`、Secret `SDBOT_GITHUB_APP_PRIVATE_KEY`。私钥保持多行 PEM，仅保存到 Secrets；不会作为 workflow_dispatch 参数传入，也不写站点或 artifact。App 必须安装到源仓和目标仓，跨组织分别取 installation。

源仓令牌仅申请 Contents／Issues／Pull requests／Actions／Checks／Commit statuses 读取权限；目标仓令牌仅申请 Contents 写权限。令牌由 `actions/create-github-app-token@v2` 申请，在任务结束时撤销。Worker 触发 collect.yml 的令牌另需目标仓 Actions 写权限。

App 的 Actions 写权限在 App 注册页 **Permissions & events → Repository permissions → Actions → Read and write** 设置，并由目标组织在安装页批准更新；仅修改注册页不等于既有 installation 已获授权。两个看板仓同属一个组织时批准一次对应 installation 即可。仓库 Settings → Actions 的默认 `GITHUB_TOKEN` 权限继续保持只读；触发所需的 App Actions 写权限与此设置不同。

工作流只接受 `workflow_dispatch`，固定 checkout main，禁止 checkout 输入指定的任意分支。输入 `source_repository` 可省略，填写时必须匹配本站源仓；`request_id` 为诊断用刷新编号，不包含原始 Webhook、私钥或安装令牌。可在 Actions 的 **Collect dashboard data** 手动执行，也可以由 Bot 调用 GitHub workflow dispatch API。

采集步骤从环境变量读取源仓 `GITHUB_TOKEN` 和目标仓 `GSB_PUBLISH_TOKEN`，运行 `publish.py --repo ... --publish-repo ... --output .tmp/collected-site`。临时目录不上传，不写回原始测试 artifact。发布器只更新 main/site/ 的八个公开站点文件；保留源码和工作流，非强制更新冲突会失败，不覆盖新提交。

## 完成状态和重试

Bot 的“已触发采集”只表示 GitHub 接受调度。实际采集结果看 **Collect dashboard data**，Pages 结果看 **Deploy dashboard Pages**。失败保留上一版页面，支持手动重跑或下一轮刷新。

工作流按目标仓串行，`cancel-in-progress=false`，不会中断运行中的采集。GitHub 可能合并／替换尚未开始的同组等待任务，快照按执行时最新仓库状态采集。dispatch 在网络异常时可能重复执行，刷新编号不作为 GitHub 的去重保证。

写 site 使用 App 安装令牌，不能替换为 Actions 默认 GITHUB_TOKEN 后仍期待 push 自动触发另一个工作流。`pages.yml` 自身的上传和部署继续使用其默认 GITHUB_TOKEN 即可。

## 本地验证与同步

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

测试覆盖正式／测试映射、拒绝跨站和恶意 inputs、读写凭据隔离、公开内容边界、非强制提交和测试报告统计。Bot 仓 `npm run test:worker-adapter` 覆盖 Worker 到模拟 Actions API 的签名凭据与触发链路。两者不代表真实 GitHub runner 或 Pages 已执行，上线前仍需验证。

将此功能同步到测试仓时只同步 `collect.yml`、`collection_context.py`、测试与文档，不要用正式仓整条 main 覆盖测试仓的 site 快照。切换前停止同站点的本机自动采集，避免两种调度同时写入。

参考：[GitHub App token Action](https://github.com/actions/create-github-app-token/tree/v2)、[工作流触发 API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。
