#!/usr/bin/env python3
"""指数/个股买卖点监控 —— 命令行版。零依赖，只用标准库。

用法：
    python3 check_indices.py                  # 查一遍所有指数和个股
    python3 check_indices.py --find 关键词      # 按名字搜 secid
    python3 check_indices.py --raw <secid>     # 打印候选字段，核对 PE/PB/股息率
"""

import json
import sys
import http.cookiejar
import urllib.request
import urllib.parse

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://quote.eastmoney.com/",
    "Origin": "https://quote.eastmoney.com",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

# 用一个带 cookie jar 的 opener，先访问一次东方财富主站"预热"出会话 cookie，
# 再拿这个会话去打数据接口 —— 部分反爬系统只放行"先逛过主站"的请求。
_cookie_jar = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cookie_jar))
_session_primed = False


def _prime_session():
    global _session_primed
    if _session_primed:
        return
    try:
        req = urllib.request.Request("https://quote.eastmoney.com/", headers=HEADERS)
        _opener.open(req, timeout=8).read()
    except Exception:
        pass
    _session_primed = True

# secid 格式: {marketCode}.{code}
#   1.xxxxxx = 上海A股   0.xxxxxx = 深圳A股/创业板   100.XXX = 美股指数
#   105.XXX  = 纳斯达克(未验证)   106.XXX = 纽交所(未验证)   116.xxxxx = 港股(未验证)
#
# ⚠️ 恒生科技指数(124.HSTECH)、黄金comex(101.GC00Y)、中国移动(改用港股116.00941)
# 已经用 --find 和实测数据核实修好。其余港股/美股的 secid 还是重新猜的，第一次
# 跑重点看这些标的现价是否合理，不对就用 --find 重新查。

INDICES = [
    {"name": "标普指数",     "secid": "100.SPX",    "buy_price": (4500, 4700), "sell_price": ">=7500"},
    {"name": "恒生科技指数", "secid": "124.HSTECH", "buy_price": "<=4800",     "sell_price": ">=5800"},
    {"name": "纳斯达克指数", "secid": "100.NDX",    "buy_price": None,         "sell_price": ">=25746"},
    {"name": "恒生指数",     "secid": "100.HSI",    "buy_price": "<=20000",    "sell_price": (27000, 28000)},
    {"name": "创业板指",     "secid": "0.399006",   "buy_price": None,         "sell_price": (4000, 4050)},
    {"name": "上证指数",     "secid": "1.000001",   "buy_price": (3100, 3500), "sell_price": ">=4100"},
    {"name": "黄金comex",    "secid": "101.GC00Y",  "buy_price": "<=3800",     "sell_price": ">=9077"},
]

GROUPS = ["价格判断", "价格+PE判断", "价格+股息率判断", "PE判断", "PB判断"]

