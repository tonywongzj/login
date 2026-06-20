"""采集配置：自选股代码与抓取间隔"""

# A股代码，akshare 格式如 "600519"（贵州茅台）、"000001"（平安银行）
WATCHLIST = [
    "600519",
    "000001",
    "300750",
]

# 采集间隔（秒）
FETCH_INTERVAL_SECONDS = 60

DB_PATH = "invest_system/data/market_data.db"
