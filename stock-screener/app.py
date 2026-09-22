from flask import Flask, jsonify, render_template, request

from screener import ScreenCriteria, run_screen, _S

app = Flask(__name__)


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/test")
def api_test():
    results = {}
    tests = [
        ("网易财经", "http://quotes.money.163.com/hs/service/diyrank.do",
         {"query": "STYPE%3AEQA", "fields": "SYMBOL,NAME", "count": "3", "page": "0", "type": "query"}),
        ("新浪财经", "http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData",
         {"num": "3", "node": "hs_a", "page": "1"}),
    ]
    for name, url, params in tests:
        try:
            r = _S.get(url, params=params, timeout=8)
            results[name] = f"✅ 成功 (HTTP {r.status_code}, {len(r.text)} 字节)"
        except Exception as e:
            results[name] = f"❌ 失败: {e}"
    return jsonify(results)


@app.post("/api/screen")
def api_screen():
    body = request.get_json(force=True, silent=True) or {}

    report_period = body.get("report_period", "2023-12-31")
    fund_period = body.get("fund_period", "2023-12-31")
    max_deep_check = int(body.get("max_deep_check", 100))
    use_ths = str(body.get("use_ths", True)).lower() != "false"
    use_ttjj = str(body.get("use_ttjj", True)).lower() != "false"
    industry_keywords = body.get("industry_keywords") or []

    criteria = ScreenCriteria(
        max_market_cap_yi=float(body.get("max_market_cap_yi", 200)),
        min_market_cap_yi=float(body.get("min_market_cap_yi", 5)),
        max_pe=float(body.get("max_pe", 40)),
        min_revenue_growth=float(body.get("min_revenue_growth", 20)),
        min_profit_growth=float(body.get("min_profit_growth", 20)),
        min_roe=float(body.get("min_roe", 15)),
        max_debt_ratio=float(body.get("max_debt_ratio", 60)),
    )

    try:
        result = run_screen(
            report_period, fund_period, criteria, max_deep_check,
            use_ths=use_ths, use_ttjj=use_ttjj,
            industry_keywords=industry_keywords,
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502

    return jsonify({
        "stage_counts": result.stage_counts,
        "rows": result.table.to_dict(orient="records"),
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
