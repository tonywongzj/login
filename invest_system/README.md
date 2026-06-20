# 投资数据采集系统

使用 [AKShare](https://akshare.akfamily.xyz/)（免费开源金融数据接口，覆盖 A 股实时行情）采集自选股数据，存入本地 SQLite 数据库。

说明：同花顺没有面向个人开发者的公开实时数据 API，因此用 AKShare 替代，数据同样来自交易所/东方财富等公开行情源，合规且无需申请密钥。

## 安装

```bash
cd invest_system
pip install -r requirements.txt
```

## 配置

编辑 `config.py`：
- `WATCHLIST`：自选股代码列表（如 `"600519"`）
- `FETCH_INTERVAL_SECONDS`：采集间隔（秒）

## 运行

只采集一次：
```bash
python main.py --once
```

持续采集（按间隔循环）：
```bash
python main.py
```

数据存储在 `data/market_data.db`（SQLite），表 `quotes` 包含价格、涨跌幅、成交量等字段，可用任意 SQLite 客户端或 pandas 查询分析。

## 后续可扩展

- 加入均线/MACD 等指标计算模块
- 加定时任务（cron / APScheduler）
- 暴露 HTTP API 供前端看板查询
