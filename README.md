<div align="center">

# GLaDOS 自动签到

<p><sub>每天自动完成签到，结果可推送到手机。</sub></p>

支持 **多账号** · **8 个域名** · **Cloudflare Turnstile**：可用 GitHub Actions 无人值守，也可用浏览器扩展在本机真实浏览器中签到（扩展支持内置更新）。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.13-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![GLaDOS Check-in](https://github.com/Devilstore/Glados-Railgun-checkin/actions/workflows/gladosCheck.yml/badge.svg?branch=master)](https://github.com/Devilstore/Glados-Railgun-checkin/actions/workflows/gladosCheck.yml)
[![Last commit](https://img.shields.io/github/last-commit/Devilstore/Glados-Railgun-checkin?branch=master)](https://github.com/Devilstore/Glados-Railgun-checkin/commits/master)

[快速开始](#快速开始) · [浏览器扩展](#-浏览器扩展cloudflare-备用方案) · [账号配置](#配置-glados_cookies) · [积分兑换](#积分兑换) · [消息推送](#消息推送) · [问题排查](#问题排查) · [常见问题](#常见问题faq)

</div>

---

> [!NOTE]
> 非官方项目，与 GLaDOS 官方无关，仅供学习与交流使用。

## 🚀快速开始

> [!TIP]
> **还没有 GLaDOS 账号？**
>
> 用[**邀请链接注册**](https://glados.space/landing/0A58E-NV28S-6U3QV-33VMG)；结算时使用优惠码 `DEVILSTORE` 可享 9 折。

1. Fork 本仓库。
2. 在自己的仓库进入 `Settings` → `Secrets and variables` → `Actions` → `New repository secret`，至少添加 `GLADOS_COOKIES`。
3. 打开 `Actions` → `GLaDOS Check-in` → `Run workflow` 手动跑一次，看到「签到成功」或「重复签到」即完成。
4. 之后每天 **09:18 / 12:18**（北京时间）自动运行。

| Secret | 必填 | 说明 |
| --- | :---: | --- |
| `GLADOS_COOKIES` | **是** | 账号列表，固定 JSON 数组，见[账号配置](#配置-glados_cookies) |
| `PUSHDEER_SENDKEY` | 否 | PushDeer 推送，见[消息推送](#消息推送) |
| `SERVERCHAN_SENDKEY` | 否 | Server酱 推送，见[消息推送](#消息推送) |
| `GLADOS_EXCHANGE_PLAN` | 否 | `plan100` / `plan200` / `plan500`，见[积分兑换](#积分兑换) |
| `GLADOS_VERBOSE` | 否 | `true` / `1` / `yes` 输出详细日志 |

## 🧩 浏览器扩展（Cloudflare 备用方案）

### 怎么选

| 使用场景 | 推荐 |
|---|---|
| 每天不想开电脑，接受 Actions 自动跑 | Python / Actions |
| 经常遇到 Cloudflare、Turnstile、只拿到 1 积分 | 浏览器扩展 |
| 想两者兼顾 | 保留 Actions，同时安装扩展补签 |

Actions 版是纯 HTTP 请求，**无法通过 Cloudflare Turnstile**。如果日志出现：

- `Cloudflare` / `Just a moment` / `Turnstile`；
- HTTP `403` / `429` / `503`；
- `Automated check-in detected`；
- 只拿到 1 积分，明显少于正常签到；

说明本次积分没有完整获得，继续重跑脚本通常也没有用。  
请改用配套浏览器扩展，在真实浏览器里点击官网签到按钮，让 Turnstile 由官方组件完成。

### 安装与使用

1. 下载本仓库，或到 [Latest Release](https://github.com/Devilstore/Glados-Railgun-checkin/releases/latest) 下载扩展压缩包并解压；
2. 打开 `edge://extensions`（Chrome 为 `chrome://extensions`），启用「开发人员模式」；
3. 点「加载解压缩的扩展」，选择 `extension/` 目录；
4. 打开扩展设置，点「+ 添加账号」：
   - 主账号选「浏览器登录态」；
   - 其他账号选「手动填 Cookie」；
5. 保存后点「立即签到」，之后可在「设置」里配置自动签到、通知和推送。

完整说明见：[`extension/README.md`](extension/README.md)

### 版本

当前版本：`1.1.7`。

- `extension/` 目录始终是**最新源码**，适合开发者和本地加载；
- 发布包按版本号命名，例如 `glados-checkin-extension-v1.1.7.zip`；
- 加载目录不变时扩展 ID 不变，账号数据保留；
- 不要把 `latest` 当成唯一文件名；以 GitHub Releases 的 **Latest** 为准，版本化包便于回退和排查。

Python / Actions 和扩展可以同时保留：Actions 负责无人值守，扩展负责 Cloudflare 限制下的本机补签。

升级方式二选一：

- **扩展内更新**（1.1.0 起）：设置页顶部点「检查更新」→「更新到 vX」→ 首次授权一次扩展所在目录 →「重新加载」。之后每次更新只需两次点击。
- **手动更新**：下载 zip 解压覆盖 `extension/`，到 `edge://extensions` 点「重新加载」。

Chrome 不允许扩展写入自己的安装目录，所以首次更新需要你手动指定一次目录（句柄会被记住）。详见 [`extension/README.md`](extension/README.md)。

## 🔧配置 GLADOS_COOKIES

必须是 **JSON 数组**，每个账号一个对象，只允许下面四个字段：

```json
[
  {
    "name": "大号",
    "origin": "glados.cloud",
    "cookie": "koa:sess=...; koa:sess.sig=...; gld:sess=...",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Safari/537.36"
  },
  {
    "name": "小号",
    "origin": "railgun.info",
    "cookie": "koa:sess=...; koa:sess.sig=..."
  },
  {
    "name": "账号3",
    "cookie": "gld:sess=..."
  }
]
```

| 字段 | 必填 | 说明 |
| --- | :---: | --- |
| `cookie` | **是** | 完整 Cookie；新版建议同时包含 `gld:sess` 与 `gld:sess.sig` |
| `name` | 否 | 备注名，不填显示 `账号1` |
| `origin` | 否 | Cookie 所属域名，不填自动探测 |
| `user-agent` | 否 | 提取 Cookie 时的浏览器 UA，建议填写 |

**要点**

- 字段名固定，出现其他字段直接报错。
- 重复 Cookie 自动去重，不会重复签到。
- 旧 `&` 分隔仍兼容但会提示迁移；换行分隔、字符串数组、单个对象已不支持。

**如何获取**

签到页按 `F12` → `Network` → 刷新 → 选中任一请求 → `Request Headers`，复制 `Cookie` 与 `User-Agent` 的完整值。

**探测顺序**（不填 `origin` 时按此顺序，命中即停）

`glados.cloud` → `railgun.info` → `glados.network` → `glados.rocks` → `glados.one` → `glados.space` → `glados.vip` → `glados-facility.com`

探测用短超时快速筛一遍；只对**网络无响应**的域名再试一次，返回「没有权限」的不重试。

## 🎁积分兑换

设置 `GLADOS_EXCHANGE_PLAN` 后才执行，且只在签到**成功 / 重复**时兑换。

| 档位 | 消耗积分 | 获得天数 |
| --- | :---: | :---: |
| `plan100` | 100 | 10 天 |
| `plan200` | 200 | 30 天 |
| `plan500` | 500 | 100 天 |

不填或填非法值则不兑换；余额不足时接口返回失败，不会扣成负数。

## 📣消息推送

| 后端 | Secret | 获取密钥 |
| --- | --- | --- |
| PushDeer | `PUSHDEER_SENDKEY` | [pushdeer.com](https://www.pushdeer.com/product.html) 下载 App，在 App 内获取 pushkey |
| Server酱 | `SERVERCHAN_SENDKEY` | [sct.ftqq.com](https://sct.ftqq.com/) 微信扫码登录，在页面获取 SendKey |

两个可单独或同时配置（都发，任一成功即视为成功）；都不配则跳过推送，不影响签到。

### 推送效果

```text
GLaDOS 签到 · 成功 1 · 失败 1 · 重复 1
#1  大号  ✅ 签到成功  glados.cloud  获得 20 积分 · 剩余 48 天 · 总 409 积分
#2  小号  🔄 重复签到  railgun.info  获得 0 积分 · 剩余 23 天 · 总 528 积分
#3  账号3  🔴 签到失败  未探测  获得 0 积分 · 剩余 None 天 · 总 None 积分
```

| 标记 | 含义 |
| --- | --- |
| `✅ 签到成功` | 本次签到成功，`获得 N 积分` 为本次所得 |
| `🔄 重复签到` | 今天已签过，正常结果，不算失败 |
| `🔴 签到失败` | 未能签到，见[问题排查](#问题排查) |

账号名列只在**多账号**时出现。

## ⏰修改运行时间

默认每天 **09:18 / 12:18**（北京时间），由 `.github/workflows/gladosCheck.yml` 的 `schedule` 控制：

```yaml
schedule:
  - cron: '18 9,12 * * *'
    timezone: 'Asia/Shanghai'
```

改 `cron` 即可调整时间；`timezone` 让 GitHub 按北京时间解释。例如只保留早上一次：

```yaml
schedule:
  - cron: '18 9 * * *'
    timezone: 'Asia/Shanghai'
```

## 🔍问题排查

**正常日志**

| 日志片段 | 说明 |
| --- | --- |
| `✅ 命中登录域名（剩余 N 天）` | 探测成功，后续只在该域名签到 |
| `✅ 重试后命中登录域名（剩余 N 天）` | 该域名首次无响应，重试后成功 |
| `[REDACTED]` | 脱敏标记，凭证已被替换 |

**异常日志**

| 日志片段 | 原因与处理 |
| --- | --- |
| `候选域名均返回「没有权限」` | Cookie 失效，或账号不在候选域名内 → 重新登录并更新 Cookie |
| `候选域名均未获得服务端响应` | 网络/服务端故障，非 Cookie 问题 → 稍后重跑 |
| `设备平台不匹配(loginDevice=…)` | UA 与登录设备不一致 → 补充 `user-agent` 字段 |
| `签到被拒：please checkin via …` | token 与域名不符（多为服务端规则变更）→ 确认 Cookie 来源域名 |
| `无权限(code=-2)` | 该 Cookie 失效或账号风控 |
| `Cloudflare` / `Just a moment` / `Turnstile` / HTTP `403` `429` `503` | Cloudflare 拦截或限流，纯 HTTP 无法完成验证 → **改用浏览器扩展补签**，见[浏览器扩展](#-浏览器扩展cloudflare-备用方案) |
| `Automated check-in detected` / 只给 1 积分 | GLaDOS 判定为自动签到；脚本已适配 challenge，但 TLS/HTTP 指纹、IP、设备等仍可能被识别 → **改用浏览器扩展**，在真实浏览器中完成验证 |
| `运行超出预算` | 单轮超时，剩余账号被跳过 → 下轮或手动重跑 |
| `积分请求失败 / 响应解析失败 / 格式异常 / 字段无法解析` | 查总积分失败 → 推送里显示 `总 None 积分`，**不影响签到结果**，可忽略 |

> 推送里出现 `总 None 积分` 只表示本次没取到总积分（该接口偶发较慢），与签到成功与否无关；想确认可手动重跑一次。

## ❓常见问题（FAQ）

<details>
<summary><strong>Q：一次运行多久？</strong></summary>

正常几秒到几十秒。单轮预算 300 秒（约 5 分钟），超出会跳过剩余账号。

</details>

<details>
<summary><strong>Q：Cookie 多久会过期？</strong></summary>

没有固定期限。退出登录、改密码、服务端会话策略调整都可能让它提前失效。出现「候选域名均返回没有权限」或 `code=-2` 时，重新登录并更新 `GLADOS_COOKIES` 即可。

</details>

<details>
<summary><strong>Q：支持多个账号吗？</strong></summary>

支持，数量不限，在 JSON 数组里多写几项即可。重复的 Cookie 会自动去重，不会重复签到。

</details>

<details>
<summary><strong>Q：需要标注每条 Cookie 属于哪个域名吗？</strong></summary>

不需要，脚本会自动探测。填 `origin` 的好处是少发几个探测请求、日志更清楚。注意**各站 Cookie 通常不互通**，每条 Cookie 必须来自它真正登录的站点。

</details>

<details>
<summary><strong>Q：填错 <code>origin</code> 会怎样？</strong></summary>

不会失败。`origin` 只是**优先尝试**：命中就直接签到，返回「没有权限」则自动回退遍历全部 8 个内置域名。

</details>

<details>
<summary><strong>Q：多账号时怎么区分日志是哪个账号？</strong></summary>

不填 `name` 时按顺序自动命名，显示 `🍪[账号1]`、`🍪[账号2]`；填了则显示 `🍪[1:大号]`、`🍪[2:小号]`、`🍪[3:账号3]`，序号与总结里的 `#1` `#2` `#3` 对应。

</details>

<details>
<summary><strong>Q：一个账号会跑几个任务？</strong></summary>

一个。脚本先探测域名、再只在该域名签到，任务数等于账号数。

</details>

<details>
<summary><strong>Q：「重复签到」算成功还是失败？</strong></summary>

算正常结果。表示当天已签过，服务端返回 `code=1`，总结里单独计数为「重复」，不计入失败。

</details>

<details>
<summary><strong>Q：遇到设备不匹配（code=4）怎么办？</strong></summary>

GLaDOS 会校验 UA 与登录设备。填了 `user-agent` 就原样使用；没填则用默认 UA，失败时按 `loginDevice` 自动重试一次；仍失败会提示补充 `user-agent` —— 填入**提取 Cookie 时那个浏览器**的 UA 即可。

</details>

<details>
<summary><strong>Q：Actions 是绿色的，但没收到通知？</strong></summary>

先确认对应 Secret 拼写正确（日志会打印「已配置 N 个后端」）。注意 Server酱 返回 `code=0` 只代表**任务已入队**，不代表已送达；长时间未收到请检查该 SendKey 是否已绑定微信。

</details>

<details>
<summary><strong>Q：公开仓库的定时任务会自己停掉吗？</strong></summary>

会。GitHub 对公开仓库有「连续 60 天无活动则停用 schedule」的规则。本仓库内置 keepalive 步骤定期产生活动，但并非 100% 保证；发现停跑去 Actions 页面重新启用即可。

</details>

<details>
<summary><strong>Q：配置了兑换会不会把积分乱花掉？</strong></summary>

按 `GLADOS_EXCHANGE_PLAN` 指定档位执行，**不填就不兑换**，且只在签到成功/重复时才兑换。余额不足时接口返回失败，不会扣成负数。

</details>

<details>
<summary><strong>Q：Cloudflare 拦截导致没有积分 / 只有 1 积分怎么办？</strong></summary>

这是纯 HTTP 脚本的固有限制。日志出现 Cloudflare、Turnstile、403/429/503，或只拿到 1 积分时，说明本次签到没有完整完成。继续重跑大概率仍会被拦截。

请改用配套浏览器扩展 [`extension/`](extension/README.md)：扩展在真实浏览器里点击官网签到按钮，由官方组件完成 Turnstile；支持 8 个域名、多账号、自动兑换和推送。

</details>

<details>
<summary><strong>Q：签到失败会让 Actions 变红吗？</strong></summary>

分两种情况：**配置错误**（未填 Cookie、JSON 格式非法）会以非 0 退出码结束，工作流变红；**业务失败**（Cookie 失效 `code=-2`、服务端 5xx）不会变红，避免偶发失败天天误报。因此业务失败需要自己关注推送或日志。

</details>

<details>
<summary><strong>Q：「剩余 0 天」是怎么回事？</strong></summary>

账号当天到期，签到本身仍会成功。建议配置 `GLADOS_EXCHANGE_PLAN` 用积分续期，详见[积分兑换](#积分兑换)。

</details>

<details>
<summary><strong>Q：可以本地运行吗？</strong></summary>

可以，用于调试。安装依赖后设置环境变量再执行：

```bash
pip install -r requirements.txt
export GLADOS_COOKIES='[{"cookie":"koa:sess=..."}]'
python checkin.py
```

Windows PowerShell 用 `$env:GLADOS_COOKIES='[...]'`。

</details>

---

## 📁文件结构

```text
.
├── checkin.py                    # 主程序：账号模型 / API / 配置 / 报告 / 推送
├── logging_config.py             # 日志配置（北京时间、级别短标签、脱敏）
├── requirements.txt              # 依赖
├── README.md                     # 说明文档
├── LICENSE                       # MIT 许可
├── extension/                    # 浏览器扩展：Cloudflare 备用签到方案
│   ├── manifest.json             # MV3 清单
│   ├── background.js             # Service Worker：调度 / 签到 / DNR / 推送
│   ├── inject.js                 # 页面主世界：保持可见 + 旁听签到响应
│   ├── updater.js                # 内置更新：版本检查 / zip 解压 / 写盘
│   ├── popup.*                   # 工具栏弹窗
│   ├── options.*                 # 设置页
│   └── test-*.js                 # Node 测试（不打包进发布包）
└── .github/workflows/
    └── gladosCheck.yml           # Actions 定时任务
```

## 📝更新日志

**2026-01**

- 重构代码，添加日志输出方便定位，支持新版网址，支持配置积分兑换策略。

**2026-04**

- 优化代码逻辑与日志输出。

**2026-09**

- 设备平台自适应重试，无需手动配置 UA。
- 网络层自动重试与退避。
- 日志时间统一为北京时间；定时任务调整为每天 2 次。
- 默认关闭自动兑换。

**2026-10**

- 推送兼容 Server酱。

**2026-11**

**1.1.7**

- 修复 v1.1.6 引入的在线更新回归：写入预检把真实浏览器对已存在文件的 `TypeMismatchError` 误当成异常抛出，导致更新报 `The path supplied exists, but was not an entry of requested type.`；测试 mock 同步模拟真实 API 的类型错误行为。

**1.1.6**

- 全面代码审查修复（30 项）：更新器增加解压体积上限、4 段版本号、更稳的目录剥离与写入预检；修复双击更新竞态、并发写账号覆盖签到结果、SW 保活与会话状态丢失、订阅表单被后台刷新清空等；
- 修复 Server酱 URL 拼接、停留时间上限、更新检查文案与实测不一致等问题。

**1.1.5**

- 修复在线更新后扩展无法加载：旧文件备份目录原为 `_backup/`，而 Chrome/Edge 保留所有以 `_` 开头的文件名，导致加载报错。改为 `backups/`；
- 若本地已存在 `_backup/` 目录，需手动删除后重新加载扩展。

**1.1.4**

- 与 v1.1.3 功能相同，仅作为在线更新修复的验证版本发布，方便确认下载流程已恢复正常；
- 测试文件中的 mock 版本号同步至当前版本。

**1.1.3**

- 修复在线更新失败（`Failed to fetch`）：Release 下载链接会重定向到 `release-assets.githubusercontent.com`，原权限清单只授权了旧的 `objects.githubusercontent.com`。改为通配符授权 `*.githubusercontent.com`，覆盖所有 GitHub 下载 CDN；
- 安装包下载加 60 秒超时与更明确的错误提示，避免网络挂起时一直卡在「正在下载安装包…」。

**1.1.2**

- 修复跨零点后昨日签到回执（如 `Checkin! Got 14 Points`）被误显示为今日所得：历史回执加「上次」前缀、不再高亮积分；
- 「今日是否已签」改用服务端日期判断，本地日期仅兜底；状态请求禁用缓存，避免跨零点读到昨日响应而误判；
- 修复并发写日志丢条、保存账号时旧快照覆盖签到结果、签到中重置会话签错账号；
- Cookie 注入规则限定到账号所属站点域，不再带到第三方请求；
- 推送失败同时写入日志页；新增 `test-state.js`、`test-today.js`。

**1.1.1**

- 设置页更新区简化为单行，任何时刻最多一个按钮；更新说明折叠；
- 修复 `hidden` 属性被 `.btn` 的 `display` 覆盖、导致多个按钮同时显示的问题（弹窗同源修复）；
- 修复自动检查更新无视觉反馈、无超时导致"看起来没反应"：改为显式状态机，请求 15 秒超时，节流 1 小时；
- 去掉「选目录」常驻按钮与「更新前备份」开关（目录按需弹出、备份始终开启）；
- 移除 `logRetention` 死字段。

**1.1.0**

- 扩展新增**内置更新**：设置页检查 GitHub Release，授权一次目录后就地写入新版本，随后重新加载生效；
- 下载 zip 在内存解压（无第三方库），校验包内版本与 Release 一致、比当前新，拒绝目录穿越与 ZIP64，旧文件备份到 `_backup/`；
- 最低 Chrome / Edge 版本提高到 103（需要 `DecompressionStream('deflate-raw')` 与目录选择 API）；
- 新增 GitHub 相关 `host_permissions`。

**1.0.7**

- 代码审计修复多处缺陷：
  - 保留标签页提前移除 DNR 规则 → Cookie 模式退化成浏览器登录态，可能签错账号；
  - DNR 规则 id 撞号 → 误删其他标签页的注入规则；
  - 关闭「今日已签则跳过」后自动任务每 15 分钟重复签到；
  - 批量签到把所有账号的页面逐一切到前台；
  - 兑换请求体格式与 Python 版不一致；
  - 签到按钮长时间禁用时白等 100 秒；
- 账号绑定到已停用站点时保存前提示；
- 新增 DNR 规则与 UI 静态测试。

**1.0.6**

- 人机验证相关动作（自动点击、切前台、人工验证）写入日志 `detail`，前缀 `⚙`；静默通过不记录，避免日常噪音。

**1.0.5**

- 推送换行修正：PushDeer 改用 `type=text`、Server酱用行尾两空格硬换行，与 Python 推送逐字一致；
- 重复状态文案对齐 Python（「重复签到」），单账号不再显示账号名。

**1.0.4**

- 服务端返回 `code=5`（Cloudflare 拦截）后，把签到页切到前台等待人工验证，拿到令牌后自动重试一次；
- 验证未完成时保留标签页，便于接着操作。

**1.0.3**

- 修复 Turnstile 在点击签到后才出现时扩展一直停留在后台的问题；
- 点击期间并行监控验证框，发现后自动激活签到页并提示人工完成；
- 即使 iframe 初始不可见也会进入等待验证流程。

**1.0.2**

- 扩展增加可选的 Cloudflare 验证框自动点击（默认关闭，需要 `debugger` 权限）；
- 通过 CDP 在 iframe 内查询 checkbox 坐标，失败时回退到置顶页面人工验证；
- 补充 `debugger` 权限说明。

**1.0.1**

- 扩展版本升级到 `1.0.1`；
- 清理扩展内部历史/版本说明注释；
- 忽略 `SHA256SUMS.txt`、`release-notes.md`、`debug.py` 等本地发布/调试文件。

**1.0.0**

- GLADOS_COOKIES 格式改为 JSON 数组，支持 `name` / `origin` / `cookie` / `user-agent`；旧 `&` 格式仍兼容。
- 优化失败原因提示；签到被拒、兑换未完成等场景给出可执行建议。
- 日志自动脱敏：`koa:*` / `gld:*` / Bearer → `[REDACTED]`。
- 加入 challenge 校验机制；获取失败时回退旧协议。
- 识别 Cloudflare/Turnstile 拦截与 403/429/503；积分不完整时日志和推送会提示改用浏览器扩展。

## ⭐Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=Devilstore/Glados-Railgun-checkin&type=Date&legend=top-left)](https://star-history.com/#Devilstore/Glados-Railgun-checkin&type=Date)

---

## 📄声明

- 不保证稳定运行，接口与风控策略可能随时调整。
- 只调用网页端使用的公开 API，不破解验证码；服务端风控仍可能拒绝或降权。
- 使用风险自负；因使用本工具导致的账号风控、限权或封禁由使用者自行承担。
- 本项目以 [MIT](LICENSE) 发布。

如果这个项目对你有帮助，欢迎点个 ⭐ Star。
