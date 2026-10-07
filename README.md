# dsh-tab-groups

**把浏览器里所有指向 DeepSeek Harness（DSH）Web GUI 的标签页，自动收进同一个标签组。**

你在 DSH 里同时开着好几个会话（每个会话一条 `#/session/<id>` 链接，中键点侧栏就是新标签页），
标签栏很快就乱了。这个扩展会在你打开 DSH 标签页的**瞬间**把它们归进一个名叫 `DSH` 的组，
新开一个自动进去一个，全部关掉后空组被浏览器自动清掉。

**本仓库是一个包，两张脸**：

| 脸 | 跑在哪 | 负责 |
| --- | --- | --- |
| 浏览器扩展（`manifest.json` + `src/` + `icons/`） | Edge / Chrome 等 Chromium 浏览器 | **全部**标签组行为——因为只有扩展能碰浏览器标签栏 |
| DSH 插件（`lib/` + `cordis.patch.yml`） | DSH 宿主 + Web GUI 页面 | 把扩展镜像到一个固定路径；在 GUI 里检测扩展、引导安装、并直接驱动它（改名/改色/立即归组） |

两边用 Chromium 的 `externally_connectable` 桥打通：DSH 页面能实时读到扩展状态并下指令，
而"页面上有没有 `chrome.runtime`"本身就是"扩展装没装"的判据。

- 纯本地运行：不发网络请求、不采集数据、扩展没有 host 权限
- 零依赖、零构建：扩展直接加载即用，插件直接挂载即用
- 60 项单元测试 + 45 项真实浏览器端到端断言 + 9 项插件挂载断言（含**真实 DSH GUI**）

---

## 能不能"装了 DSH 插件就把浏览器扩展一起装上"？

**不能全自动，但能一步到位到"只剩一次点击"。** 三句话讲清楚：

1. **插件装不了扩展。** 没有任何 DSH 侧或页面侧的 API 能往浏览器里装扩展——
   `edge://extensions` 是特权页面，任何网页、任何本地进程都无法脚本化它。
2. **静默强制安装这条路在你的机器上被官方堵死了。** 唯一能"静默装扩展"的机制是企业策略
   `ExtensionInstallForcelist`，而微软官方文档写得非常明确：

   > On macOS instances, apps and extensions from outside the Microsoft Edge Add-ons website
   > can only be force installed if the instance is managed via MDM, or joined to a domain via MCX.
   > — [Microsoft Edge 策略文档](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/extensioninstallforcelist)

   我实测了这台机器：`Enrolled via DEP: No`、`MDM enrollment: No`，也没有任何受管策略文件。
   所以即使去写策略，非商店扩展也不会被强制安装。
3. **能做的都做了。** 插件把扩展镜像到一个**固定路径**（这样你不用去翻 npm 包内部目录），
   在 GUI 里用一颗芯片检测它、缺了就给出三步引导（含"复制路径"按钮），装好就自动变绿并可直接控制。

**所以真正的安装流程是两步**（第二步只有一次点击，且只需做一次）：

### 第一步：装 DSH 插件

```sh
dsh plugin --profile web add link:$PWD      # 在 dsh-tab-groups 目录里执行
```

宿主半区会把扩展镜像到 **`~/.dsh/dsh-tab-groups-extension`**，并在日志里打印这个路径。
刷新 GUI 后右下角出现「DSH 分组」芯片。

### 第二步：把镜像目录加载进浏览器（唯一的一次点击）

1. 地址栏打开 `edge://extensions`（Chrome 是 `chrome://extensions`），打开左下角**开发人员模式**
2. 点**加载解压缩的扩展**，选择 `~/.dsh/dsh-tab-groups-extension`
   （Finder 里按 `Cmd+Shift+G` 可以粘贴这个路径）
3. 回到 DSH 页面，芯片会在几秒内自己变绿（也可以点「重新检测」）

只想用扩展、不要 DSH 插件也可以：直接对本目录做「加载解压缩的扩展」即可，
插件那半边不影响扩展的任何行为。

> 想要彻底免掉这一步，只能把扩展上架 Edge 加载项商店。到那时
> `ExtensionInstallForcelist`（或用户自己点一次"添加"）才有意义。

---

## 两边是怎么打通的

