# 云端 Agent 助手工作台

在浏览器中交给 Agent 编程或文件整理任务。工作台通过 **OpenCode CLI** 调用真实模型，展示执行进展，交付可预览、可下载的文件，并保存每个会话的上下文。

[代码任务与追问截图](docs/evidence/code-follow-up.png) · [文件分析截图](docs/evidence/report-preview.png) · [验收记录](docs/VALIDATION.md)

## 启动

需要 Docker 和 Docker Compose，以及支持流式 OpenAI Chat Completions 和工具调用的模型网关。

1. 将 [配置示例](.env.example) 复制为本地 `.env`。
2. 填写 `AGENT_API_BASE_URL`、`AGENT_API_KEY` 和 `AGENT_MODEL`。基地址形如 `https://gateway.example/v1`。密钥通过服务端环境变量注入。
3. 构建并启动。打开 [http://127.0.0.1:3000/](http://127.0.0.1:3000/)。

~~~sh
cp .env.example .env
# 编辑 .env，填入实际网关地址、密钥和模型 ID
docker compose up --build -d
curl --fail http://127.0.0.1:3000/api/health
~~~

端口被占用时，在 `.env` 内设置 `WORKBENCH_PORT`，例如 3001。停止服务用 `docker compose down`。命名数据卷保存会话、任务事件、文件和 CLI 上下文。

## 浏览器演示

### 开发并继续修改代码

1. 新建「CSV 汇总工具」，把 [sales.csv](demo/sales.csv) 拖入输入框。发送「用 Python 标准库按商品汇总 amount，生成脚本和 unittest，并运行测试」。
2. 展开「执行进展」查看读写和命令结果。助手结论后的文件可直接预览和下载。右上「文件」按钮打开或收起文件侧栏。
3. 关闭页面再回来，从左侧找回会话。发送「在原脚本加入 `--month YYYY-MM` 筛选，并重跑测试」。验证更新后的文件和测试结果。

### 在另一个会话整理材料

新建「会议纪要整理」，拖入 [会议纪要.txt](demo/会议纪要.txt)，发送「提取行动项、负责人、截止日期和待确认事项，生成 Markdown 行动清单」。预览或下载报告，并切回原会话继续工作。如果之前的任务仍在执行，新任务显示「排队中」。

## 查看实际产物

从真实模型联调中导出的 [Python 脚本](demo/results/code/outputs/aggregate_sales.py)、[测试](demo/results/code/outputs/test_aggregate_sales.py) 和 [行动清单](demo/results/行动清单.md) 随仓库提供。代码演示可在不配置模型的情况下复验。

~~~sh
cd demo/results/code
python3 -m unittest discover -s outputs -q
python3 outputs/aggregate_sales.py inputs/sales.csv --month 2026-02
~~~

本次复验通过 35 项测试。筛选结果为 Notebook 80、Pen 25，合计 105。材料任务的三个行动项及待确认会议室可在行动清单中核对。[完整验证记录](docs/VALIDATION.md)

## 实现取舍与限制

- 工作台面向可信的单用户任务，端口默认绑定本机。一个任务运行时，可以进入其他会话、上传文件或提交下一项工作。
- 关闭浏览器后后台继续执行。服务重启时恢复历史和文件，执行中的任务会标记为中断。用户可以取消当前任务，或在看到错误原因后决定是否续接。
- OpenCode 的工具、消息和终态事件经后端持久化并通过 SSE 传给浏览器。界面依次展示执行进展、助手结论和成果文件。
- 默认每轮最多 12 次模型请求，每个 UTC 自然日最多 120 次。代理限制单次输入和生成量，并控制出站间隔。供应商返回的用量随任务保存。
- 单文件上传上限为 20 MiB。侧栏支持代码、Markdown 和常见文本格式预览。其他格式和较大文件可下载。会话工作目录分开，共享容器内的非 root 运行用户。

更多信息见[设计与接口](docs/DESIGN.md)和[后端联调记录](docs/BACKEND_VALIDATION.md)。开发环境使用 Node.js 24 或更新版本，本地运行 `npm ci`、`npm run build` 和 `npm test`。
