"""Streamlit result blocks copied as-is (pandas loops), used as the parity reference.

Source: 1_Multi_Backtest.py, "Historical Shares and Position Values",
"Realized and Unrealized Gains/Losses", "Annual Gains/Losses Summary",
"Rebalance as of Today", "REBALANCING TIMER", "Historical Rebalancing
Comparison" / "Historical Allocation Tables". Only st.* display calls and
session-state lookups were replaced by arguments and return values.
"""

from __future__ import annotations

import pandas as pd

from backtest_engine.legacy import multi_backtest as L


def get_cached_rebalancing_dates(freq, sim_index):
    return L.get_dates_by_freq(freq, sim_index[0], sim_index[-1], sim_index)


def shares_and_gains(cfg, portfolio_results, allocation_data, raw_data):
    portfolio_values = portfolio_results["with_additions"]

    def get_price_on_date(df, target_date):
        try:
            available_dates = df.index[df.index <= target_date]
            if len(available_dates) > 0:
                return float(df.loc[available_dates[-1], "Close"])
            return None
        except Exception:
            return None

    shares_data, values_data = {}, {}
    all_tickers_set = set()
    for date, alloc_dict in allocation_data.items():
        all_tickers_set.update(alloc_dict.keys())
    all_tickers_set.discard(None)
    all_tickers_list = sorted(list(all_tickers_set))
    if "CASH" in all_tickers_list:
        all_tickers_list.remove("CASH")
        all_tickers_list.append("CASH")

    rebalancing_dates = []
    frequency_mapping = {
        "monthly": "Monthly", "weekly": "Weekly", "bi-weekly": "Biweekly", "biweekly": "Biweekly",
        "quarterly": "Quarterly", "semi-annually": "Semiannually", "semiannually": "Semiannually",
        "annually": "Annually", "yearly": "Annually", "never": "Never", "none": "Never",
        "buy & hold": "Buy & Hold", "buy & hold (target)": "Buy & Hold (Target)",
    }
    rebalancing_frequency = cfg.get("rebalancing_frequency", "none")
    rb_freq_display = frequency_mapping.get(str(rebalancing_frequency).lower(), rebalancing_frequency)
    try:
        sim_index = portfolio_results["no_additions"].index
        portfolio_rebalancing_dates = get_cached_rebalancing_dates(rb_freq_display, sim_index)
        if portfolio_rebalancing_dates:
            rebalancing_dates = sorted([d for d in portfolio_rebalancing_dates if d in allocation_data])
    except Exception:
        rebalancing_dates = []
    if not rebalancing_dates:
        if rb_freq_display not in ["Never", "Buy & Hold", "Buy & Hold (Target)"]:
            rebalancing_dates = sorted(allocation_data.keys())
    if not rebalancing_dates:
        return None

    for date in rebalancing_dates:
        alloc_dict = allocation_data[date]
        if date in portfolio_values.index:
            portfolio_value = float(portfolio_values.loc[date])
        else:
            available_dates = portfolio_values.index[portfolio_values.index <= date]
            portfolio_value = float(portfolio_values.loc[available_dates[-1]]) if len(available_dates) > 0 else 0.0
        shares_row, values_row = {}, {}
        for ticker in all_tickers_list:
            alloc_value = alloc_dict.get(ticker, 0)
            if isinstance(alloc_value, dict):
                alloc_pct = float(alloc_value.get("allocation", alloc_value.get("weight", 0)))
            else:
                alloc_pct = float(alloc_value) if alloc_value is not None else 0.0
            if ticker == "CASH":
                shares_row[ticker] = 0.0
                values_row[ticker] = portfolio_value * alloc_pct
            else:
                df = raw_data.get(ticker)
                price = None
                if isinstance(df, pd.DataFrame) and "Close" in df.columns:
                    price = get_price_on_date(df, date)
                if price and price > 0:
                    allocation_value = portfolio_value * alloc_pct
                    shares = allocation_value / price
                    shares_row[ticker] = round(shares, 2)
                    values_row[ticker] = shares * price
                else:
                    shares_row[ticker] = 0.0
                    values_row[ticker] = portfolio_value * alloc_pct
        shares_data[date] = shares_row
        values_data[date] = values_row

    shares_df = pd.DataFrame(shares_data).T
    shares_df.index = pd.to_datetime(shares_df.index)
    shares_df = shares_df.sort_index().fillna(0.0)[all_tickers_list]
    values_df = pd.DataFrame(values_data).T
    values_df.index = pd.to_datetime(values_df.index)
    values_df = values_df.sort_index().fillna(0.0)[all_tickers_list]

    sorted_dates = sorted(rebalancing_dates)
    prices_df = pd.DataFrame(index=sorted_dates, columns=all_tickers_list)
    prices_df.index = pd.to_datetime(prices_df.index)
    for ticker in all_tickers_list:
        if ticker == "CASH":
            prices_df[ticker] = None
            continue
        df = raw_data.get(ticker)
        if isinstance(df, pd.DataFrame) and "Close" in df.columns:
            prices_df[ticker] = df["Close"].reindex(sorted_dates, method="ffill").values
        else:
            prices_df[ticker] = None

    shares_df_aligned = shares_df.reindex(sorted_dates).fillna(0.0)
    values_df_aligned = values_df.reindex(sorted_dates).fillna(0.0)
    prev_shares_df = shares_df_aligned.shift(1).fillna(0.0)
    prev_prices_df = prices_df.shift(1)
    prev_values_df = values_df_aligned.shift(1).fillna(0.0)

    avg_purchase_price = {}
    realized_gains_data, unrealized_gains_data = {}, {}
    for ticker in all_tickers_list:
        if ticker == "CASH":
            continue
        first_date = sorted_dates[0]
        first_value = values_df.loc[first_date, ticker]
        first_shares = shares_df.loc[first_date, ticker]
        if first_shares > 0 and first_value > 0:
            avg_purchase_price[ticker] = first_value / first_shares
        elif prices_df.loc[first_date, ticker] is not None:
            avg_purchase_price[ticker] = prices_df.loc[first_date, ticker]
        else:
            avg_purchase_price[ticker] = 0.0

    for i, date in enumerate(sorted_dates):
        current_shares = shares_df_aligned.loc[date]
        prev_shares = prev_shares_df.loc[date]
        current_prices = prices_df.loc[date]
        prev_prices = prev_prices_df.loc[date] if i > 0 else pd.Series(None, index=all_tickers_list)
        prev_values = prev_values_df.loc[date] if i > 0 else pd.Series(0.0, index=all_tickers_list)
        realized_row, unrealized_row = {}, {}
        shares_diff = current_shares - prev_shares
        valid_prices = (current_prices.notna()) & (current_prices > 0)
        valid_prev_prices = prev_prices.notna() & (prev_prices > 0)
        for ticker in all_tickers_list:
            if ticker == "CASH":
                realized_row[ticker] = 0.0
                unrealized_row[ticker] = 0.0
                continue
            prev_shares_count = prev_shares.get(ticker, 0.0)
            current_shares_count = current_shares.get(ticker, 0.0)
            current_price = current_prices.get(ticker) if valid_prices.get(ticker, False) else None
            prev_price = prev_prices.get(ticker) if valid_prev_prices.get(ticker, False) else None
            if current_price is None or current_price <= 0:
                realized_row[ticker] = 0.0
                unrealized_row[ticker] = 0.0
                continue
            shares_diff_ticker = shares_diff.get(ticker, 0.0)
            if shares_diff_ticker < 0:
                shares_sold = abs(shares_diff_ticker)
                realized_gain = 0.0
                if prev_shares_count > 0 and current_price > 0:
                    if prev_price and prev_price > 0:
                        realized_gain = (current_price - prev_price) * shares_sold
                    else:
                        prev_value = prev_values.get(ticker, 0.0)
                        if prev_value > 0 and prev_shares_count > 0:
                            realized_gain = (current_price - prev_value / prev_shares_count) * shares_sold
                        elif avg_purchase_price.get(ticker, 0.0) > 0:
                            realized_gain = (current_price - avg_purchase_price[ticker]) * shares_sold
                realized_row[ticker] = realized_gain
                if current_shares_count > 0:
                    if prev_price and prev_price > 0:
                        unrealized_row[ticker] = (current_price - prev_price) * current_shares_count
                    elif avg_purchase_price.get(ticker, 0.0) > 0:
                        unrealized_row[ticker] = (current_price - avg_purchase_price[ticker]) * current_shares_count
                    else:
                        unrealized_row[ticker] = 0.0
                else:
                    unrealized_row[ticker] = 0.0
                    avg_purchase_price[ticker] = 0.0
            else:
                realized_row[ticker] = 0.0
                if prev_shares_count > 0:
                    if prev_price and prev_price > 0:
                        unrealized_row[ticker] = (current_price - prev_price) * prev_shares_count
                    elif avg_purchase_price.get(ticker, 0.0) > 0:
                        unrealized_row[ticker] = (current_price - avg_purchase_price[ticker]) * prev_shares_count
                    else:
                        unrealized_row[ticker] = 0.0
                else:
                    unrealized_row[ticker] = 0.0
        for ticker in all_tickers_list:
            if ticker == "CASH":
                continue
            prev_shares_count = prev_shares.get(ticker, 0.0)
            current_shares_count = current_shares.get(ticker, 0.0)
            current_price = current_prices.get(ticker) if valid_prices.get(ticker, False) else None
            if current_price is None or current_price <= 0:
                continue
            shares_diff_ticker = shares_diff.get(ticker, 0.0)
            if shares_diff_ticker > 0:
                shares_bought = shares_diff_ticker
                if prev_shares_count > 0:
                    if avg_purchase_price.get(ticker, 0.0) > 0:
                        prev_cost_basis = prev_shares_count * avg_purchase_price[ticker]
                    else:
                        prev_value = prev_values.get(ticker, 0.0)
                        if prev_value > 0:
                            prev_cost_basis = prev_value
                        elif prev_price and prev_price > 0:
                            prev_cost_basis = prev_shares_count * prev_price
                        else:
                            prev_cost_basis = 0.0
                    total_shares = current_shares_count
                    if total_shares > 0:
                        avg_purchase_price[ticker] = (prev_cost_basis + shares_bought * current_price) / total_shares
                    else:
                        avg_purchase_price[ticker] = current_price
                else:
                    avg_purchase_price[ticker] = current_price
        realized_gains_data[date] = realized_row
        unrealized_gains_data[date] = unrealized_row

    realized_df = pd.DataFrame(realized_gains_data).T.sort_index().fillna(0.0)[all_tickers_list]
    realized_df["TOTAL"] = realized_df.sum(axis=1)
    unrealized_df = pd.DataFrame(unrealized_gains_data).T.sort_index().fillna(0.0)[all_tickers_list]
    unrealized_df["TOTAL"] = unrealized_df.sum(axis=1)

    labels, annual_r, annual_u = [], {}, {}
    for i, current_date in enumerate(sorted_dates):
        if i > 0:
            prev_date = sorted_dates[i - 1]
            labels.append(f"{prev_date.strftime('%Y-%m-%d')} - {current_date.strftime('%Y-%m-%d')}")
            start_year, end_year = prev_date.year, current_date.year
        else:
            labels.append(f"{current_date.strftime('%Y-%m-%d')} (start)")
            start_year = end_year = current_date.year
        year = end_year if start_year < end_year else (end_year + 1 if start_year == end_year else end_year)
        annual_r[year] = annual_r.get(year, 0.0) + realized_df["TOTAL"].iloc[i]
        annual_u[year] = annual_u.get(year, 0.0) + unrealized_df["TOTAL"].iloc[i]
    annual = []
    for year in sorted(set(annual_r) | set(annual_u)):
        r, u = annual_r.get(year, 0.0), annual_u.get(year, 0.0)
        abs_total = abs(r) + abs(u)
        annual.append({
            "period": f"{year - 1}-{year}", "realized": r, "unrealized": u, "total": r + u,
            "taxable_pct": (abs(r) / abs_total) * 100 if abs_total > 0.01 else 0.0,
        })
    return {
        "dates": [d.strftime("%Y-%m-%d") for d in sorted_dates],
        "tickers": all_tickers_list,
        "shares": shares_df.values.tolist(),
        "values": values_df.values.tolist(),
        "periods": labels,
        "realized": realized_df[all_tickers_list].values.tolist(),
        "unrealized": unrealized_df[all_tickers_list].values.tolist(),
        "realized_total": realized_df["TOTAL"].tolist(),
        "unrealized_total": unrealized_df["TOTAL"].tolist(),
        "annual": annual,
    }


