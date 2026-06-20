import datetime as dt
import logging

import akshare as ak

from config import WATCHLIST
from db import insert_quotes

logger = logging.getLogger(__name__)

COLUMN_MAP = {
    "代码": "code",
    "名称": "name",
    "最新价": "price",
    "涨跌幅": "change_pct",
    "成交量": "volume",
    "成交额": "amount",
    "最高": "high",
    "最低": "low",
    "今开": "open",
    "昨收": "prev_close",
}


def fetch_quotes():
    """抓取全市场A股实时行情，过滤出自选股"""
    df = ak.stock_zh_a_spot_em()
    df = df[df["代码"].isin(WATCHLIST)]
    df = df.rename(columns=COLUMN_MAP)

    now = dt.datetime.now().isoformat(timespec="seconds")
    rows = [
        (
            row["code"],
            row["name"],
            row["price"],
            row["change_pct"],
            row["volume"],
            row["amount"],
            row["high"],
            row["low"],
            row["open"],
            row["prev_close"],
            now,
        )
        for _, row in df.iterrows()
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
