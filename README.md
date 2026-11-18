# 云端 Agent 助手工作台

面向单用户的浏览器 Agent 工作台。后端调用真实 OpenCode CLI，支持独立会话、可恢复的任务进展、文件分析和代码成果。

## 用 Docker 启动

1. 把 `.env.example` 复制为 `.env`。
2. 填入兼容 OpenAI Chat Completions 的网关地址、API Key 和模型 ID。API 地址填写基地址，例如 `https://gateway.example/v1`。
3. 启动服务并检查健康接口。

```sh
docker compose up --build -d
curl --fail http://127.0.0.1:3000/api/health
```

打开 [http://127.0.0.1:3000/](http://127.0.0.1:3000/) 进入工作台。可以在 `.env` 里使用 `WORKBENCH_PORT` 修改宿主机端口。停止服务用 `docker compose down`。SQLite、文件与 OpenCode 上下文保存在 Compose 数据卷中。

## 浏览器演示

1. 新建「CSV 汇总工具」会话，把 [sales.csv](demo/sales.csv) 拖进输入框。发送「用 Python 标准库编写 CSV 汇总工具，按商品汇总 amount，生成脚本和 unittest 并运行测试」。展开执行进展，查看真实读写和命令事件。用对话中的「预览」「下载」获取成果，点「文件」可打开或收起侧栏。
2. 在代码任务运行期间新建「会议纪要整理」会话，把 [会议纪要.txt](demo/会议纪要.txt) 拖进输入框，要求生成 Markdown 行动清单。若代码任务仍在运行，材料任务会显示排队。检查报告中的负责人、日期和待确认事项。
3. 关闭页面后重新打开。从左侧找回「CSV 汇总工具」，继续发「在现有代码上加 `--month YYYY-MM` 筛选并重跑测试」。用预览查看改动后的脚本，确认 2026-02 只汇总到 Notebook 80 和 Pen 25。
4. 新发一轮任务并在执行中点「停止」，检查状态显示已取消，之前生成的文件仍可查看。模型服务遇到限流或超时时，进展区显示原因；「继续任务」将续接提示填入输入框，由用户确认发送。

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

需要 Node.js 24 或更新版本执行本地构建和测试。Vite 只用于构建浏览器资源，容器运行时由 Express 提供静态文件。

```sh
npm ci
npm run build
npm test
```