def today_weights(cfg, metrics_data):
    today_weights = {}
    if cfg.get("use_momentum", True):
        if metrics_data:
            most_recent_metrics = metrics_data[max(metrics_data.keys())]
            for ticker, ticker_metrics in most_recent_metrics.items():
                if isinstance(ticker_metrics, dict) and "Calculated_Weight" in ticker_metrics:
                    weight = ticker_metrics.get("Calculated_Weight", 0)
                    if weight > 0:
                        today_weights[ticker] = weight
            total_weight = sum(today_weights.values())
            if total_weight < 1.0:
                today_weights["CASH"] = 1.0 - total_weight
    else:
        if cfg.get("stocks"):
            total_allocation = sum(stock.get("allocation", 0) for stock in cfg["stocks"] if stock.get("ticker"))
            if total_allocation > 0:
                for stock in cfg["stocks"]:
                    ticker = stock.get("ticker", "").strip()
                    allocation = stock.get("allocation", 0)
                    if ticker and allocation > 0:
                        today_weights[ticker] = allocation / total_allocation
    labels_today = [k for k, v in sorted(today_weights.items(), key=lambda x: (-x[1], x[0])) if v > 0]
    vals_today = [float(today_weights[k]) * 100 for k in labels_today]
    if not labels_today or sum(vals_today) < 0.1:
        labels_today, vals_today = ["CASH"], [100.0]
    return today_weights, [[k, v] for k, v in zip(labels_today, vals_today)]


