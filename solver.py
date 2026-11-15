"""Cloudflare Turnstile 打码平台客户端。

GLaDOS 自 2026-11-12 起要求签到请求携带 Turnstile token，纯 HTTP 请求产生不了
token。这里把「出 token」这一步外包给打码平台：平台用真实浏览器算出 token，
调用方只负责把它拼进签到请求体。

token 与 challenge 是一对一的（Turnstile 的 cData 就是 nonce），所以必须先取
challenge 再打码，不能复用旧 token。

支持的平台（通过 CAPTCHA_SOLVER_PROVIDER 选择）：

- ``jfbym``（云码，默认）：0.02 元/次，不支持指定代理
- ``capsolver``：支持传入自己的代理，需要 token 与签到同 IP 时用它

本模块不打印日志，也不吞异常：失败抛 ``SolverError``，由调用方决定如何处理。
"""

import time
from typing import Dict, Optional

import requests


class SolverError(RuntimeError):
    """打码失败：余额不足、sitekey 不支持、平台报错等。"""


class JfbymSolver:
    """云码 Turnstile 识别（type=40012）。"""

    name = "jfbym"
    SUBMIT_URL = "http://api.jfbym.com/api/YmServer/funnelApi"
    RESULT_URL = "http://api.jfbym.com/api/YmServer/funnelApiResult"

    SUBMIT_OK = 10000
    RESULT_READY = 10001
    RESULT_FATAL = frozenset({10002, 10003, 10006, 10007, 10010})

    def __init__(
        self,
        key: str,
        captcha_type: str = "40012",
        timeout: float = 25.0,
        poll_interval: float = 3.0,
        max_polls: int = 40,
    ):
        self.key = key
        self.captcha_type = captcha_type
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.max_polls = max_polls
        self.session = requests.Session()

    def solve(
        self,
        sitekey: str,
        page_url: str,
        action: str = "checkin",
        cdata: str = "",
        user_agent: str = "",
    ) -> str:
        payload = {
            "token": self.key,
            "type": self.captcha_type,
            "sitekey": sitekey,
            "pageurl": page_url,
            "action": action,
            "data": cdata,
            "userAgent": user_agent,
        }
        try:
            reply = self.session.post(self.SUBMIT_URL, json=payload, timeout=self.timeout).json()
        except (requests.RequestException, ValueError) as e:
            raise SolverError(f"提交打码任务失败：{e.__class__.__name__}") from e

        if reply.get("code") != self.SUBMIT_OK:
            raise SolverError(f"打码平台拒绝任务：{reply.get('msg')}（{reply.get('code')}）")

        data = reply.get("data") or {}
        captcha_id, record_id = data.get("captchaId"), data.get("recordId")
        if not captcha_id or not record_id:
            raise SolverError("打码平台未返回任务 ID")

        for _ in range(self.max_polls):
            time.sleep(self.poll_interval)
            try:
                poll = self.session.post(
                    self.RESULT_URL,
                    json={"token": self.key, "captchaId": captcha_id, "recordId": record_id},
                    timeout=self.timeout,
                ).json()
            except (requests.RequestException, ValueError):
                continue  # 单次轮询抖动不算失败，继续等

            code = poll.get("code")
            if code == self.RESULT_READY:
                token = _pick_token(poll.get("data"))
                if token:
                    return token
                continue
            if code in self.RESULT_FATAL:
                raise SolverError(f"打码失败：{poll.get('msg')}（{code}）")

        raise SolverError(f"打码超时（轮询 {self.max_polls} 次仍未出结果）")


class CapsolverSolver:
    """CapSolver Turnstile 识别。

    与云码的区别是支持传入代理：token 里绑定的出口 IP 与签到请求一致时，
    服务端做 remoteip 校验的站点也能通过。
    """

    name = "capsolver"
    BASE_URL = "https://api.capsolver.com"
    READY = "ready"

    def __init__(
        self,
        key: str,
        proxy: str = "",
        timeout: float = 25.0,
        poll_interval: float = 2.0,
        max_polls: int = 40,
    ):
        self.key = key
        self.proxy = proxy.strip()
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.max_polls = max_polls
        self.session = requests.Session()

    def solve(
        self,
        sitekey: str,
        page_url: str,
        action: str = "checkin",
        cdata: str = "",
        user_agent: str = "",
    ) -> str:
        task: Dict[str, str] = {
            "type": "AntiTurnstileTask" if self.proxy else "AntiTurnstileTaskProxyLess",
            "websiteURL": page_url,
            "websiteKey": sitekey,
        }
        if self.proxy:
            task["proxy"] = self.proxy
        if action or cdata:
            task["metadata"] = {"action": action, "cdata": cdata}

        try:
            reply = self.session.post(
                f"{self.BASE_URL}/createTask",
                json={"clientKey": self.key, "task": task},
                timeout=self.timeout,
            ).json()
        except (requests.RequestException, ValueError) as e:
            raise SolverError(f"提交打码任务失败：{e.__class__.__name__}") from e

        if reply.get("errorId"):
            raise SolverError(f"打码平台拒绝任务：{reply.get('errorDescription')}")

        task_id = reply.get("taskId")
        if not task_id:
            raise SolverError("打码平台未返回 taskId")

        for _ in range(self.max_polls):
            time.sleep(self.poll_interval)
            try:
                poll = self.session.post(
                    f"{self.BASE_URL}/getTaskResult",
                    json={"clientKey": self.key, "taskId": task_id},
                    timeout=self.timeout,
                ).json()
            except (requests.RequestException, ValueError):
                continue
            if poll.get("errorId"):
                raise SolverError(f"打码失败：{poll.get('errorDescription')}")
            if poll.get("status") == self.READY:
                token = (poll.get("solution") or {}).get("token")
                if token:
                    return token
                raise SolverError("打码平台返回空 token")

        raise SolverError(f"打码超时（轮询 {self.max_polls} 次仍未出结果）")


PROVIDERS = {"jfbym": JfbymSolver, "capsolver": CapsolverSolver}


def build_solver(provider: str, key: str, proxy: str = "") -> Optional[object]:
    """按配置构造打码客户端；未配置密钥时返回 None（保持原有行为）。"""
    provider = (provider or "jfbym").strip().lower()
    key = (key or "").strip()
    if not key:
        return None
    solver_class = PROVIDERS.get(provider)
    if solver_class is None:
        raise SolverError(f"不支持的打码平台：{provider}（可选 {'/'.join(PROVIDERS)}）")
    if solver_class is CapsolverSolver:
        return solver_class(key, proxy=proxy)
    return solver_class(key)


def _pick_token(data: object) -> str:
    """云码的返回体在不同版本里有 list / dict 两种形态。"""
    if isinstance(data, list):
        data = data[0] if data else None
    if isinstance(data, dict):
        for key in ("data", "token"):
            value = data.get(key)
            if isinstance(value, str) and value:
                return value
        return ""
    return data if isinstance(data, str) else ""