**ID 是钉死的。** 未打包扩展如果 manifest 里没有 `key`，它的 ID 由**安装目录的绝对路径**推导——
目录一挪，ID 就变，插件就找不到它了。所以 manifest 里钉了一个公钥 `key`
（`node tools/make-key.mjs` 可复查），扩展 ID 恒为 `pnncehmieeobfabnbdepbldiknndjbhl`，
搬到哪都一样。仓库里**不存私钥**（只有打包 `.crx` 才需要）。

**桥是浏览器给的。** 扩展声明了 `externally_connectable`：

```json
"matches": ["http://127.0.0.1/*", "http://localhost/*", "https://*.dsh-market.com/*"]
```

Chromium 只对匹配的页面注入 `chrome.runtime`。于是：

- 页面看得到 `chrome.runtime.sendMessage` → 扩展在
- 看不到 → 扩展没装（或者没启用），芯片显示引导

不需要探测扩展 URL、不需要改 manifest、不需要任何额外权限。

**协议**（`src/protocol.js`，纯逻辑、被单测覆盖）：

| 消息 | 返回 |
| --- | --- |
| `{type:'ping'}` | `{ok, installed, protocol, id, version}` |
| `{type:'status'}` | 开关、组名、颜色、命中数、待归组数、窗口数、上次运行结果 |
| `{type:'reconcile'}` | 立即归组，返回 `{moved, groups, matched, errors}` |
| `{type:'set-config', config}` | 白名单校验后写入并立即重新归组 |

**它故意什么都不暴露**：状态里只有计数，没有任何标签页地址、标题或 ID。

**信任边界**：`externally_connectable` 只能按 host 匹配、不能按端口，所以**本机上任何网页**
（任意 localhost 端口）都能连上这个扩展。因此配置写入是**逐键白名单校验**的——
未知键直接拒绝（不会静默丢弃），类型不对直接报错，而不是让 `normalizeConfig` 把它悄悄改成默认值。
一个恶意本地页面最多能做的事是改组名/颜色/开关或触发一次归组，够不着任何标签页内容。

---

## 怎么判断"一个标签页是 DSH"

识别锚点是**网页标题 `DeepSeek Harness`**。这个选择是查证过的，不是猜的：

- `@deepseek-ai/dsh-web-frontend/dist/index.html` 里 `<title>` 写死为 `DeepSeek Harness`；
- 整个前端 bundle 里**没有任何** `document.title` 赋值，所以标题在运行期不会变；
- 宿主 webserver 只会向 index.html **注入** `window.__DSH_BOOT__` 脚本，不重写 `<title>`
  （`dsh-host-webserver/lib/index.js` 里连 `title` 这个词都不出现）。

因此按标题识别一条规则就同时覆盖了：随机 `--port`、`localhost` vs `127.0.0.1`、局域网地址、
以及 cloudflared 隧道域名（例如 `https://<id>.dsh-market.com`）——后者是端口规则永远追不上的。

前缀匹配做得比较克制：标题必须以规则开头，且**后续第一个字符不是字母数字**才算命中
（空白会被跳过）。所以 `DeepSeek Harness · 会话标题`、`DeepSeek Harness — 登录` 命中，
而另一个恰好叫 `DeepSeek Harness Docs` 的站点**不会**被误伤——这条有专门的测试和端到端断言。

此外还有按 **origin** 识别的规则（默认 `http://127.0.0.1:3080`、`http://localhost:3080`），
它负责"页面标题还没加载出来的那一瞬间"就立刻归组。

## 安装（只装扩展的话）

1. 地址栏打开 `edge://extensions`（Chrome 是 `chrome://extensions`）
2. 打开左下角 **开发人员模式 / Developer mode**
3. 点 **加载解压缩的扩展 / Load unpacked**，选择本目录，或插件镜像出来的
   `~/.dsh/dsh-tab-groups-extension`
4. 装好后点扩展图标即可看到面板；点「设置」可以改组名、颜色、识别规则

一行命令帮你直接打开那个页面：

```sh
open -a "Microsoft Edge" "edge://extensions/"
```

> 说明：这是"加载解压缩的扩展"（开发者模式）安装方式，Edge 重启后依然生效，
> 但每次启动 Edge 可能提示"停用开发人员模式扩展"——这是浏览器的正常提示，选择保留即可。
> 想彻底消除提示需要上架 Edge 加载项商店。

