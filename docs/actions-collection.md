# Actions 看板采集

## 功能

`.github/workflows/collect.yml` 将已有 Python 采集器放到 GitHub Actions 运行。Node／Compose 或 Cloudflare Worker Bot 只接收／记录 Webhook、合并更新并触发该工作流；采集后的 App 提交继续触发 `pages.yml` 发布 GitHub Pages。现有本机 `publish.py` 用法保持兼容。

正式仓和测试仓使用相同工作流及脚本，保留各自的站点快照与同步进度。每个仓的 `board-config.json` 只保存自己的单一源仓映射；同步共享代码时不能复制另一环境的部署映射。`collection_context.py` 从本仓 `board-config.json` 按当前 `GITHUB_REPOSITORY` 反查唯一源仓。正式对应 `openJiuwen-ai/sciencediscovery`，测试对应 `ScienceDiscovery/sciencediscovery`。未知目标仓、跨站源仓参数和非法请求编号会在申请凭据前被拒绝。

## 配置和运行

正式与测试分别配置 Actions Variables：`SDBOT_TOKEN_BROKER_URL` 为对应 Worker 的 HTTPS `/actions/token` 地址，`SDBOT_TOKEN_AUDIENCE` 与该 Worker 的 OIDC audience 一致。采集 job 使用 `id-token: write`，通过 `collect_with_oidc.py` 领取临时凭据，不再使用仓库 App ID 或私钥 Secret。

Worker 校验 GitHub OIDC 签名、issuer、audience、不可变仓库与组织 ID、main 分支、collect.yml 和 schedule／workflow_dispatch 事件，固定映射决定令牌的仓库和权限。源仓令牌仅有 Contents／Issues／Pull requests／Actions／Checks／Commit statuses 读取权限，目标仓仅有 Contents 写权限；Metadata 均只读。App 私钥保存在对应 Worker，不能把正式私钥交给测试实例。

客户端领取令牌后先遮蔽日志，只把两个安装令牌传给采集子进程；不会传递 OIDC 请求凭据或私钥。结束时尝试撤销两令牌，部分兑换失败也撤销已领取的令牌；强制终止或撤销失败时由令牌有效期兜底。没有长期 Secret 或个人令牌回退。

同一个 run／attempt 对每种用途仅能兑换一次，Worker 持久保存非秘密签发记录。网络失败或响应丢失后使用 GitHub Re-run jobs 或新的运行恢复。先部署支持兑换的 Worker，再更新本仓工作流；验证成功后删除旧 `SDBOT_GITHUB_APP_PRIVATE_KEY` 仓库 Secret。不要撤销 Worker 正在使用的 App 私钥本身。

App 的 Actions 写权限在 App 注册页 **Permissions & events → Repository permissions → Actions → Read and write** 设置，并由目标组织在安装页批准更新；仅修改注册页不等于既有 installation 已获授权。即使两个看板仓同属一个组织，也要分别批准正式与测试 App 各自的 installation；测试 App 只安装到实验源仓及测试看板仓。仓库 Settings → Actions 的默认 `GITHUB_TOKEN` 权限继续保持只读；触发所需的 App Actions 写权限与此设置不同。

工作流接受 `workflow_dispatch`，并在每小时第 17、47 分钟定时续跑；固定 checkout main，禁止 checkout 输入指定的任意分支。输入 `source_repository` 可省略，填写时必须匹配本站源仓；`request_id` 为诊断用刷新编号，不包含原始 Webhook、私钥或安装令牌。可在 Actions 的 **Collect dashboard data** 手动执行，也可以由 Bot 调用 GitHub workflow dispatch API。

采集步骤从环境变量读取源仓 `GITHUB_TOKEN` 和目标仓 `GSB_PUBLISH_TOKEN`，运行 `publish.py --repo ... --publish-repo ... --output .tmp/collected-site --incremental`。临时目录不上传，不写回原始测试 artifact。发布器基于本轮 checkout 的准确 HEAD，将 `.sync/` 进度及变化的 `site/` 分片放入一个 Git 提交。保留源码和工作流；并发冲突直接失败，下轮从新 main 续跑。只有 site 变化才触发 Pages。详情见 [增量同步](incremental-history.md)。

## 完成状态和重试

Bot 的“已触发采集”只表示 GitHub 接受调度。实际采集结果看 **Collect dashboard data**，Pages 结果看 **Deploy dashboard Pages**。失败保留上一版页面，支持手动重跑或下一轮刷新。

工作流按目标仓串行，`cancel-in-progress=false`，不会中断运行中的采集。GitHub 可能合并／替换尚未开始的同组等待任务，快照按执行时最新仓库状态采集。dispatch 在网络异常时可能重复执行，刷新编号不作为 GitHub 的去重保证。

写 site 使用 App 安装令牌，不能替换为 Actions 默认 GITHUB_TOKEN 后仍期待 push 自动触发另一个工作流。`pages.yml` 自身的上传和部署继续使用其默认 GITHUB_TOKEN 即可。

## 本地验证与同步

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

测试覆盖正式／测试映射、拒绝跨站和恶意 inputs、读写凭据隔离、公开内容边界、非强制提交和测试报告统计。Bot 仓 `npm run test:worker-adapter` 覆盖 Worker 到模拟 Actions API 的签名凭据与触发链路。两者不代表真实 GitHub runner 或 Pages 已执行，上线前仍需验证。

将此功能同步到测试仓前，先比较目标 main 与共同源码基线；目标已有的独立功能须三方合并并在该目标源码上验证。只同步本次明确的源码、工作流、测试与文档，保留目标仓自己的 `.sync/` 和 `site/`，不要整条分支覆盖。切换前停止同站点的本机自动采集，避免两种调度同时写入。

参考：[GitHub OIDC](https://docs.github.com/en/actions/reference/security/oidc)、[工作流触发 API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。
