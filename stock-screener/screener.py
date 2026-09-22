"""
选股逻辑：基于《1到100倍》(Christopher Mayer《100 Baggers》) 核心理念。

数据来源：
  - 网易财经 diyrank API：行情 + PE + 市值 + ROE + 负债率（一个接口全搞定）
  - 网易财经 financial API：营收/净利润同比增速
  - akshare：天天基金重仓数据（可选）
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field

# 强制所有 HTTP 请求直连，绕过 macOS 系统代理（Clash/VPN）
# NO_PROXY=* 对 requests 和 akshare 内部 session 均生效
for _k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(_k, None)
os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"

import pandas as pd
import requests

_S = requests.Session()
_S.trust_env = False  # 不读取系统代理/env vars
_S.headers.update({
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    "Accept": "application/json, text/plain, */*",
    "Referer": "http://quotes.money.163.com/",
})

_163_BASE = "http://quotes.money.163.com/hs/service/diyrank.do"


def _get163(params: dict) -> dict:
    for attempt in range(3):
        try:
            r = _S.get(_163_BASE, params=params, timeout=15)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def _to_float(s) -> pd.Series:
    return pd.to_numeric(s, errors="coerce")


@dataclass
class ScreenCriteria:
    max_market_cap_yi: float = 200.0
    min_market_cap_yi: float = 5.0
    max_pe: float = 40.0
    min_revenue_growth: float = 20.0
    min_profit_growth: float = 20.0
    min_roe: float = 15.0
    max_debt_ratio: float = 60.0


@dataclass
class ScreenResult:
    table: pd.DataFrame
    stage_counts: dict = field(default_factory=dict)


_163_FIELDS = "SYMBOL,NAME,PRICE,PE,PBR,MKTCAP"


def _fetch_163_page(page: int, count: int = 50) -> list[dict]:
    params = {
        "page": page,
        "query": "STYPE:EQA",
        "fields": _163_FIELDS,
        "count": count,
        "type": "query",
    }
    data = _get163(params)
    return data.get("list", [])


def _stage1_akshare() -> pd.DataFrame:
    """akshare 东方财富接口获取全量A股行情，网易财经失败时备用"""
    import akshare as ak
    df = ak.stock_zh_a_spot_em()
    col_map = {}
    for c in df.columns:
        cl = c.strip()
        if cl in ("代码", "股票代码"):
            col_map[c] = "code"
        elif cl == "名称":
            col_map[c] = "name"
        elif cl == "最新价":
            col_map[c] = "price"
        elif "市盈率" in cl:
            col_map[c] = "pe"
        elif "市净率" in cl:
            col_map[c] = "pb"
        elif "总市值" in cl:
            col_map[c] = "mktcap_raw"
    df = df.rename(columns=col_map)
    if "code" not in df.columns:
        df["code"] = df.iloc[:, 0].astype(str)
    df["code"] = df["code"].astype(str).str.zfill(6)
    if "mktcap_raw" in df.columns:
        df["market_cap_yi"] = _to_float(df["mktcap_raw"]) / 1e8
    else:
        df["market_cap_yi"] = None
    df["pe"] = _to_float(df.get("pe"))
    df["pb"] = _to_float(df.get("pb"))
    df["price"] = _to_float(df.get("price"))
    df["industry"] = ""
    return df[["code", "name", "price", "pe", "pb", "market_cap_yi", "industry"]].copy()


def stage1_all_stocks() -> pd.DataFrame:
    """
    网易财经 diyrank 接口，一次拉取全部 A 股；失败时自动回退到 akshare 东方财富。
    """
    records = []
    page = 0
    _163_ok = True
    try:
        while True:
            items = _fetch_163_page(page)
            if not items:
                break
            records.extend(items)
            if len(items) < 100:
                break
            page += 1
            time.sleep(0.15)
    except Exception:
        _163_ok = False

    if not _163_ok or not records:
        try:
            return _stage1_akshare()
        except Exception as e:
            raise RuntimeError(
                f"网易财经和东方财富均无数据，请检查网络设置。东方财富错误：{e}"
            )

    rows = []
    for item in records:
        sym = str(item.get("SYMBOL", ""))
        code = sym[-6:].zfill(6)
        mktcap = item.get("MKTCAP")
        try:
            mktcap_yi = float(mktcap) / 10000 if mktcap else None
        except Exception:
            mktcap_yi = None
        rows.append({
            "code": code,
            "name": item.get("NAME", ""),
            "price": item.get("PRICE"),
            "pe": item.get("PE"),
            "pb": item.get("PBR"),
            "market_cap_yi": mktcap_yi,
            "industry": "",
        })

    df = pd.DataFrame(rows)
    for col in ["pe", "pb", "price", "market_cap_yi"]:
        df[col] = _to_float(df[col])
    return df


def stage2_growth(period: str) -> pd.DataFrame:
    date_str = period.replace("-", "")
    try:
        import akshare as ak
        df = ak.stock_yjbb_em(date=date_str)
    except Exception:
        return pd.DataFrame(columns=["code", "revenue_growth", "profit_growth"])

    col_map = {}
    for c in df.columns:
        cl = c.strip()
        if cl in ("股票代码", "代码"):
            col_map[c] = "code"
        elif "营业总收入" in cl and "同比" in cl:
            col_map[c] = "revenue_growth"
        elif "净利润" in cl and "同比" in cl:
            col_map[c] = "profit_growth"
    df = df.rename(columns=col_map)
    if "code" not in df.columns:
        df["code"] = df.iloc[:, 0].astype(str)
    df["code"] = df["code"].astype(str).str.zfill(6)
    df["revenue_growth"] = _to_float(df.get("revenue_growth"))
    df["profit_growth"] = _to_float(df.get("profit_growth"))
    return df[["code", "revenue_growth", "profit_growth"]].drop_duplicates("code")


def stage_fund_hold(period: str) -> pd.DataFrame:
    try:
        import akshare as ak
        df = ak.stock_report_fund_hold(symbol="重仓股", date=period.replace("-", ""))
        col_map = {}
        for c in df.columns:
            if "股票代码" in c:
                col_map[c] = "code"
            elif "基金家数" in c or "持有基金" in c:
                col_map[c] = "fund_hold_count"
            elif "占总股本" in c or "持股比例" in c:
                col_map[c] = "fund_hold_ratio"
        df = df.rename(columns=col_map)
        if "code" not in df.columns:
            df["code"] = df.iloc[:, 0].astype(str)
        df["code"] = df["code"].astype(str).str.zfill(6)
        df["fund_hold_count"] = _to_float(df.get("fund_hold_count"))
        df["fund_hold_ratio"] = _to_float(df.get("fund_hold_ratio"))
        return df[["code", "fund_hold_count", "fund_hold_ratio"]].drop_duplicates("code")
    except Exception:
        return pd.DataFrame(columns=["code", "fund_hold_count", "fund_hold_ratio"])


def stage3_fina_ak(candidates: pd.DataFrame, period: str) -> pd.DataFrame:
    date_str = period.replace("-", "")
    try:
        import akshare as ak
        df = ak.stock_yjbb_em(date=date_str)
    except Exception:
        return pd.DataFrame(columns=["code", "roe", "debt_ratio"])

    col_map = {}
    for c in df.columns:
        cl = c.strip()
        if cl in ("股票代码", "代码"):
            col_map[c] = "code"
        elif "净资产收益率" in cl or cl == "ROE":
            col_map[c] = "roe"
        elif "资产负债率" in cl:
            col_map[c] = "debt_ratio"
    df = df.rename(columns=col_map)
    if "code" not in df.columns:
        df["code"] = df.iloc[:, 0].astype(str)
    df["code"] = df["code"].astype(str).str.zfill(6)

    result_cols = ["code"]
    if "roe" in df.columns:
        df["roe"] = _to_float(df["roe"])
        result_cols.append("roe")
    if "debt_ratio" in df.columns:
        df["debt_ratio"] = _to_float(df["debt_ratio"])
        result_cols.append("debt_ratio")

    codes = set(candidates["code"].astype(str))
    df = df[df["code"].isin(codes)]
    return df[result_cols].drop_duplicates("code") if len(result_cols) > 1 else pd.DataFrame(columns=["code", "roe", "debt_ratio"])


def composite_score(row: pd.Series) -> float:
    s = 0.0
    s += min(row.get("roe") or 0, 50) * 1.0
    s += min(row.get("revenue_growth") or 0, 100) * 0.5
    s += min(row.get("profit_growth") or 0, 100) * 0.5
    s += max(0.0, 60 - (row.get("debt_ratio") or 60)) * 0.5
    s += min(row.get("fund_hold_count") or 0, 50) * 0.3
    s += max(0.0, 200 - (row.get("market_cap_yi") or 200)) * 0.1
    s += max(0.0, 40 - (row.get("pe") or 40)) * 0.2
    return round(s, 2)


def run_screen(
    report_period: str,
    fund_period: str,
    criteria: ScreenCriteria | None = None,
    max_deep_check: int = 100,
    use_ths: bool = True,
    use_ttjj: bool = True,
    industry_keywords: list[str] | None = None,
) -> ScreenResult:
    criteria = criteria or ScreenCriteria()
    counts: dict[str, int] = {}

    df = stage1_all_stocks()

    s1 = df[
        (df["market_cap_yi"] >= criteria.min_market_cap_yi)
        & (df["market_cap_yi"] <= criteria.max_market_cap_yi)
        & (df["pe"] > 0) & (df["pe"] <= criteria.max_pe)
    ].copy()

    if industry_keywords:
        pattern = "|".join(industry_keywords)
        mask = s1["industry"].str.contains(pattern, na=False, case=False)
        s1 = s1[mask]
        counts["1a_行业筛选"] = len(s1)

    counts["1_市值PE初筛"] = len(s1)
    if s1.empty:
        return ScreenResult(table=pd.DataFrame(), stage_counts=counts)

    growth = stage2_growth(report_period)
    if not growth.empty:
        s1 = s1.merge(growth, on="code", how="left")
        s2 = s1[
            (s1["revenue_growth"] >= criteria.min_revenue_growth)
            & (s1["profit_growth"] >= criteria.min_profit_growth)
        ].copy()
    else:
        s2 = s1.copy()
        s2["revenue_growth"] = None
        s2["profit_growth"] = None
    counts["2_营收净利增速筛"] = len(s2)
    if s2.empty:
        return ScreenResult(table=pd.DataFrame(), stage_counts=counts)

    if use_ths:
        fina = stage3_fina_ak(s2, report_period)
        if not fina.empty:
            s2 = s2.merge(fina, on="code", how="left")
            s3 = s2[
                (s2["roe"] >= criteria.min_roe)
                & (s2["debt_ratio"] <= criteria.max_debt_ratio)
            ].copy()
        else:
            s3 = s2.copy()
            s3["roe"] = None
            s3["debt_ratio"] = None
        counts["3_ROE负债率筛"] = len(s3)
        if s3.empty:
            return ScreenResult(table=pd.DataFrame(), stage_counts=counts)
    else:
        s3 = s2.copy()
        s3["roe"] = None
        s3["debt_ratio"] = None
        counts["3_ROE负债率筛(已跳过)"] = len(s3)

    if use_ttjj:
        fund = stage_fund_hold(fund_period)
        final = s3.merge(fund, on="code", how="left")
    else:
        final = s3.copy()

    final["fund_hold_count"] = final.get("fund_hold_count", pd.Series(0, index=final.index)).fillna(0)
    final["fund_hold_ratio"] = final.get("fund_hold_ratio", pd.Series(0, index=final.index)).fillna(0)

    final["score"] = final.apply(composite_score, axis=1)
    final = final.sort_values("score", ascending=False).head(max_deep_check).reset_index(drop=True)
    counts["4_最终结果"] = len(final)

    cols = ["code", "name", "price", "market_cap_yi", "pe", "pb",
            "revenue_growth", "profit_growth", "roe", "debt_ratio",
            "fund_hold_count", "fund_hold_ratio", "score", "industry"]
    return ScreenResult(table=final[[c for c in cols if c in final.columns]], stage_counts=counts)
