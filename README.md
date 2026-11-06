<div align="center">

# GLaDOS 自动签到

<p><sub>每天自动完成签到，结果可推送到手机。</sub></p>

支持 **多账号** · **域名自动探测** · **设备自适应** · **单轮时间预算**，运行在 GitHub Actions 上，无需服务器。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.13-3776AB?logo=python&logoColor=white)](https://www.python.org/)

[快速开始](#快速开始) · [账号配置](#配置-glados_cookies) · [积分兑换](#积分兑换) · [消息推送](#消息推送) · [问题排查](#问题排查) · [常见问题](#常见问题faq)

</div>

---

> [!NOTE]
> 非官方项目，与 GLaDOS 官方无关，仅供学习与交流使用。

## 🚀快速开始

> [!TIP]
> **还没有 GLaDOS 账号？**
>
> 用[**邀请链接注册**](https://glados.space/landing/0A58E-NV28S-6U3QV-33VMG) 享 9 折优惠，邀请码 [`0A58E-NV28S-6U3QV-33VMG`](https://0a58e-nv28s-6u3qv-33vmg.glados.space) · 优惠码 [`DEVILSTORE`](https://0a58e-nv28s-6u3qv-33vmg.glados.space)

1. Fork 本仓库。
2. 在自己的仓库进入 `Settings` → `Secrets and variables` → `Actions` → `New repository secret`，至少添加 `GLADOS_COOKIES`。
3. 打开 `Actions` → `auto check` → `Run workflow` 手动跑一次，看到「签到成功」或「重复签到」即完成。
4. 之后每天 **09:18 / 12:18**（北京时间）自动运行。

| Secret | 必填 | 说明 |
| --- | :---: | --- |
| `GLADOS_COOKIES` | **是** | 账号列表，固定 JSON 数组，见[账号配置](#配置-glados_cookies) |
| `PUSHDEER_SENDKEY` | 否 | PushDeer 推送，见[消息推送](#消息推送) |
| `SERVERCHAN_SENDKEY` | 否 | Server酱 推送，见[消息推送](#消息推送) |
| `GLADOS_EXCHANGE_PLAN` | 否 | `plan100` / `plan200` / `plan500`，见[积分兑换](#积分兑换) |
| `GLADOS_VERBOSE` | 否 | `true` / `1` / `yes` 输出详细日志 |

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
| `Automated check-in detected` / 只给 1 积分 | GLaDOS 判定为自动签到；脚本已适配 challenge，但 TLS/HTTP 指纹、IP、设备等仍可能被识别 → 手动签到或使用官方客户端 |
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

- GLADOS_COOKIES 格式改为 JSON 数组，支持 `name` / `origin` / `cookie` / `user-agent`；旧 `&` 格式仍兼容。
- 优化失败原因提示；签到被拒、兑换未完成等场景给出可执行建议。
- 日志自动脱敏：`koa:*` / `gld:*` / Bearer → `[REDACTED]`。
- 加入 challenge 校验机制；获取失败时回退旧协议。

## ⭐Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=Devilstore/Glados-Railgun-checkin&type=Date&legend=top-left)](https://star-history.com/#Devilstore/Glados-Railgun-checkin&type=Date)

---

## 📄声明

- 不保证稳定运行，接口与风控策略可能随时调整。
- 只调用网页端使用的公开 API，不破解验证码；服务端风控仍可能拒绝或降权。
- 使用风险自负；因使用本工具导致的账号风控、限权或封禁由使用者自行承担。
- 本项目以 [MIT](LICENSE) 发布。

如果这个项目对你有帮助，欢迎点个 ⭐ Star。
