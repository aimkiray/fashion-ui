# AI Fashion Studio - 商业级服装动态展示与试衣系统

AI Fashion Studio 是一套面向服装电商、快时尚品牌与独立设计师的高保真真人服装动态展示系统。依托 **Krea-2** 穿衣扩散底模与 **MiniMax H3 (FL2VA)** 视频生成大模型，实现从单张服装平铺/试衣模特图到 10 秒 4K/1080P 商业展示成片的端到端生成。

---

## 核心特性

- **双阶段工业级出片链路**：
  - **阶段一 (20s)**：Krea-2 极速服装迁移与模特试衣定妆照生成，严格锁定服装版型与面料质感；
  - **阶段二 (10s 动态)**：MiniMax H3 视频流驱动，实现两段式分镜（向前慢速走秀步态 + 45° 转体细节展示），自带环境微风与脚步原声音轨。
- **模特主角主角面孔锁定 (Dual Reference)**：
  - 支持上传品牌专属模特肖像参考图，精准锁定模特五官面孔、发型与神态，将服装自然穿戴上身。
- **场景背景融合与多样化预设**：
  - 阳光都市街拍（Sunny Streetwear Chic）
  - 极简纯色影棚（Minimalist Lookbook Studio）
  - 摩天楼职场通勤（Executive Urban Commuter）
  - 高端艺术买手店（Luxury Concept Boutique）
  - 自然户外林荫（Nature Sunlight & Garden）
  - 现代极简咖啡厅（Lifestyle Nordic Cafe）
  - 自定义专属场景（支持自由提示词及背景参考图）
- **一键批量排队出片**：
  - 系统自动选取【都市街拍、纯色影棚、艺术买手店】顺序排队生成 3 套成片；
  - 前端支持多场景 Tab 平滑轮询预览与一键批量下载（ZIP/错峰多文件直连）。
- **高可用与并发保障**：
  - 服务端全局 FIFO 原子执行队列，彻底防止任务插队与 GPU 显存频繁换模抖动。

---

## 快速启动

### 1. 安装依赖
```bash
npm install
```

### 2. 启动服务
确保本地已运行 ComfyUI（默认端口 `http://127.0.0.1:8188`）：
```bash
# 通过脚本启动
start.bat

# 或直接运行
node server.js
```
访问 Web 界面：`http://localhost:3000`

---

## 项目结构

```text
fashion_ui/
├── server.js            # Node.js 后端服务（ComfyUI WebSocket 通信与队列管理）
├── workflows/           # ComfyUI 工作流模板 JSON
│   ├── krea2_outfit_transfer.json
│   └── fashion_streetwear_10s_extend.json
├── public/              # 前端静态页面与客户端代码
│   ├── index.html       # Web 交互控制台
│   ├── app.js           # 响应式前端交互逻辑与状态管理
│   ├── style.css        # 现代化暗色系 UI 样式库
│   ├── favicon.ico
│   └── presets/         # 官方服装测试样例图片
├── package.json         # 项目描述与依赖
├── start.bat            # Windows 快速启动脚本
├── restart.bat          # 重启服务脚本
└── stop.bat             # 停止服务脚本
```
