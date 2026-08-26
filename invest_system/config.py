"""采集配置：自选股代码与抓取间隔"""

import os

# A股代码，如 "600519"（贵州茅台）、"000001"（平安银行）
WATCHLIST = [
    "600519",
    "000001",
    "300750",
]

# 采集间隔（秒）
FETCH_INTERVAL_SECONDS = 60

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(_BASE_DIR, "data", "market_data.db")
