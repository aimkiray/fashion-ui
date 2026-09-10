# AI Fashion Studio - 商业级服装动态展示与试衣系统

AI Fashion Studio 是一套面向服装电商、快时尚品牌与独立设计师的高保真真人服装动态展示系统。依托 **Krea-2** 穿衣扩散底模 / **GPT Image 2** 图像编辑双引擎与 **MiniMax H3** 视频生成大模型，实现从单张服装平铺/试衣模特图到 10 秒 1080P 商业展示成片的端到端生成。

---

## 核心特性

- **双阶段工业级出片链路**：
  - **阶段一（约 20-40s）**：模特试衣定妆照生成，严格锁定服装版型与面料质感；
  - **阶段二（10s 动态）**：MiniMax H3 视频流驱动，实现两段式分镜（向前慢速走秀步态 + 45° 转体细节展示），自带环境微风与脚步原声音轨。
- **定妆照双引擎可选**：
  - **Krea-2**（ComfyUI 本地扩散，速度优先）；
  - **GPT Image 2**（OpenAI 图像编辑，质量优先，官方 `openai-imagegen-demo` 标准请求格式，默认非流式直连 + 自动重试/超时兜底）。
- **比例精确可控**：
  - 支持 3:4 / 9:16 / 1:1 三种比例；上游模型能力不足时（如 gpt-image-2 仅支持 1:1、2:3、3:2 画幅）服务端自动按所选比例无损居中裁剪还原；
  - 视频画布按定妆照真实宽高比自动推导，首帧与成片比例严格对齐。
- **现有定妆照直接生成视频**：
  - 历史记录中的任意定妆照可一键跳过阶段一、直接进入视频生成（零 API 成本），支持结果面板与历史卡片双入口。
- **小红书式瀑布流历史**：
  - 历史记录按媒体真实宽高比瀑布流排布（CSS Grid masonry，无裁剪、无空洞、零跳动），支持单条删除与懒加载。
- **模特主角面孔锁定（Dual Reference）**：
  - 支持上传品牌专属模特肖像参考图，精准锁定模特五官面孔、发型与神态，将服装自然穿戴上身。
- **场景背景融合与多样化预设**：
  - 阳光都市街拍 / 极简纯色影棚 / 摩天楼职场通勤 / 高端艺术买手店 / 自然户外林荫 / 现代极简咖啡厅；
  - 支持自定义场景（自由提示词 + 背景参考图）。
- **一键批量排队出片**：
  - 系统自动选取【都市街拍、纯色影棚、艺术买手店】顺序排队生成 3 套成片；
  - 前端支持多场景 Tab 平滑轮询预览与一键批量下载。
- **高可用与并发保障**：
  - 服务端全局 FIFO 原子执行队列，彻底防止任务插队与 GPU 显存频繁换模抖动；
  - 断点续询：页面刷新后自动恢复进行中任务的进度追踪；
  - 图像请求带超时熔断、指数退避重试与流式/非流式自动降级。

---

## 环境要求

- **Node.js** ≥ 18（依赖原生 `fetch` / `AbortSignal.timeout`）
- **ComfyUI** 运行于 `http://127.0.0.1:8188`，需已安装：
  - Krea-2 穿衣迁移工作流所需的自定义节点（见 `workflows/krea2_outfit_transfer.json`）
  - MiniMax H3 视频扩展工作流所需节点（见 `workflows/fashion_streetwear_10s_extend.json`）
- **Python 3 + Pillow**：用于定妆照比例裁剪（`crop_to_aspect.py`）与视频首帧画布对齐（`resize_to_canvas.py`）
- **OpenAI API Key**（仅 GPT Image 2 引擎需要，支持任意 OpenAI 兼容中转端点）

## 快速启动

### 1. 安装依赖
```bash
npm install
```

### 2. 配置密钥
复制 `.env.example` 为 `.env` 并填入你的 Key（或在 Web 界面「API 设置」面板中配置，优先级：Web 界面 > `.env` > 默认值）：
```bash
OPENAI_API_KEY=sk-xxxxxxxx
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_QUALITY=high
```

### 3. 启动服务
确保本地已运行 ComfyUI（默认端口 `http://127.0.0.1:8188`）：
```bash
# Windows 一键脚本（自动拉起 ComfyUI 检测与 Web 服务）
start.bat

# 或直接运行
node server.js
```
访问 Web 界面：`http://localhost:3000`

---

## 项目结构

```text
fashion_ui/
├── server.js               # Node.js 后端服务（ComfyUI WebSocket 通信、双阶段编排、FIFO 队列）
├── services/
│   ├── config.js           # 配置加载（.env / config.json / Web 界面三级优先级）
│   └── imagegen/
│       ├── index.js        # 定妆照引擎路由
│       ├── gptImage2.js    # GPT Image 2 引擎（非流式默认、TTFB/静默看门狗、重试与降级）
│       ├── krea2.js        # Krea-2 引擎（ComfyUI 工作流驱动）
│       └── sse.js          # SSE 解析工具
├── workflows/              # ComfyUI 工作流模板 JSON
│   ├── krea2_outfit_transfer.json
│   └── fashion_streetwear_10s_extend.json
├── public/                 # 前端静态页面与客户端代码
│   ├── index.html          # Web 交互控制台
│   ├── app.js              # 前端交互逻辑、任务轮询、瀑布流历史
│   ├── style.css           # 暗色系 UI 样式（含瀑布流网格）
│   └── vendor/phosphor/    # Phosphor Icons 本体
├── crop_to_aspect.py       # 按所选比例无损居中裁剪定妆照
├── resize_to_canvas.py     # 视频首帧画布对齐
├── detect_flatlay.py       # 服装平铺图检测
├── .env.example            # 环境变量模板
├── package.json            # 项目描述与依赖
├── start.bat / restart.bat / stop.bat   # Windows 服务脚本
└── storage/                # 运行时用户数据（已 gitignore，不入库）
```

## 隐私说明

- `storage/`（用户上传的服装图、生成的定妆照与视频）、`config.json`、`.env` 均已在 `.gitignore` 中排除，**不会进入仓库与 git 历史**；
- API Key 仅保存在本地，请勿将 `.env` / `config.json` 提交到任何公开位置；若不慎泄露请立即在服务商后台轮换。

## 分离部署（应用与 ComfyUI 分机）

当 Web 应用与 ComfyUI 运行在不同机器时（例如应用在 Mac、ComfyUI 在 Windows GPU 主机），在应用侧 `.env` 中设置：

```bash
COMFY_URL=http://<comfyui-host>:8188
COMFY_REMOTE=1
```

- 工作流输入经 `POST /upload/image` 暂存，成片经 `GET /view` 取回，全程 HTTP，无需共享文件系统；
- ComfyUI 主机需以 `--listen 0.0.0.0` 启动；
- ComfyUI 没有删除 API，暂存文件会累积在其 `input/online_temp` 与 `output/online_temp` 中，请偶尔手动清理。

## License

MIT
