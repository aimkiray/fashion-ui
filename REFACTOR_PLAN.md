## 三次 Review 结论（三个独立子代理交叉审计）

审计阵容：全量修复落盘核实代理（逐行+运行时探针）、e2e 执行验证代理（自建 mock ComfyUI 跑真实 server）、新鲜眼缺陷猎捕代理（56,000 组用例机器比对等价性）。

### 结论：0 个 FAKE 修复、0 个新生产 bug、e2e 6/6 PASS

| 审计 | 结果 |
|---|---|
| 落盘核实 | 14 REAL / 1 PARTIAL（纯缩进）/ **0 FAKE** —— 上轮的静默失败已全部真正修复 |
| e2e 执行 | 6/6 PASS：remote 视频链路、existing_still 直生视频、still_only、**本地 dir-scan fallback（sha256 字节级一致）**、local 正常拷贝、5 组负路径全 400 |
| 新鲜眼 | 行为等价性：对旧/新代码执行 ~56,000 组 buildPrompts/styledSubject/h3SegPrompt/stripTextboxNoise/computeTaskPrompts 用例——输出完全一致；FIFO 运行时探针确认严格串行（async Python 桥不会引起 ComfyUI 提交交错）；前端契约、Windows 路径、错误码全部 CLEAN |

### 本轮修复（新鲜眼代理的 F1–F5 测试基础设施问题）
- F1: core.test.js 不再依赖 gitignored 的 storage/ PNG fixture → 自造合成 PNG（干净 clone 可跑）
- F2: regression 测试不再泄漏 COMFY_REMOTE 环境变量与分叉的 paths 模块实例
- F4: 新增 5 个守护测试——evictStale 活跃守卫（task/batch × queued/running/completed 矩阵）、FIFO 严格串行+错误韧性、有效上传路径（magic bytes 接受 + 静态服务 + 清理）
- F5: 测试重定向 COMFY_DIR 到 tmp → `npm test` 永不再创建 `D:/Comfy` 目录（并清除了历史残留）
- F7: stage1Still.js 缩进残留彻底清理（整文件重写），修正返回值文档

### 调试中额外发现并修正
- regression 测试 3 原先"靠跨进程 tmp 残留碰巧通过"→ 改为确定性的 local-mode 分支断言（force COMFY_REMOTE=0 + fresh paths 实例）

**测试规模：32 → 37，全部通过。**

## 二次 Review 结论（修复批次审计）

对第一轮修复本身再做对抗审计（独立代理）+ 新增本地模式 e2e。结论：**11 项修复中 3 项因字符串替换缩进不匹配而静默未落盘**（String.replace 无匹配时不报错——本轮最大教训），均已用精确文件内容重新修复并逐项运行时验证：

| # | 问题 | 结果 |
|---|---|---|
| #2 | stage2Video 本地 fallback subfolder 修复未落盘（误把 remote 分支既有代码当证据）→ 本地模式视频拷贝 ENOENT | ✅ 已修，本地模式 e2e completed、视频字节验证、临时目录零残留 |
| #5 | batch 清理 active 守卫未落盘 | ✅ 已落盘（sed 验证） |
| #9 | looksLikeImage catch→false 未落盘；gptImage2 外层 catch 吞掉上游流错误 | ✅ 均已修复 |
| — | 新发现：清理 unused imports 时误删 COMFY_TEMP_OUTPUT_DIR（stage2Video 本地 fallback 真实使用）→ ReferenceError | ✅ 恢复，静态扫描全模块无其它缺失 |
| — | regression.test.js 无意义断言 t1.unrefed | ✅ 改为 hasRef()===false |

经验教训：**任何声称"已修复"都必须有运行时证据**；本地 fallback 分支此前从未被任何 e2e 覆盖，导致两个静默失败与一个误删依赖存活至今。现在 local（fallback 强制触发）与 remote 两种模式均有端到端覆盖。

## 深度 Review 结论（重构完成后追加）

两个独立审计代理（逐行等价审计 + 缺陷猎捕）+ 假 ComfyUI 端到端验证。结论：
等价审计确认所有 14 个路由/数据/清理逻辑与原版逐字节一致；缺陷猎捕发现 1 critical + 4 major + 若干 minor，**已全部修复**并回归验证（32 测试全绿 + 全链路 e2e 两次通过）。

