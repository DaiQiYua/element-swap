# Element Swap E2E 测试夹具

零依赖端到端夹具：用真实 Edge（`--headless=new`）加载未打包扩展，通过自研极简 CDP 客户端
驱动真实页面、真实鼠标事件与真实 `chrome.storage`，验证「隐藏元素 / 替换视频」两类规则
以及 popup 面板、可视化拾取器、撤销恢复与旧版规则（image / embed）的静默忽略。

不允许安装任何依赖（不用 puppeteer），只使用 Node 内置模块与全局 `fetch` / `WebSocket`。

## 运行

```bash
node tests/e2e.mjs            # 跑全部用例
node tests/e2e.mjs --only=3,7 # 只跑第 3、7 条
node tests/e2e.mjs --headed   # 先试非 headless（窗口移到屏幕外），用于调试
```

- 退出码：`0` 全通过（含跳过），`1` 有 FAIL，`2` 夹具自身出错。
- 每条用例独立、默认 15s 超时（第 6、9 条要驱动真实拾取器，放宽到 20s；第 13 条要起抖音域 target 并跑两轮抓流，放宽到 40s）；单条失败不影响后续用例。
- 运行结束会关闭浏览器、删除临时 `user-data-dir`、关闭静态服务。

## 自动模式选择

先试 `--headless=new`；若拿不到扩展的 `service_worker` target（该模式下扩展未加载），
自动回退到「非 headless + `--window-position=-2000,-2000`」。两种模式均已实测可用。

## 扩展 ID 解析

1. 从 `/json/list` 里找 `type === 'service_worker'` 且 URL 形如 `chrome-extension://<id>/background.js`
   的 target（契约路径，最长轮询 10s）。
2. Edge 自带的组件扩展也可能注册 `background.js`，所以候选 ID 一律通过打开
   `chrome-extension://<id>/popup/popup.html` 并读 `chrome.runtime.getManifest().name` 校验归属。
3. 兜底：按 Chromium 未打包扩展 ID 规则（`sha256(目录绝对路径)` 前 32 位 hex → a–p）推算并同样校验。

## 用例