STOCKS = [
    # 价格判断
    {"name": "格力电器", "secid": "0.000651",  "group": "价格判断", "buy_price": "<=36",     "sell_price": ">=48"},
    {"name": "中国平安", "secid": "1.601318",  "group": "价格判断", "buy_price": "<=47",     "sell_price": ">=55"},
    {"name": "贵州茅台", "secid": "1.600519",  "group": "价格判断", "buy_price": "<=1200",   "sell_price": ">=1380"},
    {"name": "万科A",    "secid": "0.000002",  "group": "价格判断", "buy_price": None,       "sell_price": None, "note": "原表格未给买卖点，仅展示现价"},
    {"name": "拼多多",   "secid": "105.PDD",   "group": "价格判断", "buy_price": "<=98.5",   "sell_price": None, "note": "美股secid未验证"},
    {"name": "腾讯",     "secid": "116.00700", "group": "价格判断", "buy_price": "<=420",    "sell_price": None, "note": "港股secid未验证"},
    {"name": "新奥能源", "secid": "116.02688", "group": "价格判断", "buy_price": "<=67.15",  "sell_price": None, "note": "港股secid未验证"},
    {"name": "美团",     "secid": "116.03690", "group": "价格判断", "buy_price": "<=80",     "sell_price": None, "note": "港股secid未验证"},
    {"name": "中国移动", "secid": "116.00941", "group": "价格判断", "buy_price": "<=74.55",  "sell_price": None, "note": "港股secid未验证"},
    {"name": "微软",     "secid": "105.MSFT",  "group": "价格判断", "buy_price": "<=370",    "sell_price": None, "note": "美股secid未验证"},
    {"name": "meta",     "secid": "105.META",  "group": "价格判断", "buy_price": "<=512.52", "sell_price": None, "note": "美股secid未验证"},
    {"name": "苹果",     "secid": "105.AAPL",  "group": "价格判断", "buy_price": "<=182.12", "sell_price": None, "note": "美股secid未验证"},
    {"name": "google",   "secid": "105.GOOGL", "group": "价格判断", "buy_price": "<=143.47", "sell_price": None, "note": "美股secid未验证"},
    {"name": "nvidia",   "secid": "105.NVDA",  "group": "价格判断", "buy_price": "<=90",     "sell_price": None, "note": "美股secid未验证"},
    {"name": "tsm台积电","secid": "106.TSM",   "group": "价格判断", "buy_price": "<=134.12", "sell_price": None, "note": "美股secid未验证"},
    {"name": "阿里巴巴", "secid": "106.BABA",  "group": "价格判断", "buy_price": "<=100",    "sell_price": None, "note": "美股secid未验证"},
    {"name": "泡泡玛特", "secid": "116.09992", "group": "价格判断", "buy_price": "<=140",    "sell_price": None, "note": "港股secid未验证"},

    # 价格+PE判断
    {"name": "恒瑞医药", "secid": "1.600276", "group": "价格+PE判断", "buy_price": "<=52",    "buy_pe": 25},
    {"name": "甘李药业", "secid": "1.603087", "group": "价格+PE判断", "buy_price": (40, 50),  "buy_pe": 20},
    {"name": "汇川技术", "secid": "0.300124", "group": "价格+PE判断", "buy_price": "<=40",    "buy_pe": 20},
    {"name": "豪威集团", "secid": "1.603501", "group": "价格+PE判断", "buy_price": "<=70",    "buy_pe": 25},
    {"name": "安克创新", "secid": "0.300866", "group": "价格+PE判断", "buy_price": (80, 90),  "buy_pe": 15},
    {"name": "片仔癀",   "secid": "1.600436", "group": "价格+PE判断", "buy_price": "<=65.13", "buy_pe": 20},

    # 价格+股息率判断（新增）
    {"name": "中国神华",             "secid": "1.601088",  "group": "价格+股息率判断", "buy_price": "<=36",  "buy_dividend": 6,   "note": "股价或股息率任一触发即为买点"},
    {"name": "中国石油",             "secid": "1.601857",  "group": "价格+股息率判断", "buy_price": "<=8.6", "buy_dividend": 6,   "note": "股价或股息率任一触发即为买点"},
    {"name": "中国海洋石油(HK0883)", "secid": "116.00883", "group": "价格+股息率判断", "buy_price": "<=20",  "buy_dividend": 7.5, "note": "港股secid未验证；股价或股息率任一触发即为买点"},

    # PE判断
    {"name": "长江电力", "secid": "1.600900", "group": "PE判断", "buy_pe": 15},
    {"name": "安集科技", "secid": "1.688019", "group": "PE判断", "buy_pe": 25},

    # PB判断
    {"name": "中信银行", "secid": "1.601998", "group": "PB判断", "buy_pb": 0.5},
    {"name": "兴业银行", "secid": "1.601166", "group": "PB判断", "buy_pb": 0.5},
]

PE_CANDIDATES = {"f9": "市盈率(动态)", "f114": "PE候选", "f115": "市盈率TTM(已确认)", "f162": "PE候选", "f163": "PE候选", "f164": "PE候选", "f167": "PE候选"}
DIV_CANDIDATES = {"f133": "股息率候选(已确认，不需缩放)", "f127": "股息率候选", "f128": "股息率候选", "f105": "股息率候选"}


def _get(url):
    _prime_session()
    req = urllib.request.Request(url, headers=HEADERS)
    with _opener.open(req, timeout=8) as resp:
        return json.loads(resp.read().decode("utf-8"))