| # | 严重度 | 问题 | 修复 |
|---|---|---|---|
| 1 | CRITICAL | server.js require 顺序改变：src/paths 在 services/config（.env 加载器）之前快照 env 常量，.env 的 COMFY_REMOTE/PORT/COMFY_URL 被静默忽略 | server.js 顶部显式 `loadEnv()`（config.js 导出），先于一切 env 快照 |
| 2 | MAJOR(既有) | H3 本地模式 fallback 找到视频但 subfolder='' → 从 output 根目录拷贝 ENOENT | 本地 fallback 补 'online_temp' |
| 3 | MAJOR(既有) | gptImage2 仍用 execFileSync 裁剪（阻塞事件循环≤10s） | 改 execFile async |
| 4 | MAJOR(既有) | krea2 无条件访问节点 8/3 但 requireNodes 未校验 → 模板漂移即 TypeError | 必查节点加 3/8 |
| 5 | MAJOR(既有) | 批量任务清理无 active 守卫，>2h 的运行中 batch 被逐出（/api/batch 404） | queued/running 跳过 |
| 6 | MINOR | 30min 轮询循环内 fetch 无容错，网络抖动即杀死长任务 | try/catch + continue |
| 7 | MINOR | 定时器可重复启动、未 unref | started 单例守卫 + unref + 返回句柄 |
| 8-9 | MINOR | readPngDims fd 泄漏；上传文件消失时 500 而非 400 | finally 关闭 / catch→false |
| 10 | MINOR(既有) | gptImage2 SSE error 事件按 message 内容判定是否上抛，多数错误被吞 | 哨兵标志 isUpstreamStreamError |
| 11-14 | NIT | unused imports、孤儿注释、stage1 缩进等抽取残渣 | 已清理 |

端到端验证（假 ComfyUI mock：/upload/image、/prompt、/history、/view、/queue、/free）：
- krea2 视频模式：completed (progress 10→45→100)，still+video 落盘 ✓
- existing_still 直生视频：completed ✓；still_only：completed ✓
- 附带发现并修复**既有 bug**：services/imagegen/index.js 从未向 krea2 传递 comfyRemote/comfyUrl —— 分离部署对 Krea-2 引擎实际无效（已修复，e2e 证实修复前必败）

## 执行状态（更新）

> **Phase 0–1 已完成（2026-09）**：同步阻塞 bug 已修复（flatlay/conform → async）。
> server.js 已缩为 ~40 行装配入口；src/ 模块拆解、统一错误中间件、`npm test`（node:test，28 个用例）均已落地。
> 已用 git 原版 server.js 逐接口对比验证行为等价（scenes/actions/model-styles/config/history/preview-prompts/错误响应 md5 一致）。
> Phase 2（ESM/Zod/SSE/graceful shutdown）、Phase 3（前端拆分）、Phase 4（TS/Docker）仍待执行。

# AI Fashion Studio — 现代化重构计划

> 评审范围：`server.js`(1745 行)、`public/app.js`(2553 行)、`public/index.html`(666 行)、
> `public/style.css`(2326 行)、`services/*`、Python 辅助脚本。
> 原则：**每一阶段独立可交付、可回滚**；Phase 1 起零行为变更，靠 Phase 0 的测试兜底。

---

## 一、现状诊断

### 1. `server.js` 是五种职责揉在一起的单体
| 职责 | 现位置（server.js） | 行数规模 |
|---|---|---|
| 提示词目录（纯数据） | `MODEL_STYLES`/`HAIRSTYLES`/`FACE_SHAPES`/`H3_ACTIONS`/`SCENES` | ~700 行 |
| ComfyUI 客户端 | `submitComfyWorkflowWithProgress` + WS 监听 | ~100 行 |
| 队列与任务存储 | `enqueueJob`、`tasks`/`batchJobs` Map + 2 个 `setInterval` | ~120 行 |
| 两阶段编排 | `runGenerationJob` | 220+ 行 |
| 路由 + 校验 | 13 个 `app.get/post/delete` | ~450 行 |

### 2. 依赖注入反模式
`services/imagegen/krea2.js` 通过一个 `context` 大对象接收 **15 个来自 server.js 的依赖**
（`requireNodes`、`submitComfyWorkflow`、`ASPECT_CANVAS`、`randomSeed`…）。
引擎层反向依赖调用方，说明模块边界倒置——重构后这些依赖应归属 `src/comfy/` 与 `src/images/`。

