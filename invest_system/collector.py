import datetime as dt
import json
import logging
import subprocess

from config import WATCHLIST
from db import insert_quotes

logger = logging.getLogger(__name__)

_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

_EASTMONEY_URL = "https://push2.eastmoney.com/api/qt/ulist.np/get"
_FIELDS = "f12,f14,f2,f3,f5,f6,f15,f16,f17,f18"


def _to_secid(code: str) -> str:
    """A股代码转为东方财富 secid：沪市(6开头)用 1.，深市/北交所用 0."""
    market = "1" if code.startswith("6") else "0"
    return f"{market}.{code}"


def fetch_quotes():
    """通过 curl 抓取自选股实时行情（东方财富 ulist 接口）"""
    if not WATCHLIST:
        return []

    secids = ",".join(_to_secid(code) for code in WATCHLIST)
    params = f"fltt=2&fields={_FIELDS}&secids={secids}"
    result = subprocess.run(
        [
            "curl",
            "-s",
            "--max-time",
            "10",
            "-A",
            _BROWSER_USER_AGENT,
            f"{_EASTMONEY_URL}?{params}",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    stocks = (payload.get("data") or {}).get("diff") or []

    now = dt.datetime.now().isoformat(timespec="seconds")
    rows = [
        (
            item["f12"],
            item["f14"],
            item["f2"],
            item["f3"],
            item["f5"],
            item["f6"],
            item["f15"],
            item["f16"],
            item["f17"],
            item["f18"],
            now,
        )
        for item in stocks
    ]
    return rows


def collect_once():
    rows = fetch_quotes()
    if not rows:
        logger.warning("未抓取到任何行情数据，请检查 WATCHLIST 代码是否正确")
        return 0
    insert_quotes(rows)
    logger.info("已采集 %d 条行情记录", len(rows))
    return len(rows)