| # | 用例 | 关键断言 |
|---|------|----------|
| 1 | 清单与静态校验 | `manifest.json` 可解析、MV3 字段齐全；清单（含 `world:MAIN` 条目与 popup 页面 `<script src>`）引用的每个 JS 都动态收集并通过 `node --check` |
| 2 | 扩展加载 | 扩展 ID 合法、`service_worker` target 存在、SW 内 `chrome.runtime.id` 一致 |
| 3 | 隐藏生效并持久化 | 加规则后重新导航，`#ad-banner` 计算样式 `display:none`，`style[data-es-internal]#es-hide-rules` 含选择器，`es_rules` 桶结构正确 |
| 4 | 视频直链原地替换（同类型改写） | `video#movie` 的 `src` 改写为直链、`data-es-applied` 有值、`data-es-backup.attrs.src` 为 `/video/orig.mp4` 且 `ruleId` 一致、`data-es-orig-html` 存在；`[data-es-replacement]`/`[data-es-hidden]` 为 0，页面 video 仍是 1 个 |
| 5 | 视频跨类型替换 | 对 `img#hero` 加 video 规则 → 出现 `video[data-es-replacement]`，src 正确，原 img 计算样式为 `none` |
| 6 | 面板操作入口收敛为两种 | 真实拾取器点 `#hero` 打开面板：`.kind` 仅 2 个（「隐藏元素」`data-kind=hide`、「替换视频」`data-kind=video`），无「替换图片」「嵌入代码」与 `#es-html`/`#es-embed` 等节点；初始态无选中且无可见输入；点「替换视频」只出现 **1 个** `input[type=url]`（`es-url`，placeholder 命中 MP4 / B 站 / 抖音），**不存在** `#es-audio`/`#es-field-audio` 第二个输入框；点「隐藏元素」输入收起；非抖音域无抓流行；`#es-close` 后宿主移除，`es:stop-pick` 后页面无未捕获异常；面板不溢出视口、「保存并生效」完整可见，视口高 400 时输入框与 hint 仍完整可见 |
| 7 | 撤销恢复（hide + video） | 生效期：banner `none`、`#movie` src 为直链且有 `data-es-applied`、未被命中的 `#hero`/`#link` 不变、`[data-es-replacement]`/`[data-es-hidden]` 为 0；`ES.clearForUrl` + `es:rules-changed` 后：banner 回 `flex`、`#movie` src 复位、`data-es-applied`/`data-es-backup` 清除、`style[data-es-internal]` 归零、隐藏 CSS 为空、存储清空 |
| 8 | popup 面板 | `本站生效规则 (3)`、3 行、kinds `hide,video,video`、徽标只有「隐藏」「视频」、直链行 meta 含 `replaced.mp4`、B 站行 meta 含 `B 站` 与 BV 号、无旧规则时 `#rulesIgnored` 隐藏；直写 image/embed 后仍 3 行且提示「已忽略 2 条旧版」、`es_rules` 仍 5 条；两段式清除（先 `is-armed` +「再点一次确认清除」，再点后回到空态）且无 JS 错误 |
| 9 | 拾取器 | `es:start-pick` → `Input.dispatchMouseEvent` 点 `#hero` → 出现 `[data-es-ui="panel"]` 且 shadowRoot 非空、`#es-tag` 为 `img`、`pickerActive` 状态流转正确、`es:stop-pick` 后页面无异常 |
| 10 | 内置页不注入 | `edge://version` 上无 `data-es-loaded`、无内部样式；导航被拦截时标记 SKIP 并说明原因 |
| 11 | 抖音抓流轨选择 | 经页面 `postMessage` 注入同构候选到主探针通道：audio+video+muxed 三条 → `pickedTrack=muxed`；audio+video 两条 → `pickedTrack=video`；仅 audio → `pickedTrack=null`（音频轨永不入选）；非抖音页 `es:grab-douyin` 仍回 `not-douyin`。真实抖音 CDN 流无法在 E2E 复现，故用伪造地址 |
| 12 | 双流替换与同步（DASH 分离流） | 直链 + `payload.audioUrl` → 生成 `[data-es-media-pair]`（1 个 `<video>` + 1 个隐藏 `<audio>`，页面 `<audio>` 总数 1，幂等）；wrapper 尺寸与原元素 rect 宽高各差 ≤ 2px；带声音起播或被拒后降级（`degraded` + 「点击开启声音」提示常驻）；手势后两轨解除静音、音量一致并同步推进；`video.muted` 变化经 `volumechange` 单向映射到 `audio`；手工制造 1s 漂移后 500ms 纠偏至 < 0.3s；`playbackRate` 跟随；撤销后 wrapper/audio 归零、原元素复原、`pairs` 清空 |
| 13 | 复制合并与单框自动拆分 | popup 分离流场景只有**一个**复制按钮，经覆写 `clipboard.writeText` 捕获，复制结果为 `画面URL + "\n" + 声音URL`；把这段两行文本粘贴进面板**唯一**输入框后，`#es-url` 只剩画面地址、面板内不存在音频输入框、hint 显示「已识别：画面 + 声音」；保存后 `payload.url` 为画面轨、`payload.audioUrl` 为音频轨；只粘一条音频轨 → `#es-err` 提示且不落库；粘普通 `.mp4` 直链 → 无异常提示且 `payload` 只有 `url` |

## 目录

```
tests/
  e2e.mjs              主入口与 13 条用例（含用例超时/汇总/退出码）
  lib/cdp.mjs          极简 CDP 客户端（fetch 取 target + WebSocket 收发 + 事件订阅）
  lib/browser.mjs      Edge 启动、模式兜底、扩展 ID 解析与校验、target 工具
  lib/server.mjs       node:http 静态服务（随机端口、no-store）
  lib/assets.mjs       纯 Node 生成 PNG 与极小 MP4 外壳
  lib/util.mjs         sleep / waitForState / freePort / expect / skip
  fixtures/page.html   夹具页：#ad-banner / #hero / #movie / #player / #link
  fixtures/embed.html  历史 embed 规则的 iframe 目标页（该类规则已下线，仅作旧版 payload 留存）
  fixtures/img/*.png   运行前自动生成的纯色图（320×180，orig 蓝 / replaced 粉）
  fixtures/video/*.mp4 运行前自动生成的极小 MP4 外壳（ftyp+mdat）
```

## 已知边界

- 夹具 MP4 只是 `ftyp + mdat` 外壳，不可解码；且无头/后台标签下媒体管线会停，因此第 4、5 条
  只断言 DOM 与 `src`，不断言 `readyState` / `videoWidth`。
- 合成鼠标事件（第 6、9 条）要求页面标签页在前台：先 `Target.activateTarget` + `Page.bringToFront`，
  否则 `Input.dispatchMouseEvent` 会一直卡住。
- `chrome-extension://` 页面里的 `Page.addScriptToEvaluateOnNewDocument` 若被拒绝，popup
  错误采集仍有 `Runtime.exceptionThrown` 兜底。
- 静态服务不支持 `Range` 请求，视频片段加载不在断言范围内。