## 设置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 启用自动归组 | 开 | 关掉后不再移动任何标签页 |
| 组名 | `DSH` | 也是"认领已有分组"的标识（浏览器重启后组 ID 会变） |
| 组颜色 | blue | Chromium 支持的 9 种颜色 |
| 始终使用上面的组名与颜色 | 开 | 关掉后你手动改的组名会被尊重 |
| 归组后自动折叠 | 关 | 只折叠，绝不强行展开 |
| 按网页标题识别 | `DeepSeek Harness` | 每行一条 |
| 允许标题前缀匹配 | 开 | 见上文的前缀规则 |
| 按来源识别 | `127.0.0.1:3080`、`localhost:3080` | 支持 `http://127.0.0.1:*` 通配端口 |
| 本机任意端口都算 DSH | 关 | 只在你不跑其他本地服务时开 |
| 把已在别的分组里的 DSH 标签页也拉过来 | 开 | 关掉则只处理未分组的 |
| 跳过固定（pinned）标签页 | 开 | Chromium 不允许固定标签页入组，代码里有降级重试 |

设置页底部有一块**实时预览**：直接列出"按当前规则会命中哪些标签页、它们现在在哪个组里"，
调规则时不用猜。

## 行为细节

- **按窗口分组**：标签组本身是窗口内的概念，所以每个窗口各自拥有一个 `DSH` 组，
  跨越两个窗口的 DSH 标签页不会互相打架（有单测覆盖）。
- **幂等**：归组动作本身会再次触发标签页事件，但空计划不会产生任何 API 调用，
  所以不会出现抖动或死循环（有端到端断言）。
- **认领已有组**：扩展把"自己拥有的组 ID"记在 `chrome.storage.session` 里；
  browser 重启后组 ID 失效，则按**组名**找回。所以：**改了组名又重启浏览器，会另建一个新组**；
  想避免就保持组名不变，或把"始终使用配置的组名"打开。
- **不劫持别人的组**：只认领组名匹配或自己记录过的组。你已经手动建好、里面恰有一个 DSH 标签页的
  分组不会被改名（那个标签页会被拉出来，除非你关掉"从别的分组拉过来"）。
- **空组自动消失**：DSH 标签页全关后浏览器会清掉空组，扩展会把过期的组 ID 一并丢弃；
  之后再开 DSH 标签页会重新建组。
- **GUI 芯片三态**：右下角芯片有三档——**展开**（面板；预览/控制）、**收起**（一颗状态点，
  已连接时的默认状态，右下角几乎不占地方）、**隐藏**（面板里的「隐藏」按钮，整个收掉）。
  隐藏**只对本次页面加载有效**，刷新即恢复：芯片是这个插件唯一的界面，
  所以不能做成"藏了就再也找不回来"。扩展掉线时芯片会自己回来并展开，保证安装引导不会丢。

## 验证

```sh
npm test                    # 60 项纯逻辑单测（node --test，无需浏览器）
npm run id                  # 复查扩展 ID：manifest 的 key、插件常量、client 内联值三者是否一致
node tools/make-icons.mjs   # 重新生成图标（纯 Node，零依赖）

# 真实浏览器端到端：加载扩展、开标签页、从扩展自己的 service worker 里读
# chrome.tabGroups 状态做断言（不是 mock）
PLAYWRIGHT_PATH="/path/to/node_modules/playwright" node tools/e2e.mjs

# 换成你真实的 Edge 二进制跑，并带上真实 DSH GUI 通道
PLAYWRIGHT_PATH="/path/to/node_modules/playwright" \
E2E_CHANNEL=msedge \
DSH_E2E_URL="http://127.0.0.1:3080/?token=..." \
node tools/e2e.mjs

# 插件能不能在真实 DSH 宿主里挂载？（隔离 DSH_HOME，不碰你的 profile 与 ~/.dsh）
DSH_BIN=/path/to/dsh \
PLAYWRIGHT_PATH="/path/to/node_modules/playwright" \
npm run test:mount
```

端到端覆盖（45 项断言）：

- **扩展自身**：自动建组、组名与颜色、后开的 DSH 标签页自动入组、`DeepSeek Harness Docs`
  不被误伤、普通网页不被归组、弹窗面板统计与「立即归组」、重复触发幂等、
  固定标签页被正确放过、设置页改配置后真实标签组跟着改名/变色、恢复默认、
  关标签页后组自动清除、清除后再开能重建。
- **配对**：真实加载出来的扩展 ID 与插件里的常量一致（证明钉 `key` 生效）；
  页面能拿到 `chrome.runtime`、ping/status/reconcile/set-config 全通、非法配置被拒绝、
  页面改的组名在浏览器标签栏里真的生效、状态里不含任何标签页内容。