def alloc_table(alloc_dict, price_date, portfolio_value, raw_data, exclude=()):
    if not alloc_dict:
        return None

    def _price_on_or_before(df, target_date):
        try:
            available_dates = df.index[df.index <= target_date]
            if len(available_dates) > 0:
                return float(df.loc[available_dates[-1], "Close"])
            return None
        except Exception:
            return None

    rows = []
    for tk in sorted(k for k in alloc_dict.keys() if k not in exclude):
        alloc_value = alloc_dict.get(tk, 0)
        alloc_pct = float(alloc_value.get("allocation", alloc_value.get("weight", 0))) if isinstance(alloc_value, dict) \
            else (float(alloc_value) if alloc_value is not None else 0.0)
        if tk == "CASH":
            price, shares, total_val = None, 0, portfolio_value * alloc_pct
        else:
            df = raw_data.get(tk)
            price = None
            if isinstance(df, pd.DataFrame) and "Close" in df.columns and not df["Close"].dropna().empty:
                if price_date is None:
                    try:
                        price = float(df["Close"].iloc[-1])
                    except Exception:
                        price = None
                else:
                    price = _price_on_or_before(df, price_date)
            if price and price > 0:
                shares = round(portfolio_value * alloc_pct / price, 1)
                total_val = shares * price
            else:
                shares, total_val = 0.0, portfolio_value * alloc_pct
        pct_of_port = (total_val / portfolio_value * 100) if portfolio_value > 0 else 0
        rows.append({"ticker": tk, "alloc_pct": alloc_pct * 100, "price": price, "shares": float(shares),
                     "value": total_val, "pct": pct_of_port})
    df_table = pd.DataFrame(rows).set_index("ticker")
    df_display = df_table.copy()
    show_cash = False
    if "CASH" in df_display.index:
        cash_val = df_display.at["CASH", "value"]
        try:
            show_cash = bool(cash_val and not pd.isna(cash_val) and cash_val != 0)
        except Exception:
            show_cash = False
        if not show_cash:
            df_display = df_display.drop("CASH")
    shown = [r for r in rows if r["ticker"] in df_display.index]
    return {
        "rows": shown,
        "total": {"alloc_pct": df_display["alloc_pct"].sum(), "value": df_display["value"].sum(),
                  "pct": df_display["pct"].sum()},
        "cash_shown": show_cash,
    }


