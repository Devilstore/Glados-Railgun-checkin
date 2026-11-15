<div align="center">

# GLaDOS 自动签到

<p><sub>在真实浏览器中完成 GLaDOS 签到，支持多账号、Cloudflare Turnstile、自动兑换和推送。</sub></p>

支持 **浏览器登录态** · **Cookie 多账号** · **8 个域名** · **Turnstile** · **自动兑换** · **推送**

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

| 设置 | 说明 |
|---|---|
| 签到时段 | 目标小时内随机触发 |
| 随机延迟 | 目标小时内最多等待的分钟数 |
| 页面停留 | 拟人停留，最低 2.5 秒 |
| 今日已签则跳过 | 避免重复签到 |
| 桌面通知 | 全部任务完成后汇总通知 |
| 远程推送 | PushDeer / ServerChan |

自动重试：

- 每账号每天最多 3 次自动重试；
- 失败后按约 30 分钟 / 2 小时 / 2 小时退避；
- 用尽后当天暂停，第二天重新开始；
- 手动「立即签到」不受限制。

## 🔔 推送

支持：

- PushDeer SendKey；
- ServerChan SendKey。

配置后，批量签到结束发送一条汇总；单账号手动签到即时发送。  
推送格式与 Python 脚本一致：

```text
GLaDOS 签到 · 成功 1 · 失败 1 · 重复 1

#1  大号  ✅ 签到成功  glados.cloud  获得 20 积分 · 剩余 48 天 · 总 409 积分
#2  小号  🔄 今日已签到  railgun.info  获得 0 积分 · 剩余 23 天 · 总 528 积分
#3  账号3  🔴 签到失败  glados.cloud  获得 0 积分 · 剩余 None 天 · 总 None 积分
```

推送配置独立于桌面通知；两个 SendKey 都留空则不推送。

## 🔒 数据与权限

- 账号、Cookie、推送 Key、日志只保存在本机浏览器，不会上传到任何服务器；
- Cookie 和 SendKey 为明文存储，请勿分享浏览器 Profile；
- 除 GLaDOS 接口外，只会在配置推送后请求 PushDeer / ServerChan；
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
| `host_permissions` | 8 个 GLaDOS 域名及推送接口 |

## 🔄 版本与更新

当前版本：`1.0.1`。

- `extension/` 目录始终是最新源码；
- 发布包按版本命名，例如 `glados-checkin-extension-v1.0.1.zip`；
- 升级时替换 `extension/` 内容，到 `edge://extensions` 点「重新加载」；
- 加载目录不变时扩展 ID 不变，账号数据保留；
- 下载发布包请以 GitHub Releases 的 **Latest** 为准。

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

确认使用的是新版站点（如 `glados.cloud`），不要在机房 IP、代理或隐藏标签页环境中运行；交互式验证可能需要在临时标签页出现时手动完成一次。

</details>

## 📄声明

- 只调用 GLaDOS 网页端自身使用的接口；
- 不破解、不伪造 Turnstile；
- 使用风险自负，服务端风控策略可能随时调整；
- 本项目以 [MIT](../LICENSE) 发布。