- **真实 DSH GUI**（用你本机 `http://127.0.0.1:3080` 的会话）：
  标题锚点成立、真实标签页被自动归组；**把插件的浏览器半区挂进真实 DSH 壳**，
  芯片渲染成功、检测到扩展并进入已连接状态、面板显示版本与实时计数，
  再在真实 GUI 里点芯片的「立即归组」，浏览器标签组真的恢复；
  芯片默认收起成一颗状态点、点一下展开、「隐藏」能整个收掉、刷新后自己回来。

另外 `npm run test:mount` 是**插件挂载**的完整验证，三段递进、全程隔离：

1. 用临时 `DSH_HOME` 组一个只含核心 web bundles + 本插件的 profile，
   `--dump-config` 里必须出现 `# == dsh-tab-groups`（证明 cordis 行能解析）；
2. 启动 `dsh web --port 0`，宿主半区必须真的把扩展镜像写进 `$DSH_HOME/dsh-tab-groups-extension`；
3. 用真 Edge 打开**这个实例的** GUI（带着镜像目录加载扩展，**不做任何注入**）：
   芯片必须由真实宿主投递并渲染、必须连上扩展、页面不能有 JS 报错。

实测结论（本机，2026-10-07）：Chromium 与 **Microsoft Edge 154.0.4258.53** 均 **45/45** 通过，
包含真实 `http://127.0.0.1:3080` 的 DSH GUI 会话；`test:mount` **9/9** 通过。
（这两条通道都不往你的 profile 或 `~/.dsh` 里装任何东西：真实 GUI 通道是把插件的浏览器半区
挂进真实壳里跑，挂载通道用的是临时 `DSH_HOME`。）

## 文件

```
# ---- 扩展那张脸（浏览器加载的部分）----
manifest.json         MV3 清单：permissions tabs/tabGroups/storage，无 host_permissions，
                      externally_connectable 只放开 127.0.0.1 / localhost / *.dsh-market.com，
                      key 钉死扩展 ID
src/config.js         配置默认值与容错归一化（纯逻辑）
src/rules.js          DSH 识别 + 分组计划（纯逻辑，无 chrome.* 引用）
src/protocol.js       与页面通信的协议：ping/status/reconcile/set-config + 逐键白名单校验
src/extension-id.js   扩展 ID 与协议版本（单一来源）
src/background.js     service worker：事件 → 防抖 → 串行 reconcile → chrome.tabs.group；
                      onMessageExternal 处理页面来的消息
src/popup.html/js     弹出面板：开关 / 统计 / 立即归组 / 进设置
src/options.html/js   设置页 + 实时预览
src/ui.css            两页面共用的样式（跟随系统深色模式）
icons/                程序化生成的图标

# ---- DSH 插件那张脸 ----
lib/index.js          宿主半区：把扩展镜像到 ~/.dsh/dsh-tab-groups-extension（幂等、窄删除）
lib/client.js         浏览器半区：GUI 里的 shadow-DOM 芯片（检测 / 引导 / 控制）
cordis.patch.yml      把插件行插进 profile roster

# ---- 工具与测试 ----
tools/make-icons.mjs  程序化生成图标（自带最小 PNG 编码器）
tools/make-key.mjs    生成/复查扩展 ID 与三处常量的一致性
tools/e2e.mjs         真实浏览器端到端验证（45 项断言）
tools/verify-profile.sh 在隔离 DSH_HOME 里组 profile + 启动实例 + 检查镜像
tools/verify-mount.mjs  用真浏览器验证插件客户端半区由真实宿主投递并连上扩展
tools/playwright-loader.mjs 两条浏览器通道共用的 Playwright 解析
test/rules.test.mjs   识别与分组决策
test/protocol.test.mjs 协议与信任边界
test/pairing.test.mjs 两张脸的一致性（ID/版本/权限/文件/清单）
test/host.test.mjs    宿主半区镜像行为（含"不碰无关文件"）
```

## 隐私与安全

扩展只申请 `tabs`（读标签页标题/地址）、`tabGroups`（读写标签组）、`storage`（存配置）三个权限，
**没有 host 权限**，不注入任何内容脚本，不发起任何网络请求。所有判断都在本机内存里完成。