def get_portfolio_value(portfolio_results):
    latest_value = portfolio_results["with_additions"].iloc[-1]
    if not pd.isna(latest_value) and latest_value > 0:
        return float(latest_value)
    return 10000


def timer(cfg, allocation_data):
    alloc_dates = sorted(list(allocation_data.keys()))
    rebalancing_frequency = cfg.get("rebalancing_frequency", "none")
    f = rebalancing_frequency.lower() if rebalancing_frequency else ""
    if rebalancing_frequency and f in ["annually", "yearly", "year"]:
        rebalance_dates = [d for d in alloc_dates if d.month == 1 and d.day == 1]
    elif rebalancing_frequency and f in ["monthly", "month"]:
        rebalance_dates = [d for d in alloc_dates if d.day == 1]
    elif rebalancing_frequency and f in ["quarterly", "3months"]:
        rebalance_dates = [d for d in alloc_dates if d.month in [1, 4, 7, 10] and d.day == 1]
    elif rebalancing_frequency and f in ["semi-annually", "semiannually", "6months"]:
        rebalance_dates = [d for d in alloc_dates if d.month in [1, 7] and d.day == 1]
    else:
        rebalance_dates = alloc_dates[:-1] if len(alloc_dates) > 1 else alloc_dates
    actual = rebalance_dates[-1] if rebalance_dates else (alloc_dates[-2] if len(alloc_dates) > 1 else alloc_dates[-1])
    frequency_mapping = {
        "monthly": "month", "weekly": "week", "bi-weekly": "2weeks", "biweekly": "2weeks", "quarterly": "3months",
        "semi-annually": "6months", "semiannually": "6months", "annually": "year", "yearly": "year",
        "market_day": "market_day", "calendar_day": "calendar_day", "never": "none", "none": "none",
    }
    return {"last_rebalance": actual.strftime("%Y-%m-%d"),
            "frequency": frequency_mapping.get(rebalancing_frequency.lower(), rebalancing_frequency)}


