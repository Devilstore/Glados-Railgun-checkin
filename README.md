# Glados自动签到

## 食用方式：

### 注册一个GLaDOS的账号([注册地址](https://glados.space/landing/0A58E-NV28S-6U3QV-33VMG))

### **Fork**本仓库

![图片加载失败](imgs/1.png)

### 添加**secret**

1. 跳转至自己的仓库的`Settings`->`Secrets and variables`->`Action`

2. 添加1个`repository secret`，命名为`GLADOS_COOKIES`，其值对应GLaDOS账号的cookie值中的有效部分（获取方式如下）

- 在GLaDOS的签到页面按`F12`

- 切换到`Network`页面下，刷新

![图片加载失败](imgs/2.png)

- 重新登录实际使用的站点，刷新账号页面，在 Network 中选择成功返回账号信息的 `/api/user/status` 请求。在 `Request Headers` 下找到 `Cookie`，复制完整的值（不含 `Cookie:` 前缀），更新 `GLADOS_COOKIES`。不要复制响应头 `Set-Cookie`、单个 Cookie 值或 cURL 命令。

  > 格式示意（不是可用凭据）：`koa:sess=...; koa:sess.sig=...; gld:sess=...; gld:sess.sig=...`
  > 以浏览器实际发送的完整 Cookie 为准，不要按照旧示例删减字段。上游 [Issue #37](https://github.com/Devilstore/Glados-Railgun-checkin/issues/37) 报告了新增 `gld:sess`、`gld:sess.sig` 后需要更新 Cookie 的情况。Cookie 只保存在 GitHub Secret 中，不要贴到日志、Issue 或代码。

![图片加载失败](imgs/3.png)

- 多账号请在 `GLADOS_COOKIES` 中 添加多个 `cookies` 中间使用 `&`连接即可。（例如： `c1&c3&c3...`）

3. 配置积分兑换策略（非必须）

- 添加1个`repository secret`，命名为`GLADOS_EXCHANGE_PLAN`，配置自动兑换积分策略：

| 值 | 积分要求 | 兑换天数 |
|---|---------|---------|
| `plan100` | 100 积分 | 10 天 |
| `plan200` | 200 积分 | 30 天 |
| `plan500` | 500 积分 | 100 天 |

> 不配置时默认不进行自动兑换；如需兑换，设置 `GLADOS_EXCHANGE_PLAN` 为 `plan100` / `plan200` / `plan500`。

4. 手机推送（非必须）

- 添加1个`repository secret`，命名为`PUSHDEER_SENDKEY`，其值对应 PushDeer key: ([获取地址](https://www.pushdeer.com/product.html))。

### **star**自己的仓库

![图片加载失败](imgs/4.png)

## 文件结构

```shell
├── checkin.py                 # 签到主程序
├── logging_config.py          # 日志配置
├── test_checkin.py            # 单元测试
└── .github/
    └── workflows/
        └── gladosCheck.yml    # GitHub Actions 工作流
```

## 更新日志

- **2026-01**: 重构代码，添加log输出方便定位，支持新版网址，支持配置积分兑换策略。
- **2026-04**: 优化代码逻辑，优化日志输出，支持[新版域名](https://railgun.info) ，在 GLADOS_COOKIES 中添加新版域名下的 cookies 即可使用。
- **2026-09**: 新增设备平台自适应重试（code 4 无需手动配置 UA 即可自动恢复）；默认关闭自动兑换，需显式配置 `GLADOS_EXCHANGE_PLAN` 才启用。
- **2026-09**: 新增网络层重试/退避：`requests.Session` 挂载 `HTTPAdapter` + `urllib3.Retry`（total=3、指数退避 1/2/4s、对 429/5xx 自动重试），降低 CI 网络抖动导致的误报失败；业务 200 响应不受影响。


## 问题排查与定位
- `code: -2` / `没有权限` / `No permission` 是站点拒绝登录凭据；如果状态、签到和积分接口均如此，优先重新登录并更新完整 Cookie，核对获取 Cookie 的域名。增加 GitHub Actions 权限不能修复站点登录状态。当前脚本请求 `glados.cloud` 和 `railgun.info`；若浏览器使用其他域名，需要先核对实际 API 请求域名。
- Actions 的绿色状态现在要求每份 Cookie 至少在一个站点签到成功或重复签到；缺少 Cookie、全部站点失败或部分账号未成功时，以非零状态退出。另一站点拒绝当前 Cookie 不会覆盖已有的成功结果。
- 大家可以通过查询 actions 中的 running checkin 日志快速定位问题，有其他问题提交issue。
- 若日志出现 `code : 4, message : Automated check-in detected`：这是 GLaDOS 的**设备平台校验**（`reason=device-mismatch`，即签到请求 UA 平台与登录设备平台不一致）。脚本已内置**设备平台自适应**：首次失败时自动读取服务端返回的 `loginDevice` 并切换对应平台 UA 重试，**无需手动配置 User-Agent**；若长期仍失败，请重新登录 glados.cloud 手动签到一次并刷新 cookie。

  <img width="1684" height="844" alt="image" src="https://github.com/user-attachments/assets/45348a5f-43e4-45f5-8fdf-ce84d343b30d" />

## 声明

本项目不保证稳定运行与更新, 因GitHub相关规定可能会删库, 请注意备份