# qt/stock/get（单只行情接口）目前会被东方财富直接拒绝连接（Empty reply from
# server，curl 和 Python 都实测过，跟请求头/TLS指纹无关），已确认改用
# qt/ulist.np/get（批量/自选股接口）代替，指数和个股统一走这一个接口一次性拿。
# 价格字段f2的缩放倍数因市场而异：A股/上证系（secid前缀0、1）放大100倍，
# 港股(116)、美股(105/106)实测放大1000倍（腾讯4388->438.8、美团803->80.3
# 都对得上买点量级）；COMEX期货(101)实测只放大10倍（黄金43759->4375.9才
# 对得上3800/9077这组买卖点）；PE f115、PB f23 统一放大100倍；股息率f133
# 已经是正常百分比数字，不需要再除。其余指数(100.xxx)暂时按100倍处理，还
# 没有实测数据核实。
def _price_scale_for(secid):
    prefix = secid.split(".")[0]
    if prefix in ("105", "106", "116"):
        return 1000
    if prefix == "101":  # COMEX期货，实测只需要除以10（黄金43759 -> 4375.9才对得上买卖点）
        return 10
    return 100


def fetch_quote_map(secids):
    joined = ",".join(secids)
    url = f"https://push2.eastmoney.com/api/qt/ulist.np/get?secids={joined}&fields=f2,f12,f23,f115,f133"
    data = _get(url)
    scale_by_code = {secid.split(".")[1]: _price_scale_for(secid) for secid in secids}
    result = {}
    diff = (data or {}).get("data", {}).get("diff") or []
    for item in diff:
        code = item.get("f12")
        price = item.get("f2")
        pe = item.get("f115")
        pb = item.get("f23")
        div = item.get("f133")
        price_scale = scale_by_code.get(code, 100)
        result[code] = {
            "price": price / price_scale if price not in (None, "-") else None,
            "pe": pe / 100 if pe not in (None, "-") else None,
            "pb": pb / 100 if pb not in (None, "-") else None,
            "dividend": div if div not in (None, "-") else None,
        }
    return result


def _search_once(keyword):
    url = "https://searchapi.eastmoney.com/api/suggest/get?" + urllib.parse.urlencode({
        "input": keyword, "type": "14", "token": "D43BF722C8E33BDC906FB84D85E326E8",
    })
    data = _get(url)
    return (data or {}).get("QuotationCodeTable", {}).get("Data") or []


def find_secid(keyword):
    # 有些名字（比如带"指数"两个字的）在东方财富的搜索库里匹配不到，只能搜到
    # 跟踪该指数的ETF；这里自动多试几个变体关键词，一次性把结果都列出来。
    variants = [keyword]
    for suffix in ("指数", "ETF", "指数ETF"):
        if keyword.endswith(suffix) and keyword != suffix:
            variants.append(keyword[: -len(suffix)])
    seen_codes = set()
    found_any = False
    for kw in dict.fromkeys(variants):  # 去重但保持顺序
        items = _search_once(kw)
        if not items:
            continue
        print(f"关键词 '{kw}' 的搜索结果：")
        for it in items[:10]:
            code = it.get("QuoteID")
            if code in seen_codes:
                continue
            seen_codes.add(code)
            print(f"  {it.get('Code')}  市场={it.get('MarketType')}  secid={code}  {it.get('Name')}")
            found_any = True
    if not found_any:
        print(f"没找到 '{keyword}' 相关结果（也试过去掉\"指数\"/\"ETF\"后缀），可能需要换个关键词，比如英文缩写")


def debug_raw_fields(secid):
    # qt/stock/get 已失效，改用批量接口查单个 secid 的候选字段原始值
    all_fields = ",".join(set(list(PE_CANDIDATES) + list(DIV_CANDIDATES) + ["f2", "f12", "f23"]))
    url = f"https://push2.eastmoney.com/api/qt/ulist.np/get?secids={secid}&fields={all_fields}"
    data = _get(url)
    diff = (data or {}).get("data", {}).get("diff") or []
    if not diff:
        print(f"secid={secid} 没有返回数据")
        return
    d = diff[0]
    print(f"secid={secid} 原始字段（未做任何缩放，PE/PB/价格字段通常要再除以100）：")
    for k, v in d.items():
        label = PE_CANDIDATES.get(k) or DIV_CANDIDATES.get(k) or ""
        print(f"  {k} = {v}  {label}")


