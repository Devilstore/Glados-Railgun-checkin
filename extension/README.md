<div align="center">

# GLaDOS 自动签到

<p><sub>在真实浏览器中完成 GLaDOS 签到，支持多账号、Cloudflare Turnstile、自动兑换和推送。</sub></p>

支持 **浏览器登录态** · **Cookie 多账号** · **8 个域名** · **Turnstile** · **可选自动点击验证框** · **自动兑换** · **推送** · **内置更新**

</div>

---

> [!NOTE]
> 非官方扩展，与 GLaDOS 官方无关。
> Python / Actions 版本见主库 [README](../README.md)。

## 🚀 快速开始

1. 下载本仓库，或到 [Latest Release](https://github.com/Devilstore/Glados-Railgun-checkin/releases/latest) 下载扩展压缩包并解压。
2. 打开 `edge://extensions`（Chrome 为 `chrome://extensions`），开启「开发人员模式」。
3. 点「加载解压缩的扩展」，选择 `extension/` 目录。
4. 打开设置页，点「+ 添加账号」：
   - 主账号选「浏览器登录态」，不需要填 Cookie；
   - 其他账号选「手动填 Cookie」。
5. 保存后点「立即签到」；需要自动运行时在「设置」里配置签到时段。

> 首次安装会自动打开设置页。扩展必须在浏览器运行时才能签到。

## ⚙️ 配置

### 账号

| 字段 | 说明 |
|---|---|
| 名称 | 留空自动命名为「账号 1」「账号 2」…… |
| 所属站点 | 账号实际登录的 GLaDOS 域名 |
| 认证方式 | 浏览器登录态 / 手动填 Cookie |
| Cookie | 仅 Cookie 模式需要，至少包含成对的 `gld:sess` + `gld:sess.sig` 或 `koa:sess` + `koa:sess.sig` |
| User-Agent | 建议留空；仅当 Cookie 来自其他设备时填写 |
| 兑换模式 | 不兑换 / 100 / 200 / 500 积分 |
| 启用 | 关闭后不参与自动签到 |

- **浏览器登录态**：直接使用当前浏览器里的登录会话；同一站点只能有一个此类账号。
- **Cookie 模式**：把 Cookie 注入临时标签页，可添加多个账号。
- 多账号可用不同浏览器 Profile 登录后复制 Cookie；不要分享 Cookie。

### 站点

内置 8 个域名，默认只启用 `glados.cloud`：

```text
glados.cloud
glados.network
glados.rocks
glados.one
glados.space
glados.vip
glados-facility.com
railgun.info
```

站点页只保留启用 / 域名 / 删除；内置站点的删除按钮禁用，请使用启用 / 停用。

### 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| 签到时段 | 9 点 | 目标小时内随机触发 |
| 随机延迟 | 45 分钟 | 目标小时内最多等待的分钟数 |
| 页面停留 | 4.5–6.5 秒 | 拟人停留，最低 2.5 秒 |
| 今日已签则跳过 | 开 | 影响手动批量签到；自动任务无论此开关如何，每天只跑一次 |
| 桌面通知 | 开 | 全部任务完成后汇总通知 |
| 测试签到显示签到窗口 | 开 | 单账号测试时把签到页切到前台，能看到按钮点击过程 |
| 被验证拦截时切前台人工完成 | 开 | 服务端返回 Cloudflare 失败后置顶页面等待人工验证，通过后自动重试一次 |
| 验证未完成时保留标签页 | 开 | 不自动关闭签到页，方便接着手动完成验证 |
| 自动点击 Cloudflare 验证框 | 关 | 实验性；用 debugger 点击 Cloudflare iframe 复选框，图片题仍需手动 |
| 打开设置页时检查更新 | 开 | 只读 GitHub Release 版本号，1 小时内最多一次；关闭后完全不联网检查 |
| 远程推送 | 空 | PushDeer / ServerChan |

> 自动点击需要 `debugger` 权限。Chrome 不允许把 `debugger` 作为可选权限，因此即使关闭自动点击，安装时也会看到调试权限提示；开启后 Chrome 可能在点击瞬间显示“扩展正在调试此浏览器”，失败会自动转为置顶页面并等待人工完成。

**人机验证的日志留痕**

自动点击属于「扩展替你动了鼠标」的动作，因此只要发生交互，全过程都会写进账号卡片和日志页的灰色诊断行，前缀为 `⚙`：

| 场景 | 日志内容（`detail` 尾部） |
|---|---|
| 自动点击并拿到令牌 | `⚙ 已自动点击验证框（input[type=checkbox]）、自动点击后取得令牌` |
| 自动点击但无令牌 | `⚙ 已自动点击验证框（frame-fallback）、自动点击后 15 秒内仍无令牌` |
| 自动点击关闭 / 转人工 | `⚙ 自动点击已关闭，已切前台等人工、人工验证完成` |
| 无需验证（正常） | 不记录，避免日常噪音 |

即：**看到 `⚙` 就代表扩展动过验证框**；没有 `⚙` 说明本次静默通过或压根不需要验证。

自动重试：

- 每账号每天最多 3 次自动重试；
- 失败后按约 30 分钟 / 2 小时 / 2 小时退避；
- 用尽后当天暂停，第二天重新开始；
- 手动「立即签到」不受限制。

自动调度的两条硬规则（1.0.7 起）：

1. **每天只跑一次**：账号当天已成功或已重复签到后，自动任务不再回头重跑，与「今日已签则跳过」开关无关。该开关只影响手动批量签到。
2. **保留标签页不丢身份**：需要人工验证时保留的标签页会继续携带该账号的 Cookie（cookie 模式），标签页关闭时才清理注入规则；同一账号的新一轮签到会先关掉上一次遗留的页面。

## 🔔 推送

支持：

- PushDeer SendKey；
- ServerChan SendKey。

配置后，批量签到结束发送一条汇总；单账号手动签到即时发送。  
推送格式与 Python 脚本 `Report.render` 逐字一致：

```text
GLaDOS 签到 · 成功 1 · 失败 1 · 重复 1

#1  大号  ✅ 签到成功  glados.cloud  获得 20 积分 · 剩余 48 天 · 总 409 积分
#2  小号  🔄 重复签到  railgun.info  获得 0 积分 · 剩余 23 天 · 总 528 积分
#3  账号3  🔴 签到失败  glados.cloud  获得 0 积分 · 剩余 None 天 · 总 None 积分
```

两个后端的换行方式不同，这是刻意对齐 Python 的结果：

| 后端 | 请求参数 | 行分隔 | 说明 |
|---|---|---|---|
| PushDeer | `type=text` | `\n` | Python 用 `pypushdeer.send_text()`，即纯文本 |
| ServerChan | Markdown | `  \n` | 行尾两空格做硬换行；单 `\n` 会被渲染成一段 |

> 推送里的 `⏎` 位置由 `sendPushNotification` 按后端分别拼接，`node test-push.js` 做逐字比对。

推送配置独立于桌面通知；两个 SendKey 都留空则不推送。

## 🔒 数据与权限

- 账号、Cookie、推送 Key、日志只保存在本机浏览器，不会上传到任何服务器；
- Cookie 和 SendKey 为明文存储，请勿分享浏览器 Profile；
- Cookie 注入规则只作用于该账号所属站点域（含子域），不会把会话 Cookie 带到第三方请求上；
- 除 GLaDOS 接口外，只会在配置推送后请求 PushDeer / ServerChan；
- 开启「检查更新」时（默认开启）会读取 GitHub Release 版本号，1 小时内最多一次，可关闭；
- 扩展不在页面中注入广告，不加载远程代码。

主要权限：

| 权限 | 用途 |
|---|---|
| `storage` | 本地保存账号、设置和日志 |
| `alarms` | 定时签到 |
| `notifications` | 桌面通知 |
| `declarativeNetRequest` | 给临时标签页注入 Cookie / UA |
| `scripting` | 在签到页点击按钮 |
| `tabs` | 创建和关闭临时签到标签页 |
| `cookies` | 读取当前登录态，便于配置 |
| `debugger` | 实验性自动点击 Cloudflare 验证框；仅在点击瞬间附加 |
| `host_permissions` | 8 个 GLaDOS 域名、推送接口、GitHub API 与 `*.githubusercontent.com`（Release 下载重定向域名） |

## 🔄 版本与更新

当前版本：`1.1.7`。

- `extension/` 目录始终是最新源码；
- 发布包按版本命名，例如 `glados-checkin-extension-v1.1.7.zip`；
- 加载目录不变时扩展 ID 不变，账号数据保留；
- 下载发布包请以 GitHub Releases 的 **Latest** 为准。

### 内置更新（1.1.0 新增）

设置页顶部只有**一行**：`v1.1.7 · 已是最新` ＋ 一个按钮。发现新版本时才变成
`v1.1.7 → v1.1.8  有新版本` ＋「更新到 v1.1.8」（更新说明折叠在旁边的文字按钮里）。

界面状态：

| 情形 | 显示 |
|---|---|
| 打开设置页 | 先显示缓存结论；过期则 `v1.1.7 · 正在检查…`（此期间不显示按钮） |
| 已是最新 | `v1.1.7 · 已是最新（刚刚检查）` ＋「检查更新」 |
| 有新版本 | `v1.1.7 → v1.1.8  有新版本` ＋「更新到 v1.1.8」 |
| 更新完成 | `已更新到 v1.1.8 · 需重新加载生效` ＋「重新加载」 |
| 检查失败 | 红底 `检查失败：<原因>` ＋「检查更新」 |

流程：

1. 点「检查更新」→ 读 `api.github.com` 最新 Release 的 `tag_name`，与本地 `manifest.version` 按段比较（`1.10.0 > 1.9.9`）。请求 15 秒超时。
2. 点「更新到 vX」→ **首次**会弹出目录选择器，请选「加载已解压的扩展程序」时用的那个文件夹。授权后记住，以后直接写入。
3. 下载 zip、内存解压，校验：包内 `manifest.json` 版本必须等于 Release 且比当前新；路径不得含 `..` 或绝对路径；拒绝 ZIP64。
4. 旧文件自动备份到扩展目录下的 `backups/v<旧版本>/`（不能以 `_` 开头，否则 Chrome 拒绝加载扩展）。
5. 只覆盖安装包内的文件，**不删除**目录里的其他文件。
6. 完成后按钮变成「重新加载」→ 调 `chrome.runtime.reload()` 生效。

为什么必须选一次目录（三个独立原因，缺一即可行）：

1. **扩展拿不到自己的真实磁盘路径**。`chrome.runtime.getURL()` 只返回虚拟源 `chrome-extension://<id>/`；`chrome.management.getSelf()` 只有 id/version/installType。未打包扩展的 ID 是路径的哈希（SHA-256 前 16 字节），单向不可逆。
2. **`chrome.runtime.getPackageDirectoryEntry()` 帮不上**。它返回的是只读的旧版 `DirectoryEntry`，URL 形如 `filesystem:chrome-extension://<id>/root/`，指向 Chrome 内部的虚拟挂载，不是磁盘目录；无法写入，也无法转成可写的 `FileSystemDirectoryHandle`。
3. **File System Access 的设计就要求用户手势**。即使知道路径字符串，也**不能**凭空构造句柄——必须由 `showDirectoryPicker()` 在用户点击后返回。这是安全模型，无法绕过（否则任意网页都能静默读写磁盘）。

结论：对「开发者模式加载的未打包扩展」，一次目录授权是平台下限，无法省略。已尽量把成本降到一次：句柄存 IndexedDB，之后每次更新都是两次点击。

注意事项：

- 需要 Chrome / Edge **103+**（`DecompressionStream('deflate-raw')` + `showDirectoryPicker`）。
- 若 `extension/` 是 git 工作区，就地更新会让 `git status` 出现改动，属预期；`git checkout -- extension` 可还原。
- 更新绝不自动执行，必须你点确认。
- 手动方式依旧有效：下载 zip 解压覆盖，再去扩展页点「重新加载」。

## 🧪本地测试

测试只跑 Node，不依赖浏览器，也不需要安装任何包：

```bash
cd extension
node test-classify.js     # 服务端响应归类（21 项）
node test-push.js         # 推送格式与 Python 逐字比对（10 项）
node test-turnstile.js    # 人机验证日志文案（6 项）
node test-rules.js        # DNR 规则 id 分配、域名限定与保留标签页（18 项）
node test-updater.js      # 版本比较 / zip 解析 / 路径安全 / 端到端写盘（23 项）
node test-ui-hidden.js    # 更新区按钮互斥与自动检查触发（26 项）
node test-state.js        # 并发写日志不丢、保存账号不覆盖签到结果（10 项）
node test-today.js        # 跨零点后昨日回执不误显示为今日所得（9 项）
node test-docs.js         # 文档与代码一致性（26 项）
```

`test-push.js` 的基准值由真实 Python 代码（`checkin.py` 的 `Report.render`）生成，不是手写的。
`test-updater.js` 会手工构造 zip 并用内存文件系统模拟写盘，验证目录穿越拦截与备份位置。

## 📁文件结构

```text
extension/
├── manifest.json        # 扩展清单（MV3）
├── background.js        # Service Worker：调度、签到、DNR、推送
├── inject.js            # 页面主世界：保持可见 + 旁听签到响应
├── updater.js           # 内置更新：版本检查、zip 解压、写盘
├── popup.html/css/js    # 工具栏弹窗：今日概览
├── options.html/css/js  # 设置页：账号、站点、日历、调度、推送、日志
├── icons/               # 图标
└── test-*.js            # Node 测试（不打包进发布包）
```

## ❓常见问题

<details>
<summary><strong>Q：浏览器关闭后会签到吗？</strong></summary>

不会。扩展依赖浏览器进程，电脑关机或浏览器退出后不会执行。
</details>

<details>
<summary><strong>Q：为什么需要真实浏览器？</strong></summary>

GLaDOS 新版签到包含 Cloudflare Turnstile，纯 HTTP 脚本无法完成验证。扩展在官网页面中点击签到按钮，由官方组件完成验证。
</details>

<details>
<summary><strong>Q：多个账号需要多个浏览器吗？</strong></summary>

不需要。主账号用「浏览器登录态」，其他账号用 Cookie 模式。若多个账号共用同一个登录会话，需要用不同浏览器 Profile 分别登录并获取 Cookie。
</details>

<details>
<summary><strong>Q：读取不到当前登录 / Cookie 为空？</strong></summary>

`document.cookie` 看不到 httpOnly 会话 Cookie，这不一定代表未登录。用「测登录态」确认服务端会话有效后，选择「浏览器登录态」即可。
</details>

<details>
<summary><strong>Q：Cloudflare 验证失败怎么办？</strong></summary>

1.0.4 起默认开启「被验证拦截时切前台人工完成」：服务端返回 `code=5` 后，扩展会把签到页切到前台并弹通知，等你完成验证；拿到令牌后自动再点一次。若 90 秒内没完成，标签页会保留（受「验证未完成时保留标签页」控制）。

另外：如果保留的标签页属于 Cookie 模式账号，它**会继续携带该账号的 Cookie**（注入规则不提前移除），所以你在保留页里点签到，签的仍是这个账号，不会串到浏览器当前登录的账号上。

原有注意事项仍成立：不要用机房 IP，代理节点也可能被判高风险；多账号短时间内连续签到会提高二次验证概率，建议账号之间留出间隔。

</details>

## 📄声明

- 只调用 GLaDOS 网页端自身使用的接口；
- 不破解、不伪造 Turnstile；
- 使用风险自负，服务端风控策略可能随时调整；
- 本项目以 [MIT](../LICENSE) 发布。