### 3. 真实 bug：同步子进程阻塞事件循环
`detectFlatlayScoreSync` 用 `execFileSync` 调 Python（timeout 3s）。生成期间**整个服务器
（含进度轮询、上传、配置接口）冻结**。必须改为 `util.promisify(execFile)` 异步版。

### 4. 工程卫生缺失
- 无 lint / format / test / 任何 `npm script`
- 路由内手写 `path.basename` 白名单做输入校验，规则散落
- 无统一 async 错误处理中间件（路由内 try/catch 各自为政）
- 无 graceful shutdown（SIGTERM 不清理 `setInterval`、WS、HTTP server）
- `console.log/warn/error` 直出

### 5. 前端是巨型回调文件
- 单个 `DOMContentLoaded` 闭包，~20 个模块级 `let` 状态变量
- 164 处 `getElementById`、19 处 `innerHTML` HTML 拼接（XSS 攻击面）
- 手写 setTimeout 轮询（任务进度 + 批量进度两套）
- 2326 行 CSS 无分区约定

### 6. 模块系统
CommonJS + Node ≥ 18（已依赖原生 `fetch`）。应统一迁 ESM。

---

## 二、目标结构

```text
fashion_ui/
├── server.js                  # 仅启动装配：读取 env → createApp() → listen（~60 行）
├── src/
│   ├── paths.js               # 目录与画布常量（ASPECT_CANVAS、storage 目录）
│   ├── config/
│   │   ├── env.js             # .env 解析
│   │   └── store.js           # config.json 三级优先级（现 services/config.js 迁入）
│   ├── prompt-catalog/        # 纯数据，零逻辑
│   │   ├── scenes.js
│   │   ├── modelStyles.js
│   │   ├── hairstyles.js
│   │   ├── faceShapes.js
│   │   └── h3Actions.js
│   ├── prompts/               # 纯函数，重点单测对象
│   │   ├── computeTaskPrompts.js
│   │   ├── h3SegPrompt.js
│   │   ├── styledSubject.js
│   │   └── textbox.js         # stripTextboxNoise
│   ├── comfy/
│   │   ├── client.js          # WS + HTTP 提交、进度事件
│   │   ├── files.js           # 现 services/comfyFiles.js
│   │   ├── nodes.js           # requireNodes 工作流节点校验
│   │   └── idleRelease.js     # 空闲释放（含 /queue 检查）
│   ├── images/
│   │   ├── canvas.js          # readPngDims / nearestCanvasKey
│   │   ├── conform.js         # python-bridge（execFile 异步 + 兜底 copy）
│   │   └── flatlay.js         # 平铺图检测（异步化）
│   ├── queue/fifo.js          # 全局 FIFO 队列（可注入并发数）
│   ├── store/tasks.js         # 任务/批量 Map + 生命周期清理（封装 setInterval）
│   ├── jobs/
│   │   ├── runGenerationJob.js   # 编排：stage1 → stage2
│   │   ├── stage1Still.js
│   │   └── stage2Video.js
│   ├── routes/                # Express Router，一资源一文件
│   │   ├── system.js          # /api/system /api/actions /api/scenes /api/model-styles
│   │   ├── config.js          # /api/config(+test)
│   │   ├── prompts.js         # /api/preview-prompts
│   │   ├── generate.js        # /api/upload /api/generate /api/generate-batch /api/batch
│   │   ├── tasks.js           # /api/progress
│   │   └── history.js         # /api/history (+delete)
│   ├── http/
│   │   ├── app.js             # createApp(): express 装配 + 中间件
│   │   ├── asyncHandler.js
│   │   └── errorMiddleware.js
│   └── schemas/               # Zod schema（generate / batch / config）
├── services/imagegen/         # 保留；删除 context 大对象，直接 import src/comfy
├── public/                    # 前端（见 Phase 3）
└── tests/
    ├── unit/                  # computeTaskPrompts / nearestCanvasKey / requireNodes / h3SegPrompt
    └── http/                  # supertest + 打桩的 Comfy/OpenAI
```

---

## 三、分阶段执行