def last_rebalance_date(cfg, portfolio_results, allocation_data):
    alloc_dates = sorted(list(allocation_data.keys()))
    final_date = alloc_dates[-1]
    last_rebal_date = None
    rebalancing_frequency = cfg.get("rebalancing_frequency", "Monthly")
    frequency_mapping = {
        "monthly": "Monthly", "weekly": "Weekly", "bi-weekly": "Biweekly", "biweekly": "Biweekly",
        "quarterly": "Quarterly", "semi-annually": "Semiannually", "semiannually": "Semiannually",
        "annually": "Annually", "yearly": "Annually", "never": "Never", "none": "Never",
    }
    rebalancing_frequency = frequency_mapping.get(rebalancing_frequency.lower(), rebalancing_frequency)
    if rebalancing_frequency != "Never":
        sim_index = portfolio_results["no_additions"].index
        dates = get_cached_rebalancing_dates(rebalancing_frequency, sim_index)
        if dates:
            for date in reversed(sorted(dates)):
                if date <= final_date:
                    last_rebal_date = date
                    break
    if not last_rebal_date and len(alloc_dates) > 1:
        last_rebal_date = alloc_dates[-2]
    elif not last_rebal_date:
        last_rebal_date = alloc_dates[-1]
    return last_rebal_date, final_date