def _check_hit(price, buy, sell):
    def one(target):
        if target is None:
            return False
        if isinstance(target, tuple):
            return target[0] <= price <= target[1]
        if isinstance(target, str):
            if target.startswith("<="):
                return price <= float(target[2:])
            if target.startswith(">="):
                return price >= float(target[2:])
        return False
    if one(buy):
        return "买点"
    if one(sell):
        return "卖点"
    return None


def _fmt(target):
    if target is None:
        return "-"
    if isinstance(target, tuple):
        return f"{target[0]}-{target[1]}"
    return str(target)


def main():
    hits = []
    all_secids = [idx["secid"] for idx in INDICES] + [s["secid"] for s in STOCKS]
    try:
        quote_map = fetch_quote_map(all_secids)
        fetch_error = None
    except Exception as e:
        quote_map = {}
        fetch_error = e

    print("=== 指数买卖点监控 ===")
    for idx in INDICES:
        code = idx["secid"].split(".")[1]
        q = quote_map.get(code, {})
        if fetch_error:
            print(f"{idx['name']:10s} 抓取失败：{fetch_error}")
        elif q.get("price") is not None:
            price = q["price"]
            hit = _check_hit(price, idx.get("buy_price"), idx.get("sell_price"))
            status = hit if hit else "正常"
            print(f"{idx['name']:10s} 现价={price:<10} 买点={_fmt(idx.get('buy_price')):<14} 卖点={_fmt(idx.get('sell_price')):<10} 状态={status}")
            if hit:
                hits.append(f"{idx['name']} 触发{hit}（现价{price}）")
        else:
            print(f"{idx['name']:10s} 抓取失败：批量接口没有返回这个secid的数据")
        note = idx.get("note")
        if note:
            print(f"  ⚠️ {note}")

    print("\n=== 个股买卖点监控 ===")
    for group in GROUPS:
        group_stocks = [s for s in STOCKS if s["group"] == group]
        if not group_stocks:
            continue
        print(f"\n-- {group} --")
        for s in group_stocks:
            code = s["secid"].split(".")[1]
            val = quote_map.get(code, {})
            if fetch_error:
                print(f"{s['name']:10s} 抓取失败：{fetch_error}")
            elif val.get("price") is not None:
                price = val["price"]
                hit = _check_hit(price, s.get("buy_price"), s.get("sell_price"))
                if not hit and "buy_pe" in s and val.get("pe") is not None and val["pe"] <= s["buy_pe"]:
                    hit = "买点(PE)"
                if not hit and "buy_pb" in s and val.get("pb") is not None and val["pb"] <= s["buy_pb"]:
                    hit = "买点(PB)"
                if not hit and "buy_dividend" in s and val.get("dividend") is not None and val["dividend"] >= s["buy_dividend"]:
                    hit = "买点(股息率)"
                status = hit if hit else "正常"
                # PE/PB/股息率对每支股票都展示实时数据，不管它的买卖点判断标准用不用这个指标
                pe_str = f"PE={val.get('pe')}" if val.get("pe") is not None else ""
                pb_str = f"PB={val.get('pb')}" if val.get("pb") is not None else ""
                div_str = f"股息率={val.get('dividend')}%" if val.get("dividend") is not None else ""
                extras = " ".join(x for x in (pe_str, pb_str, div_str) if x)
                print(f"{s['name']:10s} 现价={price:<10} 买点={_fmt(s.get('buy_price')):<14} 卖点={_fmt(s.get('sell_price')):<10} {extras} 状态={status}")
                if hit:
                    hits.append(f"{s['name']} 触发{hit}（现价{price}）")
            else:
                print(f"{s['name']:10s} 抓取失败：批量接口没有返回这个secid的数据")
            note = s.get("note")
            if note:
                print(f"  ⚠️ {note}")

    print("\n=== 触发提醒 ===")
    if hits:
        for h in hits:
            print(f"  🔔 {h}")
    else:
        print("  暂无标的触发买卖点")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--find" and len(args) > 1:
        find_secid(args[1])
    elif args and args[0] == "--raw" and len(args) > 1:
        debug_raw_fields(args[1])
    else:
        main()
