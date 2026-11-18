# 云端 Agent 助手工作台

面向单用户的 Agent 工作台。当前后端可通过 HTTP API 创建和续接会话，调用真实 OpenCode CLI，订阅任务事件并上传、下载文件。浏览器界面将在下一阶段接入。

## 用 Docker 启动后端

1. 把 `.env.example` 复制为 `.env`。
2. 填入兼容 OpenAI Chat Completions 的网关地址、API Key 和模型 ID。API 地址填写基地址，例如 `https://gateway.example/v1`。
3. 启动服务并检查健康接口。

```sh
docker compose up --build -d
curl --fail http://127.0.0.1:3000/api/health
```

可以在 `.env` 里使用 `WORKBENCH_PORT` 修改宿主机端口。停止服务用 `docker compose down`。SQLite、文件与 OpenCode 上下文保存在 Compose 数据卷中。

## 发送任务并查看结果

以下需要 `curl` 和 `jq`。

```sh
base=http://127.0.0.1:3000
session_id=$(curl --fail --silent "$base/api/sessions" \
  -H 'Content-Type: application/json' \
  -d '{"title":"代码任务"}' | jq -r '.id')
run_id=$(curl --fail --silent "$base/api/sessions/$session_id/messages" \
  -H 'Content-Type: application/json' \
  -d '{"content":"生成 outputs/hello.py，打印 Hello Workbench，并运行它验证。"}' | jq -r '.run.id')
curl --fail -N "$base/api/runs/$run_id/events"
curl --fail "$base/api/sessions/$session_id/files"
curl --fail "$base/api/sessions/$session_id/files/download?path=outputs/hello.py" -o hello.py
```

上传材料时提交 `multipart/form-data` 的 `file` 字段。使用返回的 `path` 在消息中引用材料。向原会话提交新消息即可续接。

```sh
curl --fail "$base/api/sessions/$session_id/files" -F 'file=@meeting.txt'
```

接口清单与数据流见[设计方案](docs/DESIGN.md)。后端运行结果见[验证记录](docs/BACKEND_VALIDATION.md)。

## 额度与限制

- 每轮默认最多 12 次模型请求，每个 UTC 自然日最多 120 次。单次请求体默认上限 512 KiB，单次生成上限 4,096 token。可在 `.env` 调整。
- 服务在向供应商发请求前持久化计数，默认以至少 1.5 秒间隔出站。供应商拒绝请求后，本轮调用中止。页面可从运行详情或终态事件读取尝试数、返回用量的请求数和已知 token 数。
- 供应商遗漏用量时，仅汇总已收到的用量。请求及生成限制减少消耗，费用和剩余额度以供应商为准。
- 默认只监听本机端口，一次执行一个任务。工作目录按会话分开，容器内的 Agent 以同一非 root 用户运行。应用用于可信任务和材料。

需要 Node.js 24 或更新版本运行本地测试。

```sh
npm ci
npm test
```