`externally_connectable` 是本仓库唯一的一处信任让步：它按 host 匹配、**不能按端口**，
所以本机上任何网页都能连上这个扩展。作为补偿，配置写入走逐键白名单校验（未知键直接拒绝、
类型不对直接报错），状态响应里只有计数、没有任何标签页地址或标题。

## Safari 为什么没有扩展

你（本机 macOS 26.7.1 + Safari 27.0）如果指望 Safari 也这样自动分组，答案是**不行**，
而且两条路都是**死的**——下面每条都在本机实测过，不是转述博客：

**1. Safari 扩展 API 里没有标签组。** Safari WebExtensions 没有 `chrome.tabGroups`
（`query`/`update`/`onCreated`… 全无），连 `tabs.Tab.groupId` 这个属性都不存在，
`tabs.group()` / `tabs.move()` 也没有。所以扩展能**找到** DSH 标签页（`url`/`title` 都可读），
却**无法读、建、改**任何标签组。旧的原生 App Extension API（`SFSafariWindow` / `SFSafariTab` /
`SFSafariPage`）同样一个组成员都没有。Apple 自己也没宣布支持——WWDC26 的 Safari 场次里
有人当面问 Tab Group API，得到的答复是"去 bugs.webkit.org 提需求"。

**2. AppleScript / JXA 里也没有标签组。** 直接读本机词典
`/Applications/Safari.app/Contents/Resources/Safari.sdef`（8710 字节，全文 164 行）：
整个 Safari suite 只有一个 `tab` 类，属性仅
`source`/`URL`/`index`/`text`/`visible`/`name`/`pid`，命令只有
`add reading list item`、`do JavaScript`、`email contents`、`search the web`、`show bookmarks`。
**没有 `tab group` 类、没有 `tab groups` 元素、没有 `groupId` 属性、没有任何建组/移组命令。**
（注意：`index` 是只读的，`tab` 也不响应 `move`，连窗口内重排标签都不是官方可脚本化的。
另一个坑：AppleScript 编译器对**未知属性名**不报错，所以"`tab groups of front window` 编译通过了"
是假象，不能当作支持证据。）

**唯一一条真路：快捷指令（Shortcuts）。** Safari 通过
`com.apple.appintents-extension` 向快捷指令提供了一等公民动作。本机
`SafariLinkExtension.appex/Contents/Resources/en.lproj/AppIntents.strings` 里逐条读得到：

| 动作 | 官方描述 |
| --- | --- |
| `Create Tab Group` | "Creates a new Tab Group, optionally with specified contents." |
| `Move Tabs to Tab Group` | "Move Safari tabs from their current Tab Group into a new one." |
| `Search Tabs` | "Perform a search of tabs in Safari." |
| `Open Tab Group` / `Delete Tab Groups` / `Set Profile or Tab Group` | 见同一份 strings |

配方（能在 Safari 上做到的最佳效果）：

1. 打开「快捷指令」，新建一个快捷指令，添加：**`Search Tabs`**（关键词 `127.0.0.1:3080`）
   → **`Create Tab Group`**（标题填 `DeepSeek Harness`）。
2. 给它起个名字，比如 `DSH 归组`。
3. 之后就能用命令行零点击触发：
   ```sh
   /usr/bin/shortcuts run "DSH 归组"
   ```
4. **硬限制**：macOS 快捷指令**没有"某个标签页被打开"触发器**（只有时间 / Focus / 打开 App /
   邮件这类触发器）。所以 Safari 上**做不到"标签一出现就自动归组"**，只能被主动触发——
   比如让 DSH 启动时自己调一次，或定时跑。上面这条配方我**只在 bundle 层面验证了动作存在**，
   没有在快捷指令 GUI 里逐个点过（本机 Shortcuts 从未启动、无元数据缓存），
   你第一次建的时候请先确认动作选择器里搜 "Tab Group" 能搜到。

**如果目标只是"别让 DSH 的标签混进普通标签里"，Safari 上有个比自动化更稳的办法：**
把 `http://127.0.0.1:3080` 用 **Safari「添加到程序坞」(Web App)** 变成独立 App，
或者给它一个**独立的 Profile / 窗口**。这样从根上就隔离了，零维护、不依赖任何脚本——
在 Safari 上强烈建议优先考虑这条。

（以上 Safari 结论不适用于 Edge/Chrome：那里的 `chrome.tabGroups` 是完整可用的，也就是本扩展的做法。）

## English

**Automatically collect every browser tab showing the DeepSeek Harness (DSH) Web GUI into one tab group.**

