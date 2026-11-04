import logging
import logging.config
import datetime
import re


"""北京时间（UTC+8）"""
BEIJING_TZ = datetime.timezone(datetime.timedelta(hours=8))


LEVEL_TAGS = {
    "DEBUG": "[D]",
    "INFO": "[I]",
    "WARNING": "[W]",
    "ERROR": "[E]",
    "CRITICAL": "[C]",
}

"""日志脱敏规则：抹掉 GLaDOS 会话字段与 Bearer 凭证，避免 Cookie 泄漏到 Actions 日志"""
_SECRET_PATTERNS = (
    (re.compile(r"\b((?:koa|gld):[A-Za-z0-9_.-]+=)([^;\s\"']+)"), r"\1[REDACTED]"),
    (re.compile(r"(\"cookie\"\s*:\s*\")([^\"]+)(\")", re.IGNORECASE), r"\1[REDACTED]\3"),
    (re.compile(r"(Bearer\s+)([A-Za-z0-9._~+/=-]+)", re.IGNORECASE), r"\1[REDACTED]"),
)


def redact(text):
    """对日志文本做敏感信息脱敏"""
    if not isinstance(text, str) or not text:
        return text
    for pattern, replacement in _SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


class AlignedFormatter(logging.Formatter):
    """日志级别显示为固定 3 字符短标签（[W]/[I]/[E]...）；时间用北京时间，并统一脱敏"""

    def formatTime(self, record, datefmt=None):
        """北京时间。strftime 不认 %f，这里统一走 datetime 以保证时区准确"""
        dt = datetime.datetime.fromtimestamp(record.created, tz=BEIJING_TZ)
        return dt.strftime(datefmt or "%Y-%m-%d %H:%M:%S")

    def format(self, record):
        # 复制一份再改写：直接改 record 会让后续 handler 读到已带标签的 levelname（输出变成 "[["），
        # 也会污染共享的 LogRecord。makeLogRecord 只做浅拷贝，开销可忽略。
        copy = logging.makeLogRecord(record.__dict__)
        copy.levelname = LEVEL_TAGS.get(record.levelname, f"[{record.levelname[0]}]")
        copy.msg = redact(record.msg)
        if record.args:
            if isinstance(record.args, tuple):
                copy.args = tuple(redact(arg) if isinstance(arg, str) else arg for arg in record.args)
            elif isinstance(record.args, dict):
                copy.args = {k: redact(v) if isinstance(v, str) else v for k, v in record.args.items()}
        return super().format(copy)


LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "standard": {
            "()": "logging_config.AlignedFormatter",
            "format": "%(asctime)s - %(levelname)s - %(message)s",
            "datefmt": "%Y-%m-%d %H:%M:%S",
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "standard",
            "level": "INFO",
        },
    },
    "root": {
        "handlers": ["console"],
        "level": "INFO",
    },
}


def init_logger():
    """初始化日志"""
    logging.config.dictConfig(LOGGING_CONFIG)
    return logging.getLogger()