### Phase 0 — 安全网（半天）
1. `package.json` scripts：`dev`(node --watch)、`lint`、`format`、`test`
2. ESLint flat config + Prettier（一次性 format，独立 commit 不混入逻辑变更）
3. Vitest 骨架；先给**纯函数**补回归测试：
   `computeTaskPrompts`、`nearestCanvasKey`、`requireNodes`、`h3SegPrompt`、`stripTextboxNoise`
4. supertest 冒烟：无 workflow 时 `/api/generate` 的 400 路径；`/api/progress` 404 路径

### Phase 1 — 零行为变更拆解（核心，1–2 天）
按依赖自底向上搬移，**每步一个 commit 并跑测试**：
1. `paths.js`（常量与目录初始化）
2. `prompt-catalog/*`（直接剪切数据）
3. `prompts/*`（纯函数 + 单测迁移）
4. `comfy/*`、`images/*`（吸收 `context` 大对象里的依赖；`services/imagegen/*` 改为直接 import）
5. `queue/fifo.js`、`store/tasks.js`（把两个 `setInterval` 收进 store，暴露 `start()/stop()`）
6. `jobs/*`：`runGenerationJob` 拆成 `stage1Still` + `stage2Video`，编排层只保留顺序与进度更新
7. `routes/*`：Express Router + `asyncHandler` + 统一错误中间件；Zod schema 校验入参，
   删除散落的 `path.basename` 白名单（收敛为一个 `sanitizeFilename` 工具）
8. `server.js` 缩为装配入口

验收：API 响应逐字节等价（可用录制对比），测试全绿。

### Phase 2 — 现代化（1 天）
1. `"type": "module"` 全量 ESM（require→import）
2. 修复阻塞 bug：`detectFlatlayScoreSync` → `execFile` 异步，任务编排中 `await`
3. pino 结构化日志（替代 `console.*`），请求日志 + requestId
4. graceful shutdown：SIGTERM/SIGINT → 停 `setInterval` → 关 WS → `server.close()`
5. 进度推送：`/api/progress/:taskId` 轮询 → SSE（`text/event-stream`），前端保留轮询兜底
6. 依赖收敛：`cors` 可按需保留；`ws` 用法不变

### Phase 3 — 前端拆分（1–2 天）
1. `public/app.js` → ES modules，按面板拆：
   `api.js`（fetch 封装）、`state.js`（集中状态 + 订阅）、`dropzone.js`、`scenePicker.js`、
   `promptInspector.js`、`resultPanel.js`、`batchPanel.js`、`historyMasonry.js`、`lightbox.js`、`polling.js`
2. 消灭 `innerHTML` 拼接：改 `<template>` + `cloneNode` + `textContent`（用户提供的自定义提示词不再进 HTML 字符串）
3. `style.css` 拆为 `base.css / layout.css / panels.css / history.css / modal.css`，
   主题色收敛为 `:root` 自定义属性
4. 两套手写轮询合并为 `polling.js` 单实现（指数退避 + 页面隐藏时暂停）

可选升级（不在必选路径）：Vite dev server（proxy 到 Express，获得 HMR 与模块打包）。

### Phase 4 — 类型与部署（可选，1 天）
1. TypeScript：`tsconfig` + 渐进迁移（先 `allowJs`，核心模块先 `.ts`）
2. Dockerfile + docker-compose（app 侧；ComfyUI 走 `COMFY_REMOTE=1`）
3. CI：GitHub Actions 跑 lint + test

---

## 四、风险与对策

| 风险 | 对策 |
|---|---|
| 搬移引入行为漂移 | 每步 commit + 纯函数回归测试；API 层用固定 payload 对比响应 |
| workflow JSON 模板节点 id 漂移 | `requireNodes` 逻辑原样保留并加单测 |
| Python 脚本平台差异（win/mac） | `python-bridge` 统一封装，保留现有 `python3/python` 探测逻辑 |
| 前端拆分引入 DOM 时序 bug | 逐模块搬移；`historyMasonry` 的 resize 监听合并为一处 |
| `.env` / `storage/` 不入库 | 重构全程不动 `.gitignore` 与密钥加载优先级 |

## 五、不做的事（刻意保留）

- 不引入框架（React/Vue）——UI 是静态单页 + 原生交互，收益不抵迁移风险
- 不引入数据库——内存 Map + 历史文件扫描契合本地单用户场景，仅封装为 `store/tasks.js`
- 不更换 Express 5 / multer / ws——版本已是最新大版本