**One package, two faces.** The browser extension (`manifest.json` + `src/` + `icons/`) owns all of the
tab-group behavior, because the tab strip is only reachable from an extension — a DSH browser-half plugin
is plain page JavaScript with no `chrome.tabs` / `chrome.tabGroups` anywhere in the SDK. The DSH plugin
(`lib/` + `cordis.patch.yml`) mirrors that extension into `~/.dsh/dsh-tab-groups-extension` so "Load
unpacked" has a fixed path, then renders a status chip inside the Web GUI that detects the extension,
guides installation when it is missing, and drives it (rename, recolor, group now).

**Can the plugin install the extension too?** Not silently. No DSH-side or page-side API can install a
browser extension, and the one silent mechanism — the enterprise policy `ExtensionInstallForcelist` —
is documented to work on macOS only for store extensions or on MDM-managed machines
([Microsoft Edge policy docs](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/extensioninstallforcelist));
this Mac reports `MDM enrollment: No`. So the flow is: install the plugin, then click once in
`edge://extensions` and pick the mirrored directory. That one click is the part nobody can automate.

A tab is recognised as DSH by its **page title `DeepSeek Harness`** — a verified anchor: the title is
hard-coded in `@deepseek-ai/dsh-web-frontend/dist/index.html`, never reassigned at runtime, and the host
only injects `window.__DSH_BOOT__` without rewriting `<title>`. One rule therefore covers random ports,
`localhost` vs `127.0.0.1`, LAN binds and cloudflared tunnel hostnames. Prefix matching is deliberately
strict: the continuation must start with a non-word character, so `DeepSeek Harness · session` matches
while an unrelated `DeepSeek Harness Docs` does not. Configured origins are the fallback for the instant
before a title loads.

**The two halves talk over Chromium's `externally_connectable` bridge.** Because the manifest pins a `key`,
the extension ID is the same wherever the folder lives
(`pnncehmieeobfabnbdepbldiknndjbhl`), so the plugin can address it. `chrome.runtime` exists in the DSH page
only when an installed extension lists that origin — so its presence *is* the installation check, with no
probing and no extra permissions. The protocol is `ping` / `status` / `reconcile` / `set-config`; config
writes are validated key by key (unknown keys are rejected outright, wrong types are reported rather than
silently normalized), and `status` carries counts only — never a tab URL, title or id.

Install: `edge://extensions` → enable *Developer mode* → *Load unpacked* → pick this directory (or the
mirrored `~/.dsh/dsh-tab-groups-extension`). Everything is local: three permissions, no host permissions,
no content scripts, no network requests.

`npm test` runs 60 pure-logic unit tests without a browser; `tools/e2e.mjs` loads the extension into a real
Chromium/Edge and asserts against the browser's own `chrome.tabGroups` state, drives the message protocol
from inside a page, and mounts the plugin's GUI half into the live DSH shell — **45/45 passing on both
Chromium and Microsoft Edge 154, including a real `http://127.0.0.1:3080` session** (45 assertions). A third lane,
`npm run test:mount`, proves the plugin really mounts: it builds a throwaway `DSH_HOME` whose profile
contains only this package plus the core web bundles, boots `dsh web`, checks the host half wrote the
mirror, and then opens that instance's GUI in a real Edge with the extension loaded — asserting the
chip is delivered by the host with no injection at all, that it defaults to a single status dot, and that
its “hide” action is scoped to one page load so the guide can never be lost.

### Safari is out of scope, and here is why

Safari exposes **no** tab-group API to extensions (no `chrome.tabGroups`, no `tabs.Tab.groupId`, no
`tabs.group`) and **none** to AppleScript either — Safari 27's own dictionary
`/Applications/Safari.app/Contents/Resources/Safari.sdef` has a single `tab` class with
`source`/`URL`/`index`/`text`/`visible`/`name` and no `tab group` class, element, property or command.
The only first-party route is Shortcuts: Safari ships `Create Tab Group` / `Move Tabs to Tab Group` /
`Search Tabs` App Intents, drivable headlessly with `/usr/bin/shortcuts run "<name>"`. That works, but
macOS has no "tab opened" trigger, so it cannot be event-driven — it needs an explicit trigger. If the
real goal is simply keeping DSH tabs away from the rest, making the GUI a Safari Web App
(*Add to Dock*) or giving it its own Profile is more robust than any scripting.

## License

MIT
