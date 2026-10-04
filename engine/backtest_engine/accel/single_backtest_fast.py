def single_backtest_fast(config, sim_index, reindexed_data, _cache_version="v2_daily_allocations"):
    # Copy of the legacy single_backtest with the per-day pandas lookups replaced by numpy arrays
    # (see backtest_engine/accel). Every formula and branch is kept; only how values are read changes.
    
    stocks_list = config['stocks']
    tickers = [s['ticker'] for s in stocks_list if s['ticker']]
    # Filter tickers to those present in reindexed_data to avoid KeyErrors for invalid tickers
    available_tickers = [t for t in tickers if t in reindexed_data]
    if len(available_tickers) < len(tickers):
        missing = set(tickers) - set(available_tickers)
    tickers = available_tickers
    # Recompute allocations and include_dividends to only include valid tickers
    # Handle duplicate tickers by summing their allocations
    allocations = {}
    include_dividends = {}
    for s in stocks_list:
        if s.get('ticker') and s.get('ticker') in tickers:
            ticker = s['ticker']
            allocation = s.get('allocation', 0)
            include_div = s.get('include_dividends', False)
            
            if ticker in allocations:
                # If ticker already exists, add the allocation
                allocations[ticker] += allocation
                # For include_dividends, use True if any instance has it True
                include_dividends[ticker] = include_dividends[ticker] or include_div
            else:
                # First occurrence of this ticker
                allocations[ticker] = allocation
                include_dividends[ticker] = include_div
    
    # Update tickers to only include unique tickers after deduplication
    tickers = list(allocations.keys())
    benchmark_ticker = config['benchmark_ticker']
    initial_value = config.get('initial_value', 0)
    added_amount = config.get('added_amount', 0)
    added_frequency = config.get('added_frequency', 'none')
    rebalancing_frequency = config.get('rebalancing_frequency', 'none')
    use_momentum = config.get('use_momentum', True)
    momentum_windows = config.get('momentum_windows', [])
    normalize_momentum_windows_discard_flags(momentum_windows)
    calc_beta = config.get('calc_beta', False)
    calc_volatility = config.get('calc_volatility', False)
    beta_window_days = config.get('beta_window_days', 365)
    exclude_days_beta = config.get('exclude_days_beta', 30)
    vol_window_days = config.get('vol_window_days', 365)
    exclude_days_vol = config.get('exclude_days_vol', 30)
    current_data = {t: reindexed_data[t] for t in tickers + [benchmark_ticker] if t in reindexed_data}
    attach_mcap_close_lookup(config, reindexed_data)
    dates_added = get_dates_by_freq(added_frequency, sim_index[0], sim_index[-1], sim_index)
    
    # Get regular rebalancing dates
    dates_rebal = sorted(get_dates_by_freq(rebalancing_frequency, sim_index[0], sim_index[-1], sim_index))
    
    # OPTIMIZATION: Precompute MA columns once at the start if MA filter OR MA cross rebalancing is enabled
    # This is the key performance improvement - compute MA once instead of every day!
    ma_crossings_data = None
    ma_filter_data = None
    if config.get('use_sma_filter', False) or config.get('ma_cross_rebalance', False):
        ma_window = config.get('sma_window', 200)
        ma_type = config.get('ma_type', 'SMA')
        ma_multiplier = config.get('ma_multiplier', 1.48)  # Default multiplier for market days
        precompute_ma_columns(reindexed_data, ma_window, ma_type, ma_multiplier)
        
        # ULTRA OPTIMIZATION: Precompute ALL MA filters if MA filter is enabled
        if config.get('use_sma_filter', False):
            ma_filter_data = precompute_ma_filters(reindexed_data, ma_window, ma_type, ma_multiplier, config.get('stocks', []), config)
        
        # ULTRA OPTIMIZATION: Precompute ALL MA crossings if MA cross rebalancing is enabled
        if config.get('ma_cross_rebalance', False):
            tolerance_percent = config.get('ma_tolerance_percent', 2.0)
            confirmation_days = config.get('ma_confirmation_days', 3)
            ma_crossings_data = precompute_ma_crossings(reindexed_data, ma_window, ma_type, tolerance_percent, confirmation_days)
    
    # Handle first rebalance strategy - replace first rebalance date if needed
    first_rebalance_strategy = st.session_state.get('multi_backtest_first_rebalance_strategy', 'momentum_window_complete')
    if first_rebalance_strategy == "momentum_window_complete" and use_momentum and momentum_windows:
        try:
            # Calculate when momentum window completes
            window_sizes = [int(w.get('lookback', 0)) for w in momentum_windows if w is not None]
            max_window_days = max(window_sizes) if window_sizes else 0
            momentum_completion_date = sim_index[0] + pd.Timedelta(days=max_window_days)
            
            # Find the closest trading day to momentum completion
            momentum_completion_trading_day = sim_index[sim_index >= momentum_completion_date][0] if len(sim_index[sim_index >= momentum_completion_date]) > 0 else sim_index[-1]
            
            # Replace the first rebalancing date with momentum completion date
            if len(dates_rebal) > 0:
                # Remove the first rebalancing date and add momentum completion date
                dates_rebal = dates_rebal[1:] if len(dates_rebal) > 1 else []
                dates_rebal.insert(0, momentum_completion_trading_day)
                dates_rebal = sorted(dates_rebal)
        except Exception:
            pass  # Fall back to regular rebalancing dates

    # Dictionaries to store historical data for new tables
    historical_allocations = {}
    historical_metrics = {}
    
    # Precompute start dates for all tickers (same as Page 5)
    start_dates_config = {}
    for t in tickers:
        if t in reindexed_data and isinstance(reindexed_data.get(t), pd.DataFrame):
            fd = reindexed_data[t].first_valid_index()
            start_dates_config[t] = fd if fd is not None else pd.NaT
        else:
            start_dates_config[t] = pd.NaT

    _acc = _accel_arrays(reindexed_data, sim_index, list(tickers) + [benchmark_ticker])

    def calculate_momentum(date, current_assets, momentum_windows, stocks_config=None):
        cumulative_returns, valid_assets = {}, []
        window_rets_by_asset = {}
        
        current_assets = filter_tickers_by_sp500_entry(current_assets, date, config)
        if not current_assets:
            return {}, []

        # Apply MA filter BEFORE calculating momentum (ULTRA OPTIMIZED!)
        assets_to_calculate = current_assets
        if config.get('use_sma_filter', False) and ma_filter_data is not None:
            # ULTRA FAST: Use precomputed filter results!
            filtered_assets = [t for t in current_assets if ma_filter_data.get(date, {}).get(t, True)]
            
            # If no assets remain after MA filtering, go to cash immediately
            if not filtered_assets:
                return {}, []
            
            # Only calculate momentum for filtered assets
            assets_to_calculate = filtered_assets
        else:
            # No MA filter - use all assets
            pass
        filtered_windows = [w for w in momentum_windows if w["weight"] > 0]
        # Normalize weights so they sum to 1 (same as app.py)
        total_weight = sum(w["weight"] for w in filtered_windows)
        if total_weight == 0:
            normalized_weights = [0 for _ in filtered_windows]
        else:
            normalized_weights = [w["weight"] / total_weight for w in filtered_windows]
        
        # Only consider assets that exist in current_data (filtered earlier)
        candidate_assets = [t for t in assets_to_calculate if t in current_data]
        
        # Window bounds depend only on the date: built once, at the first candidate (where the legacy
        # loop first read them, so a malformed window still fails at the same point).
        _bounds = None
        # Calculate momentum only for SMA-filtered assets
        for t in candidate_assets:
            is_valid, asset_returns = True, 0.0
            window_rets_list = []
            df_t = current_data.get(t)
            _a = _acc.get(t)
            if _a is not None and df_t is not None and df_t.index is _a.index:
                if not _a.has_close:
                    continue
            elif not (isinstance(df_t, pd.DataFrame) and 'Close' in df_t.columns and not df_t['Close'].dropna().empty):
                # no usable data for this ticker
                continue
            if _bounds is None:
                _bounds = []
                for idx, window in enumerate(filtered_windows):
                    lookback, exclude = window["lookback"], window["exclude"]
                    _bounds.append((window, normalized_weights[idx], date - pd.Timedelta(days=lookback), date - pd.Timedelta(days=exclude)))
            sd = start_dates_config.get(t, pd.NaT)
            for window, weight, start_mom, end_mom in _bounds:
                # If no start date or asset starts after required lookback, mark invalid
                if pd.isna(sd) or sd > start_mom:
                    is_valid = False
                    break
                if _a is not None:
                    _ps = _a.asof_pos(start_mom)
                    _pe = _a.asof_pos(end_mom)
                    if _ps < 0 or _pe < 0:
                        is_valid = False
                        break
                    price_start = _a.close[_ps]
                    price_end = _a.close[_pe]
                else:
                    try:
                        price_start_index = df_t.index.asof(start_mom)
                        price_end_index = df_t.index.asof(end_mom)
                    except Exception:
                        is_valid = False
                        break
                    if pd.isna(price_start_index) or pd.isna(price_end_index):
                        is_valid = False
                        break
                    price_start = df_t.loc[price_start_index, "Close"]
                    price_end = df_t.loc[price_end_index, "Close"]
                if pd.isna(price_start) or pd.isna(price_end) or price_start == 0:
                    is_valid = False
                    break
                
                # ACADEMIC FIX: Include dividends in momentum calculation if configured (Jegadeesh & Titman 1993)
                if include_dividends.get(t, False):
                    # Calculate cumulative dividends in the momentum window
                    if _a is not None and _a.dividends is not None:
                        divs_in_period = _a.dividend_sum(_ps, _pe + 1)
                    else:
                        if _a is not None:
                            price_start_index = _a.index[_ps]
                            price_end_index = _a.index[_pe]
                        divs_in_period = df_t.loc[price_start_index:price_end_index, "Dividends"].fillna(0).sum()
                    ret = ((price_end + divs_in_period) - price_start) / price_start
                else:
                    ret = (price_end - price_start) / price_start
                recent_ret = None
                if (
                    ret < 0
                    and parse_bool_from_json(window.get("discard_if_negative", False), False)
                    and parse_bool_from_json(window.get("discard_unless_recent_positive", False), False)
                ):
                    recent_ret = _momentum_return_between(
                        df_t, end_mom, date, include_dividends.get(t, False)
                    )
                if _momentum_window_discards_negative(window, ret, recent_ret):
                    is_valid = False
                    break
                asset_returns += ret * weight
                window_rets_list.append(ret)
            if is_valid:
                cumulative_returns[t] = asset_returns
                window_rets_by_asset[t] = window_rets_list
                valid_assets.append(t)
        
        if config.get('use_window_capped_score', False) and window_rets_by_asset:
            cumulative_returns = _window_capped_momentum_scores(window_rets_by_asset, normalized_weights)
        return cumulative_returns, valid_assets

    def calculate_momentum_weights(returns, valid_assets, date, momentum_strategy='Classic', negative_momentum_strategy='Cash', config=None):
        # Mirror approach used in allocations/app.py: compute weights from raw momentum
        # (Classic or Relative) and then optionally post-filter by inverse volatility
        # and inverse absolute beta (multiplicative), then renormalize. This avoids
        # dividing by beta directly which flips signs when beta is negative.
        if not valid_assets:
            return {}, {}
        # Keep only non-nan momentum values
        rets = {t: returns.get(t, np.nan) for t in valid_assets}
        rets = {t: rets[t] for t in rets if not pd.isna(rets[t])}
        if not rets:
            return {}, {}

        metrics = {t: {} for t in rets.keys()}

        # compute beta and volatility metrics when requested
        beta_vals = {}
        vol_vals = {}
        # Get config parameters (same as in single_backtest)
        if config is None:
            config = {}
        calc_beta = config.get('calc_beta', False)
        calc_volatility = config.get('calc_volatility', False)
        benchmark_ticker = config.get('benchmark_ticker', '^GSPC')
        beta_window_days = config.get('beta_window_days', 365)
        exclude_days_beta = config.get('exclude_days_beta', 30)
        vol_window_days = config.get('vol_window_days', 365)
        exclude_days_vol = config.get('exclude_days_vol', 30)
        
        df_bench = reindexed_data.get(benchmark_ticker)
        if calc_beta:
            start_beta = date - pd.Timedelta(days=beta_window_days)
            end_beta = date - pd.Timedelta(days=exclude_days_beta)
        if calc_volatility:
            start_vol = date - pd.Timedelta(days=vol_window_days)
            end_vol = date - pd.Timedelta(days=exclude_days_vol)

        for t in list(rets.keys()):
            df_t = reindexed_data.get(t)
            if calc_beta and df_bench is not None and isinstance(df_t, pd.DataFrame):
                returns_t_beta = _accel_window(_acc, t, df_t, start_beta, end_beta)
                returns_bench_beta = _accel_window(_acc, benchmark_ticker, df_bench, start_beta, end_beta)
                if len(returns_t_beta) < 2 or len(returns_bench_beta) < 2:
                    beta_vals[t] = np.nan
                else:
                    variance = np.var(returns_bench_beta)
                    beta_vals[t] = (np.cov(returns_t_beta, returns_bench_beta)[0,1] / variance) if variance > 0 else np.nan
                metrics[t]['Beta'] = beta_vals[t]
            if calc_volatility and isinstance(df_t, pd.DataFrame):
                returns_t_vol = _accel_window(_acc, t, df_t, start_vol, end_vol)
                if len(returns_t_vol) < 2:
                    vol_vals[t] = np.nan
                else:
                    vol_vals[t] = returns_t_vol.std() * np.sqrt(365.25)
                metrics[t]['Volatility'] = vol_vals[t]

        # attach raw momentum
        for t in rets:
            metrics[t]['Momentum'] = rets[t]

        # Build initial weights from raw momentum (Classic or Relative)
        weights = {}
        rets_keys = list(rets.keys())
        all_negative = all(rets[t] <= 0 for t in rets_keys)
        relative_mode = isinstance(momentum_strategy, str) and momentum_strategy.lower().startswith('relat')
        
        # Calculate effective strategy for negative momentum (needed for equal weight logic)
        effective_strategy_for_equal_weight = None
        if all_negative:
            is_sp500top20 = any(is_special_dynamic_ticker(t) for t in rets_keys) or config.get('dynamic_portfolio_data') is not None
            effective_strategy_for_equal_weight = negative_momentum_strategy
            if is_sp500top20 and negative_momentum_strategy == 'Cash':
                effective_strategy_for_equal_weight = 'Relative momentum'

        def calculate_near_zero_symmetric_momentum(returns, neutral_zone=0.05):
            """
            Relative momentum avec zone neutre autour de 0 - VERSION AMÉLIORÉE
            
            Avantages:
            - Les rendements dans [-5%, +5%] ont des allocations très similaires
            - Pas de biaisage par le pire actif
            - Compression progressive des actifs négatifs
            - Traitement indépendant de chaque ticker
            """
            import numpy as np
            import math
            
            returns_array = np.array(list(returns.values()))
            
            # NZS: Use relative ranking like Relative Momentum but with compression
            min_score = min(returns.values())
            offset = -min_score + 0.01 if min_score < 0 else 0.01
            shifted = {t: max(0.01, returns[t] + offset) for t in returns.keys()}
            
            # Apply NZS compression to the shifted scores
            compressed_scores = {}
            for ticker, shifted_val in shifted.items():
                return_val = returns[ticker]
                
                # Zone neutre : allocations similaires pour rendements proches de 0
                if abs(return_val) <= neutral_zone:
                    # Dans la zone neutre : allocations presque identiques
                    compression_factor = 1.0 - (abs(return_val) / neutral_zone) * 0.1
                else:
                    # Au-delà de la zone neutre : compression progressive
                    if return_val < -neutral_zone:
                        # Négatif au-delà de la zone neutre
                        excess_negativity = abs(return_val) - neutral_zone
                        compression_factor = 0.9 * math.exp(-excess_negativity * 3.0)
                    else:
                        # Positif au-delà de la zone neutre
                        compression_factor = 1.0
                
                compressed_scores[ticker] = shifted_val * compression_factor
            
            # Normalize
            sum_scores = sum(compressed_scores.values())
            weights = {t: compressed_scores[t] / sum_scores for t in compressed_scores}
            
            return weights

        if all_negative:
            # Special handling for SP500TOP20: use Relative as default instead of Cash
            is_sp500top20 = any(is_special_dynamic_ticker(t) for t in rets_keys) or config.get('dynamic_portfolio_data') is not None
            
            # For SP500TOP20, use Relative as default if user chose Cash
            effective_strategy = negative_momentum_strategy
            if is_sp500top20 and negative_momentum_strategy == 'Cash':
                effective_strategy = 'Relative momentum'
            
            if effective_strategy == 'Cash':
                weights = {t: 0.0 for t in rets_keys}
            elif effective_strategy == 'Equal weight':
                weights = {t: 1.0 / len(rets_keys) for t in rets_keys}
            elif effective_strategy == 'Relative momentum':
                # ANCIENNE LOGIQUE Relative Momentum
                min_score = min(rets[t] for t in rets_keys)
                offset = -min_score + 0.01
                shifted = {t: max(0.01, rets[t] + offset) for t in rets_keys}
                ssum = sum(shifted.values())
                weights = {t: shifted[t] / ssum for t in shifted}
            elif effective_strategy == 'Near-Zero Symmetry':
                # NOUVELLE LOGIQUE Near-Zero Symmetry
                weights = calculate_near_zero_symmetric_momentum(rets)
        else:
            if relative_mode:
                if momentum_strategy == 'Relative Momentum':
                    # ANCIENNE LOGIQUE Relative Momentum
                    min_score = min(rets[t] for t in rets_keys)
                    offset = -min_score + 0.01 if min_score < 0 else 0.01
                    shifted = {t: max(0.01, rets[t] + offset) for t in rets_keys}
                    ssum = sum(shifted.values())
                    weights = {t: shifted[t] / ssum for t in shifted}
                elif momentum_strategy == 'Near-Zero Symmetry':
                    # NOUVELLE LOGIQUE Near-Zero Symmetry
                    weights = calculate_near_zero_symmetric_momentum(rets)
            else:
                # Check user's selection for momentum strategy
                if momentum_strategy == 'Classic':
                    positive_scores = {t: rets[t] for t in rets_keys if rets[t] > 0}
                    if positive_scores:
                        ssum = sum(positive_scores.values())
                        weights = {t: (positive_scores.get(t, 0.0) / ssum) for t in rets_keys}
                    else:
                        weights = {t: 0.0 for t in rets_keys}
                elif momentum_strategy == 'Relative Momentum':
                    # ANCIENNE LOGIQUE Relative Momentum
                    min_score = min(rets.values())
                    offset = -min_score + 0.01 if min_score < 0 else 0.01
                    shifted = {t: max(0.01, rets[t] + offset) for t in rets_keys}
                    ssum = sum(shifted.values())
                    weights = {t: shifted[t] / ssum for t in shifted}
                elif momentum_strategy == 'Near-Zero Symmetry':
                    # NOUVELLE LOGIQUE Near-Zero Symmetry
                    weights = calculate_near_zero_symmetric_momentum(rets)
                else:
                    # Fallback to Classic if unknown strategy
                    positive_scores = {t: rets[t] for t in rets_keys if rets[t] > 0}
                    if positive_scores:
                        ssum = sum(positive_scores.values())
                        weights = {t: (positive_scores.get(t, 0.0) / ssum) for t in rets_keys}
                    else:
                        weights = {t: 0.0 for t in rets_keys}

        # Post-filtering: multiply weights by inverse vol and inverse |beta| when requested
        # BUT NOT for Equal weight strategy (when all negative) - keep true equal weights
        if (calc_volatility or calc_beta) and weights and not (all_negative and effective_strategy == 'Equal weight'):
            filter_scores = {}
            for t in weights:
                score = 1.0
                if calc_volatility:
                    v = metrics.get(t, {}).get('Volatility', np.nan)
                    if not pd.isna(v) and v > 0:
                        score *= 1.0 / v
                if calc_beta:
                    b = metrics.get(t, {}).get('Beta', np.nan)
                    if not pd.isna(b) and b != 0:
                        score *= 1.0 / abs(b)
                filter_scores[t] = score

            filtered = {t: weights.get(t, 0.0) * filter_scores.get(t, 1.0) for t in weights}
            ssum = sum(filtered.values())
            # If filtering removes all weight (sum==0), fall back to unfiltered weights
            if ssum > 0:
                weights = {t: filtered[t] / ssum for t in filtered}

        # Apply allocation filters in correct order: Max Allocation -> Min Threshold -> Max Allocation (two-pass system)
        use_max_allocation = config.get('use_max_allocation', False)
        max_allocation_percent = config.get('max_allocation_percent', 20.0)
        use_threshold = config.get('use_minimal_threshold', False)
        threshold_percent = config.get('minimal_threshold_percent', 4.0)
        apply_caps_before_top_n = False
        
        # Build dictionary of individual ticker caps from stock configs
        individual_caps = {}
        for stock in config.get('stocks', []):
            ticker = stock.get('ticker', '')
            individual_cap = stock.get('max_allocation_percent', None)
            if individual_cap is not None and individual_cap > 0:
                individual_caps[ticker] = individual_cap / 100.0
        
        # Apply caps if either global cap is enabled OR any individual caps exist
        if apply_caps_before_top_n and (use_max_allocation or individual_caps) and weights:
            max_allocation_decimal = max_allocation_percent / 100.0
            
            # FIRST PASS: Apply maximum allocation filter (EXCLUDE CASH from max_allocation limit)
            capped_weights = {}
            excess_weight = 0.0
            
            for ticker, weight in weights.items():
                # CASH is exempt from max_allocation limit to prevent money loss
                if ticker == 'CASH':
                    capped_weights[ticker] = weight
                else:
                    # Use individual cap if available, otherwise use global cap
                    ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                    
                    if weight > ticker_cap:
                        # Cap the weight and collect excess
                        capped_weights[ticker] = ticker_cap
                        excess_weight += (weight - ticker_cap)
                    else:
                        # Keep original weight
                        capped_weights[ticker] = weight
            
            # Redistribute excess weight proportionally among stocks that are below the cap
            if excess_weight > 0:
                # Find stocks that can receive more weight (below their individual cap) - include CASH as eligible
                eligible_stocks = {}
                for ticker, weight in capped_weights.items():
                    if ticker == 'CASH':
                        eligible_stocks[ticker] = weight
                    else:
                        ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                        if weight < ticker_cap:
                            eligible_stocks[ticker] = weight
                
                if eligible_stocks:
                    # Calculate total weight of eligible stocks
                    total_eligible_weight = sum(eligible_stocks.values())
                    
                    if total_eligible_weight > 0:
                        # Redistribute excess proportionally
                        for ticker in eligible_stocks:
                            proportion = eligible_stocks[ticker] / total_eligible_weight
                            additional_weight = excess_weight * proportion
                            new_weight = capped_weights[ticker] + additional_weight
                            
                            # CASH can receive unlimited weight, other stocks are capped
                            if ticker == 'CASH':
                                capped_weights[ticker] = new_weight
                            else:
                                # Make sure we don't exceed the individual ticker's cap
                                ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                capped_weights[ticker] = min(new_weight, ticker_cap)
            
            weights = capped_weights
            
            # Final normalization to 100% in case not enough stocks to distribute excess
            total_weight = sum(weights.values())
            if total_weight > 0:
                weights = {ticker: weight / total_weight for ticker, weight in weights.items()}
        
        # Apply minimal threshold filter if enabled
        if apply_caps_before_top_n and use_threshold and weights:
            threshold_decimal = threshold_percent / 100.0
            
            # Check which stocks are below threshold after max allocation redistribution
            filtered_weights = {}
            for ticker, weight in weights.items():
                if weight >= threshold_decimal:
                    # Keep stocks above or equal to threshold (remove stocks below threshold)
                    filtered_weights[ticker] = weight
            
            # Normalize remaining stocks to sum to 1.0
            if filtered_weights:
                total_weight = sum(filtered_weights.values())
                if total_weight > 0:
                    weights = {ticker: weight / total_weight for ticker, weight in filtered_weights.items()}
                else:
                    weights = {}
            else:
                # If no stocks meet threshold, keep original weights
                weights = weights
        
        # SECOND PASS: Apply maximum allocation filter again (in case normalization created new excess)
        if apply_caps_before_top_n and (use_max_allocation or individual_caps) and weights:
            max_allocation_decimal = max_allocation_percent / 100.0
            
            # Check if any stocks exceed the cap after threshold filtering and normalization
            capped_weights = {}
            excess_weight = 0.0
            
            for ticker, weight in weights.items():
                # CASH is exempt from max_allocation limit to prevent money loss
                if ticker == 'CASH':
                    capped_weights[ticker] = weight
                else:
                    # Use individual cap if available, otherwise use global cap
                    ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                    
                    if weight > ticker_cap:
                        # Cap the weight and collect excess
                        capped_weights[ticker] = ticker_cap
                        excess_weight += (weight - ticker_cap)
                    else:
                        # Keep original weight
                        capped_weights[ticker] = weight
            
            # Redistribute excess weight proportionally among stocks that are below the cap
            if excess_weight > 0:
                # Find stocks that can receive more weight (below their individual cap) - include CASH as eligible
                eligible_stocks = {}
                for ticker, weight in capped_weights.items():
                    if ticker == 'CASH':
                        eligible_stocks[ticker] = weight
                    else:
                        ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                        if weight < ticker_cap:
                            eligible_stocks[ticker] = weight
                
                if eligible_stocks:
                    # Calculate total weight of eligible stocks
                    total_eligible_weight = sum(eligible_stocks.values())
                    
                    if total_eligible_weight > 0:
                        # Redistribute excess proportionally
                        for ticker in eligible_stocks:
                            proportion = eligible_stocks[ticker] / total_eligible_weight
                            additional_weight = excess_weight * proportion
                            new_weight = capped_weights[ticker] + additional_weight
                            
                            # CASH can receive unlimited weight, other stocks are capped
                            if ticker == 'CASH':
                                capped_weights[ticker] = new_weight
                            else:
                                # Make sure we don't exceed the individual ticker's cap
                                ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                capped_weights[ticker] = min(new_weight, ticker_cap)
            
            weights = capped_weights
            
            # Final normalization to 100% in case not enough stocks to distribute excess
            total_weight = sum(weights.values())
            if total_weight > 0:
                weights = {ticker: weight / total_weight for ticker, weight in weights.items()}

        # STEP 1: Apply Limit to Top N filter FIRST (if enabled)
        # This selects the top N tickers, keeping their proportional weights
        # IMPORTANT: This runs BEFORE Equal Weight, so Equal Weight can then equalize the selected tickers
        use_limit_to_top_n = config.get('use_limit_to_top_n', False)
        limit_to_top_n_tickers = config.get('limit_to_top_n_tickers', 10)
        
        should_apply_limit_to_top_n = False
        if use_limit_to_top_n and limit_to_top_n_tickers > 0 and weights:
            if all_negative:
                # When all negative, only apply if using Relative momentum or Near-Zero Symmetry
                if effective_strategy_for_equal_weight in ['Relative momentum', 'Near-Zero Symmetry']:
                    should_apply_limit_to_top_n = True
            else:
                # When there are positive momentums, always apply if enabled
                should_apply_limit_to_top_n = True
        
        if should_apply_limit_to_top_n:
            # IMPORTANT: Limit to top N is applied AFTER min/max allocation filters
            # This means we work with the tickers that survived the filters
            # Get all tickers except CASH with weight > 0 (these are the tickers that passed min/max filters)
            # Sort by their final weight (after all filters) in descending order
            ticker_weights = [(ticker, weight) for ticker, weight in weights.items() 
                            if ticker != 'CASH' and weight > 0]
            ticker_weights.sort(key=lambda x: x[1], reverse=True)
            
            if ticker_weights:
                # Get top N tickers from the filtered set (with optional sector/industry caps)
                # If filters left fewer tickers than N requested, take all available tickers
                n_to_select = min(limit_to_top_n_tickers, len(ticker_weights))
                ranked_tickers = [ticker for ticker, _ in ticker_weights]
                sector_industry_map = st.session_state.get('multi_backtest_sector_industry_map', {})
                max_per_sector = config.get('max_tickers_per_sector') if config.get('use_sector_concentration_limit') else None
                max_per_industry = config.get('max_tickers_per_industry') if config.get('use_industry_concentration_limit') else None
                top_n_tickers = select_tickers_with_concentration_limits(
                    ranked_tickers,
                    n_to_select,
                    sector_industry_map=sector_industry_map,
                    max_per_sector=max_per_sector,
                    max_per_industry=max_per_industry,
                    unknown_counts_as_category=config.get('unknown_counts_as_category', True),
                )
                
                # Keep their original proportional weights (unlike equal weight which sets all to 1/N)
                # Create new weights dictionary with original weights for top N, 0 for others
                new_weights = {}
                total_top_n_weight = 0.0
                for ticker in weights.keys():
                    if ticker == 'CASH':
                        # Keep CASH weight as is (should be 0 in most cases)
                        new_weights[ticker] = weights.get(ticker, 0.0)
                    elif ticker in top_n_tickers:
                        # Keep original weight for top N tickers
                        new_weights[ticker] = weights.get(ticker, 0.0)
                        total_top_n_weight += weights.get(ticker, 0.0)
                    else:
                        # Set to 0 for tickers not in top N
                        new_weights[ticker] = 0.0
                
                # If there's any CASH weight, distribute it proportionally to top N tickers based on their relative weights
                cash_weight = new_weights.get('CASH', 0.0)
                if cash_weight > 0 and total_top_n_weight > 0:
                    # Distribute cash proportionally based on each ticker's weight relative to total top N weight
                    for ticker in top_n_tickers:
                        ticker_weight = new_weights[ticker]
                        proportion = ticker_weight / total_top_n_weight if total_top_n_weight > 0 else 0.0
                        new_weights[ticker] += cash_weight * proportion
                    new_weights['CASH'] = 0.0
                
                # Final normalization to ensure weights sum to exactly 1.0 (100%)
                # This preserves the relative proportions among top N tickers
                total_weight = sum(new_weights.values())
                if total_weight > 0:
                    weights = {ticker: weight / total_weight for ticker, weight in new_weights.items()}
                else:
                    # Fallback: if somehow total is 0, keep the new_weights as is
                    weights = new_weights

        # STEP 2: Apply Equal Weight filter AFTER Limit to Top N (if enabled)
        # This equalizes the weights of the tickers selected by Limit to Top N (or all tickers if Limit to Top N was not used)
        # Equal weight should:
        # - Apply to all positive momentum cases
        # - Apply to Relative momentum and Near-Zero Symmetry when all negative
        # - NOT apply when all negative and strategy is Cash (should go to 100% cash)
        # - NOT apply when all negative and strategy is Equal weight (already equal weight for all)
        use_equal_weight = config.get('use_equal_weight', False)
        equal_weight_n_tickers = config.get('equal_weight_n_tickers', 10)
        
        # Determine if equal weight should be applied
        should_apply_equal_weight = False
        if use_equal_weight and equal_weight_n_tickers > 0 and weights:
            if all_negative:
                # When all negative, only apply if using Relative momentum or Near-Zero Symmetry
                if effective_strategy_for_equal_weight in ['Relative momentum', 'Near-Zero Symmetry']:
                    should_apply_equal_weight = True
            else:
                # When there are positive momentums, always apply if enabled
                should_apply_equal_weight = True
        
        if should_apply_equal_weight:
            # IMPORTANT: Equal weight is applied AFTER Limit to Top N (if Limit to Top N was applied)
            # If Limit to Top N was enabled, we equalize the tickers it selected
            # If Limit to Top N was not enabled, we select our own top N tickers and equalize them
            # Get all tickers except CASH with weight > 0
            ticker_weights = [(ticker, weight) for ticker, weight in weights.items() 
                            if ticker != 'CASH' and weight > 0]
            
            if ticker_weights:
                # If Limit to Top N was applied, use the tickers it selected (all tickers with weight > 0)
                # Otherwise, select top N based on Equal Weight's N value
                if should_apply_limit_to_top_n:
                    # Limit to Top N already selected the tickers - just equalize all that remain
                    top_n_tickers = [ticker for ticker, _ in ticker_weights]
                else:
                    # No Limit to Top N - select top N based on Equal Weight's N value
                    ticker_weights.sort(key=lambda x: x[1], reverse=True)
                    n_to_select = min(equal_weight_n_tickers, len(ticker_weights))
                    ranked_tickers = [ticker for ticker, _ in ticker_weights]
                    sector_industry_map = st.session_state.get('multi_backtest_sector_industry_map', {})
                    max_per_sector = config.get('max_tickers_per_sector') if config.get('use_sector_concentration_limit') else None
                    max_per_industry = config.get('max_tickers_per_industry') if config.get('use_industry_concentration_limit') else None
                    top_n_tickers = select_tickers_with_concentration_limits(
                        ranked_tickers,
                        n_to_select,
                        sector_industry_map=sector_industry_map,
                        max_per_sector=max_per_sector,
                        max_per_industry=max_per_industry,
                        unknown_counts_as_category=config.get('unknown_counts_as_category', True),
                    )
                
                # Calculate equal weight per ticker (1/n where n is the actual number selected)
                equal_weight_per_ticker = 1.0 / len(top_n_tickers)
                
                # Create new weights dictionary with equal weights for top N, 0 for others
                new_weights = {}
                for ticker in weights.keys():
                    if ticker == 'CASH':
                        # Keep CASH weight as is (should be 0 in most cases)
                        new_weights[ticker] = weights.get(ticker, 0.0)
                    elif ticker in top_n_tickers:
                        new_weights[ticker] = equal_weight_per_ticker
                    else:
                        # Set to 0 for tickers not in top N
                        new_weights[ticker] = 0.0
                
                # If there's any CASH weight, distribute it proportionally to top N tickers
                cash_weight = new_weights.get('CASH', 0.0)
                if cash_weight > 0:
                    # Add cash weight proportionally to top N tickers
                    for ticker in top_n_tickers:
                        new_weights[ticker] += cash_weight / len(top_n_tickers)
                    new_weights['CASH'] = 0.0
                
                # Final normalization to ensure weights sum to exactly 1.0 (100%)
                # This is important especially when fewer tickers remain than requested N
                total_weight = sum(new_weights.values())
                if total_weight > 0:
                    weights = {ticker: weight / total_weight for ticker, weight in new_weights.items()}
                else:
                    # Fallback: if somehow total is 0, keep the new_weights as is
                    weights = new_weights

        # STEP 3: Sector/industry caps without Top N / Equal Weight — exclude only (no fill)
        # When Top N or Equal Weight already ran, caps were applied there (with fill-to-N).
        use_sector_cap = bool(config.get('use_sector_concentration_limit'))
        use_industry_cap = bool(config.get('use_industry_concentration_limit'))
        if (use_sector_cap or use_industry_cap) and not should_apply_limit_to_top_n and not should_apply_equal_weight and weights:
            ticker_weights = [(ticker, weight) for ticker, weight in weights.items()
                             if ticker != 'CASH' and weight > 0]
            ticker_weights.sort(key=lambda x: x[1], reverse=True)
            if ticker_weights:
                ranked_tickers = [ticker for ticker, _ in ticker_weights]
                kept = select_tickers_with_concentration_limits(
                    ranked_tickers,
                    len(ranked_tickers),
                    sector_industry_map=st.session_state.get('multi_backtest_sector_industry_map', {}),
                    max_per_sector=config.get('max_tickers_per_sector') if use_sector_cap else None,
                    max_per_industry=config.get('max_tickers_per_industry') if use_industry_cap else None,
                    fill_deferred=False,
                    unknown_counts_as_category=config.get('unknown_counts_as_category', True),
                )
                kept_set = set(kept)
                new_weights = {}
                for ticker, weight in weights.items():
                    if ticker == 'CASH':
                        new_weights[ticker] = weight
                    elif ticker in kept_set:
                        new_weights[ticker] = weight
                    else:
                        new_weights[ticker] = 0.0
                total_weight = sum(new_weights.values())
                if total_weight > 0:
                    weights = {ticker: weight / total_weight for ticker, weight in new_weights.items()}
                else:
                    weights = new_weights

        # Final allocation filters (after Top N / Equal Weight): Max Allocation -> Min Threshold -> Max Allocation
        if (use_max_allocation or individual_caps) and weights:
            max_allocation_decimal = max_allocation_percent / 100.0

            capped_weights = {}
            excess_weight = 0.0

            for ticker, weight in weights.items():
                if ticker == 'CASH':
                    capped_weights[ticker] = weight
                else:
                    ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))

                    if weight > ticker_cap:
                        capped_weights[ticker] = ticker_cap
                        excess_weight += (weight - ticker_cap)
                    else:
                        capped_weights[ticker] = weight

            if excess_weight > 0:
                eligible_stocks = {}
                for ticker, weight in capped_weights.items():
                    if ticker == 'CASH':
                        eligible_stocks[ticker] = weight
                    else:
                        ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                        if weight < ticker_cap:
                            eligible_stocks[ticker] = weight

                if eligible_stocks:
                    total_eligible_weight = sum(eligible_stocks.values())

                    if total_eligible_weight > 0:
                        for ticker in eligible_stocks:
                            proportion = eligible_stocks[ticker] / total_eligible_weight
                            additional_weight = excess_weight * proportion
                            new_weight = capped_weights[ticker] + additional_weight

                            if ticker == 'CASH':
                                capped_weights[ticker] = new_weight
                            else:
                                ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                capped_weights[ticker] = min(new_weight, ticker_cap)

            weights = capped_weights

            total_weight = sum(weights.values())
            if total_weight > 0:
                weights = {ticker: weight / total_weight for ticker, weight in weights.items()}

        if use_threshold and weights:
            threshold_decimal = threshold_percent / 100.0

            filtered_weights = {}
            for ticker, weight in weights.items():
                if weight >= threshold_decimal:
                    filtered_weights[ticker] = weight

            if filtered_weights:
                total_weight = sum(filtered_weights.values())
                if total_weight > 0:
                    weights = {ticker: weight / total_weight for ticker, weight in filtered_weights.items()}
                else:
                    weights = {}
            else:
                weights = weights

        if (use_max_allocation or individual_caps) and weights:
            max_allocation_decimal = max_allocation_percent / 100.0

            capped_weights = {}
            excess_weight = 0.0

            for ticker, weight in weights.items():
                if ticker == 'CASH':
                    capped_weights[ticker] = weight
                else:
                    ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))

                    if weight > ticker_cap:
                        capped_weights[ticker] = ticker_cap
                        excess_weight += (weight - ticker_cap)
                    else:
                        capped_weights[ticker] = weight

            if excess_weight > 0:
                eligible_stocks = {}
                for ticker, weight in capped_weights.items():
                    if ticker == 'CASH':
                        eligible_stocks[ticker] = weight
                    else:
                        ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                        if weight < ticker_cap:
                            eligible_stocks[ticker] = weight

                if eligible_stocks:
                    total_eligible_weight = sum(eligible_stocks.values())

                    if total_eligible_weight > 0:
                        for ticker in eligible_stocks:
                            proportion = eligible_stocks[ticker] / total_eligible_weight
                            additional_weight = excess_weight * proportion
                            new_weight = capped_weights[ticker] + additional_weight

                            if ticker == 'CASH':
                                capped_weights[ticker] = new_weight
                            else:
                                ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                capped_weights[ticker] = min(new_weight, ticker_cap)

            weights = capped_weights

            total_weight = sum(weights.values())
            if total_weight > 0:
                weights = {ticker: weight / total_weight for ticker, weight in weights.items()}

        # Attach calculated weights to metrics and return
        for t in weights:
            metrics[t]['Calculated_Weight'] = weights.get(t, 0.0)

        # Debug print when beta/vol are used
        if calc_beta or calc_volatility:
            try:
                for t in rets_keys:
                    pass
            except Exception:
                pass

        return weights, metrics
        # --- MODIFIED LOGIC END ---

    values = {t: [0.0] for t in tickers}
    unallocated_cash = [0.0]
    unreinvested_cash = [0.0]
    portfolio_no_additions = [initial_value]
    
    # Initial allocation and metric storage
    if not use_momentum:
        current_allocations = {t: allocations.get(t,0) for t in tickers}
        
        # Apply MA / S&P 500 entry filters even when momentum is disabled
        if (config.get('use_sma_filter', False) and ma_filter_data is not None) or _universe_filters_active(config):
            # Get list of current tickers (excluding CASH)
            current_tickers = [t for t in tickers if t != 'CASH']
            filtered_tickers = list(current_tickers)
            if config.get('use_sma_filter', False) and ma_filter_data is not None:
                filtered_tickers = [t for t in filtered_tickers if ma_filter_data.get(sim_index[0], {}).get(t, True)]
            filtered_tickers = filter_tickers_by_sp500_entry(filtered_tickers, sim_index[0], config)
            excluded_assets = {t: "Excluded by filter" for t in current_tickers if t not in filtered_tickers}
            
            # Redistribute allocations of excluded tickers proportionally among remaining tickers
            if excluded_assets:
                excluded_ticker_list = list(excluded_assets.keys())
                
                # Calculate total allocation of excluded tickers
                excluded_allocation = sum(current_allocations.get(t, 0) for t in excluded_ticker_list)
                
                # Remove excluded tickers from current allocations
                for excluded_ticker in excluded_ticker_list:
                    if excluded_ticker in current_allocations:
                        del current_allocations[excluded_ticker]
                
                # If there are remaining tickers (excluding CASH), redistribute proportionally
                remaining_tickers = [t for t in current_allocations.keys() if t != 'CASH']
                if remaining_tickers:
                    # Calculate total allocation of remaining tickers (excluding CASH)
                    remaining_allocation = sum(current_allocations.get(t, 0) for t in remaining_tickers)
                    
                    if remaining_allocation > 0:
                        # Redistribute excluded allocation proportionally
                        for ticker in remaining_tickers:
                            proportion = current_allocations[ticker] / remaining_allocation
                            current_allocations[ticker] += excluded_allocation * proportion
                    else:
                        # If no remaining tickers have allocation, distribute equally
                        equal_allocation = excluded_allocation / len(remaining_tickers)
                        for ticker in remaining_tickers:
                            current_allocations[ticker] = equal_allocation
                elif 'CASH' in current_allocations:
                    # If only CASH remains, give all to CASH
                    current_allocations['CASH'] += excluded_allocation
                else:
                    # No tickers remain, allocate to CASH
                    current_allocations['CASH'] = 1.0
        
        # Apply allocation filters in correct order: Max Allocation -> Min Threshold -> Max Allocation (two-pass system)
        use_max_allocation = config.get('use_max_allocation', False)
        max_allocation_percent = config.get('max_allocation_percent', 20.0)
        use_threshold = config.get('use_minimal_threshold', False)
        threshold_percent = config.get('minimal_threshold_percent', 4.0)
        
        # Build dictionary of individual ticker caps from stock configs
        individual_caps = {}
        for stock in config.get('stocks', []):
            ticker = stock.get('ticker', '')
            individual_cap = stock.get('max_allocation_percent', None)
            if individual_cap is not None and individual_cap > 0:
                individual_caps[ticker] = individual_cap / 100.0
        
        # Apply caps if either global cap is enabled OR any individual caps exist
        if (use_max_allocation or individual_caps) and current_allocations:
            max_allocation_decimal = max_allocation_percent / 100.0
            
            # FIRST PASS: Apply maximum allocation filter (EXCLUDE CASH from max_allocation limit)
            capped_allocations = {}
            excess_allocation = 0.0
            
            for ticker, allocation in current_allocations.items():
                # CASH is exempt from max_allocation limit to prevent money loss
                if ticker == 'CASH':
                    capped_allocations[ticker] = allocation
                else:
                    # Use individual cap if available, otherwise use global cap
                    ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                    
                    if allocation > ticker_cap:
                        # Cap the allocation and collect excess
                        capped_allocations[ticker] = ticker_cap
                        excess_allocation += (allocation - ticker_cap)
                    else:
                        # Keep original allocation
                        capped_allocations[ticker] = allocation
            
            # Redistribute excess allocation proportionally among stocks that are below the cap
            if excess_allocation > 0:
                # Find stocks that can receive more allocation (below their individual cap) - include CASH as eligible
                eligible_stocks = {}
                for ticker, allocation in capped_allocations.items():
                    if ticker == 'CASH':
                        eligible_stocks[ticker] = allocation
                    else:
                        ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                        if allocation < ticker_cap:
                            eligible_stocks[ticker] = allocation
                
                if eligible_stocks:
                    # Calculate total allocation of eligible stocks
                    total_eligible_allocation = sum(eligible_stocks.values())
                    
                    if total_eligible_allocation > 0:
                        # Redistribute excess proportionally
                        for ticker in eligible_stocks:
                            proportion = eligible_stocks[ticker] / total_eligible_allocation
                            additional_allocation = excess_allocation * proportion
                            new_allocation = capped_allocations[ticker] + additional_allocation
                            
                            # CASH can receive unlimited allocation, other stocks are capped
                            if ticker == 'CASH':
                                capped_allocations[ticker] = new_allocation
                            else:
                                # Make sure we don't exceed the individual ticker's cap
                                ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                capped_allocations[ticker] = min(new_allocation, ticker_cap)
            
            current_allocations = capped_allocations
        
        # Apply minimal threshold filter for non-momentum strategies
        if use_threshold and current_allocations:
            threshold_decimal = threshold_percent / 100.0
            
            # First: Filter out stocks below threshold
            filtered_allocations = {}
            for ticker, allocation in current_allocations.items():
                if allocation >= threshold_decimal:
                    # Keep stocks above or equal to threshold
                    filtered_allocations[ticker] = allocation
            
            # Then: Normalize remaining stocks to sum to 1
            if filtered_allocations:
                total_allocation = sum(filtered_allocations.values())
                if total_allocation > 0:
                    current_allocations = {ticker: allocation / total_allocation for ticker, allocation in filtered_allocations.items()}
                else:
                    current_allocations = {}
            else:
                # If no stocks meet threshold, keep original allocations
                current_allocations = current_allocations
        
        # SECOND PASS: Apply maximum allocation filter again (in case normalization created new excess)
        if (use_max_allocation or individual_caps) and current_allocations:
            max_allocation_decimal = max_allocation_percent / 100.0
            
            # Check if any stocks exceed the cap after threshold filtering and normalization
            capped_allocations = {}
            excess_allocation = 0.0
            
            for ticker, allocation in current_allocations.items():
                # CASH is exempt from max_allocation limit to prevent money loss
                if ticker == 'CASH':
                    capped_allocations[ticker] = allocation
                else:
                    # Use individual cap if available, otherwise use global cap
                    ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                    
                    if allocation > ticker_cap:
                        # Cap the allocation and collect excess
                        capped_allocations[ticker] = ticker_cap
                        excess_allocation += (allocation - ticker_cap)
                    else:
                        # Keep original allocation
                        capped_allocations[ticker] = allocation
            
            # Redistribute excess allocation proportionally among stocks that are below the cap
            if excess_allocation > 0:
                # Find stocks that can receive more allocation (below their individual cap) - include CASH as eligible
                eligible_stocks = {}
                for ticker, allocation in capped_allocations.items():
                    if ticker == 'CASH':
                        eligible_stocks[ticker] = allocation
                    else:
                        ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                        if allocation < ticker_cap:
                            eligible_stocks[ticker] = allocation
                
                if eligible_stocks:
                    # Calculate total allocation of eligible stocks
                    total_eligible_allocation = sum(eligible_stocks.values())
                    
                    if total_eligible_allocation > 0:
                        # Redistribute excess proportionally
                        for ticker in eligible_stocks:
                            proportion = eligible_stocks[ticker] / total_eligible_allocation
                            additional_allocation = excess_allocation * proportion
                            new_allocation = capped_allocations[ticker] + additional_allocation
                            
                            # CASH can receive unlimited allocation, other stocks are capped
                            if ticker == 'CASH':
                                capped_allocations[ticker] = new_allocation
                            else:
                                # Make sure we don't exceed the individual ticker's cap
                                ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                capped_allocations[ticker] = min(new_allocation, ticker_cap)
            
            current_allocations = capped_allocations
    else:
        # For momentum portfolios, start with 100% CASH initially
        # Momentum weights will be applied on rebalancing dates
        current_allocations = {t: 0.0 for t in tickers}  # Start with 0% in all assets
        # Store initial metrics (will be updated on first rebalancing date)
        historical_metrics[sim_index[0]] = {t: {'Calculated_Weight': 0.0, 'Momentum': 0.0} for t in tickers}
    
    sum_alloc = sum(current_allocations.get(t,0) for t in tickers)
    if sum_alloc > 0:
        for t in tickers:
            values[t][0] = initial_value * current_allocations.get(t,0) / sum_alloc
        unallocated_cash[0] = 0
    else:
        unallocated_cash[0] = initial_value
    
    historical_allocations[sim_index[0]] = {t: values[t][0] / initial_value if initial_value > 0 else 0 for t in tickers}
    historical_allocations[sim_index[0]]['CASH'] = unallocated_cash[0] / initial_value if initial_value > 0 else 0
    
    # Daily Treasury yield on idle cash (^IRX family via get_risk_free_rate_robust), optional
    # One fetch per backtest; 0% daily if no Treasury data / failure / pre-history (plain cash)
    rf_daily_by_i = None
    if config.get('idle_cash_earns_treasury_yield', False):
        try:
            _rf = get_risk_free_rate_robust(
                pd.DatetimeIndex(sim_index),
                before_first_quote_daily=0.0,
                fallback_zeros_on_failure=True,
            )
            a = np.asarray(_rf.values, dtype=np.float64)
            np.nan_to_num(a, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
            np.clip(a, -0.02 / 365.25, 0.02, out=a)
            rf_daily_by_i = a
        except Exception:
            rf_daily_by_i = None
    
    # Day-loop constants hoisted out of the loop (same values the legacy loop recomputed every day).
    _dates_rebal_normalized = {pd.Timestamp(d).normalize() for d in dates_rebal}
    _collect_as_cash = config.get('collect_dividends_as_cash', False)
    _yield_on = config.get('idle_cash_earns_treasury_yield', False)
    _ma_cross_rebalance = config.get('ma_cross_rebalance', False)
    _day = _accel_day_readers(_acc, reindexed_data, tickers, sim_index)
    _sim_dates = list(sim_index)
    # Per-day flags computed once (the legacy loop rebuilt the rebalancing set every day).
    _is_rebal = [d.normalize() in _dates_rebal_normalized for d in _sim_dates]
    _is_added = [d in dates_added for d in _sim_dates]
    # Per-ticker state in ticker order (sums below add in the same order as the legacy generators).
    _vl = [values[t] for t in tickers]
    _rows = [(t, values[t], _day.get(t), bool(include_dividends.get(t, False))) for t in tickers]
    for i in range(len(sim_index)):
        # Check for interrupt every 5 iterations (much more frequent)
        if i % 5 == 0:
            # Check if interrupt was requested
            if hasattr(st.session_state, 'hard_kill_requested') and st.session_state.hard_kill_requested:
                print("🛑 Hard kill requested - stopping backtest")
                break
        
        date = _sim_dates[i]
        if i == 0: continue
        
        date_prev = _sim_dates[i-1]
        total_unreinvested_dividends = 0
        stocks_prev = sum([_v[-1] for _v in _vl])
        uc_prev = unallocated_cash[-1]
        ur_prev = unreinvested_cash[-1]
        for t, _vals, _r, _inc in _rows:
            if _r is not None:
                # Aligned frame: positional reads, same values as the .loc lookups below.
                price_prev = _r.close[i - 1]
                val_prev = _vals[-1]
                div = _r.div[i] if _r.div is not None else 0.0
                var = _r.pchg[i]
                if _inc:
                    if _collect_as_cash and div > 0:
                        nb_shares = val_prev / price_prev if price_prev > 0 else 0
                        dividend_cash = nb_shares * div
                        total_unreinvested_dividends += dividend_cash
                        rate_of_return = var
                        val_new = val_prev * (1 + rate_of_return)
                    else:
                        if _r.leveraged:
                            if _r.base_close is not None:
                                base_price_prev = _r.base_close[i - 1]
                                dividend_rate = div / base_price_prev if base_price_prev > 0 else 0
                                rate_of_return = var + dividend_rate
                            else:
                                rate_of_return = var + (div / price_prev if price_prev > 0 else 0)
                        else:
                            rate_of_return = var + (div / price_prev if price_prev > 0 else 0)
                        val_new = val_prev * (1 + rate_of_return)
                else:
                    val_new = val_prev * (1 + var)
                _vals.append(val_new)
                continue
            df = reindexed_data[t]
            price_prev = df.loc[date_prev, "Close"]
            val_prev = values[t][-1]
            # --- Dividend fix: find the correct trading day for dividend ---
            div = 0.0
            # CRITICAL FIX: For leveraged tickers, get dividends from the base ticker, not the leveraged ticker
            if "?L=" in t or "?E=" in t:
                # For leveraged tickers, get dividend data from the base ticker
                base_ticker, leverage, expense_ratio = parse_ticker_parameters(t)
                if base_ticker in reindexed_data:
                    base_df = reindexed_data[base_ticker]
                    if "Dividends" in base_df.columns:
                        if date in base_df.index:
                            div = base_df.loc[date, "Dividends"]
                        else:
                            # Find next trading day in index after 'date'
                            future_dates = base_df.index[base_df.index > date]
                            if len(future_dates) > 0:
                                div = base_df.loc[future_dates[0], "Dividends"]
            else:
                # For regular tickers, get dividend data normally
                if "Dividends" in df.columns:
                    if date in df.index:
                        div = df.loc[date, "Dividends"]
                    else:
                        # Find next trading day in index after 'date'
                        future_dates = df.index[df.index > date]
                        if len(future_dates) > 0:
                            div = df.loc[future_dates[0], "Dividends"]
            var = df.loc[date, "Price_change"] if date in df.index else 0.0
            
            # Expense ratio is already applied in apply_daily_leverage() when data is fetched
            # No need to re-apply it here (would be double application + slow loop)
            
            if include_dividends.get(t, False):
                # Check if dividends should be collected as cash instead of reinvested
                collect_as_cash = config.get('collect_dividends_as_cash', False)
                if collect_as_cash and div > 0:
                    # Calculate dividend cash and add to unreinvested cash
                    nb_shares = val_prev / price_prev if price_prev > 0 else 0
                    dividend_cash = nb_shares * div
                    total_unreinvested_dividends += dividend_cash
                    # Don't include dividend in rate of return
                    rate_of_return = var
                    val_new = val_prev * (1 + rate_of_return)
                else:
                    # Reinvest dividends (original behavior)
                    # CRITICAL FIX: For leveraged tickers, dividends should be handled differently
                    # When simulating leveraged ETFs, the dividend RATE should be the same as the base asset
                    if "?L=" in t or "?E=" in t:
                        # For leveraged tickers, get the base ticker's dividend rate (not amount)
                        base_ticker, leverage, expense_ratio = parse_ticker_parameters(t)
                        if base_ticker in reindexed_data:
                            base_df = reindexed_data[base_ticker]
                            base_price_prev = base_df.loc[date_prev, "Close"]
                            # Use the base ticker's dividend rate, not the leveraged amount
                            dividend_rate = div / base_price_prev if base_price_prev > 0 else 0
                            rate_of_return = var + dividend_rate
                        else:
                            # Fallback: use leveraged price (may cause issues)
                            rate_of_return = var + (div / price_prev if price_prev > 0 else 0)
                    else:
                        # For regular tickers, use normal dividend reinvestment
                        rate_of_return = var + (div / price_prev if price_prev > 0 else 0)
                    
                    # Calculate val_new for both leveraged and regular tickers
                    val_new = val_prev * (1 + rate_of_return)
            else:
                val_new = val_prev * (1 + var)
            values[t].append(val_new)
        unallocated_cash.append(unallocated_cash[-1])
        if _is_added[i]:
            unallocated_cash[-1] += added_amount
        unreinvested_cash.append(unreinvested_cash[-1] + total_unreinvested_dividends)
        
        dr_eff = 0.0
        if rf_daily_by_i is not None and i < len(rf_daily_by_i):
            dr_eff = float(rf_daily_by_i[i])
        if not (np.isfinite(dr_eff) and dr_eff > -0.99):
            dr_eff = 0.0
        yf = (1.0 + dr_eff) if _yield_on else 1.0
        if yf != 1.0:
            if unallocated_cash[-1] > 0:
                unallocated_cash[-1] *= yf
            if unreinvested_cash[-1] > 0:
                unreinvested_cash[-1] *= yf
        
        stocks_after = sum([_v[-1] for _v in _vl])
        prev_total = stocks_prev + uc_prev + ur_prev
        if prev_total > 0:
            new_total_na = stocks_after + uc_prev * yf + (ur_prev + total_unreinvested_dividends) * yf
            portfolio_no_additions.append(portfolio_no_additions[-1] * (new_total_na / prev_total))
        else:
            portfolio_no_additions.append(portfolio_no_additions[-1])
        
        current_total = sum([_v[-1] for _v in _vl]) + unallocated_cash[-1] + unreinvested_cash[-1]
        
        # Check if we should rebalance
        should_rebalance = False
        
        # First check if it's a regular rebalancing date
        # Normalize dates for comparison (remove timezone and time components)
        _rebal_today = _is_rebal[i]
        
        # Check for MA cross rebalancing (if enabled) - ULTRA OPTIMIZED!
        ma_cross_rebalance = _ma_cross_rebalance
        if ma_cross_rebalance and ma_crossings_data is not None:
            # ULTRA FAST: Just check if this date has precomputed crossings!
            if date in ma_crossings_data:
                crossed_assets = list(ma_crossings_data[date].keys())
                should_rebalance = True
                print(f"[MA CROSS] Detected confirmed MA cross for {crossed_assets} at {date} (precomputed), triggering immediate rebalancing")
        
        if _rebal_today and set(tickers):
            # If targeted rebalancing is enabled, check thresholds first
            if config.get('use_targeted_rebalancing', False):
                # Calculate current allocations as percentages
                current_total = sum(values[t][-1] for t in tickers) + unallocated_cash[-1] + unreinvested_cash[-1]
                if current_total > 0:
                    current_allocations = {t: values[t][-1] / current_total for t in tickers}
                    
                    # Check if any ticker exceeds its targeted rebalancing thresholds
                    targeted_settings = config.get('targeted_rebalancing_settings', {})
                    threshold_exceeded = False
                    
                    for ticker in tickers:
                        if ticker in targeted_settings and targeted_settings[ticker].get('enabled', False):
                            current_allocation_pct = current_allocations.get(ticker, 0) * 100
                            max_threshold = targeted_settings[ticker].get('max_allocation', 100.0)
                            min_threshold = targeted_settings[ticker].get('min_allocation', 0.0)
                            
                            # Check if allocation exceeds max or falls below min threshold
                            if current_allocation_pct > max_threshold or current_allocation_pct < min_threshold:
                                threshold_exceeded = True
                                break
                    
                    # Only rebalance if thresholds are exceeded
                    should_rebalance = threshold_exceeded
                else:
                    # If no current value, don't rebalance
                    should_rebalance = False
            else:
                # Regular rebalancing - always rebalance on scheduled dates
                should_rebalance = True
        elif rebalancing_frequency in ["Buy & Hold", "Buy & Hold (Target)"] and set(tickers):
            # Buy & Hold: rebalance whenever there's cash available
            total_cash = unallocated_cash[-1] + unreinvested_cash[-1]
            if total_cash > 0:
                should_rebalance = True
        
        # Handle cash distribution when no rebalancing occurs but cash is available
        if not should_rebalance:
            total_cash = unallocated_cash[-1] + unreinvested_cash[-1]
            if total_cash > 0:
                # Distribute cash proportionally to current holdings
                current_total_value = sum(values[t][-1] for t in tickers)
                if current_total_value > 0:
                    # Calculate current proportions
                    current_proportions = {t: values[t][-1] / current_total_value for t in tickers}
                    
                    # Distribute cash proportionally
                    for t in tickers:
                        values[t][-1] += total_cash * current_proportions.get(t, 0)
                    
                    # Clear cash
                    unallocated_cash[-1] = 0
                    unreinvested_cash[-1] = 0
        
        if should_rebalance:
            if use_momentum:
                # Apply S&P 500 entry + MA filters BEFORE calculating momentum
                assets_to_calculate = filter_tickers_by_sp500_entry(tickers, date, config)
                if _universe_filters_active(config) and not assets_to_calculate:
                    for t in tickers:
                        values[t][-1] = 0
                    unallocated_cash[-1] = current_total
                    unreinvested_cash[-1] = 0
                    continue
                assets_to_calculate = set(assets_to_calculate)
                if config.get('use_sma_filter', False) and ma_filter_data is not None:
                    # ULTRA FAST: Use precomputed filter results!
                    filtered_assets = [t for t in assets_to_calculate if ma_filter_data.get(date, {}).get(t, True)]
                    
                    # If no assets remain after MA filtering, go to cash immediately
                    if not filtered_assets:
                        print(f"[MA FILTER] All assets excluded at {date}, going to cash")
                        for t in tickers:
                            values[t][-1] = 0
                        unallocated_cash[-1] = current_total
                        unreinvested_cash[-1] = 0
                        # Skip rest of rebalancing logic
                        continue
                    
                    # Only calculate momentum for filtered assets
                    assets_to_calculate = filtered_assets
                    excluded_assets = [t for t in tickers if t not in filtered_assets]
                    print(f"[MA FILTER] Assets after MA filter at {date}: {filtered_assets}, excluded: {excluded_assets}")
                
                returns, valid_assets = calculate_momentum(date, assets_to_calculate, momentum_windows, config['stocks'])
                if valid_assets:
                    weights, metrics_on_rebal = calculate_momentum_weights(
                        returns, valid_assets, date=date,
                        momentum_strategy=config.get('momentum_strategy', 'Classic'),
                        negative_momentum_strategy=config.get('negative_momentum_strategy', 'Cash'),
                        config=config
                    )
                    historical_metrics[date] = metrics_on_rebal
                    
                    # Apply MA filter to weights: set excluded assets to 0 and redistribute (ULTRA OPTIMIZED!)
                    if config.get('use_sma_filter', False) and ma_filter_data is not None:
                        # ULTRA FAST: Use precomputed filter results!
                        filtered_assets = [t for t in tickers if ma_filter_data.get(date, {}).get(t, True)]
                        excluded_assets = {t: f"Below MA" for t in tickers if t not in filtered_assets}
                        
                        if excluded_assets:
                            excluded_ticker_list = list(excluded_assets.keys())
                            excluded_weight = sum(weights.get(t, 0) for t in excluded_ticker_list)
                            
                            # Remove excluded tickers from weights
                            for excluded_ticker in excluded_ticker_list:
                                if excluded_ticker in weights:
                                    del weights[excluded_ticker]
                            
                            # Redistribute excluded weight among remaining tickers
                            remaining_tickers = [t for t in weights.keys() if t != 'CASH']
                            if remaining_tickers and excluded_weight > 0:
                                remaining_weight = sum(weights.get(t, 0) for t in remaining_tickers)
                                if remaining_weight > 0:
                                    for ticker in remaining_tickers:
                                        proportion = weights[ticker] / remaining_weight
                                        weights[ticker] += excluded_weight * proportion
                                else:
                                    # Equal distribution
                                    equal_weight = excluded_weight / len(remaining_tickers)
                                    for ticker in remaining_tickers:
                                        weights[ticker] = equal_weight
                            elif excluded_weight > 0:
                                # No remaining tickers, all goes to CASH
                                weights['CASH'] = weights.get('CASH', 0) + excluded_weight
                    
                    if all(w == 0 for w in weights.values()):
                        # All cash: move total to unallocated_cash, set asset values to zero
                        # This happens when negative_momentum_strategy is 'Cash' and all momentum scores are negative
                        for t in tickers:
                            values[t][-1] = 0
                        unallocated_cash[-1] = current_total
                        unreinvested_cash[-1] = 0
                    else:
                        # Apply max_allocation to momentum weights if enabled
                        use_max_allocation = config.get('use_max_allocation', False)
                        max_allocation_percent = config.get('max_allocation_percent', 20.0)
                        
                        # Build dictionary of individual ticker caps from stock configs
                        individual_caps = {}
                        for stock in config.get('stocks', []):
                            ticker = stock.get('ticker', '')
                            individual_cap = stock.get('max_allocation_percent', None)
                            if individual_cap is not None and individual_cap > 0:
                                individual_caps[ticker] = individual_cap / 100.0
                        
                        # Apply caps if either global cap is enabled OR any individual caps exist
                        if (use_max_allocation or individual_caps) and weights:
                            max_allocation_decimal = max_allocation_percent / 100.0
                            
                            # Apply maximum allocation filter to momentum weights (EXCLUDE CASH from max_allocation limit)
                            capped_weights = {}
                            excess_weight = 0.0
                            
                            for ticker, weight in weights.items():
                                # CASH is exempt from max_allocation limit to prevent money loss
                                if ticker == 'CASH':
                                    capped_weights[ticker] = weight
                                else:
                                    # Use individual cap if available, otherwise use global cap
                                    ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                    
                                    if weight > ticker_cap:
                                        # Cap the weight and collect excess
                                        capped_weights[ticker] = ticker_cap
                                        excess_weight += (weight - ticker_cap)
                                    else:
                                        # Keep original weight
                                        capped_weights[ticker] = weight
                            
                            # Redistribute excess weight proportionally among stocks that are below the cap
                            if excess_weight > 0:
                                # Find stocks that can receive more weight (below their individual cap) - include CASH as eligible
                                eligible_stocks = {}
                                for ticker, weight in capped_weights.items():
                                    if ticker == 'CASH':
                                        eligible_stocks[ticker] = weight
                                    else:
                                        ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                        if weight < ticker_cap:
                                            eligible_stocks[ticker] = weight
                                
                                if eligible_stocks:
                                    # Calculate total weight of eligible stocks
                                    total_eligible_weight = sum(eligible_stocks.values())
                                    
                                    if total_eligible_weight > 0:
                                        # Redistribute excess proportionally
                                        for ticker in eligible_stocks:
                                            proportion = eligible_stocks[ticker] / total_eligible_weight
                                            additional_weight = excess_weight * proportion
                                            new_weight = capped_weights[ticker] + additional_weight
                                            
                                            # CASH can receive unlimited weight, other stocks are capped
                                            if ticker == 'CASH':
                                                capped_weights[ticker] = new_weight
                                            else:
                                                # Make sure we don't exceed the individual ticker's cap
                                                ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                                capped_weights[ticker] = min(new_weight, ticker_cap)
                            
                            weights = capped_weights
                            
                            # Final normalization to 100% in case not enough stocks to distribute excess
                            total_weight = sum(weights.values())
                            if total_weight > 0:
                                weights = {ticker: weight / total_weight for ticker, weight in weights.items()}
                        
                        # For Buy & Hold strategies with momentum, only distribute new cash
                        if rebalancing_frequency in ["Buy & Hold", "Buy & Hold (Target)"]:
                            # Calculate current proportions for Buy & Hold, or use momentum weights for Buy & Hold (Target)
                            if rebalancing_frequency == "Buy & Hold":
                                # Use current proportions from existing holdings
                                current_total_value = sum(values[t][-1] for t in tickers)
                                if current_total_value > 0:
                                    current_proportions = {t: values[t][-1] / current_total_value for t in tickers}
                                else:
                                    # If no current holdings, use equal weights
                                    current_proportions = {t: 1.0 / len(tickers) for t in tickers}
                            else:  # "Buy & Hold (Target)"
                                # Use momentum weights
                                current_proportions = weights
                            
                            # Only distribute the new cash (unallocated_cash + unreinvested_cash)
                            cash_to_distribute = unallocated_cash[-1] + unreinvested_cash[-1]
                            for t in tickers:
                                # Add new cash proportionally to existing holdings
                                values[t][-1] += cash_to_distribute * current_proportions.get(t, 0)
                            unreinvested_cash[-1] = 0
                            unallocated_cash[-1] = 0
                        else:
                            # Normal momentum rebalancing: replace all holdings
                            for t in tickers:
                                values[t][-1] = current_total * weights.get(t, 0)
                            unreinvested_cash[-1] = 0
                            unallocated_cash[-1] = 0
                            
                            # Verify total is preserved
                            new_total = sum(values[t][-1] for t in tickers) + unallocated_cash[-1] + unreinvested_cash[-1]
                            if abs(new_total - current_total) > 0.01:
                                print(f"[WARNING] Money loss at {date}: before={current_total:.2f}, after={new_total:.2f}, weights={weights}")
                else:
                    # No valid assets after SMA filtering -> go to cash (same as momentum strategy)
                    print(f"[SMA] Going to cash at {date}: current_total={current_total:.2f}, values before={[values[t][-1] for t in tickers]}")
                    for t in tickers:
                        values[t][-1] = 0
                    unallocated_cash[-1] = current_total
                    unreinvested_cash[-1] = 0
                    print(f"[SMA] After: unallocated_cash={unallocated_cash[-1]:.2f}, values after={[values[t][-1] for t in tickers]}")
            else:
                # Apply allocation filters in correct order: Max Allocation -> Min Threshold -> Max Allocation (two-pass system)
                use_max_allocation = config.get('use_max_allocation', False)
                max_allocation_percent = config.get('max_allocation_percent', 10.0)
                use_threshold = config.get('use_minimal_threshold', False)
                threshold_percent = config.get('minimal_threshold_percent', 2.0)
                apply_caps_before_top_n = False
                
                # Start with original allocations
                rebalance_allocations = {t: allocations.get(t, 0) for t in tickers}
                
                # Apply MA / S&P 500 entry filters (for non-momentum strategies)
                if (config.get('use_sma_filter', False) and ma_filter_data is not None) or _universe_filters_active(config):
                    # Get list of current tickers (excluding CASH)
                    current_tickers = [t for t in tickers if t != 'CASH']
                    filtered_tickers = list(current_tickers)
                    if config.get('use_sma_filter', False) and ma_filter_data is not None:
                        filtered_tickers = [t for t in filtered_tickers if ma_filter_data.get(date, {}).get(t, True)]
                    filtered_tickers = filter_tickers_by_sp500_entry(filtered_tickers, date, config)
                    excluded_assets = {t: "Excluded by filter" for t in current_tickers if t not in filtered_tickers}
                    
                    
                    # Redistribute allocations of excluded tickers proportionally among remaining tickers
                    if excluded_assets:
                        excluded_tickers = list(excluded_assets.keys())
                        excluded_allocation = sum(rebalance_allocations.get(t, 0) for t in excluded_tickers)
                        
                        # Set excluded tickers allocation to 0
                        for t in excluded_tickers:
                            rebalance_allocations[t] = 0
                        
                        # If no tickers remain, go to cash
                        if not filtered_tickers:
                            # Put everything in unallocated_cash
                            for t in tickers:
                                values[t][-1] = 0
                            unallocated_cash[-1] = current_total
                            unreinvested_cash[-1] = 0
                            # Clear rebalance_allocations so rest of rebalancing logic is skipped
                            rebalance_allocations = {t: 0 for t in tickers}
                        else:
                            # Redistribute excluded allocation among remaining tickers
                            if excluded_allocation > 0 and filtered_tickers:
                                total_remaining_allocation = sum(rebalance_allocations.get(t, 0) for t in filtered_tickers)
                                if total_remaining_allocation > 0:
                                    # Redistribute proportionally among remaining tickers
                                    for t in filtered_tickers:
                                        proportion = rebalance_allocations.get(t, 0) / total_remaining_allocation
                                        rebalance_allocations[t] += excluded_allocation * proportion
                                else:
                                    # If no remaining allocation, distribute equally
                                    equal_allocation = excluded_allocation / len(filtered_tickers)
                                    for t in filtered_tickers:
                                        rebalance_allocations[t] = equal_allocation
                    
                
                if use_max_allocation and rebalance_allocations:
                    max_allocation_decimal = max_allocation_percent / 100.0
                    
                    # FIRST PASS: Apply maximum allocation filter
                    capped_allocations = {}
                    excess_allocation = 0.0
                    
                    for ticker, allocation in rebalance_allocations.items():
                        # CASH is exempt from max_allocation limit to prevent money loss
                        if ticker == 'CASH':
                            capped_allocations[ticker] = allocation
                        elif allocation > max_allocation_decimal:
                            # Cap the allocation and collect excess
                            capped_allocations[ticker] = max_allocation_decimal
                            excess_allocation += (allocation - max_allocation_decimal)
                        else:
                            # Keep original allocation
                            capped_allocations[ticker] = allocation
                    
                    # Redistribute excess allocation proportionally among stocks that are below the cap
                    if excess_allocation > 0:
                        # Find stocks that can receive more allocation (below the cap) - include CASH as eligible
                        eligible_stocks = {ticker: allocation for ticker, allocation in capped_allocations.items() 
                                         if ticker == 'CASH' or allocation < max_allocation_decimal}
                        
                        if eligible_stocks:
                            # Calculate total allocation of eligible stocks
                            total_eligible_allocation = sum(eligible_stocks.values())
                            
                            if total_eligible_allocation > 0:
                                # Redistribute excess proportionally
                                for ticker in eligible_stocks:
                                    proportion = eligible_stocks[ticker] / total_eligible_allocation
                                    additional_allocation = excess_allocation * proportion
                                    new_allocation = capped_allocations[ticker] + additional_allocation
                                    
                                    # CASH can receive unlimited allocation, other stocks are capped
                                    if ticker == 'CASH':
                                        capped_allocations[ticker] = new_allocation
                                    else:
                                        # Make sure we don't exceed the cap
                                        capped_allocations[ticker] = min(new_allocation, max_allocation_decimal)
                    
                    rebalance_allocations = capped_allocations
                    
                    # Final normalization to 100% in case not enough stocks to distribute excess
                    total_alloc = sum(rebalance_allocations.values())
                    if total_alloc > 0:
                        rebalance_allocations = {ticker: allocation / total_alloc for ticker, allocation in rebalance_allocations.items()}
                
                # Apply minimal threshold filter for non-momentum strategies during rebalancing
                if use_threshold and rebalance_allocations:
                    threshold_decimal = threshold_percent / 100.0
                    
                    # First: Filter out stocks below threshold
                    filtered_allocations = {}
                    for t in tickers:
                        allocation = rebalance_allocations.get(t, 0)
                        if allocation >= threshold_decimal:
                            # Keep stocks above or equal to threshold
                            filtered_allocations[t] = allocation
                    
                    # Then: Normalize remaining stocks to sum to 1
                    if filtered_allocations:
                        total_allocation = sum(filtered_allocations.values())
                        if total_allocation > 0:
                            rebalance_allocations = {t: allocation / total_allocation for t, allocation in filtered_allocations.items()}
                        else:
                            rebalance_allocations = {}
                    else:
                        # If no stocks meet threshold, use original allocations
                        rebalance_allocations = {t: allocations.get(t, 0) for t in tickers}
                
                # SECOND PASS: Apply maximum allocation filter again (in case normalization created new excess)
                if use_max_allocation and rebalance_allocations:
                    max_allocation_decimal = max_allocation_percent / 100.0
                    
                    # Check if any stocks exceed the cap after threshold filtering and normalization
                    capped_allocations = {}
                    excess_allocation = 0.0
                    
                    for ticker, allocation in rebalance_allocations.items():
                        # CASH is exempt from max_allocation limit to prevent money loss
                        if ticker == 'CASH':
                            capped_allocations[ticker] = allocation
                        elif allocation > max_allocation_decimal:
                            # Cap the allocation and collect excess
                            capped_allocations[ticker] = max_allocation_decimal
                            excess_allocation += (allocation - max_allocation_decimal)
                        else:
                            # Keep original allocation
                            capped_allocations[ticker] = allocation
                    
                    # Redistribute excess allocation proportionally among stocks that are below the cap
                    if excess_allocation > 0:
                        # Find stocks that can receive more allocation (below the cap) - include CASH as eligible
                        eligible_stocks = {ticker: allocation for ticker, allocation in capped_allocations.items() 
                                         if ticker == 'CASH' or allocation < max_allocation_decimal}
                        
                        if eligible_stocks:
                            # Calculate total allocation of eligible stocks
                            total_eligible_allocation = sum(eligible_stocks.values())
                            
                            if total_eligible_allocation > 0:
                                # Redistribute excess proportionally
                                for ticker in eligible_stocks:
                                    proportion = eligible_stocks[ticker] / total_eligible_allocation
                                    additional_allocation = excess_allocation * proportion
                                    new_allocation = capped_allocations[ticker] + additional_allocation
                                    
                                    # CASH can receive unlimited allocation, other stocks are capped
                                    if ticker == 'CASH':
                                        capped_allocations[ticker] = new_allocation
                                    else:
                                        # Make sure we don't exceed the cap
                                        capped_allocations[ticker] = min(new_allocation, max_allocation_decimal)
                    
                    rebalance_allocations = capped_allocations
                    
                    # Final normalization to 100% in case not enough stocks to distribute excess
                    total_alloc = sum(rebalance_allocations.values())
                    if total_alloc > 0:
                        rebalance_allocations = {ticker: allocation / total_alloc for ticker, allocation in rebalance_allocations.items()}
                
                sum_alloc = sum(rebalance_allocations.values())
                if sum_alloc > 0:
                    # For Buy & Hold strategies, only distribute new cash without touching existing holdings
                    if rebalancing_frequency in ["Buy & Hold", "Buy & Hold (Target)"]:
                        # Calculate current proportions for Buy & Hold, or use target allocations for Buy & Hold (Target)
                        if rebalancing_frequency == "Buy & Hold":
                            # Use current proportions from existing holdings
                            current_total_value = sum(values[t][-1] for t in tickers)
                            if current_total_value > 0:
                                current_proportions = {t: values[t][-1] / current_total_value for t in tickers}
                            else:
                                # If no current holdings, use equal weights
                                current_proportions = {t: 1.0 / len(tickers) for t in tickers}
                        else:  # "Buy & Hold (Target)"
                            # Use target allocations
                            current_proportions = {t: rebalance_allocations.get(t, 0) / sum_alloc for t in tickers}
                        
                        # Only distribute the new cash (unallocated_cash + unreinvested_cash)
                        cash_to_distribute = unallocated_cash[-1] + unreinvested_cash[-1]
                        for t in tickers:
                            # Add new cash proportionally to existing holdings
                            values[t][-1] += cash_to_distribute * current_proportions.get(t, 0)
                        unreinvested_cash[-1] = 0
                        unallocated_cash[-1] = 0
                    else:
                        # Normal rebalancing: replace all holdings
                        # For targeted rebalancing, rebalance TO THE THRESHOLD LIMITS, not to base allocations
                        if config.get('use_targeted_rebalancing', False):
                            targeted_settings = config.get('targeted_rebalancing_settings', {})
                            target_allocations = {}
                            
                            # Calculate target allocations based on threshold limits
                            for t in tickers:
                                if t in targeted_settings and targeted_settings[t].get('enabled', False):
                                    current_allocation_pct = (values[t][-1] / current_total) * 100 if current_total > 0 else 0
                                    max_threshold = targeted_settings[t].get('max_allocation', 100.0)
                                    min_threshold = targeted_settings[t].get('min_allocation', 0.0)
                                    
                                    # Rebalance to the threshold limit that was exceeded
                                    if current_allocation_pct > max_threshold:
                                        target_allocations[t] = max_threshold / 100.0
                                    elif current_allocation_pct < min_threshold:
                                        target_allocations[t] = min_threshold / 100.0
                                    else:
                                        # Within bounds - keep current allocation
                                        target_allocations[t] = current_allocation_pct / 100.0
                                else:
                                    # Not in targeted settings - use current allocation
                                    target_allocations[t] = (values[t][-1] / current_total) if current_total > 0 else rebalance_allocations.get(t, 0)
                            
                            # For targeted rebalancing, calculate the remaining allocation for non-targeted tickers
                            total_targeted = 0
                            targeted_count = 0
                            
                            for t in tickers:
                                if t in targeted_settings and targeted_settings[t].get('enabled', False):
                                    total_targeted += target_allocations[t]
                                    targeted_count += 1
                            
                            # Calculate remaining allocation for non-targeted tickers
                            remaining_allocation = 1.0 - total_targeted
                            non_targeted_tickers = [t for t in tickers if t not in targeted_settings or not targeted_settings[t].get('enabled', False)]
                            
                            if non_targeted_tickers and remaining_allocation > 0:
                                # Distribute remaining allocation PROPORTIONALLY to base allocations (not equally)
                                non_targeted_base_sum = sum(rebalance_allocations.get(t, 0) for t in non_targeted_tickers)
                                if non_targeted_base_sum > 0:
                                    # Distribute proportionally to base allocations
                                    for t in non_targeted_tickers:
                                        base_proportion = rebalance_allocations.get(t, 0) / non_targeted_base_sum
                                        target_allocations[t] = base_proportion * remaining_allocation
                                else:
                                    # If no base allocations, distribute equally
                                    allocation_per_ticker = remaining_allocation / len(non_targeted_tickers)
                                    for t in non_targeted_tickers:
                                        target_allocations[t] = allocation_per_ticker
                            elif non_targeted_tickers:
                                # No remaining allocation - set non-targeted to 0
                                for t in non_targeted_tickers:
                                    target_allocations[t] = 0.0
                            
                            # Apply target allocations
                            for t in tickers:
                                values[t][-1] = current_total * target_allocations.get(t, 0)
                        else:
                            # Regular rebalancing - use base allocations
                            for t in tickers:
                                weight = rebalance_allocations.get(t, 0) / sum_alloc
                                values[t][-1] = current_total * weight
                        
                        unreinvested_cash[-1] = 0
                        unallocated_cash[-1] = 0
            
            # Note: Daily allocations will be stored below after rebalancing
        
        # Store daily allocations for smooth allocation evolution charts (AFTER rebalancing)
        # For "start oldest" mode, only include tickers that have data available at this date
        available_tickers_at_date = []
        for t in tickers:
            _r = _day.get(t)
            if _r is not None:
                if _r.first_ok[i]:
                    available_tickers_at_date.append(t)
                continue
            if t in reindexed_data:
                price_value = reindexed_data[t].loc[date]
                # Handle case where loc returns a Series instead of scalar
                if isinstance(price_value, pd.Series):
                    price_value = price_value.iloc[0] if len(price_value) > 0 else np.nan
                if not pd.isna(price_value):
                    available_tickers_at_date.append(t)
        
        current_total_after_rebal = sum(values[t][-1] for t in available_tickers_at_date) + unallocated_cash[-1] + unreinvested_cash[-1]
        if current_total_after_rebal > 0:
            daily_allocs = {t: values[t][-1] / current_total_after_rebal for t in available_tickers_at_date}
            daily_allocs['CASH'] = (unallocated_cash[-1] + unreinvested_cash[-1]) / current_total_after_rebal
            historical_allocations[date] = daily_allocs

    # Store last allocation
    last_date = sim_index[-1]
    last_total = sum(values[t][-1] for t in tickers) + unallocated_cash[-1] + unreinvested_cash[-1]
    if last_total > 0:
        historical_allocations[last_date] = {t: values[t][-1] / last_total for t in tickers}
        historical_allocations[last_date]['CASH'] = unallocated_cash[-1] / last_total if last_total > 0 else 0
    else:
        historical_allocations[last_date] = {t: 0 for t in tickers}
        historical_allocations[last_date]['CASH'] = 0
    
    # Store last metrics: always add a last-rebalance snapshot so the UI has a metrics row
    # If momentum is used, compute metrics; otherwise build metrics from the last allocation snapshot
    if use_momentum:
        returns, valid_assets = calculate_momentum(last_date, set(tickers), momentum_windows, config['stocks'])
        weights, metrics_on_rebal = calculate_momentum_weights(
            returns, valid_assets, date=last_date,
            momentum_strategy=config.get('momentum_strategy', 'Classic'),
            negative_momentum_strategy=config.get('negative_momentum_strategy', 'Cash'),
            config=config
        )
        # For momentum strategies, do NOT force add CASH - let the momentum strategy determine allocations
        # CASH should only be added if the momentum strategy itself decides to go to cash
        # (which happens when all momentum scores are negative and negative_momentum_strategy is 'Cash')
        historical_metrics[last_date] = metrics_on_rebal
    else:
        # Build a metrics snapshot from the last allocation so there's always a 'last rebalance' metrics entry
        if last_date in historical_allocations:
            alloc_snapshot = historical_allocations.get(last_date, {})
            metrics_on_rebal = {}
            for ticker_sym, alloc_val in alloc_snapshot.items():
                metrics_on_rebal[ticker_sym] = {'Calculated_Weight': alloc_val}
            # Ensure CASH entry exists
            if 'CASH' not in metrics_on_rebal:
                metrics_on_rebal['CASH'] = {'Calculated_Weight': alloc_snapshot.get('CASH', 0)}
            # Only set if not already present
            if last_date not in historical_metrics:
                historical_metrics[last_date] = metrics_on_rebal

    results = pd.DataFrame(index=sim_index)
    for t in tickers:
        results[f"Value_{t}"] = values[t]
    results["Unallocated_cash"] = unallocated_cash
    results["Unreinvested_cash"] = unreinvested_cash
    results["Total_assets"] = results[[f"Value_{t}" for t in tickers]].sum(axis=1)
    results["Total_with_dividends_plus_cash"] = results["Total_assets"] + results["Unallocated_cash"] + results["Unreinvested_cash"]
    results['Portfolio_Value_No_Additions'] = portfolio_no_additions

    return results["Total_with_dividends_plus_cash"], results['Portfolio_Value_No_Additions'], historical_allocations, historical_metrics
