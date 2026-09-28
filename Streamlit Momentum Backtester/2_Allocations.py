# ALLOCATIONS PAGE - WITH CACHE
# STANDALONE (same bootstrap as 1_Multi_Backtest - no yahoo_finance_setup)
import streamlit as st
import datetime
from datetime import timedelta, time
import pandas as pd
import numpy as np
import requests
import re
from bs4 import BeautifulSoup
import yfinance as yf
import plotly.graph_objects as go
import plotly.express as px
from plotly.subplots import make_subplots
import os
import diskcache as dc
from typing import Any

# Initialize API call counter
if 'api_call_count' not in st.session_state:
    st.session_state.api_call_count = 0

# Yahoo Finance Cache Functions
def get_ticker_with_cache(ticker_symbol: str) -> Any:
    """Get yf.Ticker object with 4-hour cache"""
    try:
        cache_key = f"ticker_obj_{ticker_symbol}"
        cache_dir = '.streamlit/ticker_cache'
        if not os.path.exists(cache_dir):
            os.makedirs(cache_dir, exist_ok=True)
        
        disk_cache = dc.Cache(cache_dir)
        cached_result = disk_cache.get(cache_key)
        if cached_result is not None:
            return cached_result
        
        ticker = yf.Ticker(ticker_symbol)
        st.session_state.api_call_count += 1
        disk_cache.set(cache_key, ticker, expire=14400)  # 4 hours
        return ticker
    except Exception:
        return yf.Ticker(ticker_symbol)

def get_ticker_history_with_cache(ticker_symbol: str, period: str = "max", auto_adjust: bool = False, 
                                 columns: list = None) -> pd.DataFrame:
    """Get ticker historical data with 4-hour cache"""
    try:
        cache_key = f"history_{ticker_symbol}_{period}_{auto_adjust}_{columns}"
        cache_dir = '.streamlit/ticker_cache'
        if not os.path.exists(cache_dir):
            os.makedirs(cache_dir, exist_ok=True)
        
        disk_cache = dc.Cache(cache_dir)
        cached_result = disk_cache.get(cache_key)
        if cached_result is not None:
            return cached_result
        
        ticker = yf.Ticker(ticker_symbol)
        st.session_state.api_call_count += 1
        hist = ticker.history(period=period, auto_adjust=auto_adjust)
        
        if columns and not hist.empty:
            available_columns = [col for col in columns if col in hist.columns]
            if available_columns:
                hist = hist[available_columns]
        
        disk_cache.set(cache_key, hist, expire=14400)  # 4 hours
        return hist
    except Exception:
        ticker = yf.Ticker(ticker_symbol)
        hist = ticker.history(period=period, auto_adjust=auto_adjust)
        if columns and not hist.empty:
            available_columns = [col for col in columns if col in hist.columns]
            if available_columns:
                hist = hist[available_columns]
        return hist

def get_ticker_info_with_cache(ticker_symbol: str) -> dict:
    """Get ticker info with 4-hour cache"""
    try:
        cache_key = f"info_{ticker_symbol}"
        cache_dir = '.streamlit/ticker_info_cache'
        if not os.path.exists(cache_dir):
            os.makedirs(cache_dir, exist_ok=True)
        
        disk_cache = dc.Cache(cache_dir)
        cached_result = disk_cache.get(cache_key)
        if cached_result is not None:
            return cached_result
        
        ticker = yf.Ticker(ticker_symbol)
        st.session_state.api_call_count += 1
        info = ticker.info
        disk_cache.set(cache_key, info, expire=14400)  # 4 hours
        return info
    except Exception:
        return {}

def get_batch_download_with_cache(ticker_list: list, period: str = "max", 
                                 auto_adjust: bool = False, **kwargs) -> pd.DataFrame:
    """Get batch download data with 4-hour cache"""
    try:
        cache_key = f"batch_{sorted(ticker_list)}_{period}_{auto_adjust}_{kwargs}"
        cache_dir = '.streamlit/ticker_cache'
        if not os.path.exists(cache_dir):
            os.makedirs(cache_dir, exist_ok=True)
        
        disk_cache = dc.Cache(cache_dir)
        cached_result = disk_cache.get(cache_key)
        if cached_result is not None:
            return cached_result
        
        batch_data = yf.download(ticker_list, period=period, auto_adjust=auto_adjust, **kwargs)
        st.session_state.api_call_count += 1
        disk_cache.set(cache_key, batch_data, expire=14400)  # 4 hours
        return batch_data
    except Exception:
        return yf.download(ticker_list, period=period, auto_adjust=auto_adjust, **kwargs)

def clear_all_yahoo_caches():
    """Clear all Yahoo Finance caches"""
    total_cleared = 0
    
    cache_dir = '.streamlit/ticker_cache'
    if os.path.exists(cache_dir):
        disk_cache = dc.Cache(cache_dir)
        cache_size = len(disk_cache)
        disk_cache.clear()
        total_cleared += cache_size
    
    info_cache_dir = '.streamlit/ticker_info_cache'
    if os.path.exists(info_cache_dir):
        info_cache = dc.Cache(info_cache_dir)
        info_cache_size = len(info_cache)
        info_cache.clear()
        total_cleared += info_cache_size
    
    return total_cleared

import json
import io
import contextlib
import warnings
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import matplotlib.dates as mdates
from reportlab.lib.pagesizes import letter, A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Image
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors as reportlab_colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
import base64
import os
import signal
import sys
import threading
import diskcache as dc
warnings.filterwarnings('ignore')

# =============================================================================
# CALCULATION FUNCTIONS (SAME AS PAGE 1)
# =============================================================================
def calculate_volatility(returns):
    """Calculate annualized volatility - same as page 1"""
    return returns.std() * np.sqrt(365.25) if len(returns) > 1 else np.nan

def calculate_beta(returns, benchmark_returns):
    """Calculate beta - same as page 1"""
    portfolio_returns = pd.Series(returns)
    benchmark_returns = pd.Series(benchmark_returns)
    common_idx = portfolio_returns.index.intersection(benchmark_returns.index)
    if len(common_idx) < 2:
        return np.nan
    pr = portfolio_returns.reindex(common_idx).dropna()
    br = benchmark_returns.reindex(common_idx).dropna()
    # Re-align after dropping NAs
    common_idx = pr.index.intersection(br.index)
    if len(common_idx) < 2 or br.loc[common_idx].var() == 0:
        return np.nan
    cov = pr.loc[common_idx].cov(br.loc[common_idx])
    var = br.loc[common_idx].var()
    return cov / var

# Handle rerun flag for smooth UI updates - must be at the very top
if st.session_state.get('alloc_rerun_flag', False):
    st.session_state.alloc_rerun_flag = False
    st.rerun()

# =============================================================================
# HARD KILL FUNCTIONS
# =============================================================================
def hard_kill_process():
    """Completely kill the current process and all background threads"""
    try:
        # Kill all background threads
        for thread in threading.enumerate():
            if thread != threading.current_thread():
                thread.join(timeout=0.1)

        # Force garbage collection
        import gc
        gc.collect()

        # On Windows, use os._exit for immediate termination
        if os.name == 'nt':
            os._exit(1)
        else:
            # On Unix-like systems, use os.kill
            os.kill(os.getpid(), signal.SIGTERM)
    except Exception:
        # Last resort - force exit
        os._exit(1)

def check_kill_request():
    """Check if user has requested a hard kill"""
    if st.session_state.get('hard_kill_requested', False):
        st.error("🛑 **HARD KILL REQUESTED** - Terminating all processes...")
        st.stop()

def emergency_kill():
    """Emergency kill function that stops backtest without crashing the app"""
    st.error("🛑 **EMERGENCY KILL** - Forcing immediate backtest termination...")
    st.session_state.hard_kill_requested = True
    st.rerun()

# =============================================================================
# TICKER ALIASES FUNCTIONS
# =============================================================================

def get_ticker_aliases_for_backtest():
    """Define ticker aliases for backtest data - NO Canadian mappings to preserve USD data"""
    aliases = {
        # Stock Market Indices
        'SPX': '^GSPC',           # S&P 500 (price only, no dividends) - 1927+
        'SPXTR': '^SP500TR',      # S&P 500 Total Return (with dividends) - 1988+
        'SP500': '^GSPC',         # S&P 500 (price only, no dividends) - 1927+
        'SP500TR': '^SP500TR',    # S&P 500 Total Return (with dividends) - 1988+
        'SPYTR': '^SP500TR',      # S&P 500 Total Return (with dividends) - 1988+
        'NASDAQ': '^IXIC',        # NASDAQ Composite (price only, no dividends) - 1971+
        'NDX': '^NDX',           # NASDAQ 100 (price only, no dividends) - 1985+
        'QQQTR': 'QQQ',          # NASDAQ-100 (with dividends) - 1999+
        'DOW': '^DJI',           # Dow Jones Industrial Average (price only, no dividends) - 1992+
        
        # Treasury Yield Indices (LONGEST HISTORY - 1960s+)
        'TNX': '^TNX',           # 10-Year Treasury Yield (1962+) - Price only, no coupons
        'TYX': '^TYX',           # 30-Year Treasury Yield (1977+) - Price only, no coupons
        'FVX': '^FVX',           # 5-Year Treasury Yield (1962+) - Price only, no coupons
        'IRX': '^IRX',           # 3-Month Treasury Yield (1960+) - Price only, no coupons
        
        # Treasury Bond ETFs (MODERN - WITH COUPONS/DIVIDENDS)
        'TLTETF': 'TLT',          # 20+ Year Treasury Bond ETF (2002+) - With coupons
        'IEFETF': 'IEF',          # 7-10 Year Treasury Bond ETF (2002+) - With coupons
        'SHY': 'SHY',            # 1-3 Year Treasury Bond ETF (2002+) - With coupons
        'BIL': 'BIL',            # 1-3 Month T-Bill ETF (2007+) - With coupons
        'GOVT': 'GOVT',          # US Treasury Bond ETF (2012+) - With coupons
        'SPTL': 'SPTL',          # Long Term Treasury ETF (2007+) - With coupons
        'SPTS': 'SPTS',          # Short Term Treasury ETF (2011+) - With coupons
        'SPTI': 'SPTI',          # Intermediate Term Treasury ETF (2007+) - With coupons
        
        # Cash/Zero Return
        'ZEROX': 'ZEROX',        # Zero-cost portfolio (literally cash doing nothing)
        
        # Gold & Commodities
        'GOLDX': 'GOLDX',        # Fidelity Gold Fund (1994+) - With dividends
        'GLD': 'GLD',            # SPDR Gold Trust ETF (2004+) - With dividends
        'IAU': 'IAU',            # iShares Gold Trust ETF (2005+) - With dividends
        'GOLDF': 'GC=F',         # Gold Futures (2000+) - No dividends
        'SILVER': 'SI=F',        # Silver Futures (2000+) - No dividends
        'OIL': 'CL=F',           # Crude Oil Futures (2000+) - No dividends
        'NATGAS': 'NG=F',        # Natural Gas Futures (2000+) - No dividends
        'CORN': 'ZC=F',          # Corn Futures (2000+) - No dividends
        'SOYBEAN': 'ZS=F',       # Soybean Futures (2000+) - No dividends
        'COFFEE': 'KC=F',        # Coffee Futures (2000+) - No dividends
        'SUGAR': 'SB=F',         # Sugar Futures (2000+) - No dividends
        'COTTON': 'CT=F',        # Cotton Futures (2000+) - No dividends
        'COPPER': 'HG=F',        # Copper Futures (2000+) - No dividends
        'PLATINUM': 'PL=F',      # Platinum Futures (1997+) - No dividends
        'PALLADIUM': 'PA=F',     # Palladium Futures (1998+) - No dividends
        
        # Cryptocurrency
        'BITCOIN': 'BTC-USD',    # Bitcoin (2014+) - No dividends
        
        # Leveraged & Inverse ETFs (Synthetic Aliases)
        'TQQQTR': '^NDX?L=3?E=0.95',     # 3x NASDAQ-100 (price only) - 1985+
        'TQQQND': '^NDX?L=3?E=0.95',     # 3x NASDAQ-100 (price only) - 1985+
        'SPXLTR': '^SP500TR?L=3?E=1.00', # 3x S&P 500 (with dividends)
        'UPROTR': '^SP500TR?L=3?E=0.91', # 3x S&P 500 (with dividends)
        'QLDTR': '^IXIC?L=2?E=0.95',     # 2x NASDAQ Composite (price only) - 1971+
        'SSOTR': '^SP500TR?L=2?E=0.91',  # 2x S&P 500 (with dividends)
        'SHTR': '^GSPC?L=-1?E=0.89',     # -1x S&P 500 (price only, no dividends) - 1927+
        'PSQTR': '^IXIC?L=-1?E=0.95',    # -1x NASDAQ Composite (price only, no dividends) - 1971+
        'SDSTR': '^GSPC?L=-2?E=0.91',    # -2x S&P 500 (price only, no dividends) - 1927+
        'QIDTR': '^IXIC?L=-2?E=0.95',    # -2x NASDAQ Composite (price only, no dividends) - 1971+
        'SPXUTR': '^GSPC?L=-3?E=1.00',   # -3x S&P 500 (price only, no dividends) - 1927+
        'SQQQTR': '^NDX?L=-3?E=0.95',    # -3x NASDAQ-100 (price only, no dividends) - 1985+
        
        # Synthetic Complete Tickers
        'SPYSIM': 'SPYSIM_COMPLETE',  # Complete S&P 500 Simulation (1885+) - Historical + SPYTR
        'GOLDSIM': 'GOLDSIM_COMPLETE',  # Complete Gold Simulation (1968+) - New Historical + GOLDX
        'GOLDX': 'GOLD_COMPLETE',  # Complete Gold Dataset (1975+) - Historical + GLD
        'ZROZX': 'ZROZ_COMPLETE',  # Complete ZROZ Dataset (1962+) - Historical + ZROZ
        'TLTTR': 'TLT_COMPLETE',  # Complete TLT Dataset (1962+) - Historical + TLT
        'BITCOINX': 'BTC_COMPLETE',  # Complete Bitcoin Dataset (2010+) - Historical + BTC-USD
        'KMLMX': 'KMLM_COMPLETE',  # Complete KMLM Dataset (1992+) - Historical + KMLM
        'IEFTR': 'IEF_COMPLETE',  # Complete IEF Dataset (1962+) - Historical + IEF
        'DBMFX': 'DBMF_COMPLETE',  # Complete DBMF Dataset (2000+) - Historical + DBMF
        'TBILL': 'TBILL_COMPLETE',  # Complete TBILL Dataset (1948+) - Historical + SGOV
        
    }
    
    # Add custom mappings from session state if they exist
    if 'alloc_custom_ticker_mappings' in st.session_state:
        aliases.update(st.session_state.alloc_custom_ticker_mappings)
    
    return aliases

def get_ticker_aliases_for_stats():
    """Define ticker aliases for stats - INCLUDES Canadian mappings for better data quality"""
    base_aliases = get_ticker_aliases_for_backtest()
    
    # Add Canadian mappings for stats (better data quality)
    stats_aliases = base_aliases.copy()
    stats_aliases.update({
        # OTC Mappings for Stats (OTC tickers often have poor data quality)
        'MDALF': 'MDA.TO',          # MDA Ltd - USD OTC -> Canadian TSX (data quality)
        'KRKNF': 'PNG.V',           # Kraken Robotics - USD OTC -> Canadian Venture (data quality)
        'CNSWF': 'CSU.TO',          # Constellation Software - USD OTC -> Canadian TSX (data quality)
        'TOITF': 'TOI.V',           # Topicus - USD OTC -> Canadian Venture (data quality)
        'LMGIF': 'LMN.V',           # Lumine Group - USD OTC -> Canadian Venture (data quality)
        'DLMAF': 'DOL.TO',          # Dollarama - USD OTC -> Canadian TSX (data quality)
        'LBLCF': 'L.TO',            # Loblaw Companies - USD OTC -> Canadian TSX (data quality)
        'ANCTF': 'ATD.TO',          # Alimentation Couche-Tard - USD OTC -> Canadian TSX (data quality)
        'FRFHF': 'FFH.TO',          # Fairfax Financial - USD OTC -> Canadian TSX (data quality)
        'PWCDF': 'POW.TO',          # Power Corporation - USD OTC -> Canadian TSX (data quality)
        'CGI': 'GIB-A.TO',          # CGI Inc - NYSE -> Canadian TSX (CGI ticker is obsolete)
        
        # Canadian Ticker Mappings for Stats (NYSE/NASDAQ -> Canadian Exchange for better data)
        'MRU': 'MRU.TO',            # Metro Inc - NYSE -> Canadian TSX
        'CLS': 'CLS.TO',            # Celestica Inc - NYSE -> Canadian TSX
        'DSGX': 'DSG.TO',           # Descartes Systems Group - NASDAQ -> Canadian TSX
        'BITF': 'BITF.TO',          # Bitfarms - NASDAQ -> Canadian TSX (Bitcoin Mining)
        'BN': 'BN.TO',              # Brookfield Corporation - NYSE -> Canadian TSX
        'BAM': 'BAM.TO',            # Brookfield Asset Management - NYSE -> Canadian TSX
        'POW': 'POW.TO',            # Power Corporation - TSX
        'ENB': 'ENB.TO',            # Enbridge Inc - NYSE -> Canadian TSX
        'TRP': 'TRP.TO',            # TC Energy (TransCanada) - NYSE -> Canadian TSX
        'CNQ': 'CNQ.TO',            # Canadian Natural Resources - NYSE -> Canadian TSX
        'SU': 'SU.TO',              # Suncor Energy - NYSE -> Canadian TSX
        'CP': 'CP.TO',              # Canadian Pacific Railway - NYSE -> Canadian TSX
        'CNI': 'CNR.TO',            # Canadian National Railway - NYSE -> Canadian TSX
        # Canadian Big 6 Banks
        'RY': 'RY.TO',              # Royal Bank of Canada - NYSE -> Canadian TSX
        'TD': 'TD.TO',              # Toronto-Dominion Bank - NYSE -> Canadian TSX
        'BNS': 'BNS.TO',            # Bank of Nova Scotia (Scotiabank) - NYSE -> Canadian TSX
        'BMO': 'BMO.TO',            # Bank of Montreal - NYSE -> Canadian TSX
        'CM': 'CM.TO',              # Canadian Imperial Bank of Commerce - NYSE -> Canadian TSX
        'NA': 'NA.TO',              # National Bank of Canada - TSX only
    })
    
    return stats_aliases

def get_ticker_aliases():
    """Legacy function - now redirects to backtest aliases to maintain compatibility"""
    return get_ticker_aliases_for_backtest()

def get_leveraged_ticker_underlying():
    """Map leveraged tickers to their underlying tickers for valuation
    
    This mapping is used ONLY for valuation tables (P/E, Market Cap, etc.)
    Backtests still use the leveraged ticker for accurate price/return data.
    """
    return {
        # Berkshire Hathaway
        'BRKU': 'BRK-B',          # 2x Berkshire Hathaway
        
        # Booking
        'BKNU': 'BKNG',           # 2x Booking
        
        # UnitedHealth
        'UNHG': 'UNH',            # 2x UnitedHealth
        
        # Microsoft
        'MSFU': 'MSFT',           # 2x Microsoft
        'MSFL': 'MSFT',           # 1.5x Microsoft
        
        # Meta
        'METU': 'META',           # 2x Meta
        'FBL': 'META',            # 1.5x Meta
        
        # Google
        'GGLL': 'GOOGL',          # 2x Google
        'ALPU': 'GOOGL',          # 1.5x Google
        
        # Taiwan Semiconductor
        'TSMG': 'TSM',            # 2x Taiwan Semi
        'TSMU': 'TSM',            # 1.5x Taiwan Semi
        'TSMX': 'TSM',            # 3x Taiwan Semi
        
        # ASML
        'ASMG': 'ASML',           # 2x ASML
        
        # Amazon
        'AMZU': 'AMZN',           # 2x Amazon
        
        # Oracle
        'ORCX': 'ORCL',           # 2x Oracle
        
        # Broadcom
        'AVGU': 'AVGO',           # 2x Broadcom
        'AVL': 'AVGO',            # 1.5x Broadcom
        'AVGG': 'AVGO',           # 3x Broadcom
        'AVGX': 'AVGO',           # 4x Broadcom
        
        # NVIDIA
        'NVDL': 'NVDA',           # 2x NVIDIA
        'NVDU': 'NVDA',           # 3x NVIDIA
        'NVDG': 'NVDA',           # 4x NVIDIA
        'NVD': 'NVDA',            # Alternative NVIDIA leveraged
        
        # Netflix
        'NFXL': 'NFLX',           # 2x Netflix
        'NFLU': 'NFLX',           # 1.5x Netflix
        
        # Arista Networks
        'ANEL': 'ANET',           # 2x Arista
        
        # Super Micro Computer
        'SMCX': 'SMCI',           # 2x Super Micro
        'SMCL': 'SMCI',           # 1.5x Super Micro
        
        # Apple
        'AAPB': 'AAPL',           # 2x Apple
        'AAPU': 'AAPL',           # 1.5x Apple
    }

def resolve_ticker_alias(ticker, for_stats=False):
    """Resolve ticker alias to actual ticker symbol
    
    Args:
        ticker: The ticker symbol to resolve
        for_stats: If True, use stats aliases (includes Canadian mappings). 
                  If False, use backtest aliases (preserves USD tickers)
    """
    if for_stats:
        aliases = get_ticker_aliases_for_stats()
    else:
        aliases = get_ticker_aliases_for_backtest()
    
    # Extract base ticker before any parameters (e.g., CNSWF?L=2?E=1 -> CNSWF)
    base_ticker = ticker.split('?')[0].upper()
    
    # Special conversion for Berkshire Hathaway tickers for Yahoo Finance compatibility
    if base_ticker == 'BRK.B':
        base_ticker = 'BRK-B'
    elif base_ticker == 'BRK.A':
        base_ticker = 'BRK-A'
    
    # Get the Canadian ticker if available
    resolved_base = aliases.get(base_ticker, base_ticker)
    
    # If we have parameters, add them back to the resolved ticker
    if '?' in ticker:
        parameters = ticker.split('?', 1)[1]  # Get everything after the first ?
        return f"{resolved_base}?{parameters}"
    else:
        return resolved_base

def resolve_index_to_etf_for_stats(ticker):
    """Convert indices to equivalent ETFs for better statistics data
    
    This function converts raw indices (like ^SP500-45) to their equivalent ETFs (like XLK)
    for statistics calculations, as ETFs have more comprehensive market data.
    """
    # Extract base ticker before any parameters (e.g., ^IXIC?L=3?E=0.95 -> ^IXIC)
    base_ticker = ticker.split('?')[0].upper()
    
    # Mapping from indices to equivalent ETFs
    index_to_etf_mapping = {
        # S&P 500 Sector Indices -> Sector ETFs
        '^SP500-45': 'XLK',    # Technology
        '^SP500-35': 'XLV',    # Healthcare
        '^SP500-30': 'XLP',    # Consumer Staples
        '^SP500-40': 'XLF',    # Financials
        '^SP500-10': 'XLE',    # Energy
        '^SP500-20': 'XLI',    # Industrials
        '^SP500-25': 'XLY',    # Consumer Discretionary
        '^SP500-15': 'XLB',    # Materials
        '^SP500-55': 'XLU',    # Utilities
        '^SP500-60': 'XLRE',   # Real Estate
        '^SP500-50': 'XLC',    # Communication Services
        
        # Major Indices -> Major ETFs
        '^IXIC': 'QQQ',        # NASDAQ Composite -> NASDAQ-100 ETF
        '^NDX': 'QQQ',         # NASDAQ-100 -> NASDAQ-100 ETF
        '^GSPC': 'SPY',        # S&P 500 -> S&P 500 ETF
        '^SP500TR': 'SPY',     # S&P 500 Total Return -> S&P 500 ETF
        '^DJI': 'DIA',         # Dow Jones -> Dow Jones ETF
    }
    
    # Check if this is an index that should be converted to ETF
    if base_ticker in index_to_etf_mapping:
        etf_ticker = index_to_etf_mapping[base_ticker]
        
        # If we have parameters (like leverage), add them back to the ETF
        if '?' in ticker:
            parameters = ticker.split('?', 1)[1]  # Get everything after the first ?
            return f"{etf_ticker}?{parameters}"
        else:
            return etf_ticker
    
    # If not an index or no mapping found, return original ticker
    return ticker

def get_custom_sector_for_ticker(ticker):
    """Get custom sector for ETFs and special tickers that don't have traditional sectors
    
    Returns custom sector name for special tickers, or None to use Yahoo Finance sector.
    """
    # Check if ticker has leverage parameter (?L=)
    has_leverage = '?L=' in ticker.upper()
    
    # Extract base ticker (remove leverage parameters)
    base_ticker = ticker.split('?')[0].upper()
    
    # List of tickers that are indices/ETFs (not individual stocks)
    index_etf_tickers = {
        'SPY', 'VOO', 'IVV', 'VTI', 'ITOT', 'SCHB', 'VT', 'VXUS', 'IXUS', 'QQQ', 'QQQM', 'DIA',
        '^GSPC', '^SP500TR', '^IXIC', '^NDX', '^DJI', 'SPYSIM', 'SPYSIM_COMPLETE',
        'MTUM', 'SPMO', 'VFMO', 'QMOM', 'IMOM', 'JMOM', 'SEIM', 'FDMO', 'FPMO', 'IWMO', 'UMMT', 'LRGF', 'MOM', 'USMC', 'PDP', 'DWAQ', 'DWAS',
        'VIG', 'SCHD', 'DGRO', 'HDV', 'SPYD', 'DVY', 'SDY', 'VYM', 'RDVY', 'FDL', 'FVD', 'NOBL', 'DHS', 'FDVV', 'DGRW', 'DIVO', 'LVHD', 'SPHD', 'OUSA', 'PID', 'PEY', 'DON', 'FQAL', 'RDIV', 'VYMI', 'IDV', 'DGT', 'DWX',
        'VUG', 'MGK', 'IWF', 'RPG', 'SCHG', 'QGRO', 'JKE', 'IVW', 'TGRW', 'SPYG', 'SYG', 'GFG', 'GXG', 'GGRO', 'XLG',
        'SSO', 'QLD', 'SPXL', 'UPRO', 'TQQQ', 'TMF', 'SOXL', 'TNA', 'CURE', 'FAS', 'LABU', 'TECL',
        'TQQQTR', 'SPXLTR', 'UPROTR', 'QLDTR', 'SSOTR', 'SHTR', 'PSQTR', 'SDSTR', 'QIDTR', 'SPXUTR', 'SQQQTR',
        'TLT', 'IEF', 'SHY', 'BIL', 'ZROZ', 'TLH', 'IEI', 'SHV', 'VGSH', 'VGIT', 'VGLT', 'GOVT', 'SPTL', 'SPTS', 'SPTI',
        'TLTTR', 'TLT_COMPLETE', 'ZROZX', 'ZROZ_COMPLETE', 'IEFTR', 'IEF_COMPLETE', 'TBILL', 'TBILL_COMPLETE',
        '^TNX', '^TYX', '^FVX', '^IRX', 'AGG', 'BND', 'BNDX', 'LQD', 'HYG', 'JNK', 'MUB', 'TIP', 'VTIP',
        'GLD', 'GOLDX', 'GOLDSIM', 'IAU', 'IAUM', 'GLDM', 'SGOL', 'UGL', 'GOLD_COMPLETE', 'GOLDSIM_COMPLETE', 'GC=F', 'GOLDF',
        'GDX', 'GDXJ', 'SLV', 'SI=F', 'SILVER', 'PPLT', 'PL=F', 'PLATINUM', 'PALL', 'PA=F', 'PALLADIUM',
        'USO', 'CL=F', 'OIL', 'UNG', 'NG=F', 'NATGAS', 'DBA', 'ZC=F', 'CORN', 'ZS=F', 'SOYBEAN', 'KC=F', 'COFFEE', 'SB=F', 'SUGAR', 'CT=F', 'COTTON',
        'DBC', 'GSG', 'PDBC', 'BCI', 'HG=F', 'COPPER', 'KMLM', 'DBMF', 'KMLMX', 'KMLM_COMPLETE', 'DBMFX', 'DBMF_COMPLETE',
        'BTC-USD', 'ETH-USD', 'BITO', 'GBTC', 'ETHE', 'BITCOINX', 'BTC_COMPLETE',
        'XLK', 'VGT', 'FTEC', 'IGM', 'SMH', 'SOXX', 'SOXS', 'USD',
        '^SP500-45', '^SP500-35', '^SP500-30', '^SP500-40', '^SP500-10', '^SP500-20', '^SP500-25', '^SP500-15', '^SP500-55', '^SP500-60', '^SP500-50',
        'XLF', 'XLV', 'XLP', 'XLE', 'XLI', 'XLY', 'XLB', 'XLU', 'XLC',
        'VNQ', 'IYR', 'SCHH', 'RWR', 'XLRE',
        'VXX', 'UVXY', 'SVXY',
        'CASH', 'SGOV', 'USFR', 'ZEROX'
    }
    
    # Special case: UGL is always leveraged (2x gold ETF)
    if base_ticker == 'UGL':
        return 'LEVERAGED PRECIOUS METALS'
    
    # If ticker has leverage parameter AND is in our index/ETF list, return appropriate leveraged sector
    if has_leverage and base_ticker in index_etf_tickers:
        # Check for gold/precious metals tickers
        if base_ticker in ['GLD', 'GOLDX', 'GOLDSIM', 'IAU', 'IAUM', 'GLDM', 'SGOL', 'UGL', 'GOLD_COMPLETE', 'GOLDSIM_COMPLETE', 'GC=F', 'GOLDF', 'GDX', 'GDXJ', 'SLV', 'SI=F', 'SILVER', 'PPLT', 'PL=F', 'PLATINUM', 'PALL', 'PA=F', 'PALLADIUM']:
            return 'LEVERAGED PRECIOUS METALS'
        
        # Check for treasury/bond tickers
        if base_ticker in ['TLT', 'ZROZ', 'VGLT', 'SPTL', 'TLH', 'TLTTR', 'TLT_COMPLETE', 'ZROZX', 'ZROZ_COMPLETE', 'IEF', 'VGIT', 'SPTI', 'IEI', 'IEFTR', 'IEF_COMPLETE', 'SHY', 'BIL', 'VGSH', 'SPTS', 'SHV', 'TBILL', 'TBILL_COMPLETE', '^TNX', '^TYX', '^FVX', '^IRX', 'AGG', 'BND', 'BNDX', 'LQD', 'HYG', 'JNK', 'MUB', 'TIP', 'VTIP', 'GOVT']:
            return 'LEVERAGED TREASURIES'
        
        # Check for cryptocurrency
        if base_ticker in ['BTC-USD', 'ETH-USD', 'BITO', 'GBTC', 'ETHE', 'BITCOINX', 'BTC_COMPLETE']:
            return 'LEVERAGED CRYPTOCURRENCY'
        
        # Check for commodities (excluding precious metals)
        if base_ticker in ['USO', 'CL=F', 'OIL', 'UNG', 'NG=F', 'NATGAS', 'DBA', 'ZC=F', 'CORN', 'ZS=F', 'SOYBEAN', 'KC=F', 'COFFEE', 'SB=F', 'SUGAR', 'CT=F', 'COTTON', 'DBC', 'GSG', 'PDBC', 'BCI', 'HG=F', 'COPPER', 'KMLM', 'DBMF', 'KMLMX', 'KMLM_COMPLETE', 'DBMFX', 'DBMF_COMPLETE']:
            return 'LEVERAGED COMMODITIES'
        
        # Check for real estate
        if base_ticker in ['VNQ', 'IYR', 'SCHH', 'RWR', 'XLRE']:
            return 'LEVERAGED REAL ESTATE'
        
        # Check for volatility
        if base_ticker in ['VXX', 'UVXY', 'SVXY']:
            return 'LEVERAGED VOLATILITY'
        
        # Default to LEVERAGED ETF for all other index/ETF tickers
        return 'LEVERAGED ETF'
    
    # Custom sector mappings for ETFs and special tickers
    custom_sectors = {
        # Broad Market Index ETFs
        'SPY': 'INDEX FUND',
        'VOO': 'INDEX FUND',
        'IVV': 'INDEX FUND',
        'VTI': 'INDEX FUND',
        'ITOT': 'INDEX FUND',
        'SCHB': 'INDEX FUND',
        'VT': 'INDEX FUND',
        'VXUS': 'INDEX FUND',
        'IXUS': 'INDEX FUND',
        'QQQ': 'INDEX FUND',
        'QQQM': 'INDEX FUND',
        'DIA': 'INDEX FUND',
        '^GSPC': 'INDEX FUND',
        '^SP500TR': 'INDEX FUND',
        '^IXIC': 'INDEX FUND',
        '^NDX': 'INDEX FUND',
        '^DJI': 'INDEX FUND',
        'SPYSIM': 'INDEX FUND',
        'SPYSIM_COMPLETE': 'INDEX FUND',
        
        # Momentum Index ETFs
        'MTUM': 'INDEX FUND',
        'SPMO': 'INDEX FUND',
        'VFMO': 'INDEX FUND',
        'QMOM': 'INDEX FUND',
        'IMOM': 'INDEX FUND',
        'JMOM': 'INDEX FUND',
        'SEIM': 'INDEX FUND',
        'FDMO': 'INDEX FUND',
        'FPMO': 'INDEX FUND',
        'IWMO': 'INDEX FUND',
        'UMMT': 'INDEX FUND',
        'LRGF': 'INDEX FUND',
        'MOM': 'INDEX FUND',
        'USMC': 'INDEX FUND',
        'PDP': 'INDEX FUND',
        'DWAQ': 'INDEX FUND',
        'DWAS': 'INDEX FUND',
        
        # Dividend Index ETFs
        'VIG': 'INDEX FUND',
        'SCHD': 'INDEX FUND',
        'DGRO': 'INDEX FUND',
        'HDV': 'INDEX FUND',
        'SPYD': 'INDEX FUND',
        'DVY': 'INDEX FUND',
        'SDY': 'INDEX FUND',
        'VYM': 'INDEX FUND',
        'RDVY': 'INDEX FUND',
        'FDL': 'INDEX FUND',
        'FVD': 'INDEX FUND',
        'NOBL': 'INDEX FUND',
        'DHS': 'INDEX FUND',
        'FDVV': 'INDEX FUND',
        'DGRW': 'INDEX FUND',
        'DIVO': 'INDEX FUND',
        'LVHD': 'INDEX FUND',
        'SPHD': 'INDEX FUND',
        'OUSA': 'INDEX FUND',
        'PID': 'INDEX FUND',
        'PEY': 'INDEX FUND',
        'DON': 'INDEX FUND',
        'FQAL': 'INDEX FUND',
        'RDIV': 'INDEX FUND',
        'VYMI': 'INDEX FUND',
        'IDV': 'INDEX FUND',
        'DGT': 'INDEX FUND',
        'DWX': 'INDEX FUND',
        
        # Growth Index ETFs
        'VUG': 'INDEX FUND',
        'MGK': 'INDEX FUND',
        'IWF': 'INDEX FUND',
        'RPG': 'INDEX FUND',
        'SCHG': 'INDEX FUND',
        'QGRO': 'INDEX FUND',
        'JKE': 'INDEX FUND',
        'IVW': 'INDEX FUND',
        'TGRW': 'INDEX FUND',
        'SPYG': 'INDEX FUND',
        'SYG': 'INDEX FUND',
        'GFG': 'INDEX FUND',
        'GXG': 'INDEX FUND',
        'GGRO': 'INDEX FUND',
        'XLG': 'INDEX FUND',
        
        # Leveraged Index ETFs
        'SSO': 'LEVERAGED ETF',
        'QLD': 'LEVERAGED ETF',
        'SPXL': 'LEVERAGED ETF',
        'UPRO': 'LEVERAGED ETF',
        'TQQQ': 'LEVERAGED ETF',
        'TMF': 'LEVERAGED ETF',
        'SOXL': 'LEVERAGED ETF',
        'TNA': 'LEVERAGED ETF',
        'CURE': 'LEVERAGED ETF',
        'FAS': 'LEVERAGED ETF',
        'LABU': 'LEVERAGED ETF',
        'TECL': 'LEVERAGED ETF',
        'TQQQTR': 'LEVERAGED ETF',
        'SPXLTR': 'LEVERAGED ETF',
        'UPROTR': 'LEVERAGED ETF',
        'QLDTR': 'LEVERAGED ETF',
        'SSOTR': 'LEVERAGED ETF',
        'SHTR': 'LEVERAGED ETF',
        'PSQTR': 'LEVERAGED ETF',
        'SDSTR': 'LEVERAGED ETF',
        'QIDTR': 'LEVERAGED ETF',
        'SPXUTR': 'LEVERAGED ETF',
        'SQQQTR': 'LEVERAGED ETF',
        
        # Treasury/Bond ETFs
        'TLT': 'TREASURIES',
        'IEF': 'TREASURIES',
        'SHY': 'TREASURIES',
        'BIL': 'TREASURIES',
        'ZROZ': 'TREASURIES',
        'TLH': 'TREASURIES',
        'IEI': 'TREASURIES',
        'SHV': 'TREASURIES',
        'VGSH': 'TREASURIES',
        'VGIT': 'TREASURIES',
        'VGLT': 'TREASURIES',
        'GOVT': 'TREASURIES',
        'SPTL': 'TREASURIES',
        'SPTS': 'TREASURIES',
        'SPTI': 'TREASURIES',
        'TLTTR': 'TREASURIES',
        'TLT_COMPLETE': 'TREASURIES',
        'ZROZX': 'TREASURIES',
        'ZROZ_COMPLETE': 'TREASURIES',
        'IEFTR': 'TREASURIES',
        'IEF_COMPLETE': 'TREASURIES',
        'TBILL': 'TREASURIES',
        'TBILL_COMPLETE': 'TREASURIES',
        '^TNX': 'TREASURIES',
        '^TYX': 'TREASURIES',
        '^FVX': 'TREASURIES',
        '^IRX': 'TREASURIES',
        'AGG': 'BONDS',
        'BND': 'BONDS',
        'BNDX': 'BONDS',
        'LQD': 'BONDS',
        'HYG': 'BONDS',
        'JNK': 'BONDS',
        'MUB': 'BONDS',
        'TIP': 'BONDS',
        'VTIP': 'BONDS',
        
        # Gold/Precious Metals
        'GLD': 'GOLD',
        'GOLDX': 'GOLD',
        'GOLDSIM': 'GOLD',
        'IAU': 'GOLD',
        'IAUM': 'GOLD',
        'GLDM': 'GOLD',
        'SGOL': 'GOLD',
        'GOLD_COMPLETE': 'GOLD',
        'GOLDSIM_COMPLETE': 'GOLD',
        'GC=F': 'GOLD',
        'GOLDF': 'GOLD',
        'GDX': 'GOLD MINERS',
        'GDXJ': 'GOLD MINERS',
        'SLV': 'SILVER',
        'SI=F': 'SILVER',
        'SILVER': 'SILVER',
        'PPLT': 'PLATINUM',
        'PL=F': 'PLATINUM',
        'PLATINUM': 'PLATINUM',
        'PALL': 'PALLADIUM',
        'PA=F': 'PALLADIUM',
        'PALLADIUM': 'PALLADIUM',
        
        # Commodities
        'USO': 'OIL',
        'CL=F': 'OIL',
        'OIL': 'OIL',
        'UNG': 'NATURAL GAS',
        'NG=F': 'NATURAL GAS',
        'NATGAS': 'NATURAL GAS',
        'DBA': 'AGRICULTURE',
        'ZC=F': 'AGRICULTURE',
        'CORN': 'AGRICULTURE',
        'ZS=F': 'AGRICULTURE',
        'SOYBEAN': 'AGRICULTURE',
        'KC=F': 'AGRICULTURE',
        'COFFEE': 'AGRICULTURE',
        'SB=F': 'AGRICULTURE',
        'SUGAR': 'AGRICULTURE',
        'CT=F': 'AGRICULTURE',
        'COTTON': 'AGRICULTURE',
        'DBC': 'COMMODITIES',
        'GSG': 'COMMODITIES',
        'PDBC': 'COMMODITIES',
        'BCI': 'COMMODITIES',
        'HG=F': 'COMMODITIES',
        'COPPER': 'COMMODITIES',
        'KMLM': 'MANAGED FUTURES',
        'DBMF': 'MANAGED FUTURES',
        'KMLMX': 'MANAGED FUTURES',
        'KMLM_COMPLETE': 'MANAGED FUTURES',
        'DBMFX': 'MANAGED FUTURES',
        'DBMF_COMPLETE': 'MANAGED FUTURES',
        
        # Cryptocurrency
        'BTC-USD': 'CRYPTOCURRENCY',
        'ETH-USD': 'CRYPTOCURRENCY',
        'BITO': 'CRYPTOCURRENCY',
        'GBTC': 'CRYPTOCURRENCY',
        'ETHE': 'CRYPTOCURRENCY',
        'BITCOINX': 'CRYPTOCURRENCY',
        'BTC_COMPLETE': 'CRYPTOCURRENCY',
        'BITCOIN': 'CRYPTOCURRENCY',
        
        # Bitcoin ETFs
        'IBIT': 'CRYPTOCURRENCY',      # iShares Bitcoin Trust (BlackRock)
        'FBTC': 'CRYPTOCURRENCY',      # Fidelity Wise Origin Bitcoin Fund
        'BITB': 'CRYPTOCURRENCY',      # Bitwise Bitcoin ETF Trust
        'ARKB': 'CRYPTOCURRENCY',      # ARK 21Shares Bitcoin ETF
        'BTCO': 'CRYPTOCURRENCY',      # Invesco Galaxy Bitcoin ETF
        'HODL': 'CRYPTOCURRENCY',      # 21Shares Crypto Basket 10 ETP
        'EZBC': 'CRYPTOCURRENCY',      # ETC Group Bitcoin ETP
        'XBTF': 'CRYPTOCURRENCY',      # ProShares Bitcoin Futures Strategy ETF
        'BTF': 'CRYPTOCURRENCY',       # Valkyrie Bitcoin Strategy ETF
        'BTCC': 'CRYPTOCURRENCY',      # Purpose Bitcoin ETF (Canada)
        
        # Technology
        'XLK': 'TECHNOLOGY INDEX',
        'VGT': 'TECHNOLOGY INDEX',
        'FTEC': 'TECHNOLOGY INDEX',
        'IGM': 'TECHNOLOGY INDEX',
        'SMH': 'TECHNOLOGY',
        'SOXX': 'TECHNOLOGY',
        'SOXS': 'LEVERAGED ETF',
        'USD': 'LEVERAGED ETF',
        
        # S&P 500 Sector Indices
        '^SP500-45': 'TECHNOLOGY INDEX',
        '^SP500-35': 'HEALTHCARE INDEX',
        '^SP500-30': 'CONSUMER STAPLES INDEX',
        '^SP500-40': 'FINANCIAL INDEX',
        '^SP500-10': 'ENERGY INDEX',
        '^SP500-20': 'INDUSTRIALS INDEX',
        '^SP500-25': 'CONSUMER DISCRETIONARY INDEX',
        '^SP500-15': 'MATERIALS INDEX',
        '^SP500-55': 'UTILITIES INDEX',
        '^SP500-60': 'REAL ESTATE INDEX',
        '^SP500-50': 'COMMUNICATION INDEX',
        'XLF': 'FINANCIAL INDEX',
        'XLV': 'HEALTHCARE INDEX',
        'XLP': 'CONSUMER STAPLES INDEX',
        'XLE': 'ENERGY INDEX',
        'XLI': 'INDUSTRIALS INDEX',
        'XLY': 'CONSUMER DISCRETIONARY INDEX',
        'XLB': 'MATERIALS INDEX',
        'XLU': 'UTILITIES INDEX',
        'XLC': 'COMMUNICATION INDEX',
        
        # Real Estate
        'VNQ': 'REAL ESTATE',
        'IYR': 'REAL ESTATE',
        'SCHH': 'REAL ESTATE',
        'RWR': 'REAL ESTATE',
        'XLRE': 'REAL ESTATE',
        
        # Volatility
        'VXX': 'VOLATILITY',
        'UVXY': 'VOLATILITY',
        'SVXY': 'VOLATILITY',
        
        # Cash Equivalents
        'CASH': 'CASH',
        'SGOV': 'CASH EQUIVALENT',
        'USFR': 'CASH EQUIVALENT',
        'ZEROX': 'CASH',
    }
    
    return custom_sectors.get(base_ticker, None)


def get_custom_industry_for_ticker(ticker):
    """Get custom industry for ETFs and special tickers that don't have traditional industries
    
    Returns custom industry name for special tickers, or None to use Yahoo Finance industry.
    """
    # Check if ticker has leverage parameter (?L=)
    has_leverage = '?L=' in ticker.upper()
    
    # Extract base ticker (remove leverage parameters)
    base_ticker = ticker.split('?')[0].upper()
    
    # List of tickers that are indices/ETFs (not individual stocks) - same as in get_custom_sector_for_ticker
    index_etf_tickers = {
        'SPY', 'VOO', 'IVV', 'VTI', 'ITOT', 'SCHB', 'VT', 'VXUS', 'IXUS', 'QQQ', 'QQQM', 'DIA',
        '^GSPC', '^SP500TR', '^IXIC', '^NDX', '^DJI', 'SPYSIM', 'SPYSIM_COMPLETE',
        'MTUM', 'SPMO', 'VFMO', 'QMOM', 'IMOM', 'JMOM', 'SEIM', 'FDMO', 'FPMO', 'IWMO', 'UMMT', 'LRGF', 'MOM', 'USMC', 'PDP', 'DWAQ', 'DWAS',
        'VIG', 'SCHD', 'DGRO', 'HDV', 'SPYD', 'DVY', 'SDY', 'VYM', 'RDVY', 'FDL', 'FVD', 'NOBL', 'DHS', 'FDVV', 'DGRW', 'DIVO', 'LVHD', 'SPHD', 'OUSA', 'PID', 'PEY', 'DON', 'FQAL', 'RDIV', 'VYMI', 'IDV', 'DGT', 'DWX',
        'VUG', 'MGK', 'IWF', 'RPG', 'SCHG', 'QGRO', 'JKE', 'IVW', 'TGRW', 'SPYG', 'SYG', 'GFG', 'GXG', 'GGRO', 'XLG',
        'SSO', 'QLD', 'SPXL', 'UPRO', 'TQQQ', 'TMF', 'SOXL', 'TNA', 'CURE', 'FAS', 'LABU', 'TECL',
        'TQQQTR', 'SPXLTR', 'UPROTR', 'QLDTR', 'SSOTR', 'SHTR', 'PSQTR', 'SDSTR', 'QIDTR', 'SPXUTR', 'SQQQTR',
        'TLT', 'IEF', 'SHY', 'BIL', 'ZROZ', 'TLH', 'IEI', 'SHV', 'VGSH', 'VGIT', 'VGLT', 'GOVT', 'SPTL', 'SPTS', 'SPTI',
        'TLTTR', 'TLT_COMPLETE', 'ZROZX', 'ZROZ_COMPLETE', 'IEFTR', 'IEF_COMPLETE', 'TBILL', 'TBILL_COMPLETE',
        '^TNX', '^TYX', '^FVX', '^IRX', 'AGG', 'BND', 'BNDX', 'LQD', 'HYG', 'JNK', 'MUB', 'TIP', 'VTIP',
        'GLD', 'GOLDX', 'GOLDSIM', 'IAU', 'IAUM', 'GLDM', 'SGOL', 'UGL', 'GOLD_COMPLETE', 'GOLDSIM_COMPLETE', 'GC=F', 'GOLDF',
        'GDX', 'GDXJ', 'SLV', 'SI=F', 'SILVER', 'PPLT', 'PL=F', 'PLATINUM', 'PALL', 'PA=F', 'PALLADIUM',
        'USO', 'CL=F', 'OIL', 'UNG', 'NG=F', 'NATGAS', 'DBA', 'ZC=F', 'CORN', 'ZS=F', 'SOYBEAN', 'KC=F', 'COFFEE', 'SB=F', 'SUGAR', 'CT=F', 'COTTON',
        'DBC', 'GSG', 'PDBC', 'BCI', 'HG=F', 'COPPER', 'KMLM', 'DBMF', 'KMLMX', 'KMLM_COMPLETE', 'DBMFX', 'DBMF_COMPLETE',
        'BTC-USD', 'ETH-USD', 'BITO', 'GBTC', 'ETHE', 'BITCOINX', 'BTC_COMPLETE',
        'XLK', 'VGT', 'FTEC', 'IGM', 'SMH', 'SOXX', 'SOXS', 'USD',
        '^SP500-45', '^SP500-35', '^SP500-30', '^SP500-40', '^SP500-10', '^SP500-20', '^SP500-25', '^SP500-15', '^SP500-55', '^SP500-60', '^SP500-50',
        'XLF', 'XLV', 'XLP', 'XLE', 'XLI', 'XLY', 'XLB', 'XLU', 'XLC',
        'VNQ', 'IYR', 'SCHH', 'RWR', 'XLRE',
        'VXX', 'UVXY', 'SVXY',
        'CASH', 'SGOV', 'USFR', 'ZEROX'
    }
    
    # Special case: UGL is always leveraged (2x gold ETF)
    if base_ticker == 'UGL':
        return 'LEVERAGED GOLD'
    
    # If ticker has leverage parameter AND is in our index/ETF list, determine industry
    if has_leverage and base_ticker in index_etf_tickers:
        # Check for specific semiconductor tickers (SMH, SOXX)
        if base_ticker in ['SMH', 'SOXX']:
            return 'LEVERAGED SEMICONDUCTORS'
        
        # Check for gold/precious metals tickers
        if base_ticker in ['GLD', 'GOLDX', 'GOLDSIM', 'IAU', 'IAUM', 'GLDM', 'SGOL', 'UGL', 'GOLD_COMPLETE', 'GOLDSIM_COMPLETE', 'GC=F', 'GOLDF']:
            return 'LEVERAGED GOLD'
        if base_ticker in ['GDX', 'GDXJ']:
            return 'LEVERAGED GOLD MINERS'
        if base_ticker in ['SLV', 'SI=F', 'SILVER', 'PPLT', 'PL=F', 'PLATINUM', 'PALL', 'PA=F', 'PALLADIUM']:
            return 'LEVERAGED PRECIOUS METALS'
        
        # Check for treasury/bond tickers
        if base_ticker in ['TLT', 'ZROZ', 'VGLT', 'SPTL', 'TLH', 'TLTTR', 'TLT_COMPLETE', 'ZROZX', 'ZROZ_COMPLETE']:
            return 'LEVERAGED LONG TERM TREASURIES'
        if base_ticker in ['IEF', 'VGIT', 'SPTI', 'IEI', 'IEFTR', 'IEF_COMPLETE']:
            return 'LEVERAGED INTERMEDIATE TREASURIES'
        if base_ticker in ['SHY', 'BIL', 'VGSH', 'SPTS', 'SHV', 'TBILL', 'TBILL_COMPLETE']:
            return 'LEVERAGED SHORT TERM TREASURIES'
        if base_ticker in ['AGG', 'BND', 'BNDX', 'GOVT', 'LQD', 'HYG', 'JNK', 'MUB', 'TIP', 'VTIP']:
            return 'LEVERAGED BONDS'
        
        # Check for commodities
        if base_ticker in ['USO', 'CL=F', 'OIL', 'UNG', 'NG=F', 'NATGAS']:
            return 'LEVERAGED ENERGY COMMODITIES'
        if base_ticker in ['DBA', 'ZC=F', 'CORN', 'ZS=F', 'SOYBEAN', 'KC=F', 'COFFEE', 'SB=F', 'SUGAR', 'CT=F', 'COTTON']:
            return 'LEVERAGED AGRICULTURAL COMMODITIES'
        if base_ticker in ['DBC', 'GSG', 'PDBC', 'BCI', 'HG=F', 'COPPER']:
            return 'LEVERAGED BROAD COMMODITIES'
        if base_ticker in ['KMLM', 'DBMF', 'KMLMX', 'KMLM_COMPLETE', 'DBMFX', 'DBMF_COMPLETE']:
            return 'LEVERAGED MANAGED FUTURES'
        
        # Check for cryptocurrency
        if base_ticker in ['BTC-USD', 'ETH-USD', 'BITO', 'GBTC', 'ETHE', 'BITCOINX', 'BTC_COMPLETE']:
            return 'LEVERAGED DIGITAL ASSETS'
        
        # Check for real estate
        if base_ticker in ['VNQ', 'IYR', 'SCHH', 'RWR', 'XLRE']:
            return 'LEVERAGED REIT INDEX'
        
        # Check for volatility
        if base_ticker in ['VXX', 'UVXY', 'SVXY']:
            return 'LEVERAGED VOLATILITY INDEX'
        
        # Check if it's inverse leverage (negative L value)
        if '?L=-' in ticker.upper():
            # Determine specific inverse type based on base ticker
            if base_ticker in ['^IXIC', '^NDX', 'QQQ', 'QQQM']:
                return 'INVERSE LEVERAGED NASDAQ'
            else:
                return 'INVERSE LEVERAGED INDEX'
        else:
            # Determine specific leveraged type based on base ticker
            if base_ticker in ['^IXIC', '^NDX', 'QQQ', 'QQQM']:
                return 'LEVERAGED NASDAQ INDEX'
            elif base_ticker in ['^GSPC', '^SP500TR', 'SPY', 'VOO', 'IVV']:
                return 'LEVERAGED S&P 500 INDEX'
            else:
                return 'LEVERAGED INDEX FUND'
    
    # Custom industry mappings for ETFs and special tickers
    custom_industries = {
        # Broad Market Index ETFs
        'SPY': 'S&P 500 INDEX',
        'VOO': 'S&P 500 INDEX',
        'IVV': 'S&P 500 INDEX',
        'VTI': 'BROAD MARKET INDEX',
        'ITOT': 'BROAD MARKET INDEX',
        'SCHB': 'BROAD MARKET INDEX',
        'VT': 'BROAD MARKET INDEX',
        'VXUS': 'BROAD MARKET INDEX',
        'IXUS': 'BROAD MARKET INDEX',
        'DIA': 'BROAD MARKET INDEX',
        '^GSPC': 'S&P 500 INDEX',
        '^SP500TR': 'S&P 500 INDEX',
        '^DJI': 'BROAD MARKET INDEX',
        'SPYSIM': 'SP500 SIMULATION',
        'SPYSIM_COMPLETE': 'SP500 SIMULATION',
        
        # NASDAQ Index ETFs
        'QQQ': 'NASDAQ INDEX',
        'QQQM': 'NASDAQ INDEX',
        '^IXIC': 'NASDAQ INDEX',
        '^NDX': 'NASDAQ INDEX',
        
        # Momentum Index ETFs
        'MTUM': 'MOMENTUM INDEX',
        'SPMO': 'MOMENTUM INDEX',
        'VFMO': 'MOMENTUM INDEX',
        'QMOM': 'MOMENTUM INDEX',
        'IMOM': 'MOMENTUM INDEX',
        'JMOM': 'MOMENTUM INDEX',
        'SEIM': 'MOMENTUM INDEX',
        'FDMO': 'MOMENTUM INDEX',
        'FPMO': 'MOMENTUM INDEX',
        'IWMO': 'MOMENTUM INDEX',
        'UMMT': 'MOMENTUM INDEX',
        'LRGF': 'MOMENTUM INDEX',
        'MOM': 'MOMENTUM INDEX',
        'USMC': 'MOMENTUM INDEX',
        'PDP': 'MOMENTUM INDEX',
        'DWAQ': 'MOMENTUM INDEX',
        'DWAS': 'MOMENTUM INDEX',
        
        # Dividend Index ETFs
        'VIG': 'DIVIDEND INDEX',
        'SCHD': 'DIVIDEND INDEX',
        'DGRO': 'DIVIDEND INDEX',
        'HDV': 'DIVIDEND INDEX',
        'SPYD': 'DIVIDEND INDEX',
        'DVY': 'DIVIDEND INDEX',
        'SDY': 'DIVIDEND INDEX',
        'VYM': 'DIVIDEND INDEX',
        'RDVY': 'DIVIDEND INDEX',
        'FDL': 'DIVIDEND INDEX',
        'FVD': 'DIVIDEND INDEX',
        'NOBL': 'DIVIDEND INDEX',
        'DHS': 'DIVIDEND INDEX',
        'FDVV': 'DIVIDEND INDEX',
        'DGRW': 'DIVIDEND INDEX',
        'DIVO': 'DIVIDEND INDEX',
        'LVHD': 'DIVIDEND INDEX',
        'SPHD': 'DIVIDEND INDEX',
        'OUSA': 'DIVIDEND INDEX',
        'PID': 'DIVIDEND INDEX',
        'PEY': 'DIVIDEND INDEX',
        'DON': 'DIVIDEND INDEX',
        'FQAL': 'DIVIDEND INDEX',
        'RDIV': 'DIVIDEND INDEX',
        'VYMI': 'DIVIDEND INDEX',
        'IDV': 'DIVIDEND INDEX',
        'DGT': 'DIVIDEND INDEX',
        'DWX': 'DIVIDEND INDEX',
        
        # Growth Index ETFs
        'VUG': 'GROWTH INDEX',
        'MGK': 'GROWTH INDEX',
        'IWF': 'GROWTH INDEX',
        'RPG': 'GROWTH INDEX',
        'SCHG': 'GROWTH INDEX',
        'QGRO': 'GROWTH INDEX',
        'JKE': 'GROWTH INDEX',
        'IVW': 'GROWTH INDEX',
        'TGRW': 'GROWTH INDEX',
        'SPYG': 'GROWTH INDEX',
        'SYG': 'GROWTH INDEX',
        'GFG': 'GROWTH INDEX',
        'GXG': 'GROWTH INDEX',
        'GGRO': 'GROWTH INDEX',
        'XLG': 'GROWTH INDEX',
        
        # Leveraged Index ETFs
        'SSO': 'LEVERAGED S&P 500 INDEX',
        'QLD': 'LEVERAGED NASDAQ INDEX',
        'SPXL': 'LEVERAGED S&P 500 INDEX',
        'UPRO': 'LEVERAGED S&P 500 INDEX',
        'TQQQ': 'LEVERAGED NASDAQ INDEX',
        'TMF': 'LEVERAGED INDEX FUND',
        'SOXL': 'LEVERAGED INDEX FUND',
        'TNA': 'LEVERAGED INDEX FUND',
        'CURE': 'LEVERAGED INDEX FUND',
        'FAS': 'LEVERAGED INDEX FUND',
        'LABU': 'LEVERAGED INDEX FUND',
        'TECL': 'LEVERAGED INDEX FUND',
        'TQQQTR': 'LEVERAGED NASDAQ INDEX',
        'SPXLTR': 'LEVERAGED S&P 500 INDEX',
        'UPROTR': 'LEVERAGED S&P 500 INDEX',
        'QLDTR': 'LEVERAGED NASDAQ INDEX',
        'SSOTR': 'LEVERAGED S&P 500 INDEX',
        'SHTR': 'INVERSE LEVERAGED INDEX',
        'PSQTR': 'INVERSE LEVERAGED INDEX',
        'SDSTR': 'INVERSE LEVERAGED INDEX',
        'QIDTR': 'INVERSE LEVERAGED INDEX',
        'SPXUTR': 'INVERSE LEVERAGED INDEX',
        'SQQQTR': 'INVERSE LEVERAGED INDEX',
        
        # Treasury/Bond ETFs
        'TLT': 'LONG TERM TREASURIES',
        'ZROZ': 'LONG TERM TREASURIES',
        'VGLT': 'LONG TERM TREASURIES',
        'SPTL': 'LONG TERM TREASURIES',
        'TLH': 'LONG TERM TREASURIES',
        'TLTTR': 'LONG TERM TREASURIES',
        'TLT_COMPLETE': 'LONG TERM TREASURIES',
        'ZROZX': 'LONG TERM TREASURIES',
        'ZROZ_COMPLETE': 'LONG TERM TREASURIES',
        'IEF': 'INTERMEDIATE TREASURIES',
        'VGIT': 'INTERMEDIATE TREASURIES',
        'SPTI': 'INTERMEDIATE TREASURIES',
        'IEI': 'INTERMEDIATE TREASURIES',
        'IEFTR': 'INTERMEDIATE TREASURIES',
        'IEF_COMPLETE': 'INTERMEDIATE TREASURIES',
        'SHY': 'SHORT TERM TREASURIES',
        'BIL': 'SHORT TERM TREASURIES',
        'VGSH': 'SHORT TERM TREASURIES',
        'SPTS': 'SHORT TERM TREASURIES',
        'SHV': 'SHORT TERM TREASURIES',
        'TBILL': 'SHORT TERM TREASURIES',
        'TBILL_COMPLETE': 'SHORT TERM TREASURIES',
        '^TNX': 'TREASURY YIELDS',
        '^TYX': 'TREASURY YIELDS',
        '^FVX': 'TREASURY YIELDS',
        '^IRX': 'TREASURY YIELDS',
        'AGG': 'TOTAL BOND MARKET',
        'BND': 'TOTAL BOND MARKET',
        'BNDX': 'TOTAL BOND MARKET',
        'GOVT': 'TOTAL BOND MARKET',
        'LQD': 'CORPORATE BONDS',
        'HYG': 'CORPORATE BONDS',
        'JNK': 'CORPORATE BONDS',
        'MUB': 'CORPORATE BONDS',
        'TIP': 'CORPORATE BONDS',
        'VTIP': 'CORPORATE BONDS',
        
        # Gold/Precious Metals
        'GLD': 'PRECIOUS METALS',
        'GOLDX': 'PRECIOUS METALS',
        'GOLDSIM': 'PRECIOUS METALS',
        'IAU': 'PRECIOUS METALS',
        'IAUM': 'PRECIOUS METALS',
        'GLDM': 'PRECIOUS METALS',
        'SGOL': 'PRECIOUS METALS',
        'UGL': 'PRECIOUS METALS',
        'GOLD_COMPLETE': 'PRECIOUS METALS',
        'GOLDSIM_COMPLETE': 'PRECIOUS METALS',
        'GC=F': 'GOLD FUTURES',
        'GOLDF': 'GOLD FUTURES',
        'GDX': 'GOLD MINERS',
        'GDXJ': 'GOLD MINERS',
        'SLV': 'SILVER/PLATINUM/PALLADIUM',
        'SI=F': 'SILVER/PLATINUM/PALLADIUM',
        'SILVER': 'SILVER/PLATINUM/PALLADIUM',
        'PPLT': 'SILVER/PLATINUM/PALLADIUM',
        'PL=F': 'SILVER/PLATINUM/PALLADIUM',
        'PLATINUM': 'SILVER/PLATINUM/PALLADIUM',
        'PALL': 'SILVER/PLATINUM/PALLADIUM',
        'PA=F': 'SILVER/PLATINUM/PALLADIUM',
        'PALLADIUM': 'SILVER/PLATINUM/PALLADIUM',
        
        # Commodities
        'USO': 'ENERGY COMMODITIES',
        'CL=F': 'ENERGY COMMODITIES',
        'OIL': 'ENERGY COMMODITIES',
        'UNG': 'ENERGY COMMODITIES',
        'NG=F': 'ENERGY COMMODITIES',
        'NATGAS': 'ENERGY COMMODITIES',
        'DBA': 'AGRICULTURAL COMMODITIES',
        'ZC=F': 'AGRICULTURAL COMMODITIES',
        'CORN': 'AGRICULTURAL COMMODITIES',
        'ZS=F': 'AGRICULTURAL COMMODITIES',
        'SOYBEAN': 'AGRICULTURAL COMMODITIES',
        'KC=F': 'AGRICULTURAL COMMODITIES',
        'COFFEE': 'AGRICULTURAL COMMODITIES',
        'SB=F': 'AGRICULTURAL COMMODITIES',
        'SUGAR': 'AGRICULTURAL COMMODITIES',
        'CT=F': 'AGRICULTURAL COMMODITIES',
        'COTTON': 'AGRICULTURAL COMMODITIES',
        'DBC': 'BROAD COMMODITIES',
        'GSG': 'BROAD COMMODITIES',
        'PDBC': 'BROAD COMMODITIES',
        'BCI': 'BROAD COMMODITIES',
        'HG=F': 'INDUSTRIAL METALS',
        'COPPER': 'INDUSTRIAL METALS',
        'KMLM': 'MANAGED FUTURES',
        'DBMF': 'MANAGED FUTURES',
        'KMLMX': 'MANAGED FUTURES',
        'KMLM_COMPLETE': 'MANAGED FUTURES',
        'DBMFX': 'MANAGED FUTURES',
        'DBMF_COMPLETE': 'MANAGED FUTURES',
        
        # Cryptocurrency
        'BTC-USD': 'DIGITAL ASSETS',
        'ETH-USD': 'DIGITAL ASSETS',
        'BITO': 'DIGITAL ASSETS',
        'GBTC': 'DIGITAL ASSETS',
        'ETHE': 'DIGITAL ASSETS',
        'BITCOINX': 'DIGITAL ASSETS',
        'BTC_COMPLETE': 'DIGITAL ASSETS',
        'BITCOIN': 'DIGITAL ASSETS',
        
        # Bitcoin ETFs
        'IBIT': 'DIGITAL ASSETS',      # iShares Bitcoin Trust (BlackRock)
        'FBTC': 'DIGITAL ASSETS',      # Fidelity Wise Origin Bitcoin Fund
        'BITB': 'DIGITAL ASSETS',      # Bitwise Bitcoin ETF Trust
        'ARKB': 'DIGITAL ASSETS',      # ARK 21Shares Bitcoin ETF
        'BTCO': 'DIGITAL ASSETS',      # Invesco Galaxy Bitcoin ETF
        'HODL': 'DIGITAL ASSETS',      # 21Shares Crypto Basket 10 ETP
        'EZBC': 'DIGITAL ASSETS',      # ETC Group Bitcoin ETP
        'XBTF': 'DIGITAL ASSETS',      # ProShares Bitcoin Futures Strategy ETF
        'BTF': 'DIGITAL ASSETS',       # Valkyrie Bitcoin Strategy ETF
        'BTCC': 'DIGITAL ASSETS',      # Purpose Bitcoin ETF (Canada)
        
        # Technology
        'XLK': 'TECHNOLOGY INDEX FUND',
        'VGT': 'TECHNOLOGY INDEX FUND',
        'FTEC': 'TECHNOLOGY INDEX FUND',
        'IGM': 'TECHNOLOGY INDEX FUND',
        'SMH': 'SEMICONDUCTORS',
        'SOXX': 'SEMICONDUCTORS',
        'SOXS': 'LEVERAGED SEMICONDUCTORS',
        'USD': 'LEVERAGED SEMICONDUCTORS',
        
        # S&P 500 Sector Indices
        '^SP500-45': 'SECTOR INDEX FUND',
        '^SP500-35': 'SECTOR INDEX FUND',
        '^SP500-30': 'SECTOR INDEX FUND',
        '^SP500-40': 'SECTOR INDEX FUND',
        '^SP500-10': 'SECTOR INDEX FUND',
        '^SP500-20': 'SECTOR INDEX FUND',
        '^SP500-25': 'SECTOR INDEX FUND',
        '^SP500-15': 'SECTOR INDEX FUND',
        '^SP500-55': 'SECTOR INDEX FUND',
        '^SP500-60': 'SECTOR INDEX FUND',
        '^SP500-50': 'SECTOR INDEX FUND',
        'XLF': 'SECTOR INDEX FUND',
        'XLV': 'SECTOR INDEX FUND',
        'XLP': 'SECTOR INDEX FUND',
        'XLE': 'SECTOR INDEX FUND',
        'XLI': 'SECTOR INDEX FUND',
        'XLY': 'SECTOR INDEX FUND',
        'XLB': 'SECTOR INDEX FUND',
        'XLU': 'SECTOR INDEX FUND',
        'XLC': 'SECTOR INDEX FUND',
        
        # Real Estate
        'VNQ': 'REIT INDEX',
        'IYR': 'REIT INDEX',
        'SCHH': 'REIT INDEX',
        'RWR': 'REIT INDEX',
        'XLRE': 'REIT INDEX',
        
        # Volatility
        'VXX': 'VOLATILITY INDEX',
        'UVXY': 'VOLATILITY INDEX',
        'SVXY': 'VOLATILITY INDEX',
        
        # Cash Equivalents
        'CASH': 'CASH EQUIVALENT',
        'SGOV': 'CASH EQUIVALENT',
        'USFR': 'CASH EQUIVALENT',
        'ZEROX': 'CASH EQUIVALENT',
    }
    
    return custom_industries.get(base_ticker, None)

# =============================================================================
# PERFORMANCE OPTIMIZATION: CACHING FUNCTIONS
# =============================================================================

# =============================================================================
# STANDALONE LEVERAGE FUNCTIONS (Independent from Backtest_Engine)
# =============================================================================

def _ensure_naive_index(obj: pd.DataFrame | pd.Series) -> pd.DataFrame | pd.Series:
    """Return a copy of obj with a tz-naive DatetimeIndex."""
    if not isinstance(obj.index, pd.DatetimeIndex):
        return obj
    idx = obj.index
    if getattr(idx, "tz", None) is not None:
        obj = obj.copy()
        obj.index = idx.tz_convert(None)
    return obj

def _get_default_risk_free_rate(dates):
    """Get default risk-free rate when all other methods fail."""
    default_daily = (1 + 0.02) ** (1 / 365.25) - 1
    result = pd.Series(default_daily, index=pd.to_datetime(dates))
    # Ensure the result is timezone-naive
    if getattr(result.index, "tz", None) is not None:
        result.index = result.index.tz_convert(None)
    return result

def get_risk_free_rate_robust(dates):
    """Treasury / risk-free proxy via one batched Yahoo price download (^IRX, ^FVX, ^TNX, ^TYX)."""
    try:
        dates = pd.to_datetime(dates)
        if isinstance(dates, pd.DatetimeIndex):
            if getattr(dates, "tz", None) is not None:
                dates = dates.tz_convert(None)
        
        # Single batch for all treasury symbols; prefer ^IRX → ^FVX → ^TNX → ^TYX.
        symbols = ["^IRX", "^FVX", "^TNX", "^TYX"]
        hist = None
        try:
            batch_data = get_batch_download_with_cache(
                symbols,
                period="max",
                auto_adjust=False,
                progress=False,
                group_by="ticker",
                threads=False,
            )
            if batch_data is not None and not batch_data.empty:
                for symbol in symbols:
                    if (symbol, "Close") in batch_data.columns:
                        s = batch_data[(symbol, "Close")].dropna()
                        if len(s) > 0 and (s > 0).any():
                            hist = pd.DataFrame({"Close": batch_data[(symbol, "Close")]})
                            break
        except Exception:
            hist = None

        if hist is not None and not hist.empty and 'Close' in hist.columns:
            # Filter valid data
            valid_data = hist[hist['Close'].notnull() & (hist['Close'] > 0)]
            
            if not valid_data.empty:
                # Convert annual percentage to daily rate
                annual_rates = valid_data['Close'] / 100.0
                daily_rates = (1 + annual_rates) ** (1 / 365.25) - 1.0
                
                # Create series with timezone-naive index
                daily_rate_series = pd.Series(daily_rates.values, index=daily_rates.index)
                if getattr(daily_rate_series.index, "tz", None) is not None:
                    daily_rate_series.index = daily_rate_series.index.tz_convert(None)
                
                # For each target date, use the most recent available rate
                result = pd.Series(index=dates, dtype=float)
                
                for i, target_date in enumerate(dates):
                    # Find the most recent treasury date <= target_date
                    valid_dates = daily_rate_series.index[daily_rate_series.index <= target_date]
                    
                    if len(valid_dates) > 0:
                        closest_date = valid_dates.max()
                        result.iloc[i] = daily_rate_series.loc[closest_date]
                    else:
                        # Use the earliest available rate
                        result.iloc[i] = daily_rate_series.iloc[0]
                
                return result
            else:
                # No valid data - return constant rate
                return pd.Series(0.0001, index=dates)
        else:
            # No data available - return constant rate
            return pd.Series(0.0001, index=dates)
            
    except Exception as e:
        # Fallback to constant rate
        return pd.Series(0.0001, index=dates)

def parse_ticker_parameters(ticker_symbol: str) -> tuple[str, float, float]:
    """
    Parse ticker symbol to extract base ticker, leverage multiplier, and expense ratio.
    
    Args:
        ticker_symbol: Ticker symbol with optional parameters (e.g., "SPY?L=3?E=0.84")
        
    Returns:
        tuple: (base_ticker, leverage_multiplier, expense_ratio)
        
    Examples:
        "SPY" -> ("SPY", 1.0, 0.0)
        "SPY?L=3" -> ("SPY", 3.0, 0.0)
        "QQQ?L=3?E=0.84" -> ("QQQ", 3.0, 0.84)
        "QQQ?E=1?L=2" -> ("QQQ", 2.0, 1.0)  # Order doesn't matter
    """
    # Convert commas to dots for decimal separators (like case conversion)
    ticker_symbol = ticker_symbol.replace(",", ".")
    base_ticker = ticker_symbol
    leverage = 1.0
    expense_ratio = 0.0

    # Parse leverage parameter first
    if "?L=" in base_ticker:
        try:
            parts = base_ticker.split("?L=", 1)
            base_ticker = parts[0]
            leverage_part = parts[1]
            
            # Check if there are more parameters after leverage
            if "?" in leverage_part:
                leverage_str, remaining = leverage_part.split("?", 1)
                leverage = float(leverage_str)
                base_ticker += "?" + remaining
            else:
                leverage = float(leverage_part)
                
            # Leverage validation removed - allow any leverage value for testing
        except (ValueError, IndexError) as e:
            leverage = 1.0
    
    # Parse expense ratio parameter
    if "?E=" in base_ticker:
        try:
            parts = base_ticker.split("?E=", 1)
            base_ticker = parts[0]
            expense_part = parts[1]
            
            # Check if there are more parameters after expense ratio
            if "?" in expense_part:
                expense_str, remaining = expense_part.split("?", 1)
                expense_ratio = float(expense_str)
                base_ticker += "?" + remaining
            else:
                expense_ratio = float(expense_part)
                
            # Expense ratio validation removed - allow any expense ratio value for testing
        except (ValueError, IndexError) as e:
            expense_ratio = 0.0
            
    return base_ticker.strip(), leverage, expense_ratio

def parse_leverage_ticker(ticker_symbol: str) -> tuple[str, float]:
    """
    Parse ticker symbol to extract base ticker and leverage multiplier.
    Backward compatibility wrapper for parse_ticker_parameters.
    
    Args:
        ticker_symbol: Ticker symbol, potentially with leverage (e.g., "SPY?L=3")
        
    Returns:
        tuple: (base_ticker, leverage_multiplier)
        
    Examples:
        "SPY" -> ("SPY", 1.0)
        "SPY?L=3" -> ("SPY", 3.0)
        "QQQ?L=2" -> ("QQQ", 2.0)
    """
    base_ticker, leverage, _ = parse_ticker_parameters(ticker_symbol)
    return base_ticker, leverage

def apply_daily_leverage(price_data: pd.DataFrame, leverage: float, expense_ratio: float = 0.0) -> pd.DataFrame:
    """
    Apply daily leverage multiplier and expense ratio to price data, simulating leveraged ETF behavior.
    
    Leveraged ETFs reset daily, so we apply the leverage to daily returns and then
    compound the results to get the leveraged price series. Includes daily cost drag
    equivalent to (leverage - 1) × risk_free_rate plus daily expense ratio drag.
    
    Args:
        price_data: DataFrame with 'Close' column containing price data
        leverage: Leverage multiplier (e.g., 3.0 for 3x leverage)
        expense_ratio: Annual expense ratio in percentage (e.g., 1.0 for 1% annual expense)
        
    Returns:
        DataFrame with leveraged price data including cost drag and expense ratio drag
    """
    if leverage == 1.0 and expense_ratio == 0.0:
        return price_data.copy()
    
    # Create a copy to avoid modifying original data
    leveraged_data = price_data.copy()
    
    # Get time-varying risk-free rates for the entire period
    try:
        risk_free_rates = get_risk_free_rate_robust(price_data.index)
        # Save the risk-free rate series used during backtest for consistency in graphs
        st.session_state.backtest_risk_free_series = risk_free_rates
        # Ensure risk-free rates are timezone-naive to match price_data
        if getattr(risk_free_rates.index, "tz", None) is not None:
            risk_free_rates.index = risk_free_rates.index.tz_localize(None)
    except Exception as e:
        raise
    
    # Calculate daily cost drag: (leverage - 1) × risk_free_rate
    # risk_free_rates is already in daily format, so we don't need to divide by 365.25
    try:
        daily_cost_drag = (leverage - 1) * risk_free_rates
    except Exception as e:
        raise
    
    # Calculate daily expense ratio drag: expense_ratio / 100 / 365.25 (annual to daily)
    daily_expense_drag = expense_ratio / 100.0 / 365.25
    
    # VECTORIZED APPROACH - 100-1000x faster than for loop!
    # Calculate daily returns using vectorized operations
    prices = price_data['Close'].values  # Convert to NumPy array for speed
    daily_returns = np.zeros(len(prices))
    daily_returns[1:] = prices[1:] / prices[:-1] - 1  # Vectorized returns calculation
    
    # Apply leverage to returns and subtract cost drag and expense ratio drag
    leveraged_returns = (daily_returns * leverage) - daily_cost_drag.values - daily_expense_drag
    leveraged_returns[0] = 0  # First day has no return
    
    # Compound the leveraged returns to get prices (cumulative product)
    # Using np.cumprod for vectorized compounding
    leveraged_prices = prices[0] * np.cumprod(1 + leveraged_returns)
    
    # Convert back to pandas Series with proper index
    leveraged_prices = pd.Series(leveraged_prices, index=price_data.index)
    
    # Update the Close price with leveraged prices
    leveraged_data['Close'] = leveraged_prices
    
    # Recalculate price changes with the new leveraged prices
    leveraged_data['Price_change'] = leveraged_data['Close'].pct_change(fill_method=None)
    
    # IMPORTANT: Preserve all other columns (like Dividend_per_share) from original data
    # The dividends should remain at their original values (not leveraged) for leveraged ETFs
    # This is correct behavior - leveraged ETFs don't multiply dividends
    
    return leveraged_data

def apply_leverage_to_hist_data(hist_data, leverage):
    """Apply leverage to historical data"""
    if leverage == 1.0:
        return hist_data
    
    # Create a copy to avoid modifying original
    leveraged_data = hist_data.copy()
    
    # Apply leverage to price columns
    price_columns = ['Open', 'High', 'Low', 'Close']
    for col in price_columns:
        if col in leveraged_data.columns:
            leveraged_data[col] = leveraged_data[col] * leverage
    
    # Recalculate price changes with the new leveraged prices
    leveraged_data['Price_change'] = leveraged_data['Close'].pct_change(fill_method=None)
    
    return leveraged_data

def get_ticker_data_for_valuation(ticker_symbol, period="max", auto_adjust=False):
    """Get ticker data specifically for valuation tables
    
    This function handles two special cases:
    1. Canadian tickers: Converts USD OTC to Canadian exchange (CNSWF → CSU.TO)
    2. Leveraged tickers: Uses underlying ticker for valuation (NVDL → NVDA)
    
    Args:
        ticker_symbol: Stock ticker symbol
        period: Data period
        auto_adjust: Auto-adjust setting
    """
    try:
        # Parse leverage from ticker symbol
        base_ticker, leverage = parse_leverage_ticker(ticker_symbol)
        
        # Check if this is a leveraged ticker (for valuation stats only)
        leveraged_map = get_leveraged_ticker_underlying()
        if base_ticker.upper() in leveraged_map:
            underlying_ticker = leveraged_map[base_ticker.upper()]
            print(f"📊 VALUATION: Using {underlying_ticker} stats for leveraged ticker {base_ticker}")
            resolved_ticker = underlying_ticker
        else:
            # Resolve ticker alias for valuation tables (converts USD OTC to Canadian exchange, indices to ETFs)
            resolved_ticker = resolve_ticker_alias(base_ticker, for_stats=True)
        
        # Special handling for synthetic complete tickers
        if resolved_ticker == "ZEROX":
            return generate_zero_return_data(period)
        if resolved_ticker == "SPYSIM_COMPLETE":
            hist = get_spysim_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "GOLDSIM_COMPLETE":
            hist = get_goldsim_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "TBILL_COMPLETE":
            hist = get_tbill_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "IEF_COMPLETE":
            hist = get_ief_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "TLT_COMPLETE":
            hist = get_tlt_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "ZROZ_COMPLETE":
            hist = get_zroz_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "BTC_COMPLETE":
            hist = get_bitcoin_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "BTC-USD":
            # Fallback: If BTC-USD fails, try BTC_COMPLETE data
            try:
                hist = get_bitcoin_complete_data(period)
                # Apply leverage and/or expense ratio if specified
                if leverage != 1.0 or expense_ratio != 0.0:
                    hist = apply_daily_leverage(hist, leverage, expense_ratio)
                return hist
            except Exception:
                # Final fallback: use yfinance BTC-USD
                pass
        if resolved_ticker == "KMLM_COMPLETE":
            hist = get_kmlm_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "DBMF_COMPLETE":
            hist = get_dbmf_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        
        # Create ticker object with resolved ticker
        ticker_obj = get_ticker_with_cache(resolved_ticker)
        st.session_state.api_call_count += 1
        
        # Get historical data
        hist = ticker_obj.history(period=period, auto_adjust=auto_adjust)
        
        if hist.empty:
            return None
            
        # Apply leverage if specified
        if leverage != 1.0:
            hist = apply_leverage_to_hist_data(hist, leverage)
            
        return hist
        
    except Exception as e:
        st.error(f"Error fetching data for {ticker_symbol}: {str(e)}")
        return None

def get_multiple_tickers_batch(ticker_list, period="max", auto_adjust=False):
    """
    Smart batch download with fallback to individual downloads.
    
    Strategy:
    1. Try batch download (fast - 1 API call for all tickers)
    2. If batch fails → fallback to individual downloads (reliable)
    3. Invalid tickers are skipped, others continue
    
    Args:
        ticker_list: List of ticker symbols (can include leverage format)
        period: Data period
        auto_adjust: Auto-adjust setting
    
    Returns:
        Dict[ticker_symbol, DataFrame]: Data for each ticker
    """
    if not ticker_list:
        return {}
    
    results = {}
    yahoo_tickers = []
    
    for ticker_symbol in ticker_list:
        # Parse parameters from ticker if it has ?L= or ?E= format
        base_ticker = ticker_symbol
        leverage = 1.0
        expense_ratio = 0.0
        
        if '?L=' in ticker_symbol or '?E=' in ticker_symbol:
            parts = ticker_symbol.split('?')
            base_ticker = parts[0]
            for part in parts[1:]:
                if part.startswith('L='):
                    try:
                        leverage = float(part[2:])
                    except:
                        pass
                elif part.startswith('E='):
                    try:
                        expense_ratio = float(part[2:])
                    except:
                        pass
        
        # IMPORTANT: Do NOT convert tickers for price data (preserves currency)
        # Conversion to Canadian ticker (DLMAF → DOL.TO) is ONLY for stats/info, NOT for price
        # Use original ticker to preserve USD/CAD currency
        resolved = base_ticker  # Use original ticker, no conversion
        
        # Check if it's a special ticker that needs custom handling
        custom_list = ["ZEROX", "GOLD_COMPLETE", "ZROZ_COMPLETE", "TLT_COMPLETE", 
                      "BTC_COMPLETE", "IEF_COMPLETE", "KMLM_COMPLETE", "DBMF_COMPLETE",
                      "TBILL_COMPLETE", "SPYSIM_COMPLETE", "GOLDSIM_COMPLETE"]
        
        # Also check if the original ticker (before resolution) is a special ticker
        special_aliases = ["GOLDX", "ZROZX", "TLTTR", "BITCOINX", "IEFTR", "KMLMX", "DBMFX", 
                          "TBILL", "SPYSIM", "GOLDSIM", "GOLD50", "ZROZ50", "TLT50", 
                          "BTC50", "IEF50", "KMLM50", "DBMF50", "TBILL50"]
        
        # Mark as special if it's a special ticker
        is_special = resolved in custom_list or base_ticker.upper() in special_aliases
        
        yahoo_tickers.append((ticker_symbol, resolved, leverage, expense_ratio, is_special))
    
    # Extract unique resolved tickers for batch download (exclude special tickers)
    resolved_list = list(set([resolved for _, resolved, _, _, is_special in yahoo_tickers if not is_special]))
    
    unique_resolved = list(dict.fromkeys(resolved_list))
    YF_CHUNK = 80
    try:
        for i in range(0, len(unique_resolved), YF_CHUNK):
            chunk = unique_resolved[i:i + YF_CHUNK]
            if not chunk:
                continue
            batch_data = yf.download(
                chunk if len(chunk) > 1 else chunk[0],
                period=period,
                auto_adjust=auto_adjust,
                progress=False,
                group_by='ticker',
                actions=True,
                threads=True,
            )
            st.session_state.api_call_count += 1
            if batch_data is None or getattr(batch_data, "empty", True):
                continue
            for ticker_symbol, resolved, leverage, expense_ratio, is_special in yahoo_tickers:
                if is_special or resolved not in chunk:
                    continue
                if ticker_symbol in results and results[ticker_symbol] is not None and not getattr(results[ticker_symbol], "empty", True):
                    continue
                try:
                    if (resolved, 'Close') in batch_data.columns:
                        dividends_data = batch_data.get((resolved, 'Dividends'), pd.Series(0, index=batch_data.index))
                        ticker_data = pd.DataFrame({
                            'Close': batch_data[(resolved, 'Close')],
                            'Dividends': dividends_data
                        })
                    elif 'Close' in getattr(batch_data, "columns", []):
                        ticker_data = batch_data[['Close']].copy()
                        ticker_data['Dividends'] = batch_data['Dividends'] if 'Dividends' in batch_data.columns else 0
                    else:
                        ticker_data = pd.DataFrame()
                    if ticker_data is None or ticker_data.empty:
                        continue
                    ticker_data = ticker_data.dropna(how="all")
                    if ticker_data.empty:
                        continue
                    if leverage != 1.0 or expense_ratio != 0.0:
                        ticker_data = apply_daily_leverage(ticker_data, leverage, expense_ratio)
                    results[ticker_symbol] = ticker_data
                except Exception:
                    pass
    except Exception:
        pass
    
    # Handle special tickers individually (after batch download)
    for ticker_symbol, resolved, leverage, expense_ratio, is_special in yahoo_tickers:
        if is_special:
            try:
                # Handle special complete tickers using resolved ticker
                if resolved == "ZEROX":
                    hist = generate_zero_return_data(period)
                elif resolved == "SPYSIM_COMPLETE":
                    hist = get_spysim_complete_data(period)
                elif resolved == "GOLDSIM_COMPLETE":
                    hist = get_goldsim_complete_data(period)
                elif resolved == "GOLD_COMPLETE":
                    hist = get_gold_complete_data(period)
                elif resolved == "ZROZ_COMPLETE":
                    hist = get_zroz_complete_data(period)
                elif resolved == "TLT_COMPLETE":
                    hist = get_tlt_complete_data(period)
                elif resolved == "BTC_COMPLETE":
                    hist = get_bitcoin_complete_data(period)
                elif resolved == "KMLM_COMPLETE":
                    hist = get_kmlm_complete_data(period)
                elif resolved == "IEF_COMPLETE":
                    hist = get_ief_complete_data(period)
                elif resolved == "DBMF_COMPLETE":
                    hist = get_dbmf_complete_data(period)
                elif resolved == "TBILL_COMPLETE":
                    hist = get_tbill_complete_data(period)
                else:
                    # Fallback to get_ticker_data for other special tickers
                    hist = get_ticker_data(ticker_symbol, period=period, auto_adjust=auto_adjust)
                
                if hist is not None and not hist.empty:
                    if leverage != 1.0 or expense_ratio != 0.0:
                        hist = apply_daily_leverage(hist, leverage, expense_ratio)
                    results[ticker_symbol] = hist
                else:
                    pass
            except Exception as e:
                pass
    
    return results

def get_multiple_tickers_batch_for_valuation(ticker_list, period="max", auto_adjust=False):
    """
    Bulk download for valuation data - single API call for multiple tickers.
    
    Args:
        ticker_list: List of ticker symbols
        period: Data period
        auto_adjust: Auto-adjust setting
    
    Returns:
        Dict[ticker_symbol, DataFrame]: Data for each ticker
    """
    if not ticker_list:
        return {}
    
    results = {}
    
    try:
        # BULK DOWNLOAD - Single API call for all valuation tickers
        batch_data = get_batch_download_with_cache(
            ticker_list,
            period=period,
            auto_adjust=auto_adjust,
            progress=False,
            group_by='ticker',
            actions=True  # Include dividends and stock splits
        )
        st.session_state.api_call_count += 1
        
        # Process batch data
        if not batch_data.empty:
            for ticker_symbol in ticker_list:
                try:
                    if len(ticker_list) > 1:
                        # Multi-ticker batch - need to access multi-level columns
                        if (ticker_symbol, 'Close') in batch_data.columns:
                            dividends_data = batch_data.get((ticker_symbol, 'Dividends'), pd.Series(0, index=batch_data.index))
                            ticker_data = pd.DataFrame({
                                'Close': batch_data[(ticker_symbol, 'Close')],
                                'Dividends': dividends_data
                            })
                        else:
                            ticker_data = pd.DataFrame()
                    else:
                        # Single ticker batch - but still has multi-level columns!
                        if (ticker_symbol, 'Close') in batch_data.columns:
                            dividends_data = batch_data.get((ticker_symbol, 'Dividends'), pd.Series(0, index=batch_data.index))
                            ticker_data = pd.DataFrame({
                                'Close': batch_data[(ticker_symbol, 'Close')],
                                'Dividends': dividends_data
                            })
                        else:
                            ticker_data = pd.DataFrame()
                    
                    if not ticker_data.empty:
                        results[ticker_symbol] = ticker_data
                except Exception as e:
                    pass
        else:
            raise Exception("Batch download returned empty")
                
    except Exception as e:
        # NO FALLBACK - Pure batch mode only
        pass
    
    return results

def get_ticker_data(ticker_symbol, period="max", auto_adjust=False):
    """Get ticker data (NO CACHE for maximum freshness)
    
    Args:
        ticker_symbol: Stock ticker symbol (supports leverage format like SPY?L=3)
        period: Data period
        auto_adjust: Auto-adjust setting
    """
    try:
        # Parse leverage from ticker symbol
        base_ticker, leverage = parse_leverage_ticker(ticker_symbol)
        
        # Use original ticker for backtests and calculations (NO conversion)
        resolved_ticker = base_ticker
        
        # Special handling for synthetic complete tickers
        if resolved_ticker == "ZEROX":
            return generate_zero_return_data(period)
        if resolved_ticker == "SPYSIM_COMPLETE":
            hist = get_spysim_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "GOLDSIM_COMPLETE":
            hist = get_goldsim_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "GOLD_COMPLETE":
            hist = get_gold_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "ZROZ_COMPLETE":
            hist = get_zroz_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "TLT_COMPLETE":
            hist = get_tlt_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "BTC_COMPLETE":
            hist = get_bitcoin_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "BTC-USD":
            # Fallback: If BTC-USD fails, try BTC_COMPLETE data
            try:
                hist = get_bitcoin_complete_data(period)
                # Apply leverage and/or expense ratio if specified
                if leverage != 1.0 or expense_ratio != 0.0:
                    hist = apply_daily_leverage(hist, leverage, expense_ratio)
                return hist
            except Exception:
                # Final fallback: use yfinance BTC-USD
                pass
        if resolved_ticker == "KMLM_COMPLETE":
            hist = get_kmlm_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "IEF_COMPLETE":
            hist = get_ief_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "DBMF_COMPLETE":
            hist = get_dbmf_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        if resolved_ticker == "TBILL_COMPLETE":
            hist = get_tbill_complete_data(period)
            # Apply leverage and/or expense ratio if specified
            if leverage != 1.0 or expense_ratio != 0.0:
                hist = apply_daily_leverage(hist, leverage, expense_ratio)
            return hist
        
        ticker = get_ticker_with_cache(resolved_ticker)
        st.session_state.api_call_count += 1
        hist = ticker.history(period=period, auto_adjust=auto_adjust)[["Close", "Dividends"]]
        
        if hist.empty:
            return hist
            
        # Apply leverage if specified
        if leverage != 1.0:
            hist = apply_daily_leverage(hist, leverage)
            
        return hist
    except Exception:
        return pd.DataFrame()

# Synthetic Complete Ticker Functions
def get_spysim_complete_data(period="max"):
    """Get complete SPYSIM data from our custom SPYSIM ticker with cache"""
    return get_complete_data_with_cache("SPYSIM_COMPLETE_TICKER", "create_spysim_complete_ticker", "spysim_complete", period)

def get_goldsim_complete_data(period="max"):
    """Get complete GOLDSIM data from our custom GOLDSIM ticker with cache"""
    return get_complete_data_with_cache("GOLDSIM_COMPLETE_TICKER", "create_goldsim_complete_ticker", "goldsim_complete", period)

def get_complete_data_with_cache(module_name, function_name, cache_key_prefix, period="max"):
    """Helper function to get complete data with cache"""
    try:
        # Check cache first
        cache_key = f"{cache_key_prefix}_{period}"
        cache_dir = '.streamlit/ticker_cache'
        if not os.path.exists(cache_dir):
            os.makedirs(cache_dir, exist_ok=True)
        
        disk_cache = dc.Cache(cache_dir)
        cached_result = disk_cache.get(cache_key)
        if cached_result is not None:
            return cached_result
        
        # Load data if not cached
        module = __import__(f'Complete_Tickers.{module_name}', fromlist=[function_name])
        create_function = getattr(module, function_name)
        data = create_function()
        
        if data is not None and not data.empty:
            result = pd.DataFrame({
                'Close': data['Close'],
                'Dividends': [0.0] * len(data)
            }, index=data.index)
            # Cache for 4 hours
            disk_cache.set(cache_key, result, expire=14400)
            return result
        else:
            return None
    except Exception as e:
        # NO FALLBACK - Pure batch mode only
        return pd.DataFrame()

def generate_zero_return_data(period="max"):
    """Generate synthetic zero return data for ZEROX ticker"""
    try:
        ref_ticker = get_ticker_with_cache("SPY")
        st.session_state.api_call_count += 1
        ref_hist = ref_ticker.history(period=period)
        if ref_hist.empty:
            end_date = pd.Timestamp.now()
            start_date = end_date - pd.Timedelta(days=365)
            dates = pd.date_range(start=start_date, end=end_date, freq='D')
        else:
            dates = ref_hist.index
        zero_data = pd.DataFrame({
            'Close': [100.0] * len(dates),
            'Dividends': [0.0] * len(dates)
        }, index=dates)
        return zero_data
    except Exception:
        end_date = pd.Timestamp.now()
        start_date = end_date - pd.Timedelta(days=30)
        dates = pd.date_range(start=start_date, end=end_date, freq='D')
        zero_data = pd.DataFrame({
            'Close': [100.0] * len(dates),
            'Dividends': [0.0] * len(dates)
        }, index=dates)
        return zero_data

def get_gold_complete_data(period="max"):
    """Get complete gold data from our custom gold ticker with cache"""
    return get_complete_data_with_cache("GOLD_COMPLETE_TICKER", "create_gold_complete_ticker", "gold_complete", period)

def get_zroz_complete_data(period="max"):
    """Get complete ZROZ data from our custom ZROZ ticker with cache"""
    return get_complete_data_with_cache("ZROZ_COMPLETE_TICKER", "create_safe_zroz_ticker", "zroz_complete", period)

def get_tlt_complete_data(period="max"):
    """Get complete TLT data from our custom TLT ticker with cache"""
    return get_complete_data_with_cache("TLT_COMPLETE_TICKER", "create_safe_tlt_ticker", "tlt_complete", period)

def get_bitcoin_complete_data(period="max"):
    """Get complete Bitcoin data from our custom Bitcoin ticker with cache"""
    return get_complete_data_with_cache("BITCOIN_COMPLETE_TICKER", "create_bitcoin_complete_ticker", "bitcoin_complete", period)

def get_kmlm_complete_data(period="max"):
    """Get complete KMLM data from our custom KMLM ticker"""
    try:
        from Complete_Tickers.KMLM_COMPLETE_TICKER import create_kmlm_complete_ticker
        kmlm_data = create_kmlm_complete_ticker()
        if kmlm_data is not None and not kmlm_data.empty:
            result = pd.DataFrame({
                'Close': kmlm_data['Close'],
                'Dividends': [0.0] * len(kmlm_data)
            }, index=kmlm_data.index)
            return result
        else:
            return None
    except Exception as e:
        # NO FALLBACK - Pure batch mode only
        return pd.DataFrame()

def get_ief_complete_data(period="max"):
    """Get complete IEF data from our custom IEF ticker"""
    try:
        from Complete_Tickers.IEF_COMPLETE_TICKER import create_ief_complete_ticker
        ief_data = create_ief_complete_ticker()
        if ief_data is not None and not ief_data.empty:
            result = pd.DataFrame({
                'Close': ief_data['Close'],
                'Dividends': [0.0] * len(ief_data)
            }, index=ief_data.index)
            return result
        else:
            return None
    except Exception as e:
        # NO FALLBACK - Pure batch mode only
        return pd.DataFrame()

def get_dbmf_complete_data(period="max"):
    """Get complete DBMF data from our custom DBMF ticker"""
    try:
        from Complete_Tickers.DBMF_COMPLETE_TICKER import create_dbmf_complete_ticker
        dbmf_data = create_dbmf_complete_ticker()
        if dbmf_data is not None and not dbmf_data.empty:
            result = pd.DataFrame({
                'Close': dbmf_data['Close'],
                'Dividends': [0.0] * len(dbmf_data)
            }, index=dbmf_data.index)
            return result
        else:
            return None
    except Exception as e:
        # NO FALLBACK - Pure batch mode only
        return pd.DataFrame()

def get_tbill_complete_data(period="max"):
    """Get complete TBILL data from our custom TBILL ticker"""
    try:
        from Complete_Tickers.TBILL_COMPLETE_TICKER import create_tbill_complete_ticker
        tbill_data = create_tbill_complete_ticker()
        if tbill_data is not None and not tbill_data.empty:
            result = pd.DataFrame({
                'Close': tbill_data['Close'],
                'Dividends': [0.0] * len(tbill_data)
            }, index=tbill_data.index)
            return result
        else:
            return None
    except Exception as e:
        # NO FALLBACK - Pure batch mode only
        return pd.DataFrame()


def _coerce_yahooquery_scalar(val):
    """yahooquery often returns {'raw': x, 'fmt': '…'} for numeric quote fields."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        if isinstance(val, float) and pd.isna(val):
            return None
        return float(val)
    if isinstance(val, dict):
        raw = val.get("raw")
        if raw is not None:
            try:
                f = float(raw)
                if pd.isna(f):
                    return None
                return f
            except (TypeError, ValueError):
                return None
    return None


def _flatten_yahooquery_fundamentals_row(info: dict) -> dict:
    """Ensure trailingPE / forwardPE / beta are plain floats for downstream code."""
    if not info:
        return {}
    out = dict(info)
    pe = None
    for key in ("trailingPE", "trailingPe", "priceEarnings", "peRatio", "pe"):
        pe = _coerce_yahooquery_scalar(out.get(key))
        if pe is not None and 0 < pe < 100000:
            out["trailingPE"] = pe
            break
    if pe is None:
        t = out.get("trailingPE")
        if isinstance(t, dict):
            c = _coerce_yahooquery_scalar(t)
            if c is not None:
                out["trailingPE"] = c

    fpe = _coerce_yahooquery_scalar(out.get("forwardPE"))
    if fpe is not None:
        out["forwardPE"] = fpe
    elif isinstance(out.get("forwardPE"), dict):
        out["forwardPE"] = _coerce_yahooquery_scalar(out.get("forwardPE"))

    b = _coerce_yahooquery_scalar(out.get("beta"))
    if b is not None:
        out["beta"] = b
    elif isinstance(out.get("beta"), dict):
        out["beta"] = _coerce_yahooquery_scalar(out.get("beta"))

    return out


def _format_trailing_pe_for_display(info: dict) -> str:
    flat = _flatten_yahooquery_fundamentals_row(info or {})
    pe = flat.get("trailingPE")
    if pe is None:
        return "N/A"
    try:
        return f"{float(pe):.2f}"
    except (TypeError, ValueError):
        return "N/A"


def get_ticker_info(ticker_symbol):
    """Get ticker info with 4-hour cache
    
    This function handles two special cases:
    1. Canadian tickers: Converts USD OTC to Canadian exchange (CNSWF → CSU.TO)
    2. Leveraged tickers: Uses underlying ticker for info (NVDL → NVDA)
    """
    try:
        # Parse leverage from ticker symbol
        base_ticker, leverage = parse_leverage_ticker(ticker_symbol)
        
        # Check if this is a leveraged ticker (for valuation stats only)
        leveraged_map = get_leveraged_ticker_underlying()
        if base_ticker.upper() in leveraged_map:
            underlying_ticker = leveraged_map[base_ticker.upper()]
            resolved_ticker = underlying_ticker
        else:
            # Resolve ticker alias for valuation tables (converts USD OTC to Canadian exchange, indices to ETFs)
            resolved_ticker = resolve_ticker_alias(base_ticker, for_stats=True)
        
        merged_infos = st.session_state.get("alloc_page2_info_by_resolved")
        if isinstance(merged_infos, dict) and resolved_ticker in merged_infos:
            blob = merged_infos[resolved_ticker]
            if blob:
                return _flatten_yahooquery_fundamentals_row(dict(blob))
            return {}

        # Create cache key
        cache_key = f"individual_info_{resolved_ticker}"
        
        # Check cache first (4-hour TTL)
        cache_dir = '.streamlit/ticker_info_cache'
        if not os.path.exists(cache_dir):
            os.makedirs(cache_dir, exist_ok=True)
        
        disk_cache = dc.Cache(cache_dir)
        
        # Try to get from cache first
        cached_result = disk_cache.get(cache_key)
        if cached_result is not None:
            # Return cached data
            return cached_result
        
        # If not in cache, fetch from API
        stock = get_ticker_with_cache(resolved_ticker)
        info = stock.info
        
        # Cache the result for 4 hours
        disk_cache.set(cache_key, info, expire=14400)  # 4 hours = 14400 seconds
        
        return info
    except Exception:
        return {}

def get_multiple_tickers_info_batch(ticker_list):
    """
    yahooquery batch for fundamentals / PE, merged in session across all calls on this page.

    Only unresolved Yahoo symbols are fetched: repeated calls with overlapping tickers reuse
    ``st.session_state['alloc_page2_info_by_resolved']`` and extend it in one batch per missing set.
    """
    if not ticker_list:
        return {}

    if "alloc_page2_info_by_resolved" not in st.session_state:
        st.session_state.alloc_page2_info_by_resolved = {}
    merged = st.session_state.alloc_page2_info_by_resolved

    resolved_map = {}
    leveraged_map = get_leveraged_ticker_underlying()

    for ticker_symbol in ticker_list:
        base_ticker, leverage = parse_leverage_ticker(ticker_symbol)

        if base_ticker.upper() in leveraged_map:
            resolved = leveraged_map[base_ticker.upper()]
        else:
            resolved = resolve_ticker_alias(base_ticker, for_stats=True)

        resolved_map[ticker_symbol] = resolved

    unique_resolved = list(set(resolved_map.values()))
    missing_resolved = [r for r in unique_resolved if r not in merged]

    if missing_resolved:
        try:
            from yahooquery import Ticker as YahooQueryTicker

            batch_ticker = YahooQueryTicker(missing_resolved)

            summary_detail = batch_ticker.summary_detail
            financial_data = batch_ticker.financial_data
            key_stats = batch_ticker.key_stats
            quote_type = batch_ticker.quote_type

            recommendations = {}
            earnings = {}
            asset_profile = {}
            company_info = {}

            try:
                recommendations = batch_ticker.recommendations
            except Exception:
                pass

            try:
                earnings = batch_ticker.earnings
            except Exception:
                pass

            try:
                asset_profile = batch_ticker.asset_profile
            except Exception:
                pass

            try:
                company_info = batch_ticker.company_info
            except Exception:
                pass

            st.session_state.api_call_count += 1

            for resolved_ticker in missing_resolved:
                try:
                    combined_data = {}

                    # yahooquery sometimes returns error strings (e.g. ETFs: "No fundamentals data found...")
                    # instead of dicts for financial_data. dict.update(str) raises and would wipe summary_detail.
                    sd_row = summary_detail.get(resolved_ticker) if isinstance(summary_detail, dict) else None
                    if isinstance(sd_row, dict) and sd_row:
                        combined_data.update(sd_row)

                    fd_row = financial_data.get(resolved_ticker) if isinstance(financial_data, dict) else None
                    if isinstance(fd_row, dict) and fd_row:
                        combined_data.update(fd_row)

                    ks_row = key_stats.get(resolved_ticker) if isinstance(key_stats, dict) else None
                    if isinstance(ks_row, dict) and ks_row:
                        combined_data.update(ks_row)

                    qt_row = quote_type.get(resolved_ticker) if isinstance(quote_type, dict) else None
                    if isinstance(qt_row, dict) and qt_row:
                        combined_data.update(qt_row)

                    if resolved_ticker in recommendations and recommendations[resolved_ticker]:
                        rec_data = recommendations[resolved_ticker]
                        if isinstance(rec_data, list) and len(rec_data) > 0:
                            latest_rec = rec_data[0]
                            combined_data.update({
                                'recommendationKey': latest_rec.get('recommendationKey'),
                                'recommendationMean': latest_rec.get('recommendationMean'),
                                'targetMeanPrice': latest_rec.get('targetMeanPrice'),
                                'targetHighPrice': latest_rec.get('targetHighPrice'),
                                'targetLowPrice': latest_rec.get('targetLowPrice')
                            })

                    if resolved_ticker in earnings and earnings[resolved_ticker]:
                        earnings_data = earnings[resolved_ticker]
                        if isinstance(earnings_data, dict):
                            combined_data.update(earnings_data)

                    if resolved_ticker in asset_profile and asset_profile[resolved_ticker]:
                        profile_ap = asset_profile[resolved_ticker]
                        if isinstance(profile_ap, dict):
                            combined_data.update(profile_ap)

                    if resolved_ticker in company_info and company_info[resolved_ticker]:
                        company_data = company_info[resolved_ticker]
                        if isinstance(company_data, dict):
                            combined_data.update(company_data)

                    try:
                        if hasattr(batch_ticker, 'profile') and resolved_ticker in batch_ticker.profile:
                            profile_data = batch_ticker.profile[resolved_ticker]
                            if isinstance(profile_data, dict):
                                combined_data.update(profile_data)
                    except Exception:
                        pass

                    merged[resolved_ticker] = _flatten_yahooquery_fundamentals_row(combined_data)
                except Exception:
                    merged[resolved_ticker] = {}

        except ImportError:
            st.error("❌ yahooquery not available - PE data will be skipped")
            return {}
        except Exception as e:
            st.error(f"❌ yahooquery failed: {e} - PE data will be skipped")
            return {}

    results = {}
    for ticker_symbol in ticker_list:
        resolved = resolved_map[ticker_symbol]
        results[ticker_symbol] = _flatten_yahooquery_fundamentals_row(dict(merged.get(resolved, {})))

    return results

def calculate_portfolio_metrics(portfolio_config, allocation_data):
    """Calculate portfolio metrics (NO CACHE for maximum freshness)"""
    # This will calculate portfolio metrics fresh every time
    # Note: The actual calculation logic remains unchanged
    return portfolio_config, allocation_data  # Placeholder - will be filled in by calling functions

def optimize_data_loading():
    """Session state optimization to prevent redundant operations - PAGE-SPECIFIC"""
    # Use page-specific keys to prevent conflicts between pages
    page_prefix = "alloc_page_"
    
    # Initialize performance flags if not present
    if f'{page_prefix}data_loaded' not in st.session_state:
        st.session_state[f'{page_prefix}data_loaded'] = False
    if f'{page_prefix}last_refresh' not in st.session_state:
        st.session_state[f'{page_prefix}last_refresh'] = None
    
    # Check if data needs refresh (5 minutes)
    current_time = datetime.datetime.now()
    if (st.session_state[f'{page_prefix}last_refresh'] is None or 
        (current_time - st.session_state[f'{page_prefix}last_refresh']).seconds > 300):
        st.session_state[f'{page_prefix}data_loaded'] = False
        st.session_state[f'{page_prefix}last_refresh'] = current_time
    
    return st.session_state[f'{page_prefix}data_loaded']

def create_safe_hash_key(data):
    """Create a safe, consistent hash key from complex data structures"""
    import hashlib
    import json
    try:
        # Convert to JSON string and hash for consistent hash keys
        json_str = json.dumps(data, sort_keys=True, default=str)
        return hashlib.md5(json_str.encode()).hexdigest()
    except Exception:
        # Fallback to string representation
        return hashlib.md5(str(data).encode()).hexdigest()


def select_tickers_with_concentration_limits(
    ranked_tickers,
    n_to_select,
    sector_industry_map=None,
    max_per_sector=None,
    max_per_industry=None,
    fill_deferred=True,
    unknown_counts_as_category=True,
):
    """Pick tickers from a ranked list while capping sector / industry (category) counts.

    Pass 1: take tickers in rank order if under caps (skipped ones are deferred).
    Pass 2 (only if fill_deferred=True): if still short of N, fill with deferred tickers
    in original order so a Top-N / Equal-Weight target size can still be reached.
    When fill_deferred=False (no Top N / Equal Weight), excluded tickers stay out and
    the portfolio can simply be smaller.
    Missing Yahoo sector/industry is labeled "Unknown". If unknown_counts_as_category
    is True they share one capped bucket; if False they are exempt from that cap.
    """
    if not ranked_tickers or n_to_select <= 0:
        return []
    n_to_select = min(int(n_to_select), len(ranked_tickers))
    sector_industry_map = sector_industry_map or {}
    use_sector = max_per_sector is not None and int(max_per_sector) > 0
    use_industry = max_per_industry is not None and int(max_per_industry) > 0
    if not use_sector and not use_industry:
        return list(ranked_tickers[:n_to_select])

    max_sector = int(max_per_sector) if use_sector else None
    max_industry = int(max_per_industry) if use_industry else None
    selected = []
    deferred = []
    sector_counts = {}
    industry_counts = {}

    def _labels(ticker):
        meta = sector_industry_map.get(ticker) or {}
        sector = (meta.get('sector') or 'Unknown').strip() or 'Unknown'
        industry = (meta.get('industry') or 'Unknown').strip() or 'Unknown'
        return sector, industry

    for ticker in ranked_tickers:
        if len(selected) >= n_to_select:
            break
        sector, industry = _labels(ticker)
        sector_unknown = sector == 'Unknown'
        industry_unknown = industry == 'Unknown'
        if use_sector:
            if sector_unknown and not unknown_counts_as_category:
                sector_ok = True
            else:
                sector_ok = sector_counts.get(sector, 0) < max_sector
        else:
            sector_ok = True
        if use_industry:
            if industry_unknown and not unknown_counts_as_category:
                industry_ok = True
            else:
                industry_ok = industry_counts.get(industry, 0) < max_industry
        else:
            industry_ok = True
        if sector_ok and industry_ok:
            selected.append(ticker)
            if use_sector and not (sector_unknown and not unknown_counts_as_category):
                sector_counts[sector] = sector_counts.get(sector, 0) + 1
            if use_industry and not (industry_unknown and not unknown_counts_as_category):
                industry_counts[industry] = industry_counts.get(industry, 0) + 1
        else:
            deferred.append(ticker)

    if fill_deferred and len(selected) < n_to_select:
        for ticker in deferred:
            if len(selected) >= n_to_select:
                break
            selected.append(ticker)

    return selected


def fetch_sector_industry_map(ticker_list):
    """Batch-fetch Yahoo sector + industry (category) for tickers; 24h disk cache."""
    if not ticker_list:
        return {}

    cache_dir = '.streamlit/ticker_info_cache'
    os.makedirs(cache_dir, exist_ok=True)
    disk_cache = dc.Cache(cache_dir)
    results = {}
    to_fetch = []

    for ticker_symbol in ticker_list:
        if not ticker_symbol:
            continue
        cache_key = f"sector_industry_{ticker_symbol}"
        cached = disk_cache.get(cache_key)
        if isinstance(cached, dict) and ('sector' in cached or 'industry' in cached):
            results[ticker_symbol] = {
                'sector': cached.get('sector') or 'Unknown',
                'industry': cached.get('industry') or 'Unknown',
            }
        else:
            to_fetch.append(ticker_symbol)

    if not to_fetch:
        return results

    resolved_map = {}
    for ticker_symbol in to_fetch:
        try:
            base_ticker, _ = parse_leverage_ticker(ticker_symbol)
            resolved_map[ticker_symbol] = resolve_ticker_alias(base_ticker, for_stats=True)
        except Exception:
            resolved_map[ticker_symbol] = ticker_symbol

    unique_resolved = list(set(resolved_map.values()))
    profile_by_resolved = {}

    try:
        from yahooquery import Ticker as YahooQueryTicker
        batch_ticker = YahooQueryTicker(unique_resolved)
        if 'api_call_count' not in st.session_state:
            st.session_state.api_call_count = 0
        st.session_state.api_call_count += 1
        asset_profile = batch_ticker.asset_profile
        if isinstance(asset_profile, dict):
            for resolved in unique_resolved:
                blob = asset_profile.get(resolved)
                if isinstance(blob, dict):
                    profile_by_resolved[resolved] = {
                        'sector': blob.get('sector') or 'Unknown',
                        'industry': blob.get('industry') or 'Unknown',
                    }
    except Exception:
        pass

    for ticker_symbol in to_fetch:
        resolved = resolved_map.get(ticker_symbol, ticker_symbol)
        meta = profile_by_resolved.get(resolved)
        if not meta or (meta.get('sector') in (None, 'Unknown') and meta.get('industry') in (None, 'Unknown')):
            try:
                info = get_ticker_info(ticker_symbol) or {}
                meta = {
                    'sector': info.get('sector') or (meta or {}).get('sector') or 'Unknown',
                    'industry': info.get('industry') or (meta or {}).get('industry') or 'Unknown',
                }
            except Exception:
                meta = meta or {'sector': 'Unknown', 'industry': 'Unknown'}
        results[ticker_symbol] = {
            'sector': (meta.get('sector') or 'Unknown'),
            'industry': (meta.get('industry') or 'Unknown'),
        }
        try:
            disk_cache.set(f"sector_industry_{ticker_symbol}", results[ticker_symbol], expire=86400)
        except Exception:
            pass

    return results


_WIKIPEDIA_SP500_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
_SP500_WIKI_CACHE_KEY = "sp500_wikipedia_constituents_page2_v2"


def normalize_sp500_symbol(symbol):
    """Wikipedia uses BRK.B; Yahoo uses BRK-B."""
    if not symbol:
        return ""
    return str(symbol).strip().upper().replace(".", "-")


def sp500_lookup_key(ticker):
    """Base ticker for S&P 500 date lookup (strip leverage params, Yahoo-normalize)."""
    if not ticker:
        return ""
    raw = str(ticker).strip()
    if not raw or raw.upper() == "CASH":
        return ""
    try:
        base_ticker, _ = parse_leverage_ticker(raw)
    except Exception:
        base_ticker = raw
    return normalize_sp500_symbol(base_ticker)


def is_ticker_in_sp500_on_date(ticker, as_of_date, date_added_map):
    """True if ticker is not a current S&P 500 name, or as_of_date >= Wikipedia Date added.

    Tickers absent from the Wikipedia list (ETFs, custom, cash) stay eligible.
    """
    if not ticker or str(ticker).strip().upper() == "CASH":
        return True
    if not date_added_map:
        return True
    key = sp500_lookup_key(ticker)
    if not key:
        return True
    entry = date_added_map.get(key)
    if entry is None:
        entry = date_added_map.get(key.replace("-", "."))
    if entry is None:
        return True
    try:
        entry_ts = pd.Timestamp(entry)
        as_of = pd.Timestamp(as_of_date)
        if getattr(entry_ts, "tzinfo", None) is not None:
            entry_ts = entry_ts.tz_localize(None)
        if getattr(as_of, "tzinfo", None) is not None:
            as_of = as_of.tz_localize(None)
        return as_of.normalize() >= entry_ts.normalize()
    except Exception:
        return True


def _get_sp500_date_added_map(config=None):
    if isinstance(config, dict):
        injected = config.get("_sp500_date_added")
        if isinstance(injected, dict) and injected:
            return injected
    try:
        return st.session_state.get("alloc_sp500_date_added") or {}
    except Exception:
        return {}


def filter_tickers_by_sp500_entry(tickers, as_of_date, config=None):
    """Keep tickers that are eligible on as_of_date when the portfolio option is on."""
    tickers = list(tickers) if tickers is not None else []
    if config and config.get("exclude_before_sp500_entry"):
        date_map = _get_sp500_date_added_map(config)
        if date_map:
            tickers = [t for t in tickers if is_ticker_in_sp500_on_date(t, as_of_date, date_map)]
    return filter_tickers_by_min_market_cap(tickers, as_of_date, config)


def _universe_filters_active(config):
    return bool(config) and (
        config.get("exclude_before_sp500_entry")
        or config.get("use_min_market_cap_filter")
    )


def _mcap_symbol_key(ticker):
    key = sp500_lookup_key(ticker)
    return key or str(ticker or "").strip().upper()


def is_ticker_above_min_market_cap(ticker, as_of_date, config):
    """True if estimated cap on as_of_date >= threshold. Missing cap/price => False when filter is on.

    Proxy: cap(date) ≈ today's Yahoo marketCap × (price_date / price_today), from the batched quote endpoint.
    """
    if not ticker or str(ticker).strip().upper() == "CASH":
        return True
    if not config or not config.get("use_min_market_cap_filter"):
        return True
    try:
        threshold = float(config.get("min_market_cap_billions") or 0) * 1e9
    except Exception:
        return True
    if threshold <= 0:
        return True
    scale_map = config.get("_mcap_price_scale") or {}
    key = _mcap_symbol_key(ticker)
    scale = scale_map.get(key) or scale_map.get(str(ticker).strip().upper())
    if not scale:
        return False
    series_map = config.get("_mcap_close_series") or {}
    series = series_map.get(ticker)
    if series is None:
        series = series_map.get(key)
    if series is None:
        return False
    try:
        as_of = pd.Timestamp(as_of_date)
        if getattr(as_of, "tzinfo", None) is not None:
            as_of = as_of.tz_localize(None)
        idx = series.index.asof(as_of)
        if idx is None or pd.isna(idx):
            return False
        px = float(series.loc[idx])
        if not np.isfinite(px) or px <= 0:
            return False
        return (px * float(scale)) >= threshold
    except Exception:
        return False


def filter_tickers_by_min_market_cap(tickers, as_of_date, config=None):
    tickers = list(tickers) if tickers is not None else []
    if not config or not config.get("use_min_market_cap_filter"):
        return tickers
    if not (config.get("_mcap_price_scale") or {}):
        return tickers
    return [t for t in tickers if is_ticker_above_min_market_cap(t, as_of_date, config)]


def attach_mcap_close_lookup(config, reindexed_data):
    """Point eligibility at already-downloaded Close series (no extra Yahoo)."""
    if not config or not config.get("use_min_market_cap_filter"):
        return
    closes = {}
    for t, df in (reindexed_data or {}).items():
        if not t or str(t).strip().upper() == "CASH":
            continue
        if isinstance(df, pd.DataFrame) and "Close" in df.columns:
            closes[t] = df["Close"]
            key = _mcap_symbol_key(t)
            if key and key not in closes:
                closes[key] = df["Close"]
    config["_mcap_close_series"] = closes


def fetch_yahoo_quote_market_caps(tickers):
    """Current market cap + last price via Yahoo v7/finance/quote (chunked). 24h disk cache."""
    import json as _json
    import ssl
    import urllib.parse
    import urllib.request
    import http.cookiejar

    wanted = []
    seen = set()
    for raw in tickers or []:
        key = _mcap_symbol_key(raw)
        if not key or key == "CASH" or key in seen:
            continue
        seen.add(key)
        wanted.append(key)
    if not wanted:
        return {}, None

    cache_dir = ".streamlit/ticker_info_cache"
    os.makedirs(cache_dir, exist_ok=True)
    disk_cache = dc.Cache(cache_dir)
    scale_map = {}
    missing = []
    for key in wanted:
        cached = disk_cache.get(f"yahoo_mcap_quote_v1_{key}")
        if isinstance(cached, dict) and cached.get("scale"):
            scale_map[key] = float(cached["scale"])
        else:
            missing.append(key)
    if not missing:
        return scale_map, None

    try:
        ctx = ssl._create_unverified_context()
        cj = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=ctx),
            urllib.request.HTTPCookieProcessor(cj),
        )
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
        }

        def _get(url):
            req = urllib.request.Request(url, headers=headers)
            with opener.open(req, timeout=30) as resp:
                return resp.read()

        try:
            _get("https://fc.yahoo.com")
        except Exception:
            pass
        crumb = _get("https://query1.finance.yahoo.com/v1/test/getcrumb").decode("utf-8").strip()
        if not crumb or "<" in crumb:
            return scale_map, "Yahoo quote crumb failed"

        chunk_size = 300
        for i in range(0, len(missing), chunk_size):
            chunk = missing[i:i + chunk_size]
            url = (
                "https://query1.finance.yahoo.com/v7/finance/quote?symbols="
                + urllib.parse.quote(",".join(chunk))
                + "&crumb="
                + urllib.parse.quote(crumb)
            )
            payload = _json.loads(_get(url).decode("utf-8"))
            rows = (payload.get("quoteResponse") or {}).get("result") or []
            by_symbol = {str(r.get("symbol") or "").upper(): r for r in rows if isinstance(r, dict)}
            for key in chunk:
                row = by_symbol.get(key) or by_symbol.get(key.replace("-", "."))
                if not row:
                    continue
                cap = row.get("marketCap")
                if cap is None:
                    cap = row.get("netAssets")
                price = row.get("regularMarketPrice")
                try:
                    cap = float(cap)
                    price = float(price)
                except Exception:
                    continue
                if not np.isfinite(cap) or not np.isfinite(price) or cap <= 0 or price <= 0:
                    continue
                scale = cap / price
                scale_map[key] = scale
                try:
                    disk_cache.set(
                        f"yahoo_mcap_quote_v1_{key}",
                        {"scale": scale, "market_cap": cap, "price": price},
                        expire=86400,
                    )
                except Exception:
                    pass
        if not scale_map:
            return {}, "Yahoo quote returned no market caps"
        return scale_map, None
    except Exception as e:
        return scale_map or {}, f"Error fetching Yahoo market caps: {e}"


def _download_wikipedia_sp500_html():
    """Stdlib urllib only. This page must not import http_requests or any other project file."""
    import ssl
    import urllib.request

    req = urllib.request.Request(
        _WIKIPEDIA_SP500_URL,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
        },
    )
    contexts = []
    try:
        import certifi
        contexts.append(ssl.create_default_context(cafile=certifi.where()))
    except Exception:
        pass
    try:
        contexts.append(ssl.create_default_context())
    except Exception:
        pass
    contexts.append(ssl._create_unverified_context())

    last_error = None
    for ctx in contexts:
        try:
            with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
                if getattr(resp, "status", 200) >= 400:
                    raise RuntimeError(f"Wikipedia HTTP {resp.status}")
                return resp.read()
        except Exception as e:
            last_error = e
    raise last_error or RuntimeError("Wikipedia download failed")


def fetch_sp500_wikipedia_constituents():
    """One Wikipedia GET on this page: current S&P 500 tickers + Date added. 24h disk cache."""
    cache_dir = ".streamlit/ticker_info_cache"
    os.makedirs(cache_dir, exist_ok=True)
    disk_cache = dc.Cache(cache_dir)
    cached = disk_cache.get(_SP500_WIKI_CACHE_KEY)
    if isinstance(cached, dict) and cached.get("tickers") and isinstance(cached.get("date_added"), dict):
        return cached, None
    try:
        html = _download_wikipedia_sp500_html()
        soup = BeautifulSoup(html, "html.parser")
        table = soup.find("table", {"id": "constituents"})
        if not table:
            return None, "Could not find S&P 500 table on Wikipedia"

        header_row = table.find("tr")
        headers = [c.get_text(strip=True).lower() for c in header_row.find_all(["th", "td"])]
        date_idx = next((i for i, h in enumerate(headers) if "date added" in h), None)
        if date_idx is None:
            date_idx = 5

        tickers = []
        date_added = {}
        seen = set()
        for row in table.find_all("tr")[1:]:
            cells = row.find_all(["td", "th"])
            if not cells:
                continue
            raw_symbol = cells[0].get_text(strip=True)
            ticker = normalize_sp500_symbol(raw_symbol)
            if not ticker or ticker in seen:
                continue
            seen.add(ticker)
            tickers.append(ticker)
            if date_idx < len(cells):
                date_text = cells[date_idx].get_text(strip=True)
                ts = pd.to_datetime(date_text, errors="coerce")
                if pd.notna(ts):
                    iso = pd.Timestamp(ts).strftime("%Y-%m-%d")
                    date_added[ticker] = iso
                    raw_upper = str(raw_symbol).strip().upper()
                    if raw_upper and raw_upper != ticker:
                        date_added[raw_upper] = iso

        if not tickers:
            return None, "Wikipedia S&P 500 table had no tickers"

        payload = {
            "tickers": tickers,
            "date_added": date_added,
            "copy_string": " ".join(tickers),
        }
        try:
            disk_cache.set(_SP500_WIKI_CACHE_KEY, payload, expire=86400)
        except Exception:
            pass
        return payload, None
    except Exception as e:
        return None, f"Error fetching Wikipedia S&P 500 list: {e}"


_NASDAQ_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt"
_OTHER_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt"
_US_MARKET_CACHE_KEY = "us_listed_common_stocks_page2_v1"
_US_MARKET_SKIP_NAME_RE = re.compile(
    r"\b(warrant|warrants|right|rights|unit|units|preferred)\b",
    re.IGNORECASE,
)
_US_MARKET_SYMBOL_RE = re.compile(r"^[A-Z]{1,5}(?:-[A-Z])?$")


def _download_url_bytes(url, timeout=30):
    """Stdlib urllib only. This page must not import http_requests or any other project file."""
    import ssl
    import urllib.request

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
        },
    )
    contexts = []
    try:
        import certifi
        contexts.append(ssl.create_default_context(cafile=certifi.where()))
    except Exception:
        pass
    try:
        contexts.append(ssl.create_default_context())
    except Exception:
        pass
    contexts.append(ssl._create_unverified_context())

    last_error = None
    for ctx in contexts:
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                if getattr(resp, "status", 200) >= 400:
                    raise RuntimeError(f"HTTP {resp.status} for {url}")
                return resp.read()
        except Exception as e:
            last_error = e
    raise last_error or RuntimeError(f"Download failed: {url}")


def normalize_us_listed_symbol(symbol):
    """Nasdaq uses BRK.B; Yahoo uses BRK-B."""
    if not symbol:
        return ""
    ticker = str(symbol).strip().upper().replace(".", "-")
    if not _US_MARKET_SYMBOL_RE.match(ticker):
        return ""
    return ticker


def parse_nasdaq_trader_common_stocks(nasdaq_text, other_text):
    """Keep listed common stocks; drop ETFs, test issues, warrants, rights, units, preferreds."""

    def parse_file(text, symbol_key, name_key, etf_key, test_key, nextshares_key=None):
        lines = [ln for ln in (text or "").splitlines() if ln.strip()]
        if not lines:
            return []
        header = [h.strip() for h in lines[0].split("|")]
        idx = {h: i for i, h in enumerate(header)}
        try:
            si, ni, ei, ti = idx[symbol_key], idx[name_key], idx[etf_key], idx[test_key]
        except KeyError:
            raise RuntimeError(f"Unexpected Nasdaq file headers: {header}")
        nsi = idx.get(nextshares_key) if nextshares_key else None
        found = []
        for line in lines[1:]:
            if line.startswith("File Creation"):
                continue
            parts = line.split("|")
            needed = [si, ni, ei, ti]
            if nsi is not None:
                needed.append(nsi)
            if max(needed) >= len(parts):
                continue
            if parts[ti].strip().upper() == "Y":
                continue
            if parts[ei].strip().upper() == "Y":
                continue
            if nsi is not None and parts[nsi].strip().upper() == "Y":
                continue
            if _US_MARKET_SKIP_NAME_RE.search(parts[ni] or ""):
                continue
            ticker = normalize_us_listed_symbol(parts[si])
            if ticker:
                found.append(ticker)
        return found

    tickers = []
    seen = set()
    for ticker in parse_file(
        nasdaq_text, "Symbol", "Security Name", "ETF", "Test Issue", "NextShares"
    ) + parse_file(
        other_text, "ACT Symbol", "Security Name", "ETF", "Test Issue"
    ):
        if ticker not in seen:
            seen.add(ticker)
            tickers.append(ticker)
    tickers.sort()
    return tickers


def fetch_us_listed_common_stocks():
    """NYSE/NASDAQ/AMEX common stocks from Nasdaq Trader symbol directories. 24h disk cache."""
    cache_dir = ".streamlit/ticker_info_cache"
    os.makedirs(cache_dir, exist_ok=True)
    disk_cache = dc.Cache(cache_dir)
    cached = disk_cache.get(_US_MARKET_CACHE_KEY)
    if isinstance(cached, dict) and cached.get("tickers") and cached.get("copy_string"):
        return cached, None
    try:
        nasdaq_text = _download_url_bytes(_NASDAQ_LISTED_URL).decode("latin-1")
        other_text = _download_url_bytes(_OTHER_LISTED_URL).decode("latin-1")
        tickers = parse_nasdaq_trader_common_stocks(nasdaq_text, other_text)
        if not tickers:
            return None, "Nasdaq Trader symbol directories had no common stocks"
        payload = {
            "tickers": tickers,
            "copy_string": " ".join(tickers),
        }
        try:
            disk_cache.set(_US_MARKET_CACHE_KEY, payload, expire=86400)
        except Exception:
            pass
        return payload, None
    except Exception as e:
        return None, f"Error fetching US listed common stocks: {e}"


def run_fresh_backtest(portfolios_config_hash, start_date_str, end_date_str, benchmark_str, page_id="allocations"):
    """Run fresh backtest calculations (NO CACHE for maximum freshness)
    
    Args:
        portfolios_config_hash: Hash of portfolio configurations to detect changes
        start_date_str: Start date as string
        end_date_str: End date as string  
        benchmark_str: Benchmark ticker as string
        page_id: Page identifier to prevent cross-page conflicts
    """
    # This will be called by the actual backtest functions when needed
    # The caching key includes all parameters that affect the backtest result
    return portfolios_config_hash, start_date_str, end_date_str, benchmark_str, page_id  # Placeholder

def get_exchange_rate(from_currency, to_currency, force_refresh=False):
    """
    Get exchange rate between two currencies using yfinance with disk cache.
    Cache expires every 4 hours to ensure fresh rates even when converting mid-day.
    
    Args:
        from_currency: Source currency (e.g., 'CAD', 'USD', 'EUR')
        to_currency: Target currency (e.g., 'CAD', 'USD', 'EUR')
        force_refresh: If True, bypass cache and fetch fresh rate
    
    Returns:
        tuple: (exchange_rate, rate_date, from_cache) - Exchange rate, date of the rate, and whether it came from cache
    """
    if from_currency == to_currency:
        return (1.0, datetime.now(), False)  # Not from cache, but no API call needed
    
    # Create cache key based on currency pair (cache expires every 4 hours)
    # Version 2: Always use current time for rate_date display (invalidates old cache with 00:00:00 dates)
    cache_key = f"exchange_rate_v2_{from_currency}_{to_currency}"
    cache_dir = '.streamlit/exchange_rate_cache'
    
    if not os.path.exists(cache_dir):
        os.makedirs(cache_dir, exist_ok=True)
    
    disk_cache = dc.Cache(cache_dir)
    
    # If force refresh, delete cache entry first
    if force_refresh:
        try:
            disk_cache.delete(cache_key)
        except:
            pass
    
    # Try to get from cache first (cache stores both rate and fetch time)
    # Note: diskcache.get() returns None if key doesn't exist OR if expired
    if not force_refresh:
        cached_data = disk_cache.get(cache_key)
        if cached_data is not None:
            # Handle both old format (just rate) and new format (dict with rate and fetch_time)
            if isinstance(cached_data, dict):
                # New format: dict with 'rate' and 'fetch_time'
                cached_rate = float(cached_data.get('rate', cached_data))
                fetch_time = cached_data.get('fetch_time', datetime.now())
                # Convert fetch_time to datetime if it's a string
                if isinstance(fetch_time, str):
                    fetch_time = datetime.fromisoformat(fetch_time)
                elif not isinstance(fetch_time, datetime):
                    fetch_time = datetime.now()
            elif isinstance(cached_data, tuple):
                # Old format: tuple (rate, time)
                cached_rate = float(cached_data[0])
                fetch_time = cached_data[1] if len(cached_data) > 1 else datetime.now()
            else:
                # Old format: just rate (float)
                cached_rate = float(cached_data)
                fetch_time = datetime.now()
            # Return cached rate with original fetch time (shows when rate was retrieved)
            return (cached_rate, fetch_time, True)  # True = from cache
    
    # If not in cache (or force_refresh), fetch from API
    try:
        # Yahoo Finance uses format: CADUSD=X (CAD to USD) or USDCAD=X (USD to CAD)
        # We need to figure out which format to use
        pair = f"{from_currency}{to_currency}=X"
        ticker = yf.Ticker(pair)
        hist = ticker.history(period="1d")
        
        if not hist.empty:
            rate = float(hist['Close'].iloc[-1])
        else:
            # Try reverse pair
            pair = f"{to_currency}{from_currency}=X"
            ticker = yf.Ticker(pair)
            hist = ticker.history(period="1d")
            if not hist.empty:
                rate = float(hist['Close'].iloc[-1])
                rate = 1.0 / rate  # Inverse the rate
            else:
                raise Exception("No data available")
        
        # Cache both rate and fetch time for 4 hours (14400 seconds)
        # Store as dict to preserve fetch time
        fetch_time = datetime.now()
        cache_data = {
            'rate': rate,
            'fetch_time': fetch_time.isoformat()  # Store as ISO string for diskcache compatibility
        }
        disk_cache.set(cache_key, cache_data, expire=14400)
        return (rate, fetch_time, False)  # False = from API (live)
        
    except Exception as e:
        # Fallback to common rates if API fails
        fallback_rates = {
            ('CAD', 'USD'): 0.74,  # Approximate: 1 CAD = 0.74 USD
            ('USD', 'CAD'): 1.35,  # Approximate: 1 USD = 1.35 CAD
            ('EUR', 'USD'): 1.08,
            ('USD', 'EUR'): 0.93,
            ('GBP', 'USD'): 1.27,
            ('USD', 'GBP'): 0.79,
        }
        if (from_currency, to_currency) in fallback_rates:
            rate = fallback_rates[(from_currency, to_currency)]
            # Cache fallback rates too (but shorter expiry - 1 hour)
            # Store as dict with rate and fetch_time for consistency
            fetch_time = datetime.now()
            cache_data = {
                'rate': rate,
                'fetch_time': fetch_time.isoformat()
            }
            disk_cache.set(cache_key, cache_data, expire=3600)
            return (rate, fetch_time, False)  # False = from fallback (not cache)
        # Default to 1.0 if unknown
        fetch_time = datetime.now()
        cache_data = {
            'rate': 1.0,
            'fetch_time': fetch_time.isoformat()
        }
        disk_cache.set(cache_key, cache_data, expire=3600)
        return (1.0, fetch_time, False)  # False = from fallback (not cache)

def convert_currency(amount, from_currency, to_currency):
    """Convert amount from one currency to another."""
    if from_currency == to_currency:
        return amount
    rate, _, _ = get_exchange_rate(from_currency, to_currency)
    return amount * rate

def check_currency_warning(tickers):
    """
    Check if any tickers are non-USD and display a warning.
    """
    non_usd_suffixes = ['.TO', '.V', '.CN', '.AX', '.L', '.PA', '.AS', '.SW', '.T', '.HK', '.KS', '.TW', '.JP']
    non_usd_tickers = []
    
    for ticker in tickers:
        if any(ticker.endswith(suffix) for suffix in non_usd_suffixes):
            non_usd_tickers.append(ticker)
    
    if non_usd_tickers:
        st.warning(f"⚠️ **Currency Warning**: The following tickers are not in USD: {', '.join(non_usd_tickers)}. "
                  f"Currency conversion is not taken into account, which may affect allocation accuracy. "
                  f"Consider using USD equivalents for more accurate results.")
st.set_page_config(layout="wide", page_title="Portfolio Allocation Analysis", page_icon="📈")
st.markdown("""
<style>
    /* Global Styles for the App */
    .st-emotion-cache-1f87s81 {
        padding-top: 2rem;
        padding-bottom: 2rem;
        padding-left: 1rem;
        padding-right: 1rem;
    }
    .st-emotion-cache-1v0bb62 button {
        background-color: #007bff !important;
        color: white !important;
        border-color: #007bff !important;
        font-weight: bold;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        transition: all 0.3s ease;
    }
    .st-emotion-cache-1v0bb62 button:hover {
        background-color: #0056b3 !important;
        border-color: #0056b3 !important;
        transform: translateY(-2px);
    }
    /* Fix for the scrollable dataframe - forces it to be non-scrollable */
    div.st-emotion-cache-1ftv8z > div {
        overflow: visible !important;
        max-height: none !important;
    }
    /* Make the 'View Details' button more obvious */
    button[aria-label="View Details"] {
        background-color: #0ea5e9 !important;
        color: white !important;
        border: 1px solid rgba(255,255,255,0.08) !important;
        box-shadow: 0 4px 8px rgba(14,165,233,0.16) !important;
    }
    button[aria-label="View Details"]:hover {
        background-color: #0891b2 !important;
    }
</style>
<a id="top"></a>
<button id="back-to-top" onclick="window.scrollTo(0, 0);">⬆️</button>
<style>
    #back-to-top {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 1000;
        opacity: 0.7;
        background-color: #007bff;
        color: white;
        border: none;
        border-radius: 50%;
        width: 50px;
        height: 50px;
        font-size: 24px;
        cursor: pointer;
        display: none;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        transition: opacity 0.3s;
    }
    #back-to-top:hover {
        opacity: 1;
    }
</style>
<script>
    window.onscroll = function() {
        var button = document.getElementById("back-to-top");
        if (document.body.scrollTop > 200 || document.documentElement.scrollTop > 200) {
            button.style.display = "block";
        } else {
            button.style.display = "none";
        }
    };
</script>
""", unsafe_allow_html=True)



# ...existing code...

# ==============================================================================
# PAGE-SCOPED SESSION STATE INITIALIZATION - ALLOCATIONS PAGE
# ==============================================================================
# Ensure complete independence from other pages by using page-specific session keys
if 'allocations_page_initialized' not in st.session_state:
    st.session_state.allocations_page_initialized = True

# Initialize page-specific session state with default configurations
if 'alloc_portfolio_configs' not in st.session_state:
    # Default configuration for allocations page
    st.session_state.alloc_portfolio_configs = [
        {
            'name': 'Allocation Portfolio',
            'stocks': [
                {'ticker': 'SPY', 'allocation': 0.25, 'include_dividends': True, 'include_in_sma_filter': True, 'max_allocation_percent': None},
                {'ticker': 'QQQ', 'allocation': 0.25, 'include_dividends': True, 'include_in_sma_filter': True, 'max_allocation_percent': None},
                {'ticker': 'GLD', 'allocation': 0.25, 'include_dividends': True, 'include_in_sma_filter': True, 'max_allocation_percent': None},
                {'ticker': 'TLT', 'allocation': 0.25, 'include_dividends': True, 'include_in_sma_filter': True, 'max_allocation_percent': None},
            ],
            'benchmark_ticker': '^GSPC',
            'initial_value': 10000,
                          'added_amount': 0,
              'added_frequency': 'none',
              'rebalancing_frequency': 'Monthly',
              'start_date_user': None,
              'end_date_user': None,
              'start_with': 'oldest',
            'use_momentum': True,
            'momentum_strategy': 'Classic',
            'negative_momentum_strategy': 'Cash',
            'momentum_windows': [
                {"lookback": 365, "exclude": 30, "weight": 0.5, "discard_if_negative": False, "discard_unless_recent_positive": False},
                {"lookback": 180, "exclude": 30, "weight": 0.3, "discard_if_negative": False, "discard_unless_recent_positive": False},
                {"lookback": 120, "exclude": 30, "weight": 0.2, "discard_if_negative": False, "discard_unless_recent_positive": False},
            ],
            'calc_beta': False,
            'calc_volatility': False,
            'beta_window_days': 365,
            'exclude_days_beta': 30,
            'vol_window_days': 365,
            'exclude_days_vol': 30,
            'use_sma_filter': False,
            'sma_window': 200,
            'ma_type': 'SMA',
            'use_minimal_threshold': False,
            'minimal_threshold_percent': 4.0,
            'use_max_allocation': False,
            'max_allocation_percent': 20.0,
            'use_equal_weight': False,
            'equal_weight_n_tickers': 10,
            'use_limit_to_top_n': False,
            'limit_to_top_n_tickers': 10,
            'use_sector_concentration_limit': False,
            'max_tickers_per_sector': 4,
            'use_industry_concentration_limit': False,
            'max_tickers_per_industry': 2,
            'unknown_counts_as_category': True,
            'exclude_before_sp500_entry': False,
            'use_min_market_cap_filter': False,
            'min_market_cap_billions': 10.0,
        }
    ]
if 'alloc_active_portfolio_index' not in st.session_state:
    st.session_state.alloc_active_portfolio_index = 0
if 'alloc_rerun_flag' not in st.session_state:
    st.session_state.alloc_rerun_flag = False

# Clean up any existing portfolio configs to remove unused settings
if 'alloc_portfolio_configs' in st.session_state:
    for config in st.session_state.alloc_portfolio_configs:
        config.pop('use_relative_momentum', None)
        config.pop('equal_if_all_negative', None)
        
        # Ensure MA filter fields exist with default values
        if 'use_sma_filter' not in config:
            config['use_sma_filter'] = False
        if 'sma_window' not in config:
            config['sma_window'] = 200
        if 'ma_type' not in config:
            config['ma_type'] = 'SMA'
        if 'ma_cross_rebalance' not in config:
            config['ma_cross_rebalance'] = False
        if 'ma_tolerance_percent' not in config:
            config['ma_tolerance_percent'] = 2.0
        if 'ma_confirmation_days' not in config:
            config['ma_confirmation_days'] = 3
        # Ensure threshold, max allocation, and equal weight fields exist with default values
        if 'use_minimal_threshold' not in config:
            config['use_minimal_threshold'] = False
        if 'minimal_threshold_percent' not in config:
            config['minimal_threshold_percent'] = 4.0
        if 'use_max_allocation' not in config:
            config['use_max_allocation'] = False
        if 'max_allocation_percent' not in config:
            config['max_allocation_percent'] = 20.0
        if 'use_equal_weight' not in config:
            config['use_equal_weight'] = False
        if 'equal_weight_n_tickers' not in config:
            config['equal_weight_n_tickers'] = 10
        if 'use_limit_to_top_n' not in config:
            config['use_limit_to_top_n'] = False
        if 'limit_to_top_n_tickers' not in config:
            config['limit_to_top_n_tickers'] = 10
        if 'use_sector_concentration_limit' not in config:
            config['use_sector_concentration_limit'] = False
        if 'max_tickers_per_sector' not in config:
            config['max_tickers_per_sector'] = 4
        if 'use_industry_concentration_limit' not in config:
            config['use_industry_concentration_limit'] = False
        if 'max_tickers_per_industry' not in config:
            config['max_tickers_per_industry'] = 2
        if 'unknown_counts_as_category' not in config:
            config['unknown_counts_as_category'] = True
        if 'exclude_before_sp500_entry' not in config:
            config['exclude_before_sp500_entry'] = False
        if 'use_min_market_cap_filter' not in config:
            config['use_min_market_cap_filter'] = False
        if 'min_market_cap_billions' not in config:
            config['min_market_cap_billions'] = 10.0
        
        # Ensure all stocks have include_in_sma_filter and ma_reference_ticker settings
        for stock in config.get('stocks', []):
            if 'include_in_sma_filter' not in stock:
                stock['include_in_sma_filter'] = True
            if 'ma_reference_ticker' not in stock:
                stock['ma_reference_ticker'] = ''  # Empty = use ticker's own MA
            if 'max_allocation_percent' not in stock:
                stock['max_allocation_percent'] = None
if 'alloc_paste_json_text' not in st.session_state:
    st.session_state.alloc_paste_json_text = ""

# ==============================================================================
# END PAGE-SCOPED SESSION STATE INITIALIZATION
# ==============================================================================

# Use page-scoped active portfolio for the allocations page
active_portfolio = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index] if 'alloc_portfolio_configs' in st.session_state and 'alloc_active_portfolio_index' in st.session_state else None

# NUCLEAR SYNC: FORCE momentum widgets to sync with the active portfolio
if active_portfolio:
    # NUCLEAR APPROACH: FORCE momentum session state widget to sync
    st.session_state['alloc_active_use_momentum'] = active_portfolio.get('use_momentum', False)

if active_portfolio:
    # Removed duplicate Portfolio Name input field
    if st.session_state.get('alloc_rerun_flag', False):
        st.session_state.alloc_rerun_flag = False
        st.rerun()

import numpy as np
import pandas as pd
def calculate_mwrr(values, cash_flows, dates):
    # Exact logic from app.py for MWRR calculation
    try:
        from scipy.optimize import brentq
        values = pd.Series(values).dropna()
        flows = pd.Series(cash_flows).reindex(values.index, fill_value=0.0)
        if len(values) < 2:
            return np.nan
        dates = pd.to_datetime(values.index)
        start_date = dates[0]
        time_periods = np.array([(d - start_date).days / 365.25 for d in dates])
        initial_investment = -values.iloc[0]
        significant_flows = flows[flows != 0]
        cash_flow_dates = [start_date]
        cash_flow_amounts = [initial_investment]
        cash_flow_times = [0.0]
        for date, flow in significant_flows.items():
            if date != dates[0] and date != dates[-1]:
                cash_flow_dates.append(pd.to_datetime(date))
                cash_flow_amounts.append(flow)
                cash_flow_times.append((pd.to_datetime(date) - start_date).days / 365.25)
        cash_flow_dates.append(dates[-1])
        cash_flow_amounts.append(values.iloc[-1])
        cash_flow_times.append((dates[-1] - start_date).days / 365.25)
        cash_flow_amounts = np.array(cash_flow_amounts)
        cash_flow_times = np.array(cash_flow_times)
        def npv(rate):
            return np.sum(cash_flow_amounts / (1 + rate) ** cash_flow_times)
        try:
            irr = brentq(npv, -0.999, 10)
            return irr * 100
        except (ValueError, RuntimeError):
            return np.nan
    except Exception:
        return np.nan
    # Exact logic from app.py for MWRR calculation
    try:
        from scipy.optimize import brentq
        values = pd.Series(values).dropna()
        flows = pd.Series(cash_flows).reindex(values.index, fill_value=0.0)
        if len(values) < 2:
            return np.nan
        dates = pd.to_datetime(values.index)
        start_date = dates[0]
        time_periods = np.array([(d - start_date).days / 365.25 for d in dates])
        initial_investment = -values.iloc[0]
        significant_flows = flows[flows != 0]
        cash_flow_dates = [start_date]
        cash_flow_amounts = [initial_investment]
        cash_flow_times = [0.0]
        for date, flow in significant_flows.items():
            if date != dates[0] and date != dates[-1]:
                cash_flow_dates.append(pd.to_datetime(date))
                cash_flow_amounts.append(flow)
                cash_flow_times.append((pd.to_datetime(date) - start_date).days / 365.25)
        cash_flow_dates.append(dates[-1])
        cash_flow_amounts.append(values.iloc[-1])
        cash_flow_times.append((dates[-1] - start_date).days / 365.25)
        cash_flow_amounts = np.array(cash_flow_amounts)
        cash_flow_times = np.array(cash_flow_times)
        def npv(rate):
            return np.sum(cash_flow_amounts / (1 + rate) ** cash_flow_times)
        try:
            irr = brentq(npv, -0.999, 10)
            return irr
        except (ValueError, RuntimeError):
            return np.nan
    except Exception:
        return np.nan
# Backtest_Engine.py
import streamlit as st
import pandas as pd
import numpy as np
import yfinance as yf
import io
import contextlib
import json
from datetime import datetime, timedelta
from warnings import warn
from scipy.optimize import newton, brentq, root_scalar
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import base64

# Custom CSS for a better layout, a distinct primary button, and the fixed 'Back to Top' button
st.markdown("""
<style>
    /* Global Styles for the App */
    .st-emotion-cache-1f87s81 {
        padding-top: 2rem;
        padding-bottom: 2rem;
        padding-left: 1rem;
        padding-right: 1rem;
    }
    .st-emotion-cache-1v0bb62 button {
        background-color: #007bff !important;
        color: white !important;
        border-color: #007bff !important;
        font-weight: bold;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        transition: all 0.3s ease;
    }
    .st-emotion-cache-1v0bb62 button:hover {
        background-color: #0056b3 !important;
        border-color: #0056b3 !important;
        transform: translateY(-2px);
    }
    /* Fix for the scrollable dataframe - forces it to be non-scrollable */
    div.st-emotion-cache-1ftv8z > div {
        overflow: visible !important;
        max-height: none !important;
    }
</style>
<a id="top"></a>
<button id="back-to-top" onclick="window.scrollTo(0, 0);">⬆️</button>
<style>
    #back-to-top {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 1000;
        opacity: 0.7;
        background-color: #007bff;
        color: white;
        border: none;
        border-radius: 50%;
        width: 50px;
        height: 50px;
        font-size: 24px;
        cursor: pointer;
        display: none;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        transition: opacity 0.3s;
    }
    #back-to-top:hover {
        opacity: 1;
    }
</style>
<script>
    window.onscroll = function() {
        var button = document.getElementById("back-to-top");
        if (document.body.scrollTop > 200 || document.documentElement.scrollTop > 200) {
            button.style.display = "block";
        } else {
            button.style.display = "none";
        }
    };
</script>
""", unsafe_allow_html=True)

st.set_page_config(layout="wide", page_title="Portfolio Allocation Analysis")

st.title("Portfolio Allocations")
st.markdown("Use the forms below to configure and run backtests to obtain allocation insights.")

# Portfolio Name
if 'alloc_portfolio_name' not in st.session_state:
    st.session_state.alloc_portfolio_name = "Allocation Portfolio"
alloc_portfolio_name = st.text_input("Portfolio Name", value=st.session_state.alloc_portfolio_name, key="alloc_portfolio_name_input")
st.session_state.alloc_portfolio_name = alloc_portfolio_name

# Sync portfolio name with active portfolio configuration
if 'alloc_active_portfolio_index' in st.session_state:
    active_idx = st.session_state.alloc_active_portfolio_index
    if 'alloc_portfolio_configs' in st.session_state:
        if active_idx < len(st.session_state.alloc_portfolio_configs):
            st.session_state.alloc_portfolio_configs[active_idx]['name'] = alloc_portfolio_name

# -----------------------
# Default JSON configs (for initialization)
# -----------------------
default_configs = [
    # 1) Benchmark only (SPY) - yearly rebalancing and yearly additions
    {
        'name': 'Benchmark Only (SPY)',
        'stocks': [
            {'ticker': 'SPY', 'allocation': 1.0, 'include_dividends': True},
        ],
        'benchmark_ticker': '^GSPC',
        'initial_value': 10000,
        'added_amount': 10000,
        'added_frequency': 'Annually',
        'rebalancing_frequency': 'Annually',
    'start_date_user': None,
    'end_date_user': None,
    'start_with': 'oldest',
        'use_momentum': False,
        'momentum_windows': [],
    'calc_beta': False,
    'calc_volatility': False,
        'beta_window_days': 365,
        'exclude_days_beta': 30,
                    'vol_window_days': 365,
            'exclude_days_vol': 30,
            'use_minimal_threshold': False,
            'minimal_threshold_percent': 4.0,
            'use_max_allocation': False,
            'max_allocation_percent': 20.0,
            'use_equal_weight': False,
            'equal_weight_n_tickers': 10,
            'use_limit_to_top_n': False,
            'limit_to_top_n_tickers': 10,
            'use_sector_concentration_limit': False,
            'max_tickers_per_sector': 4,
            'use_industry_concentration_limit': False,
            'max_tickers_per_industry': 2,
            'unknown_counts_as_category': True,
            'exclude_before_sp500_entry': False,
            'use_min_market_cap_filter': False,
            'min_market_cap_billions': 10.0,
        },
]

# -----------------------
# Helper functions
# -----------------------
def get_trading_days(start_date, end_date):
    return pd.bdate_range(start=start_date, end=end_date)

def get_dates_by_freq(freq, start, end, market_days):
    market_days = sorted(market_days)
    
    # Ensure market_days are timezone-naive for consistent comparison
    market_days_naive = [d.tz_localize(None) if d.tz is not None else d for d in market_days]
    
    if freq == "market_day":
        return set(market_days)
    elif freq == "calendar_day":
        return set(pd.date_range(start=start, end=end, freq='D'))
    elif freq == "Weekly":
        base = pd.date_range(start=start, end=end, freq='W-MON')
    elif freq == "Biweekly":
        base = pd.date_range(start=start, end=end, freq='2W-MON')
    elif freq == "Monthly":
        # Fixed calendar dates: 1st of each month
        monthly = []
        for y in range(start.year, end.year + 1):
            for m in range(1, 13):
                monthly.append(pd.Timestamp(year=y, month=m, day=1))
        base = pd.DatetimeIndex(monthly)
    elif freq == "Quarterly":
        # Fixed calendar dates: 1st of each quarter (Jan 1, Apr 1, Jul 1, Oct 1)
        quarterly = []
        for y in range(start.year, end.year + 1):
            for m in [1, 4, 7, 10]:  # Q1, Q2, Q3, Q4
                quarterly.append(pd.Timestamp(year=y, month=m, day=1))
        base = pd.DatetimeIndex(quarterly)
    elif freq == "Semiannually":
        # First day of Jan and Jul each year
        semi = []
        for y in range(start.year, end.year + 1):
            for m in [1, 7]:
                semi.append(pd.Timestamp(year=y, month=m, day=1))
        base = pd.DatetimeIndex(semi)
    elif freq == "Annually":
        base = pd.date_range(start=start, end=end, freq='YS')
    elif freq == "Never" or freq == "none" or freq is None:
        return set()
    else:
        raise ValueError(f"Unknown frequency: {freq}")

    dates = []
    for d in base:
        # Ensure d is timezone-naive for comparison
        d_naive = d.tz_localize(None) if d.tz is not None else d
        idx = np.searchsorted(market_days_naive, d_naive, side='right')
        if idx > 0 and market_days_naive[idx-1] >= d_naive:
            dates.append(market_days[idx-1])  # Use original market_days for return
        elif idx < len(market_days_naive):
            dates.append(market_days[idx])  # Use original market_days for return
    return set(dates)

def calculate_cagr(values, dates):
    if len(values) < 2:
        return np.nan
    start_val = values[0]
    end_val = values[-1]
    years = (dates[-1] - dates[0]).days / 365.25
    if years <= 0 or start_val == 0:
        return np.nan
    return (end_val / start_val) ** (1 / years) - 1

def calculate_max_drawdown(values):
    values = np.array(values)
    peak = np.maximum.accumulate(values)
    drawdowns = (values - peak) / np.where(peak == 0, 1, peak)
    return np.nanmin(drawdowns), drawdowns

def calculate_volatility(returns):
    # Annualized volatility
    return np.std(returns) * np.sqrt(365.25) if len(returns) > 1 else np.nan

def calculate_beta(returns, benchmark_returns):
    # Use exact logic from app.py
    portfolio_returns = pd.Series(returns)
    benchmark_returns = pd.Series(benchmark_returns)
    common_idx = portfolio_returns.index.intersection(benchmark_returns.index)
    if len(common_idx) < 2:
        return np.nan
    pr = portfolio_returns.reindex(common_idx).dropna()
    br = benchmark_returns.reindex(common_idx).dropna()
    # Re-align after dropping NAs
    common_idx = pr.index.intersection(br.index)
    if len(common_idx) < 2 or br.loc[common_idx].var() == 0:
        return np.nan
    cov = pr.loc[common_idx].cov(br.loc[common_idx])
    var = br.loc[common_idx].var()
    return cov / var

# FIXED: Correct Sortino Ratio calculation
def calculate_sortino(returns, risk_free_rate=0):
    # Annualized Sortino ratio
    target_return = risk_free_rate / 365.25  # Daily target
    downside_returns = returns[returns < target_return]
    if len(downside_returns) < 2:
        return np.nan
    downside_std = np.std(downside_returns) * np.sqrt(365.25)
    if downside_std == 0:
        return np.nan
    expected_return = returns.mean() * 365.25
    return (expected_return - risk_free_rate) / downside_std

# FIXED: Correct Ulcer Index calculation
def calculate_ulcer_index(values):
    values = np.array(values)
    peak = np.maximum.accumulate(values)
    peak[peak == 0] = 1 # Avoid division by zero
    drawdown_sq = ((values - peak) / peak)**2
    return np.sqrt(np.mean(drawdown_sq)) if len(drawdown_sq) > 0 else np.nan

# FIXED: Correct UPI calculation
def calculate_upi(cagr, ulcer_index, risk_free_rate=0):
    if pd.isna(cagr) or pd.isna(ulcer_index) or ulcer_index == 0:
        return np.nan
    return (cagr - risk_free_rate) / ulcer_index

# -----------------------
# Timer function for next rebalance date
# -----------------------
def calculate_next_rebalance_date(rebalancing_frequency, last_rebalance_date):
    """
    Calculate the next rebalance date based on rebalancing frequency and last rebalance date.
    Excludes today and yesterday as mentioned in the requirements.
    """
    if not last_rebalance_date or rebalancing_frequency == 'none':
        return None, None, None
    
    # Convert to datetime if it's a pandas Timestamp
    if hasattr(last_rebalance_date, 'to_pydatetime'):
        last_rebalance_date = last_rebalance_date.to_pydatetime()
    
    today = datetime.now().date()
    yesterday = today - timedelta(days=1)
    
    # If last rebalance was today or yesterday, use the day before yesterday as base
    if last_rebalance_date.date() >= yesterday:
        base_date = yesterday - timedelta(days=1)
    else:
        base_date = last_rebalance_date.date()
    
    def add_months_safely(date, months_to_add):
        """Safely add months to a date, handling day overflow"""
        year = date.year + (date.month + months_to_add - 1) // 12
        month = ((date.month + months_to_add - 1) % 12) + 1
        
        # Find the last day of the target month
        if month == 12:
            last_day_of_month = 31
        else:
            # Get the first day of the next month and subtract 1 day
            next_month_first = datetime(year, month + 1, 1).date()
            last_day_of_month = (next_month_first - timedelta(days=1)).day
        
        # Use the minimum of the original day or the last day of the target month
        safe_day = min(date.day, last_day_of_month)
        
        return date.replace(year=year, month=month, day=safe_day)
    
    # Calculate next rebalance date based on frequency
    if rebalancing_frequency == 'market_day':
        # Next market day (simplified - just next day for now)
        next_date = base_date + timedelta(days=1)
    elif rebalancing_frequency == 'calendar_day':
        next_date = base_date + timedelta(days=1)
    elif rebalancing_frequency == 'week':
        next_date = base_date + timedelta(weeks=1)
    elif rebalancing_frequency == '2weeks':
        next_date = base_date + timedelta(weeks=2)
    elif rebalancing_frequency == 'month':
        # Add one month safely
        next_date = add_months_safely(base_date, 1)
    elif rebalancing_frequency == '3months':
        # Add three months safely
        next_date = add_months_safely(base_date, 3)
    elif rebalancing_frequency == '6months':
        # Add six months safely
        next_date = add_months_safely(base_date, 6)
    elif rebalancing_frequency == 'year':
        next_date = base_date.replace(year=base_date.year + 1)
    else:
        return None, None, None
    
    # Calculate time until next rebalance
    now = datetime.now()
    # Ensure both datetimes are offset-naive for comparison and subtraction
    if hasattr(next_date, 'tzinfo') and next_date.tzinfo is not None:
        next_date = next_date.replace(tzinfo=None)
    next_rebalance_datetime = datetime.combine(next_date, time(9, 30))  # Assume 9:30 AM market open
    if hasattr(next_rebalance_datetime, 'tzinfo') and next_rebalance_datetime.tzinfo is not None:
        next_rebalance_datetime = next_rebalance_datetime.replace(tzinfo=None)
    if hasattr(now, 'tzinfo') and now.tzinfo is not None:
        now = now.replace(tzinfo=None)
    # If next rebalance is in the past, calculate the next one iteratively instead of recursively
    max_iterations = 10  # Prevent infinite loops
    iteration = 0
    while next_rebalance_datetime <= now and iteration < max_iterations:
        iteration += 1
        if rebalancing_frequency in ['market_day', 'calendar_day']:
            next_date = next_date + timedelta(days=1)
        elif rebalancing_frequency == 'week':
            next_date = next_date + timedelta(weeks=1)
        elif rebalancing_frequency == '2weeks':
            next_date = next_date + timedelta(weeks=2)
        elif rebalancing_frequency == 'month':
            # Add one month safely
            next_date = add_months_safely(next_date, 1)
        elif rebalancing_frequency == '3months':
            # Add three months safely
            next_date = add_months_safely(next_date, 3)
        elif rebalancing_frequency == '6months':
            # Add six months safely
            next_date = add_months_safely(next_date, 6)
        elif rebalancing_frequency == 'year':
            next_date = next_date.replace(year=next_date.year + 1)
        
        next_rebalance_datetime = datetime.combine(next_date, time(9, 30))
    
    time_until = next_rebalance_datetime - now
    
    return next_date, time_until, next_rebalance_datetime

def format_time_until(time_until):
    """Format the time until next rebalance in a human-readable format."""
    if not time_until:
        return "Unknown"
    
    total_seconds = int(time_until.total_seconds())
    days = total_seconds // 86400
    hours = (total_seconds % 86400) // 3600
    minutes = (total_seconds % 3600) // 60
    
    if days > 0:
        return f"{days} days, {hours} hours, {minutes} minutes"
    elif hours > 0:
        return f"{hours} hours, {minutes} minutes"
    else:
        return f"{minutes} minutes"

# -----------------------
# PDF Generation Functions
# -----------------------
def plotly_to_matplotlib_figure(plotly_fig, title="", width_inches=8, height_inches=6):
    """
    Convert a Plotly figure to a matplotlib figure for PDF generation
    """
    try:
        # Extract data from Plotly figure
        fig_data = plotly_fig.data
        
        # Create matplotlib figure
        fig, ax = plt.subplots(figsize=(width_inches, height_inches))
        
        # Set title
        if title:
            ax.set_title(title, fontsize=14, fontweight='bold', pad=20)
        
        # Define a color palette for different traces
        colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf']
        color_index = 0
        
        # Process each trace
        for trace in fig_data:
            if trace.type == 'scatter':
                x_data = trace.x
                y_data = trace.y
                name = trace.name if hasattr(trace, 'name') and trace.name else f'Trace {color_index}'
                
                # Get color from trace or use palette
                if hasattr(trace, 'line') and hasattr(trace.line, 'color') and trace.line.color:
                    color = trace.line.color
                else:
                    color = colors[color_index % len(colors)]
                
                # Plot the line
                ax.plot(x_data, y_data, label=name, linewidth=2, color=color)
                color_index += 1
                
            elif trace.type == 'bar':
                x_data = trace.x
                y_data = trace.y
                name = trace.name if hasattr(trace, 'name') and trace.name else f'Bar {color_index}'
                
                # Get color from trace or use palette
                if hasattr(trace, 'marker') and hasattr(trace.marker, 'color') and trace.marker.color:
                    color = trace.marker.color
                else:
                    color = colors[color_index % len(colors)]
                
                # Plot the bars
                ax.bar(x_data, y_data, label=name, color=color, alpha=0.7)
                color_index += 1
                
            elif trace.type == 'pie':
                # Handle pie charts - SIMPLE PERFECT CIRCLE SOLUTION
                labels = trace.labels if hasattr(trace, 'labels') else []
                values = trace.values if hasattr(trace, 'values') else []
                
                if labels and values:
                    # Create a slightly wider figure to ensure perfect circle
                    fig_pie, ax_pie = plt.subplots(figsize=(8.5, 8))
                    
                    # Format long titles to break into multiple lines using textwrap
                    import textwrap
                    formatted_title = textwrap.fill(title, width=40, break_long_words=True, break_on_hyphens=False)
                    ax_pie.set_title(formatted_title, fontsize=14, fontweight='bold', pad=40, y=0.95)
                    
                    # Create pie chart with smart percentage display - hide small ones to prevent overlap
                    def smart_autopct(pct):
                        return f'{pct:.1f}%' if pct > 3 else ''  # Only show percentages > 3%
                    
                    wedges, texts, autotexts = ax_pie.pie(
                        values, 
                        labels=labels, 
                        autopct=smart_autopct,  # Use smart percentage display
                        startangle=90, 
                        colors=colors[:len(values)]
                    )
                    
                    # Create legend labels with percentages
                    legend_labels = []
                    for i, label in enumerate(labels):
                        percentage = (values[i] / sum(values)) * 100
                        legend_labels.append(f"{label} ({percentage:.1f}%)")
                    
                    # Add legend with SPECIFIC POSITIONING to prevent overlap
                    ax_pie.legend(wedges, legend_labels, title="Categories", 
                                loc="center left", bbox_to_anchor=(1.15, 0.5))
                    
                    # This is the magic - force perfect circle
                    ax_pie.axis('equal')
                    
                    # Add extra spacing to prevent overlap
                    plt.subplots_adjust(right=0.8)
                    
                    return fig_pie
        
        # Format the plot
        ax.grid(True, alpha=0.3)
        if ax.get_legend_handles_labels()[0]:  # Only add legend if there are labels
            ax.legend(loc='best', frameon=True, fancybox=True, shadow=True)
        
        # Format x-axis for dates if needed
        if fig_data and len(fig_data) > 0 and hasattr(fig_data[0], 'x') and fig_data[0].x is not None:
            try:
                # Try to parse as dates
                dates = pd.to_datetime(fig_data[0].x)
                ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y'))
                ax.xaxis.set_major_locator(mdates.YearLocator(interval=2))  # Show every 2 years
                plt.setp(ax.xaxis.get_majorticklabels(), rotation=45, ha='right')
            except:
                pass
        
        # Adjust layout
        plt.tight_layout()
        
        return fig
        
    except Exception as e:
        # Return a simple error figure
        fig, ax = plt.subplots(figsize=(width_inches, height_inches))
        ax.text(0.5, 0.5, f'Error converting plot: {str(e)}', 
                ha='center', va='center', transform=ax.transAxes, fontsize=12)
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 1)
        return fig

def create_matplotlib_table(data, headers=None):
    """Create a matplotlib table for PDF generation."""
    try:
        if data is None or len(data) == 0:
            return None
        
        # Convert data to proper format
        if isinstance(data, pd.DataFrame):
            table_data = data.values.tolist()
            if headers is None:
                headers = data.columns.tolist()
        else:
            table_data = data
            if headers is None:
                headers = [f'Col {i+1}' for i in range(len(data[0]))]
        
        # Create figure and axis
        fig, ax = plt.subplots(figsize=(12, 8))
        ax.axis('tight')
        ax.axis('off')
        
        # Create table
        table = ax.table(cellText=table_data, colLabels=headers, cellLoc='center', loc='center')
        table.auto_set_font_size(False)
        table.set_fontsize(9)
        table.scale(1.2, 1.5)
        
        return fig
    except Exception as e:
        print(f"Error creating matplotlib table: {e}")
        return None

def generate_allocations_pdf(custom_name=""):
    """Generate PDF report for allocations page."""
    try:
        # Create progress bar
        progress_bar = st.progress(0)
        status_text = st.empty()
        status_text.text("📄 Initializing PDF document...")
        
        # Get active portfolio configuration
        active_portfolio = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]
        
        # Create PDF document
        buffer = io.BytesIO()
        
        # Add proper PDF metadata
        if custom_name.strip():
            title = f"Allocations Report - {custom_name.strip()}"
            subject = f"Portfolio Allocation Analysis: {custom_name.strip()}"
        else:
            title = "Allocations Report"
            subject = "Portfolio Allocation and Asset Distribution Analysis"
        
        doc = SimpleDocTemplate(
            buffer, 
            pagesize=A4, 
            rightMargin=18, 
            leftMargin=18, 
            topMargin=18, 
            bottomMargin=18,
            title=title,
            author="Portfolio Backtest System",
            subject=subject,
            creator="Allocations Application"
        )
        story = []
        
        # Define styles
        styles = getSampleStyleSheet()
        heading_style = ParagraphStyle(
            'CustomHeading',
            parent=styles['Heading1'],
            fontSize=14,
            spaceAfter=20,
            alignment=TA_CENTER,
            leftIndent=0,
            rightIndent=0,
            firstLineIndent=0,
            wordWrap=False
        )
        subheading_style = ParagraphStyle(
            'CustomSubheading',
            parent=styles['Heading2'],
            fontSize=14,
            spaceAfter=15
        )
        
        # Title page (no page break before)
        title_style = ParagraphStyle(
            'TitlePage',
            parent=styles['Title'],
            fontSize=24,
            spaceAfter=30,
            textColor=reportlab_colors.Color(0.2, 0.4, 0.6),
            alignment=1  # Center alignment
        )
        
        subtitle_style = ParagraphStyle(
            'SubtitlePage',
            parent=styles['Normal'],
            fontSize=16,
            spaceAfter=40,
            textColor=reportlab_colors.Color(0.4, 0.6, 0.8),
            alignment=1  # Center alignment
        )
        
        # Main title - use custom name if provided
        if custom_name.strip():
            main_title = f"Allocations Report - {custom_name.strip()}"
            subtitle = f"Portfolio Allocation Analysis: {custom_name.strip()}"
        else:
            main_title = "Portfolio Allocations Report"
            subtitle = "Comprehensive Investment Portfolio Analysis"
        
        story.append(Paragraph(main_title, title_style))
        story.append(Paragraph(subtitle, subtitle_style))
        
        # Document metadata is set in SimpleDocTemplate creation above
        
        # Report metadata
        current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        story.append(Paragraph(f"Generated on: {current_time}", styles['Normal']))
        story.append(Spacer(1, 10))
        
        # Table of contents
        toc_style = ParagraphStyle(
            'TOC',
            parent=styles['Heading2'],
            fontSize=14,
            spaceAfter=15,
            textColor=reportlab_colors.Color(0.3, 0.5, 0.7)
        )
        
        story.append(Paragraph("Table of Contents", toc_style))
        toc_points = [
            "Portfolio Configurations & Parameters",
            "Target Allocation if Rebalanced Today",
            "Portfolio-Weighted Summary Statistics",
            "Portfolio Composition Analysis"
        ]
        
        for i, point in enumerate(toc_points, 1):
            story.append(Paragraph(f"{i}. {point}", styles['Normal']))
        
        story.append(Spacer(1, 30))
        
        # Report overview
        overview_style = ParagraphStyle(
            'Overview',
            parent=styles['Heading2'],
            fontSize=14,
            spaceAfter=15,
            textColor=reportlab_colors.Color(0.3, 0.5, 0.7)
        )
        
        story.append(Paragraph("Report Overview", overview_style))
        story.append(Paragraph("This report provides comprehensive analysis of investment portfolios, including:", styles['Normal']))
        
        # Overview bullet points
        overview_points = [
            "Detailed portfolio configurations with all parameters and strategies",
            "Current allocations and rebalancing countdown timers"
        ]
        
        for point in overview_points:
            story.append(Paragraph(f"• {point}", styles['Normal']))
        
        story.append(PageBreak())
        
        # Update progress
        progress_bar.progress(20)
        status_text.text("📊 Adding portfolio configurations...")
        
        # SECTION 1: Portfolio Configurations & Parameters
        story.append(Paragraph("1. Portfolio Configurations & Parameters", heading_style))
        story.append(Spacer(1, 20))
        
        story.append(Paragraph(f"Portfolio: {active_portfolio.get('name', 'Unknown')}", subheading_style))
        story.append(Spacer(1, 10))
        
        # Create configuration table with all parameters
        config_data = [
            ['Parameter', 'Value', 'Description'],
            ['Initial Value', f"${active_portfolio.get('initial_value', 0):,.2f}", 'Starting portfolio value'],
            ['Added Amount', f"${active_portfolio.get('added_amount', 0):,.2f}", 'Regular contribution amount'],
            ['Added Frequency', active_portfolio.get('added_frequency', 'N/A'), 'How often contributions are made'],
            ['Rebalancing Frequency', active_portfolio.get('rebalancing_frequency', 'N/A'), 'How often portfolio is rebalanced'],
            ['Benchmark', active_portfolio.get('benchmark_ticker', 'N/A'), 'Performance comparison index'],
            ['Use Momentum', 'Yes' if active_portfolio.get('use_momentum', False) else 'No', 'Whether momentum strategy is enabled'],
            ['Momentum Strategy', active_portfolio.get('momentum_strategy', 'N/A'), 'Type of momentum calculation'],
            ['Negative Momentum Strategy', active_portfolio.get('negative_momentum_strategy', 'N/A'), 'How to handle negative momentum'],
            ['Calculate Beta', 'Yes' if active_portfolio.get('calc_beta', False) else 'No', 'Include beta in momentum weighting'],
            ['Calculate Volatility', 'Yes' if active_portfolio.get('calc_volatility', False) else 'No', 'Include volatility in momentum weighting'],
            ['Start Strategy', active_portfolio.get('start_with', 'N/A'), 'Initial allocation strategy'],
            ['Beta Lookback', f"{active_portfolio.get('beta_window_days', 0)} days", 'Days for beta calculation'],
            ['Beta Exclude', f"{active_portfolio.get('exclude_days_beta', 0)} days", 'Days excluded from beta calculation'],
            ['Volatility Lookback', f"{active_portfolio.get('vol_window_days', 0)} days", 'Days for volatility calculation'],
            ['Volatility Exclude', f"{active_portfolio.get('exclude_days_vol', 0)} days", 'Days excluded from volatility calculation'],
            ['Minimal Threshold', f"{active_portfolio.get('minimal_threshold_percent', 2.0):.1f}%" if active_portfolio.get('use_minimal_threshold', False) else 'Disabled', 'Minimum allocation percentage threshold'],
            ['Max Allocation', f"{active_portfolio.get('max_allocation_percent', 10.0):.1f}%" if active_portfolio.get('use_max_allocation', False) else 'Disabled', 'Maximum allocation percentage per stock'],
            ['MA Filter', 'Yes' if active_portfolio.get('use_sma_filter', False) else 'No', 'Filter assets below moving average'],
            ['MA Type', active_portfolio.get('ma_type', 'SMA'), 'Type of moving average (SMA or EMA)'],
            ['MA Window', f"{active_portfolio.get('sma_window', 200)} days", 'Moving average calculation window'],
            ['MA Multiplier', f"{active_portfolio.get('ma_multiplier', 1.48):.4f}", 'Multiplier to convert market days to calendar days'],
            ['MA Cross Rebalancing', 'Yes' if active_portfolio.get('ma_cross_rebalance', False) else 'No', 'Immediate rebalancing on MA cross'],
            ['MA Tolerance Band', f"{active_portfolio.get('ma_tolerance_percent', 2.0):.1f}%" if active_portfolio.get('ma_cross_rebalance', False) else 'N/A', 'Tolerance band for MA cross detection'],
            ['MA Confirmation Days', f"{active_portfolio.get('ma_confirmation_days', 3)} days" if active_portfolio.get('ma_cross_rebalance', False) else 'N/A', 'Confirmation delay for MA cross']
        ]
        
        # Add momentum windows if they exist
        momentum_windows = active_portfolio.get('momentum_windows', [])
        if momentum_windows:
            for i, window in enumerate(momentum_windows, 1):
                lookback = window.get('lookback', 0)
                weight = window.get('weight', 0)
                config_data.append([
                    f'Momentum Window {i}',
                    f"{lookback} days, {weight:.2f}",
                    f"Lookback: {lookback} days, Weight: {weight:.2f}"
                ])
        
        # Add tickers with enhanced information (without momentum - conditional columns based on MA filter)
        if active_portfolio.get('use_sma_filter', False):
            tickers_data = [['Ticker', 'Allocation\n%', 'Reinvest\nDividends', 'Include in\nMA Filter', 'MA Reference\nTicker']]
            for ticker_config in active_portfolio.get('stocks', []):
                include_ma = "✓" if ticker_config.get('include_in_sma_filter', True) else "✗"
                ma_ref = ticker_config.get('ma_reference_ticker', '')
                ma_ref_str = ma_ref if ma_ref else ticker_config['ticker']  # Use own ticker if no custom reference
                tickers_data.append([
                    ticker_config['ticker'],
                    f"{ticker_config['allocation']*100:.1f}%",
                    "✓" if ticker_config['include_dividends'] else "✗",
                    include_ma,
                    ma_ref_str
                ])
        else:
            tickers_data = [['Ticker', 'Allocation\n%', 'Reinvest\nDividends']]
            for ticker_config in active_portfolio.get('stocks', []):
                tickers_data.append([
                    ticker_config['ticker'],
                    f"{ticker_config['allocation']*100:.1f}%",
                    "✓" if ticker_config['include_dividends'] else "✗"
                ])
        
        # Create tables with proper column widths to prevent text overflow
        config_table = Table(config_data, colWidths=[2.2*inch, 1.8*inch, 2.5*inch])
        config_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), reportlab_colors.Color(0.3, 0.5, 0.7)),
            ('TEXTCOLOR', (0, 0), (-1, 0), reportlab_colors.whitesmoke),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('GRID', (0, 0), (-1, -1), 1, reportlab_colors.black),
            ('BACKGROUND', (0, 1), (-1, -1), reportlab_colors.Color(0.98, 0.98, 0.98)),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('WORDWRAP', (0, 0), (-1, -1), True),
            ('LEFTPADDING', (0, 0), (-1, -1), 6),
            ('RIGHTPADDING', (0, 0), (-1, -1), 6),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3)
        ]))
        
        # Adjust column widths based on number of columns
        if active_portfolio.get('use_sma_filter', False):
            tickers_table = Table(tickers_data, colWidths=[1.2*inch, 1.0*inch, 1.2*inch, 1.2*inch, 1.2*inch])
        else:
            tickers_table = Table(tickers_data, colWidths=[2.0*inch, 1.5*inch, 2.0*inch])
        tickers_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), reportlab_colors.Color(0.3, 0.5, 0.7)),
            ('TEXTCOLOR', (0, 0), (-1, 0), reportlab_colors.whitesmoke),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 10),
            ('GRID', (0, 0), (-1, -1), 1, reportlab_colors.black),
            ('BACKGROUND', (0, 1), (-1, -1), reportlab_colors.Color(0.98, 0.98, 0.98)),
            ('WORDWRAP', (0, 0), (-1, -1), True),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, 0), 8),
            ('BOTTOMPADDING', (0, 0), (-1, 0), 8)
        ]))
        
        story.append(config_table)
        story.append(PageBreak())
        # Show ticker allocations table, but hide Allocation % column if momentum is enabled
        if not active_portfolio.get('use_momentum', True):
            story.append(Paragraph("Initial Ticker Allocations (Entered by User):", styles['Heading3']))
            story.append(Paragraph("Note: These are the initial allocations entered by the user, not rebalanced allocations.", styles['Normal']))
            story.append(tickers_table)
            story.append(Spacer(1, 15))
        else:
            story.append(Paragraph("Initial Ticker Allocations:", styles['Heading3']))
            story.append(Paragraph("Note: Momentum strategy is enabled - ticker allocations are calculated dynamically based on momentum scores.", styles['Normal']))
            
            # Create modified table with all ticker parameters for momentum strategies (conditional columns)
            if active_portfolio.get('use_sma_filter', False):
                tickers_data_momentum = [['Ticker', 'Reinvest\nDividends', 'Max Allocation\n%', 'Include in\nMA Filter', 'MA Reference\nTicker']]
                for ticker_config in active_portfolio.get('stocks', []):
                    max_alloc = ticker_config.get('max_allocation_percent')
                    max_alloc_str = f"{max_alloc:.1f}%" if max_alloc is not None else "No limit"
                    include_ma = "✓" if ticker_config.get('include_in_sma_filter', True) else "✗"
                    ma_ref = ticker_config.get('ma_reference_ticker', '')
                    ma_ref_str = ma_ref if ma_ref else ticker_config['ticker']  # Use own ticker if no custom reference
                    tickers_data_momentum.append([
                        ticker_config['ticker'],
                        "✓" if ticker_config['include_dividends'] else "✗",
                        max_alloc_str,
                        include_ma,
                        ma_ref_str
                    ])
            else:
                tickers_data_momentum = [['Ticker', 'Reinvest\nDividends', 'Max Allocation\n%']]
                for ticker_config in active_portfolio.get('stocks', []):
                    max_alloc = ticker_config.get('max_allocation_percent')
                    max_alloc_str = f"{max_alloc:.1f}%" if max_alloc is not None else "No limit"
                    tickers_data_momentum.append([
                        ticker_config['ticker'],
                        "✓" if ticker_config['include_dividends'] else "✗",
                        max_alloc_str
                    ])
            
            # Adjust column widths based on number of columns for momentum table
            if active_portfolio.get('use_sma_filter', False):
                tickers_table_momentum = Table(tickers_data_momentum, colWidths=[1.2*inch, 1.2*inch, 1.2*inch, 1.2*inch, 1.2*inch])
            else:
                tickers_table_momentum = Table(tickers_data_momentum, colWidths=[2.0*inch, 2.0*inch, 2.0*inch])
            tickers_table_momentum.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), reportlab_colors.Color(0.3, 0.5, 0.7)),
                ('TEXTCOLOR', (0, 0), (-1, 0), reportlab_colors.whitesmoke),
                ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, -1), 10),
                ('GRID', (0, 0), (-1, -1), 1, reportlab_colors.black),
                ('BACKGROUND', (0, 1), (-1, -1), reportlab_colors.Color(0.98, 0.98, 0.98)),
                ('WORDWRAP', (0, 0), (-1, -1), True),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('TOPPADDING', (0, 0), (-1, 0), 8),
                ('BOTTOMPADDING', (0, 0), (-1, 0), 8)
            ]))
            
            story.append(tickers_table_momentum)
            story.append(Spacer(1, 15))
        
        # Update progress
        progress_bar.progress(40)
        status_text.text("🎯 Adding allocation charts and timers...")
        
        # SECTION 2: Target Allocation if Rebalanced Today
        story.append(PageBreak())
        current_date_str = datetime.now().strftime("%B %d, %Y")
        story.append(Paragraph(f"2. Target Allocation if Rebalanced Today ({current_date_str})", heading_style))
        story.append(Spacer(1, 2))
        
        # Get the allocation data from your existing UI - fetch the existing allocation data
        if 'alloc_snapshot_data' in st.session_state:
            snapshot = st.session_state.alloc_snapshot_data
            today_weights_map = snapshot.get('today_weights_map', {})
            
            # Process ALL portfolios, not just the active one
            portfolio_count = 0
            for portfolio_name, today_weights in today_weights_map.items():
                if today_weights:
                    # Add page break for all portfolios except the first one
                    if portfolio_count > 0:
                        story.append(PageBreak())
                    
                    portfolio_count += 1
                    
                    # Add portfolio header
                    story.append(Paragraph(f"Portfolio: {portfolio_name}", subheading_style))
                    story.append(Spacer(1, 2))
                    
                    # Create pie chart for this portfolio
                    try:
                        # Create labels and values for the plot
                        labels_today = [k for k, v in sorted(today_weights.items(), key=lambda x: (-x[1], x[0])) if v > 0]
                        vals_today = [float(today_weights[k]) * 100 for k in labels_today]
                        
                        # Handle case where momentum goes to cash (all assets have negative momentum)
                        # If no labels or all values are very small, show 100% CASH
                        if not labels_today or sum(vals_today) < 0.1:
                            labels_today = ['CASH']
                            vals_today = [100.0]
                        
                        if labels_today and vals_today:
                            # Create matplotlib pie chart (same format as sector/industry)
                            fig, ax_target = plt.subplots(1, 1, figsize=(10, 10))
                            
                            # Create pie chart with smart percentage display - hide small ones to prevent overlap
                            def smart_autopct(pct):
                                return f'{pct:.1f}%' if pct > 3 else ''  # Only show percentages > 3%
                            
                            wedges_target, texts_target, autotexts_target = ax_target.pie(vals_today, autopct=smart_autopct, 
                                                                                         startangle=90)
                            
                            # Add ticker names with percentages outside the pie chart slices for allocations > 1.8%
                            for i, (wedge, ticker, alloc) in enumerate(zip(wedges_target, labels_today, vals_today)):
                                # Only show tickers above 1.8%
                                if alloc > 1.8:
                                    # Calculate position for the text (middle of the slice)
                                    angle = (wedge.theta1 + wedge.theta2) / 2
                                    # Convert angle to radians and calculate position
                                    rad = np.radians(angle)
                                    # Position text outside the pie chart at 1.4 radius (farther away)
                                    x = 1.4 * np.cos(rad)
                                    y = 1.4 * np.sin(rad)
                                    
                                    # Add ticker name with percentage under it (e.g., "ORLY 5%")
                                    ax_target.text(x, y, f"{ticker}\n{alloc:.1f}%", ha='center', va='center', 
                                                 fontsize=8, fontweight='bold', 
                                                 bbox=dict(boxstyle="round,pad=0.2", facecolor='white', alpha=0.8))
                                    
                                    # Add leader line from slice edge to label
                                    # Start from edge of pie chart (radius 1.0)
                                    line_start_x = 1.0 * np.cos(rad)
                                    line_start_y = 1.0 * np.sin(rad)
                                    # End at label position
                                    line_end_x = 1.25 * np.cos(rad)
                                    line_end_y = 1.25 * np.sin(rad)
                                    
                                    ax_target.plot([line_start_x, line_end_x], [line_start_y, line_end_y], 
                                                 'k-', linewidth=0.5, alpha=0.6)
                            
                            # Create legend with percentages - positioned farther to the right to avoid overlap
                            legend_labels = [f"{ticker} ({alloc:.1f}%)" for ticker, alloc in zip(labels_today, vals_today)]
                            ax_target.legend(wedges_target, legend_labels, title="Tickers", loc="center left", bbox_to_anchor=(1.15, 0, 0.5, 1), fontsize=10)
                            
                            # Wrap long titles to prevent them from going out of bounds
                            title_text = f'Target Allocation - {portfolio_name}'
                            # Use textwrap for proper word-based wrapping
                            import textwrap
                            wrapped_title = textwrap.fill(title_text, width=40, break_long_words=True, break_on_hyphens=False)
                            ax_target.set_title(wrapped_title, fontsize=14, fontweight='bold', pad=80)
                            # Force perfectly circular shape
                            ax_target.set_aspect('equal')
                            # Use tighter axis limits to make pie chart appear larger within its space
                            ax_target.set_xlim(-1.2, 1.2)
                            ax_target.set_ylim(-1.2, 1.2)
                            
                            # Adjust layout to accommodate legend and title (better spacing to prevent title cutoff)
                            # Use more aggressive spacing like sector/industry charts for bigger pie chart
                            plt.subplots_adjust(left=0.1, right=0.7, top=0.95, bottom=0.05)
                            
                            # Save to buffer
                            target_img_buffer = io.BytesIO()
                            fig.savefig(target_img_buffer, format='png', dpi=300, facecolor='white')
                            target_img_buffer.seek(0)
                            plt.close(fig)
                            
                            # Add to PDF - reduce pie chart size to fit everything on one page
                            story.append(Image(target_img_buffer, width=5.5*inch, height=5.5*inch))
                            
                            # Add Next Rebalance Timer information - calculate from portfolio data
                            story.append(Paragraph(f"Next Rebalance Timer - {portfolio_name}", subheading_style))
                            story.append(Spacer(1, 1))
                            
                            # Calculate timer information from portfolio configuration and allocation data
                            try:
                                # Get portfolio configuration
                                portfolio_cfg = None
                                if 'alloc_snapshot_data' in st.session_state:
                                    snapshot = st.session_state['alloc_snapshot_data']
                                    portfolio_configs = snapshot.get('portfolio_configs', [])
                                    portfolio_cfg = next((cfg for cfg in portfolio_configs if cfg.get('name') == portfolio_name), None)
                                
                                if portfolio_cfg:
                                    rebalancing_frequency = portfolio_cfg.get('rebalancing_frequency', 'Monthly')
                                    initial_value = portfolio_cfg.get('initial_value', 10000)
                                    
                                    # Get last rebalance date from allocation data
                                    all_allocations = snapshot.get('all_allocations', {})
                                    portfolio_allocations = all_allocations.get(portfolio_name, {})
                                    
                                    if portfolio_allocations:
                                        alloc_dates = sorted(list(portfolio_allocations.keys()))
                                        if len(alloc_dates) > 1:
                                            last_rebal_date = alloc_dates[-2]  # Second to last date
                                        else:
                                            last_rebal_date = alloc_dates[-1] if alloc_dates else None
                                        
                                        if last_rebal_date:
                                            # Map frequency to function expectations
                                            frequency_mapping = {
                                                'monthly': 'month',
                                                'weekly': 'week',
                                                'bi-weekly': '2weeks',
                                                'biweekly': '2weeks',
                                                'quarterly': '3months',
                                                'semi-annually': '6months',
                                                'semiannually': '6months',
                                                'annually': 'year',
                                                'yearly': 'year',
                                                'market_day': 'market_day',
                                                'calendar_day': 'calendar_day',
                                                'never': 'none',
                                                'none': 'none'
                                            }
                                            mapped_frequency = frequency_mapping.get(rebalancing_frequency.lower(), rebalancing_frequency.lower())
                                            
                                            # Calculate next rebalance date
                                            
                                            next_date, time_until, next_rebalance_datetime = calculate_next_rebalance_date(
                                                mapped_frequency, last_rebal_date
                                            )
                                            
                                            if next_date and time_until:
                                                story.append(Paragraph(f"Time Until Next Rebalance: {format_time_until(time_until)}", styles['Normal']))
                                                story.append(Paragraph(f"Target Rebalance Date: {next_date.strftime('%B %d, %Y')}", styles['Normal']))
                                                story.append(Paragraph(f"Rebalancing Frequency: {rebalancing_frequency}", styles['Normal']))
                                                story.append(Paragraph(f"Portfolio Value: ${initial_value:,.2f}", styles['Normal']))
                                            else:
                                                story.append(Paragraph("Next rebalance date calculation not available", styles['Normal']))
                                        else:
                                            story.append(Paragraph("No rebalancing history available", styles['Normal']))
                                    else:
                                        story.append(Paragraph("No allocation data available for timer calculation", styles['Normal']))
                                else:
                                    story.append(Paragraph("Portfolio configuration not found for timer calculation", styles['Normal']))
                            except Exception as e:
                                story.append(Paragraph(f"Error calculating timer information: {str(e)}", styles['Normal']))
                            
                            # Add page break after pie plot + timer to separate from allocation table
                            story.append(PageBreak())
                            
                            # Now add the allocation table on the next page
                            story.append(Paragraph(f"Allocation Details for {portfolio_name}", subheading_style))
                            story.append(Spacer(1, 10))
                            
                            # Create comprehensive allocation table with all columns
                            try:
                                if today_weights:
                                    # Get portfolio value and raw data for price calculations
                                    portfolio_value = 10000  # Default value
                                    raw_data = {}
                                    
                                    if 'alloc_snapshot_data' in st.session_state:
                                        snapshot = st.session_state['alloc_snapshot_data']
                                        portfolio_configs = snapshot.get('portfolio_configs', [])
                                        portfolio_cfg = next((cfg for cfg in portfolio_configs if cfg.get('name') == portfolio_name), None)
                                        if portfolio_cfg:
                                            portfolio_value = portfolio_cfg.get('initial_value', 10000)
                                        raw_data = snapshot.get('raw_data', {})
                                    
                                    # Create comprehensive table with all columns
                                    headers = ['Asset', 'Allocation %', 'Price ($)', 'Shares', 'Total Value ($)', '% of Portfolio']
                                    table_rows = []
                                    
                                    for asset, weight in sorted(today_weights.items(), key=lambda x: (-x[1], x[0])):
                                        if float(weight) > 0:
                                            alloc_pct = float(weight) * 100
                                            allocation_value = portfolio_value * float(weight)
                                            
                                            # Get current price
                                            current_price = None
                                            shares = 0.0
                                            if asset != 'CASH' and asset in raw_data:
                                                try:
                                                    df = raw_data[asset]
                                                    if isinstance(df, pd.DataFrame) and 'Close' in df.columns and not df['Close'].dropna().empty:
                                                        current_price = float(df['Close'].iloc[-1])
                                                        if current_price and current_price > 0:
                                                            shares = round(allocation_value / current_price, 1)
                                                except Exception:
                                                    pass
                                            
                                            # Calculate total value
                                            if current_price and current_price > 0:
                                                total_val = shares * current_price
                                            else:
                                                total_val = allocation_value
                                            
                                            # Calculate percentage of portfolio
                                            pct_of_port = (total_val / portfolio_value * 100) if portfolio_value > 0 else 0
                                            
                                            # Format values for table
                                            price_str = f"${current_price:,.2f}" if current_price else "N/A"
                                            shares_str = f"{shares:,.1f}" if shares > 0 else "0.0"
                                            total_val_str = f"${total_val:,.2f}"
                                            
                                            table_rows.append([
                                                asset,
                                                f"{alloc_pct:.2f}%",
                                                price_str,
                                                shares_str,
                                                total_val_str,
                                                f"{pct_of_port:.2f}%"
                                            ])
                                    
                                    if table_rows:
                                        # Calculate total values for summary row
                                        total_alloc_pct = sum(float(row[1].rstrip('%')) for row in table_rows)
                                        total_value = sum(float(row[4].replace('$', '').replace(',', '')) for row in table_rows)
                                        total_port_pct = sum(float(row[5].rstrip('%')) for row in table_rows)
                                        
                                        # Add total row
                                        total_row = [
                                            'TOTAL',
                                            f"{total_alloc_pct:.2f}%",
                                            '',
                                            '',
                                            f"${total_value:,.2f}",
                                            f"{total_port_pct:.2f}%"
                                        ]
                                        
                                        # Create table with proper column widths
                                        page_width = 7.5*inch
                                        col_widths = [1.2*inch, 1.0*inch, 1.2*inch, 1.0*inch, 1.5*inch, 1.0*inch]
                                        alloc_table = Table([headers] + table_rows + [total_row], colWidths=col_widths)
                                        alloc_table.setStyle(TableStyle([
                                            ('BACKGROUND', (0, 0), (-1, 0), reportlab_colors.Color(0.3, 0.5, 0.7)),
                                            ('TEXTCOLOR', (0, 0), (-1, 0), reportlab_colors.whitesmoke),
                                            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                                            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                                            ('FONTSIZE', (0, 0), (-1, -1), 8),
                                            ('GRID', (0, 0), (-1, -1), 1, reportlab_colors.black),
                                            ('BACKGROUND', (0, 1), (-1, -1), reportlab_colors.Color(0.98, 0.98, 0.98)),
                                            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                                            ('LEFTPADDING', (0, 0), (-1, -1), 3),
                                            ('RIGHTPADDING', (0, 0), (-1, -1), 3),
                                            ('TOPPADDING', (0, 0), (-1, -1), 2),
                                            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
                                            ('WORDWRAP', (0, 0), (-1, -1), True),
                                            # Style the total row
                                            ('BACKGROUND', (0, -1), (-1, -1), reportlab_colors.Color(0.2, 0.4, 0.6)),
                                            ('TEXTCOLOR', (0, -1), (-1, -1), reportlab_colors.whitesmoke),
                                            ('FONTNAME', (0, -1), (-1, -1), 'Helvetica-Bold')
                                        ]))
                                        story.append(alloc_table)
                                        story.append(Spacer(1, 5))
                                    else:
                                        story.append(Paragraph("No allocation data available", styles['Normal']))
                                else:
                                    story.append(Paragraph("No allocation data available", styles['Normal']))
                            except Exception as e:
                                story.append(Paragraph(f"Error creating allocation table: {str(e)}", styles['Normal']))
                            
                            story.append(Spacer(1, 5))
                        else:
                            story.append(Paragraph(f"No allocation data available for {portfolio_name}", styles['Normal']))
                    except Exception as e:
                        story.append(Paragraph(f"Error creating pie chart for {portfolio_name}: {str(e)}", styles['Normal']))
        else:
            story.append(Paragraph("Allocation data not available. Please run the allocation analysis first.", styles['Normal']))
            story.append(Spacer(1, 5))
        
        # Update progress
        progress_bar.progress(70)
        status_text.text("📊 Adding portfolio-weighted summary statistics...")
        
        # SECTION 3: Portfolio-Weighted Summary Statistics
        story.append(PageBreak())
        story.append(Paragraph("3. Portfolio-Weighted Summary Statistics", heading_style))
        story.append(Spacer(1, 10))
        story.append(Paragraph("Metrics weighted by portfolio allocation - represents the total portfolio characteristics", styles['Normal']))
        story.append(Spacer(1, 10))
        
        # Add data accuracy warning
        warning_style = ParagraphStyle(
            'WarningStyle',
            parent=styles['Normal'],
            fontSize=10,
            textColor=reportlab_colors.Color(0.8, 0.4, 0.2),
            leftIndent=20,
            rightIndent=20,
            spaceAfter=15
        )
        story.append(Paragraph("⚠️ <b>Data Accuracy Notice:</b> Portfolio metrics (PE, Beta, etc.) are calculated from available data and may not accurately represent the portfolio if some ticker data is missing, outdated, or incorrect. These metrics should be used as indicative values for portfolio analysis.", warning_style))
        story.append(Spacer(1, 15))
        
        # Get portfolio-weighted metrics using the same approach as the main UI
        active_name = active_portfolio.get('name', 'Unknown')
        
        # Create summary statistics table
        summary_data = []
        
        # Get portfolio metrics from session state (these are calculated and stored in the main UI)
        portfolio_pe = getattr(st.session_state, 'portfolio_pe', None)
        portfolio_forward_pe = getattr(st.session_state, 'portfolio_forward_pe', None)
        portfolio_pb = getattr(st.session_state, 'portfolio_pb', None)
        portfolio_peg = getattr(st.session_state, 'portfolio_peg', None)
        portfolio_ps = getattr(st.session_state, 'portfolio_ps', None)
        portfolio_ev_ebitda = getattr(st.session_state, 'portfolio_ev_ebitda', None)
        portfolio_beta = getattr(st.session_state, 'portfolio_beta', None)
        portfolio_roe = getattr(st.session_state, 'portfolio_roe', None)
        portfolio_roa = getattr(st.session_state, 'portfolio_roa', None)
        portfolio_profit_margin = getattr(st.session_state, 'portfolio_profit_margin', None)
        portfolio_operating_margin = getattr(st.session_state, 'portfolio_operating_margin', None)
        portfolio_gross_margin = getattr(st.session_state, 'portfolio_gross_margin', None)
        portfolio_revenue_growth = getattr(st.session_state, 'portfolio_revenue_growth', None)
        portfolio_earnings_growth = getattr(st.session_state, 'portfolio_earnings_growth', None)
        portfolio_eps_growth = getattr(st.session_state, 'portfolio_eps_growth', None)
        portfolio_dividend_yield = getattr(st.session_state, 'portfolio_dividend_yield', None)
        portfolio_payout_ratio = getattr(st.session_state, 'portfolio_payout_ratio', None)
        portfolio_market_cap = getattr(st.session_state, 'portfolio_market_cap', None)
        portfolio_enterprise_value = getattr(st.session_state, 'portfolio_enterprise_value', None)
        
        # Valuation metrics
        if portfolio_pe is not None and not pd.isna(portfolio_pe):
            summary_data.append(["Valuation", "P/E Ratio", f"{portfolio_pe:.2f}", "Price-to-Earnings ratio weighted by portfolio allocation"])
        if portfolio_forward_pe is not None and not pd.isna(portfolio_forward_pe):
            summary_data.append(["Valuation", "Forward P/E", f"{portfolio_forward_pe:.2f}", "Forward Price-to-Earnings ratio weighted by portfolio allocation"])
        if portfolio_pb is not None and not pd.isna(portfolio_pb):
            summary_data.append(["Valuation", "Price/Book", f"{portfolio_pb:.2f}", "Price-to-Book ratio weighted by portfolio allocation"])
        if portfolio_peg is not None and not pd.isna(portfolio_peg):
            summary_data.append(["Valuation", "PEG Ratio", f"{portfolio_peg:.2f}", "P/E to Growth ratio weighted by portfolio allocation"])
        if portfolio_ps is not None and not pd.isna(portfolio_ps):
            summary_data.append(["Valuation", "Price/Sales", f"{portfolio_ps:.2f}", "Price-to-Sales ratio weighted by portfolio allocation"])
        if portfolio_ev_ebitda is not None and not pd.isna(portfolio_ev_ebitda):
            summary_data.append(["Valuation", "EV/EBITDA", f"{portfolio_ev_ebitda:.2f}", "EV/EBITDA ratio weighted by portfolio allocation"])
        
        portfolio_price_fcf = getattr(st.session_state, 'portfolio_price_fcf', None)
        portfolio_fcf_yield = getattr(st.session_state, 'portfolio_fcf_yield', None)
        portfolio_interest_coverage = getattr(st.session_state, 'portfolio_interest_coverage', None)
        
        if portfolio_price_fcf is not None and not pd.isna(portfolio_price_fcf):
            summary_data.append(["Valuation", "Price/FCF", f"{portfolio_price_fcf:.2f}", "Price-to-Free Cash Flow ratio weighted by portfolio allocation"])
        if portfolio_fcf_yield is not None and not pd.isna(portfolio_fcf_yield):
            summary_data.append(["Valuation", "FCF Yield (%)", f"{portfolio_fcf_yield:.2f}%", "Free Cash Flow Yield weighted by portfolio allocation"])
        if portfolio_interest_coverage is not None and not pd.isna(portfolio_interest_coverage):
            if portfolio_interest_coverage == float('inf'):
                summary_data.append(["Financial Health", "Interest Coverage", "∞", "EBIT/Interest Expense (infinite = no interest expense)"])
            else:
                summary_data.append(["Financial Health", "Interest Coverage", f"{portfolio_interest_coverage:.2f}", "EBIT/Interest Expense weighted by portfolio allocation"])
        
        # Risk metrics
        if portfolio_beta is not None and not pd.isna(portfolio_beta):
            summary_data.append(["Risk", "Beta", f"{portfolio_beta:.2f}", "Portfolio volatility relative to market (1.0 = market average)"])
        
        # Profitability metrics
        if portfolio_roe is not None and not pd.isna(portfolio_roe):
            summary_data.append(["Profitability", "ROE (%)", f"{portfolio_roe:.2f}%", "Return on Equity weighted by portfolio allocation"])
        if portfolio_roa is not None and not pd.isna(portfolio_roa):
            summary_data.append(["Profitability", "ROA (%)", f"{portfolio_roa:.2f}%", "Return on Assets weighted by portfolio allocation"])
        if portfolio_profit_margin is not None and not pd.isna(portfolio_profit_margin):
            summary_data.append(["Profitability", "Profit Margin (%)", f"{portfolio_profit_margin:.2f}%", "Net profit margin weighted by portfolio allocation"])
        if portfolio_operating_margin is not None and not pd.isna(portfolio_operating_margin):
            summary_data.append(["Profitability", "Operating Margin (%)", f"{portfolio_operating_margin:.2f}%", "Operating profit margin weighted by portfolio allocation"])
        if portfolio_gross_margin is not None and not pd.isna(portfolio_gross_margin):
            summary_data.append(["Profitability", "Gross Margin (%)", f"{portfolio_gross_margin:.2f}%", "Gross profit margin weighted by portfolio allocation"])
        
        # Growth metrics
        if portfolio_revenue_growth is not None and not pd.isna(portfolio_revenue_growth):
            summary_data.append(["Growth", "Revenue Growth (%)", f"{portfolio_revenue_growth:.2f}%", "Revenue growth rate weighted by portfolio allocation"])
        if portfolio_earnings_growth is not None and not pd.isna(portfolio_earnings_growth):
            summary_data.append(["Growth", "Earnings Growth (%)", f"{portfolio_earnings_growth:.2f}%", "Earnings growth rate weighted by portfolio allocation"])
        if portfolio_eps_growth is not None and not pd.isna(portfolio_eps_growth):
            summary_data.append(["Growth", "EPS Growth (%)", f"{portfolio_eps_growth:.2f}%", "Earnings per share growth rate weighted by portfolio allocation"])
        
        # Dividend metrics
        if portfolio_dividend_yield is not None and not pd.isna(portfolio_dividend_yield):
            summary_data.append(["Dividends", "Dividend Yield (%)", f"{portfolio_dividend_yield:.2f}%", "Dividend yield weighted by portfolio allocation"])
        if portfolio_payout_ratio is not None and not pd.isna(portfolio_payout_ratio):
            summary_data.append(["Dividends", "Payout Ratio (%)", f"{portfolio_payout_ratio:.2f}%", "Dividend payout ratio weighted by portfolio allocation"])
        
        # Size metrics
        if portfolio_market_cap is not None and not pd.isna(portfolio_market_cap):
            summary_data.append(["Size", "Market Cap ($B)", f"${portfolio_market_cap:.2f}B", "Market capitalization weighted by portfolio allocation"])
        if portfolio_enterprise_value is not None and not pd.isna(portfolio_enterprise_value):
            summary_data.append(["Size", "Enterprise Value ($B)", f"${portfolio_enterprise_value:.2f}B", "Enterprise value weighted by portfolio allocation"])
        
        if summary_data:
            # Create summary table
            summary_headers = ['Category', 'Metric', 'Value', 'Description']
            summary_table = Table([summary_headers] + summary_data, colWidths=[0.8*inch, 1.2*inch, 0.8*inch, 3.2*inch])
            summary_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), reportlab_colors.Color(0.3, 0.5, 0.7)),
                ('TEXTCOLOR', (0, 0), (-1, 0), reportlab_colors.whitesmoke),
                ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, -1), 8),
                ('GRID', (0, 0), (-1, -1), 1, reportlab_colors.black),
                ('BACKGROUND', (0, 1), (-1, -1), reportlab_colors.Color(0.98, 0.98, 0.98)),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('WORDWRAP', (0, 0), (-1, -1), True),
                ('LEFTPADDING', (0, 0), (-1, -1), 4),
                ('RIGHTPADDING', (0, 0), (-1, -1), 4),
                ('TOPPADDING', (0, 0), (-1, -1), 4),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 4)
            ]))
            story.append(summary_table)
            story.append(Spacer(1, 15))
            
            # Add interpretation
            story.append(Paragraph("Portfolio Interpretation:", subheading_style))
            story.append(Spacer(1, 10))
            
            if portfolio_beta is not None and not pd.isna(portfolio_beta):
                if portfolio_beta < 0.8:
                    story.append(Paragraph(f"• Low Risk Portfolio - Beta {portfolio_beta:.2f} indicates lower volatility than market", styles['Normal']))
                elif portfolio_beta < 1.2:
                    story.append(Paragraph(f"• Moderate Risk Portfolio - Beta {portfolio_beta:.2f} indicates market-average volatility", styles['Normal']))
                else:
                    story.append(Paragraph(f"• High Risk Portfolio - Beta {portfolio_beta:.2f} indicates higher volatility than market", styles['Normal']))
            
            if portfolio_pe is not None and not pd.isna(portfolio_pe):
                if portfolio_pe < 15:
                    story.append(Paragraph(f"• Undervalued Portfolio - P/E {portfolio_pe:.2f} suggests attractive valuations", styles['Normal']))
                elif portfolio_pe < 25:
                    story.append(Paragraph(f"• Fairly Valued Portfolio - P/E {portfolio_pe:.2f} suggests reasonable valuations", styles['Normal']))
                else:
                    story.append(Paragraph(f"• Potentially Overvalued Portfolio - P/E {portfolio_pe:.2f} suggests high valuations", styles['Normal']))
        else:
            story.append(Paragraph("No portfolio-weighted metrics available for display.", styles['Normal']))
        
        # Update progress
        progress_bar.progress(80)
        status_text.text("🏢 Adding portfolio composition analysis...")
        
        # SECTION 4: Portfolio Composition Analysis
        story.append(PageBreak())
        story.append(Paragraph("4. Portfolio Composition Analysis", heading_style))
        story.append(Spacer(1, 15))
        
        # Get sector and industry data from session state (these are calculated and stored in the main UI)
        sector_data = getattr(st.session_state, 'sector_data', pd.Series(dtype=float))
        industry_data = getattr(st.session_state, 'industry_data', pd.Series(dtype=float))
        
        # Sector Allocation
        if not sector_data.empty:
            story.append(Paragraph("Sector Allocation", subheading_style))
            story.append(Spacer(1, 10))
            
            # Create sector table
            sector_table_data = [['Sector', 'Allocation (%)']]
            for sector, allocation in sector_data.items():
                sector_table_data.append([sector, f"{allocation:.2f}%"])
            
            sector_table = Table(sector_table_data, colWidths=[3.0*inch, 1.5*inch])
            sector_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), reportlab_colors.Color(0.3, 0.5, 0.7)),
                ('TEXTCOLOR', (0, 0), (-1, 0), reportlab_colors.whitesmoke),
                ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, -1), 10),
                ('GRID', (0, 0), (-1, -1), 1, reportlab_colors.black),
                ('BACKGROUND', (0, 1), (-1, -1), reportlab_colors.Color(0.98, 0.98, 0.98))
            ]))
            story.append(sector_table)
            story.append(Spacer(1, 15))
        
        # Industry Allocation
        if not industry_data.empty:
            story.append(Paragraph("Industry Allocation", subheading_style))
            story.append(Spacer(1, 10))
            
            # Create industry table
            industry_table_data = [['Industry', 'Allocation (%)']]
            for industry, allocation in industry_data.items():
                industry_table_data.append([industry, f"{allocation:.2f}%"])
            
            industry_table = Table(industry_table_data, colWidths=[3.0*inch, 1.5*inch])
            industry_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), reportlab_colors.Color(0.3, 0.5, 0.7)),
                ('TEXTCOLOR', (0, 0), (-1, 0), reportlab_colors.whitesmoke),
                ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, -1), 10),
                ('GRID', (0, 0), (-1, -1), 1, reportlab_colors.black),
                ('BACKGROUND', (0, 1), (-1, -1), reportlab_colors.Color(0.98, 0.98, 0.98))
            ]))
            story.append(industry_table)
            story.append(Spacer(1, 15))
        
        # Add page break and create charts page
        if not sector_data.empty or not industry_data.empty:
            story.append(PageBreak())
            story.append(Paragraph("Portfolio Distribution Charts", heading_style))
            story.append(Spacer(1, 15))
            
            # Check if we actually have any allocation data to display
            has_sector_data = not sector_data.empty and len(sector_data) > 0 and sector_data.sum() > 0
            has_industry_data = not industry_data.empty and len(industry_data) > 0 and industry_data.sum() > 0
            
            if not has_sector_data and not has_industry_data:
                # Portfolio is all cash - show message instead of charts
                story.append(Paragraph("This portfolio is currently allocated 100% to cash. No sector or industry distribution charts are available.", styles['Normal']))
                story.append(Spacer(1, 15))
            else:
                # Create combined figure with both pie charts one above the other
                try:
                    # Create figure with two subplots - square subplots to ensure circular pie charts
                    fig, (ax_sector, ax_industry) = plt.subplots(2, 1, figsize=(12, 12))
                
                    # Define consistent color palette for both charts
                    consistent_colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf']
                    
                    # Sector pie chart
                    if has_sector_data:
                        sectors = sector_data.index.tolist()
                        allocations = sector_data.values.tolist()
                        
                        # Create pie chart with percentage labels but only for larger slices to avoid overlap
                        def make_autopct(values):
                            def my_autopct(pct):
                                if pd.isna(pct) or pct is None:
                                    return ''
                                total = sum(values)
                                if pd.isna(total) or total == 0:
                                    return ''
                                val = int(round(pct*total/100.0))
                                # Only show percentage if slice is large enough (>5%)
                                return f'{pct:.1f}%' if pct > 5 else ''
                            return my_autopct
                        
                        wedges_sector, texts_sector, autotexts_sector = ax_sector.pie(allocations, autopct=make_autopct(allocations), 
                                                                                     startangle=90, textprops={'fontsize': 10},
                                                                                     colors=consistent_colors[:len(allocations)])
                        
                        # Create legend with percentages - positioned further to the right
                        legend_labels = [f"{sector} ({alloc:.1f}%)" for sector, alloc in zip(sectors, allocations)]
                        ax_sector.legend(wedges_sector, legend_labels, title="Sectors", loc="center left", bbox_to_anchor=(1.05, 0, 0.5, 1), fontsize=10)
                        
                        # Wrap long titles to prevent them from going out of bounds
                        title_text = f'Sector Allocation - {portfolio_name}'
                        # Use textwrap for proper word-based wrapping
                        import textwrap
                        wrapped_title = textwrap.fill(title_text, width=40, break_long_words=True, break_on_hyphens=False)
                        ax_sector.set_title(wrapped_title, fontsize=14, fontweight='bold')
                        # Force perfectly circular shape
                        ax_sector.set_aspect('equal')
                        ax_sector.set_xlim(-1.2, 1.2)
                        ax_sector.set_ylim(-1.2, 1.2)
                    else:
                        # No sector data - show placeholder
                        ax_sector.text(0.5, 0.5, 'No sector data available', 
                                     horizontalalignment='center', verticalalignment='center', 
                                     transform=ax_sector.transAxes, fontsize=12)
                        # Wrap long titles to prevent them from going out of bounds
                        title_text = f'Sector Allocation - {portfolio_name}'
                        # Use textwrap for proper word-based wrapping
                        import textwrap
                        wrapped_title = textwrap.fill(title_text, width=40, break_long_words=True, break_on_hyphens=False)
                        ax_sector.set_title(wrapped_title, fontsize=14, fontweight='bold')
                    
                    # Industry pie chart
                    if has_industry_data:
                        industries = industry_data.index.tolist()
                        allocations = industry_data.values.tolist()
                        
                        # Create pie chart with percentage labels but only for larger slices to avoid overlap
                        def make_autopct(values):
                            def my_autopct(pct):
                                if pd.isna(pct) or pct is None:
                                    return ''
                                total = sum(values)
                                if pd.isna(total) or total == 0:
                                    return ''
                                val = int(round(pct*total/100.0))
                                # Only show percentage if slice is large enough (>5%)
                                return f'{pct:.1f}%' if pct > 5 else ''
                            return my_autopct
                        
                        wedges_industry, texts_industry, autotexts_industry = ax_industry.pie(allocations, autopct=make_autopct(allocations), 
                                                                                             startangle=90, textprops={'fontsize': 10},
                                                                                             colors=consistent_colors[:len(allocations)])
                        
                        # Create legend with percentages - positioned further to the right
                        legend_labels = [f"{industry} ({alloc:.1f}%)" for industry, alloc in zip(industries, allocations)]
                        ax_industry.legend(wedges_industry, legend_labels, title="Industries", loc="center left", bbox_to_anchor=(1.05, 0, 0.5, 1), fontsize=10)
                        
                        # Wrap long titles to prevent them from going out of bounds
                        title_text = f'Industry Allocation - {portfolio_name}'
                        # Use textwrap for proper word-based wrapping
                        import textwrap
                        wrapped_title = textwrap.fill(title_text, width=40, break_long_words=True, break_on_hyphens=False)
                        ax_industry.set_title(wrapped_title, fontsize=14, fontweight='bold')
                        # Force perfectly circular shape
                        ax_industry.set_aspect('equal')
                        ax_industry.set_xlim(-1.2, 1.2)
                        ax_industry.set_ylim(-1.2, 1.2)
                    else:
                        # No industry data - show placeholder
                        ax_industry.text(0.5, 0.5, 'No industry data available', 
                                       horizontalalignment='center', verticalalignment='center', 
                                       transform=ax_industry.transAxes, fontsize=12)
                        # Wrap long titles to prevent them from going out of bounds
                        title_text = f'Industry Allocation - {portfolio_name}'
                        # Use textwrap for proper word-based wrapping
                        import textwrap
                        wrapped_title = textwrap.fill(title_text, width=40, break_long_words=True, break_on_hyphens=False)
                        ax_industry.set_title(wrapped_title, fontsize=14, fontweight='bold')
                    
                    # Adjust layout to maintain circular shapes and accommodate legends
                    plt.subplots_adjust(hspace=0.4, left=0.1, right=0.7, top=0.95, bottom=0.05)
                    
                    # Save to buffer - don't use bbox_inches='tight' to preserve aspect ratio
                    combined_img_buffer = io.BytesIO()
                    fig.savefig(combined_img_buffer, format='png', dpi=300, facecolor='white')
                    combined_img_buffer.seek(0)
                    plt.close(fig)
                    
                    # Add to PDF - maintain square aspect ratio for circular charts
                    story.append(Image(combined_img_buffer, width=8*inch, height=8*inch))
                    story.append(Spacer(1, 15))
                    
                except Exception as e:
                    story.append(Paragraph(f"Error creating charts: {str(e)}", styles['Normal']))
        
        # Add page break and move Portfolio Risk Metrics Summary to next page
        story.append(PageBreak())
        story.append(Paragraph("Portfolio Risk Metrics Summary", subheading_style))
        story.append(Spacer(1, 10))
        
        risk_metrics_data = []
        
        # Beta
        if portfolio_beta is not None and not pd.isna(portfolio_beta):
            if portfolio_beta < 0.8:
                beta_risk = "Low Risk"
            elif portfolio_beta < 1.2:
                beta_risk = "Balanced Risk"
            elif portfolio_beta < 1.5:
                beta_risk = "Moderate Risk"
            else:
                beta_risk = "High Risk"
            risk_metrics_data.append(["Portfolio Risk Level", beta_risk, f"Beta: {portfolio_beta:.2f}"])
        else:
            risk_metrics_data.append(["Portfolio Risk Level", "NA", "Beta: NA"])
        
        # P/E
        if portfolio_pe is not None and not pd.isna(portfolio_pe):
            if portfolio_pe < 15:
                pe_rating = "Undervalued"
            elif portfolio_pe < 25:
                pe_rating = "Fair Value"
            elif portfolio_pe < 35:
                pe_rating = "Expensive"
            else:
                pe_rating = "Overvalued"
            risk_metrics_data.append(["Current P/E Rating", pe_rating, f"P/E: {portfolio_pe:.2f}"])
        else:
            risk_metrics_data.append(["Current P/E Rating", "NA", "P/E: NA"])
        
        # Forward P/E
        if portfolio_forward_pe is not None and not pd.isna(portfolio_forward_pe):
            if portfolio_forward_pe < 15:
                fpe_rating = "Undervalued"
            elif portfolio_forward_pe < 25:
                fpe_rating = "Fair Value"
            elif portfolio_forward_pe < 35:
                fpe_rating = "Expensive"
            else:
                fpe_rating = "Overvalued"
            risk_metrics_data.append(["Forward P/E Rating", fpe_rating, f"Forward P/E: {portfolio_forward_pe:.2f}"])
        else:
            risk_metrics_data.append(["Forward P/E Rating", "NA", "Forward P/E: NA"])
        
        # Dividend
        if portfolio_dividend_yield is not None and not pd.isna(portfolio_dividend_yield):
            if portfolio_dividend_yield > 5:
                div_rating = "Very High Yield"
            elif portfolio_dividend_yield > 3:
                div_rating = "Good Yield"
            elif portfolio_dividend_yield > 1.5:
                div_rating = "Moderate Yield"
            else:
                div_rating = "Low Yield"
            risk_metrics_data.append(["Dividend Rating", div_rating, f"Yield: {portfolio_dividend_yield:.2f}%"])
        else:
            risk_metrics_data.append(["Dividend Rating", "NA", "Yield: NA"])
        
        if risk_metrics_data:
            risk_headers = ['Metric', 'Rating', 'Value']
            risk_table = Table([risk_headers] + risk_metrics_data, colWidths=[2.0*inch, 1.5*inch, 1.5*inch])
            risk_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), reportlab_colors.Color(0.3, 0.5, 0.7)),
                ('TEXTCOLOR', (0, 0), (-1, 0), reportlab_colors.whitesmoke),
                ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, -1), 10),
                ('GRID', (0, 0), (-1, -1), 1, reportlab_colors.black),
                ('BACKGROUND', (0, 1), (-1, -1), reportlab_colors.Color(0.98, 0.98, 0.98))
            ]))
            story.append(risk_table)

        # Insert Returns Summary table directly after Portfolio Risk Metrics Summary
        try:
            rs_df = st.session_state.get('returns_summary_df')
            if rs_df is not None and not rs_df.empty:
                story.append(Spacer(1, 12))
                story.append(Paragraph("Returns Summary (Current Positions)", subheading_style))
                story.append(Spacer(1, 6))
                cols_pref = ['Ticker', 'Momentum', 'Beta', 'Volatility', '1W', '1M', '3M', '6M', '1Y']
                cols_present = [c for c in cols_pref if c in rs_df.columns]
                pdf_data = [cols_present]
                for _, r in rs_df.iterrows():
                    row_vals = []
                    for c in cols_present:
                        v = r.get(c, '')
                        row_vals.append(str(v) if not pd.isna(v) else 'N/A')
                    pdf_data.append(row_vals)
                available_w = doc.width
                ticker_ratio = 0.22
                other_ratio = max(0.01, (1.0 - ticker_ratio) / max(1, len(cols_present) - 1))
                col_widths = []
                for c in cols_present:
                    col_widths.append(available_w * (ticker_ratio if c == 'Ticker' else other_ratio))
                table = Table(pdf_data, colWidths=col_widths)
                table.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (-1, 0), reportlab_colors.Color(0.2, 0.2, 0.2)),
                    ('TEXTCOLOR', (0, 0), (-1, 0), reportlab_colors.whitesmoke),
                    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                    ('FONTSIZE', (0, 0), (-1, 0), 8),
                    ('FONTSIZE', (0, 1), (-1, -1), 7),
                    ('GRID', (0, 0), (-1, -1), 0.5, reportlab_colors.grey),
                    ('ALIGN', (1, 1), (-1, -1), 'RIGHT'),
                    ('ALIGN', (0, 0), (0, -1), 'LEFT'),
                ]))
                story.append(table)
        except Exception as _e:
            story.append(Paragraph(f"Returns Summary unavailable: {str(_e)}", styles['Normal']))

        # Benchmark Comparison table placed right below Returns Summary
        try:
            bmk_df = st.session_state.get('benchmark_comparison_df')
            if (bmk_df is None) or (hasattr(bmk_df, 'empty') and bmk_df.empty):
                # Fallback recompute
                snapshot = st.session_state.get('alloc_snapshot_data', {})
                raw_data = snapshot.get('raw_data') if snapshot and snapshot.get('raw_data') is not None else st.session_state.get('alloc_raw_data', {})
                available_data = {}
                _bench = ['SPY', 'QQQ', 'SPMO', 'VTI', 'VT', 'SSO', 'QLD', 'BITCOIN']
                for _t in _bench:
                    if raw_data and _t in raw_data and not raw_data[_t].empty:
                        available_data[_t] = raw_data[_t].copy()
                preloaded = get_multiple_tickers_info_batch(_bench)
                bmk_df = calculate_benchmark_returns(available_data, preloaded)
            if bmk_df is not None and not bmk_df.empty:
                story.append(Spacer(1, 12))
                story.append(Paragraph("Benchmark Comparison", subheading_style))
                story.append(Spacer(1, 6))
                bcols_pref = ['Ticker', 'PE', '1W', '1M', '3M', '6M', '1Y', 'Volatility', 'Beta']
                bcols_present = [c for c in bcols_pref if c in bmk_df.columns]
                bpdf_data = [bcols_present]
                for _, r in bmk_df.iterrows():
                    row_vals = []
                    for c in bcols_present:
                        v = r.get(c, '')
                        row_vals.append(str(v) if not pd.isna(v) else 'N/A')
                    bpdf_data.append(row_vals)
                b_available_w = doc.width
                base_map = {'Ticker': 0.18, 'PE': 0.10, 'Volatility': 0.10, 'Beta': 0.08}
                remaining_ratio = 1.0 - sum(base_map.get(c, 0.0) for c in bcols_present)
                period_count = len([c for c in bcols_present if c not in base_map])
                per_period_ratio = remaining_ratio / max(1, period_count)
                b_col_widths = []
                for c in bcols_present:
                    b_col_widths.append(b_available_w * (base_map.get(c, per_period_ratio)))
                btable = Table(bpdf_data, colWidths=b_col_widths)
                btable.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (-1, 0), reportlab_colors.Color(0.2, 0.2, 0.2)),
                    ('TEXTCOLOR', (0, 0), (-1, 0), reportlab_colors.whitesmoke),
                    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                    ('FONTSIZE', (0, 0), (-1, 0), 8),
                    ('FONTSIZE', (0, 1), (-1, -1), 7),
                    ('GRID', (0, 0), (-1, -1), 0.5, reportlab_colors.grey),
                    ('ALIGN', (2, 1), (-1, -1), 'RIGHT'),
                    ('ALIGN', (0, 0), (1, -1), 'LEFT'),
                ]))
                story.append(btable)
        except Exception as _e:
            story.append(Paragraph(f"Benchmark Comparison unavailable: {str(_e)}", styles['Normal']))
        
        # Add page break before detailed financial indicators
        story.append(PageBreak())
        
        # Add detailed financial indicators tables covering all 5 sections
        if hasattr(st.session_state, 'sector_data') and not st.session_state.sector_data.empty:
            story.append(Spacer(1, 20))
            story.append(Paragraph("Detailed Financial Indicators for Each Position", heading_style))
            story.append(Spacer(1, 10))
            
            # Get the comprehensive portfolio data from session state
            try:
                if hasattr(st.session_state, 'df_comprehensive'):
                    df_comprehensive = st.session_state.df_comprehensive
                    
                    # Helper function to create wrapped text for PDF with enhanced company name, sector, and industry handling
                    def wrap_text_for_pdf(text, max_length=25):
                        """Wrap long text to fit in PDF cells with intelligent line breaks for company names, sectors, and industries"""
                        if pd.isna(text) or text is None:
                            return 'N/A'
                        text_str = str(text)
                        if len(text_str) <= max_length:
                            return text_str
                        
                        # For company names, sector, and industry, prioritize showing the full name with line breaks
                        if 'Name' in str(text) or 'Sector' in str(text) or 'Industry' in str(text) or len(text_str) > max_length * 1.2:
                            # Try to break at spaces first for better readability
                            words = text_str.split()
                            if len(words) > 1:
                                # Find the best break point that maximizes text visibility
                                best_break = 0
                                for i, word in enumerate(words):
                                    if len(' '.join(words[:i+1])) <= max_length:
                                        best_break = i + 1
                                    else:
                                        break
                                
                                if best_break > 0:
                                    # Use line break for better PDF formatting
                                    first_line = ' '.join(words[:best_break])
                                    second_line = ' '.join(words[best_break:])
                                    
                                    # For company names, sector, and industry, allow longer second lines to show more text
                                    if len(second_line) > max_length:
                                        # Instead of truncating, try to break again
                                        second_words = second_line.split()
                                        if len(second_words) > 1:
                                            # Find another break point in the second line
                                            second_break = 0
                                            for j, word in enumerate(second_words):
                                                if len(' '.join(second_words[:j+1])) <= max_length:
                                                    second_break = j + 1
                                                else:
                                                    break
                                            if second_break > 0:
                                                second_line = ' '.join(second_words[:second_break])
                                                third_line = ' '.join(second_words[second_break:])
                                                if len(third_line) > max_length:
                                                    third_line = third_line[:max_length-3] + '...'
                                                return first_line + '\n' + second_line + '\n' + third_line
                                            else:
                                                # If we can't break further, truncate the second line
                                                second_line = second_line[:max_length-3] + '...'
                                        else:
                                            # Single long word in second line, truncate
                                            second_line = second_line[:max_length-3] + '...'
                                    
                                    return first_line + '\n' + second_line
                                else:
                                    # If we can't break at words, truncate with ellipsis
                                    return text_str[:max_length-3] + '...'
                        
                        # For other columns, try to break at spaces or special characters
                        words = text_str.split()
                        if len(words) == 1:
                            # Single long word, break at max_length
                            return text_str[:max_length-3] + '...'
                        # Try to fit as many words as possible
                        result = ''
                        for word in words:
                            if len(result + ' ' + word) <= max_length:
                                result += (' ' + word) if result else word
                            else:
                                break
                        if not result:
                            result = text_str[:max_length-3] + '...'
                        return result
                    
                    # Helper function to create a focused table
                    def create_focused_table(title, columns, data_subset, col_widths):
                        """Create a focused table with specific columns"""
                        story.append(Paragraph(f"<b>{title}</b>", styles['Normal']))
                        story.append(Spacer(1, 5))
                        
                        # Filter dataframe to only include available columns
                        available_columns = [col for col in columns if col in data_subset.columns]
                        if not available_columns:
                            return
                        
                        df_subset = data_subset[available_columns].copy()
                        
                        # Convert to list format for PDF table with text wrapping
                        pdf_data = [available_columns]  # Headers
                        for _, row in df_subset.iterrows():
                            pdf_row = []
                            for col in available_columns:
                                value = row[col]
                                if pd.isna(value) or value is None:
                                    pdf_row.append('N/A')
                                else:
                                    # Apply text wrapping based on column type
                                    if 'Name' in col:
                                        pdf_row.append(wrap_text_for_pdf(value, 22))  # Increased for better company name display
                                    elif 'Sector' in col or 'Industry' in col:
                                        pdf_row.append(wrap_text_for_pdf(value, 25))  # Increased for better sector/industry display
                                    elif 'Ticker' in col:
                                        pdf_row.append(wrap_text_for_pdf(value, 8))
                                    else:
                                        pdf_row.append(wrap_text_for_pdf(value, 15))
                            pdf_data.append(pdf_row)
                        
                        # Create table with specified column widths and enhanced styling for text wrapping
                        table = Table(pdf_data, colWidths=col_widths[:len(available_columns)])
                        table.setStyle(TableStyle([
                            ('BACKGROUND', (0, 0), (-1, 0), reportlab_colors.Color(0.3, 0.5, 0.7)),
                            ('TEXTCOLOR', (0, 0), (-1, 0), reportlab_colors.whitesmoke),
                            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                            ('FONTSIZE', (0, 0), (-1, -1), 6),  # Very small font to fit more data
                            ('GRID', (0, 0), (-1, -1), 0.5, reportlab_colors.grey),
                            ('BACKGROUND', (0, 1), (-1, -1), reportlab_colors.Color(0.98, 0.98, 0.98)),
                            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [reportlab_colors.Color(0.98, 0.98, 0.98), reportlab_colors.Color(0.95, 0.95, 0.95)]),
                            ('WORDWRAP', (0, 0), (-1, -1), True),  # Enable word wrapping for all cells
                            ('LEFTPADDING', (0, 0), (-1, -1), 3),  # Add some padding for wrapped text
                            ('RIGHTPADDING', (0, 0), (-1, -1), 3),
                            ('MINIMUMHEIGHT', (0, 0), (-1, -1), 15)  # Ensure minimum height for wrapped text, especially for company names
                        ]))
                        
                        story.append(table)
                        story.append(Spacer(1, 10))
                    
                    # Section 1: Overview & Basic Info - Company Name column optimized to 1.5" for balance
                    # Industry column optimized to 1.1" to prevent truncation while ensuring table fits within page
                    # Enhanced text wrapping for Company Name, Sector, and Industry columns to ensure full text visibility
                    # Total table width: 7.1 inches (ensures small margin on each side of 8.5" page)
                    overview_cols = ['Ticker', 'Company Name', 'Sector', 'Industry', 'Current Price ($)', 'Allocation %', 'Shares', 'Total Value ($)', '% of Portfolio']
                    overview_widths = [0.6*inch, 1.5*inch, 1.0*inch, 1.1*inch, 0.8*inch, 0.7*inch, 0.6*inch, 1.0*inch, 0.8*inch]
                    create_focused_table("📊 Overview & Basic Information", overview_cols, df_comprehensive, overview_widths)
                    
                    # Section 2: Valuation Metrics - Part 1 (Core Ratios)
                    valuation_cols_1 = ['Ticker', 'Market Cap ($B)', 'Enterprise Value ($B)', 'P/E Ratio', 'Forward P/E', 'PEG Ratio', 'Price/Book', 'Price/Sales', 'EV/EBITDA']
                    valuation_widths_1 = [0.6*inch, 0.8*inch, 1.0*inch, 0.6*inch, 0.7*inch, 0.6*inch, 0.7*inch, 0.7*inch, 0.7*inch]
                    # Filter to only include columns that exist
                    valuation_cols_1 = [col for col in valuation_cols_1 if col in df_comprehensive.columns]
                    create_focused_table("💰 Valuation Metrics - Part 1: Core Ratios", valuation_cols_1, df_comprehensive, valuation_widths_1)
                    
                    # Section 2b: Valuation Metrics - Part 2 (Cash Flow & Shares)
                    valuation_cols_2 = ['Ticker', 'Price/Cash Flow', 'Price/FCF', 'FCF Yield (%)', 'Free Cash Flow ($B)', 'Shares Outstanding (M)', 'Float Shares (M)']
                    valuation_widths_2 = [0.6*inch, 0.8*inch, 0.7*inch, 0.7*inch, 0.9*inch, 1.1*inch, 1.1*inch]
                    # Filter to only include columns that exist
                    valuation_cols_2 = [col for col in valuation_cols_2 if col in df_comprehensive.columns]
                    if len(valuation_cols_2) > 1:  # Only create if we have more than just Ticker
                        create_focused_table("💰 Valuation Metrics - Part 2: Cash Flow & Shares", valuation_cols_2, df_comprehensive, valuation_widths_2)
                    
                    # Section 3: Financial Health - Part 1 (Debt & Liquidity)
                    health_cols_1 = ['Ticker', 'Debt/Equity', 'Total Debt ($B)', 'Net Debt ($B)', 'Current Ratio', 'Quick Ratio', 'Working Capital ($B)', 'Interest Coverage']
                    health_widths_1 = [0.6*inch, 0.9*inch, 0.8*inch, 0.8*inch, 0.9*inch, 0.8*inch, 1.0*inch, 0.9*inch]
                    # Filter to only include columns that exist
                    health_cols_1 = [col for col in health_cols_1 if col in df_comprehensive.columns]
                    create_focused_table("🏥 Financial Health - Part 1: Debt & Liquidity", health_cols_1, df_comprehensive, health_widths_1)
                    
                    # Section 3b: Financial Health - Part 2 (Profitability & Returns)
                    health_cols_2 = ['Ticker', 'ROE (%)', 'ROA (%)', 'ROIC (%)', 'Profit Margin (%)', 'Operating Margin (%)', 'Gross Margin (%)']
                    health_widths_2 = [0.6*inch, 0.8*inch, 0.8*inch, 0.8*inch, 1.0*inch, 1.0*inch, 1.0*inch]
                    # Filter to only include columns that exist
                    health_cols_2 = [col for col in health_cols_2 if col in df_comprehensive.columns]
                    if len(health_cols_2) > 1:  # Only create if we have more than just Ticker
                        create_focused_table("🏥 Financial Health - Part 2: Profitability & Returns", health_cols_2, df_comprehensive, health_widths_2)
                    
                    # Section 4: Growth & Dividends - Part 1 (Revenue & Earnings)
                    growth_cols_1 = ['Ticker', 'Revenue TTM ($B)', 'Earnings TTM ($B)', 'Revenue Growth (%)', 'Earnings Growth (%)', 'EPS Growth (%)']
                    growth_widths_1 = [0.6*inch, 0.9*inch, 0.9*inch, 1.0*inch, 1.0*inch, 0.8*inch]
                    # Filter to only include columns that exist
                    growth_cols_1 = [col for col in growth_cols_1 if col in df_comprehensive.columns]
                    create_focused_table("📈 Growth & Dividends - Part 1: Revenue & Earnings", growth_cols_1, df_comprehensive, growth_widths_1)
                    
                    # Section 4b: Growth & Dividends - Part 2 (Dividend Information)
                    growth_cols_2 = ['Ticker', 'Dividend Yield (%)', 'Dividend Rate ($)', 'Payout Ratio (%)', '5Y Dividend Growth (%)']
                    growth_widths_2 = [0.6*inch, 0.9*inch, 0.9*inch, 0.8*inch, 1.0*inch]
                    # Filter to only include columns that exist
                    growth_cols_2 = [col for col in growth_cols_2 if col in df_comprehensive.columns]
                    if len(growth_cols_2) > 1:  # Only create if we have more than just Ticker
                        create_focused_table("📈 Growth & Dividends - Part 2: Dividend Information", growth_cols_2, df_comprehensive, growth_widths_2)
                    
                    # Section 5: Technical & Trading
                    technical_cols = ['Ticker', '52W High ($)', '52W Low ($)', '50D MA ($)', '200D MA ($)', 'Beta', 'Volume', 'Avg Volume', 'Analyst Rating']
                    technical_widths = [0.6*inch, 0.7*inch, 0.7*inch, 0.7*inch, 0.7*inch, 0.5*inch, 0.7*inch, 0.7*inch, 0.7*inch]
                    create_focused_table("📊 Technical & Trading", technical_cols, df_comprehensive, technical_widths)
                    
                    story.append(Spacer(1, 10))
                    story.append(Paragraph("Note: This comprehensive analysis covers all 5 sections (Overview, Valuation, Financial Health, Growth & Dividends, Technical) with the most important metrics for each position. For complete data and interactive analysis, run the allocation analysis in the Streamlit interface.", styles['Normal']))
                    
                else:
                    # Fallback: create basic table from current allocations
                    basic_data = []
                    for ticker, alloc_pct in alloc_dict.items():
                        if ticker != 'CASH':
                            basic_data.append([
                                ticker,
                                f"{alloc_pct * 100:.2f}%",
                                f"${portfolio_value * alloc_pct:,.2f}",
                                f"{(portfolio_value * alloc_pct / portfolio_value * 100):.2f}%"
                            ])
                    
                    if basic_data:
                        # Create basic table headers
                        basic_headers = ['Ticker', 'Allocation %', 'Total Value ($)', '% of Portfolio']
                        basic_table = Table([basic_headers] + basic_data, colWidths=[1.5*inch, 1.5*inch, 2.0*inch, 1.5*inch])
                        basic_table.setStyle(TableStyle([
                            ('BACKGROUND', (0, 0), (-1, 0), reportlab_colors.Color(0.3, 0.5, 0.7)),
                            ('TEXTCOLOR', (0, 0), (-1, 0), reportlab_colors.whitesmoke),
                            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                            ('FONTSIZE', (0, 0), (-1, -1), 8),
                            ('GRID', (0, 0), (-1, -1), 1, reportlab_colors.black),
                            ('BACKGROUND', (0, 1), (-1, -1), reportlab_colors.Color(0.98, 0.98, 0.98))
                        ]))
                        story.append(basic_table)
                        story.append(Spacer(1, 10))
                        story.append(Paragraph("Note: Basic allocation data shown. For comprehensive financial indicators, run the allocation analysis in the Streamlit interface.", styles['Normal']))
            
            except Exception as e:
                story.append(Paragraph(f"Note: Detailed financial indicators table could not be generated: {str(e)}", styles['Normal']))
        
        # Append AI Analysis (if available) for parity with Page 5
        try:
            ai_text_last = st.session_state.get('alloc_ai_last_text')
            if ai_text_last:
                story.append(PageBreak())
                ai_title_style = ParagraphStyle('AIAnalysis', parent=styles['Heading2'], fontSize=14, spaceAfter=12, textColor=reportlab_colors.Color(0.35, 0.6, 0.85))
                story.append(Paragraph("AI Analysis", ai_title_style))
                import json as _json, unicodedata, re
                parsed = None
                try:
                    _s = ai_text_last.find('{'); _e = ai_text_last.rfind('}')
                    if _s != -1 and _e != -1 and _e > _s:
                        parsed = _json.loads(ai_text_last[_s:_e+1])
                except Exception:
                    parsed = None
                if parsed:
                    wrap_style = ParagraphStyle('AIWrap', parent=styles['Normal'], wordWrap='CJK')
                    if parsed.get('overall_score') is not None:
                        story.append(Paragraph(f"Overall Score: {parsed.get('overall_score')}", wrap_style))
                        story.append(Spacer(1,6))
                    if parsed.get('overall_comment'):
                        story.append(Paragraph(parsed.get('overall_comment'), wrap_style))
                        story.append(Spacer(1,8))
                    tlist = parsed.get('tickers') or []
                    if tlist:
                        total_w = getattr(doc, 'width', 7.1*inch)
                        left_w = 1.0*inch
                        mid_w = 0.8*inch
                        right_w = max(2.0*inch, total_w - (left_w + mid_w))
                        header_style = ParagraphStyle('AIJsonHeader', parent=styles['Normal'], fontSize=7, leading=8, textColor=reportlab_colors.whitesmoke, fontName='Helvetica-Bold', wordWrap='CJK')
                        cell_style = ParagraphStyle('AIJsonCell', parent=styles['Normal'], fontSize=7, leading=8, wordWrap='CJK')
                        tbl = [[
                            Paragraph("Ticker", header_style),
                            Paragraph("Score", header_style),
                            Paragraph("Comment", header_style)
                        ]]
                        for tr in tlist:
                            tbl.append([
                                Paragraph(str(tr.get('ticker','')), cell_style),
                                Paragraph(str(tr.get('score','')), cell_style),
                                Paragraph(str(tr.get('comment','')), cell_style)
                            ])
                        t = Table(tbl, repeatRows=1, colWidths=[left_w, mid_w, right_w])
                        t.setStyle(TableStyle([
                            ('BACKGROUND', (0, 0), (-1, 0), reportlab_colors.Color(0.3, 0.5, 0.7)),
                            ('TEXTCOLOR', (0, 0), (-1, 0), reportlab_colors.whitesmoke),
                            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                            ('FONTSIZE', (0, 0), (-1, -1), 6),
                            ('GRID', (0, 0), (-1, -1), 0.5, reportlab_colors.grey),
                            ('BACKGROUND', (0, 1), (-1, -1), reportlab_colors.Color(0.98, 0.98, 0.98)),
                            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [reportlab_colors.Color(0.98, 0.98, 0.98), reportlab_colors.Color(0.95, 0.95, 0.95)]),
                            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                            ('WORDWRAP', (0, 0), (-1, -1), True),
                            ('LEFTPADDING', (0, 0), (-1, -1), 3),
                            ('RIGHTPADDING', (0, 0), (-1, -1), 3),
                            ('MINIMUMHEIGHT', (0, 0), (-1, -1), 15)
                        ]))
                        story.append(t)
                        story.append(Spacer(1,8))
                    sugg = parsed.get('suggestions') or []
                    if sugg:
                        story.append(Paragraph("Suggestions:", styles['Heading3']))
                        for s in sugg:
                            story.append(Paragraph(f"• {s}", wrap_style))
                        story.append(Spacer(1,6))
                    extra = parsed.get('extra_insight') or parsed.get('additional_insight') or parsed.get('extra')
                    if extra:
                        story.append(Paragraph("Additional insight:", styles['Heading3']))
                        story.append(Paragraph(str(extra), wrap_style))
                else:
                    # Multi-table parsing with narrative preserved between tables
                    _lines = ai_text_last.split('\n')
                    idx = 0
                    total_w = getattr(doc, 'width', 7.1*inch)
                    cell_style = ParagraphStyle('AICell', parent=styles['Normal'], fontSize=7, leading=8, wordWrap='CJK')
                    header_style = ParagraphStyle('AIHeader', parent=styles['Normal'], fontSize=7, leading=8, textColor=reportlab_colors.whitesmoke, fontName='Helvetica-Bold', wordWrap='CJK')
                    wrap_style = ParagraphStyle('AIWrap', parent=styles['Normal'], wordWrap='CJK')
                    import re, unicodedata
                    def disp_width(s: str) -> int:
                        w=0
                        for ch in s:
                            ea=unicodedata.east_asian_width(ch)
                            w += 2 if ea in ('W','F') else 1
                        return w
                    def render_table(md_rows):
                        ncols = max(len(r) for r in md_rows)
                        tbl_data = []
                        for ri, r in enumerate(md_rows):
                            row_cells = []
                            for c in r:
                                txt = c.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
                                row_cells.append(Paragraph(txt, header_style if ri == 0 else cell_style))
                            while len(row_cells) < ncols:
                                row_cells.append(Paragraph('', cell_style))
                            tbl_data.append(row_cells)
                        headers = [str(h) for h in md_rows[0]]
                        headers_l = [h.lower() for h in headers]
                        base = []
                        for h in headers_l:
                            if 'description' in h:
                                base.append(7.0)
                            elif 'company' in h:
                                base.append(3.0)
                            elif 'scenario' in h:
                                base.append(2.5)
                            elif 'sector' in h:
                                base.append(2.0)
                            elif 'probab' in h or 'expected' in h:
                                base.append(1.6)
                            elif 'score' in h or '10x' in h or 'quality' in h:
                                base.append(1.4)
                            elif 'ticker' in h:
                                base.append(2.0)
                            else:
                                base.append(1.8)
                        content_w = [0]*ncols
                        is_numeric = [True]*ncols
                        num_re = re.compile(r"^[-+]?\d+[\d,\.]*%?$")
                        for r in md_rows[1:]:
                            for j in range(ncols):
                                s = str(r[j] if j < len(r) else '').strip()
                                content_w[j] = max(content_w[j], disp_width(s))
                                if s and not num_re.match(s):
                                    is_numeric[j] = False
                        weights = []
                        for j in range(ncols):
                            if is_numeric[j]:
                                weights.append(max(1.4, base[j] if j < len(base) else 1.4))
                                continue
                            if j < len(headers_l) and 'ticker' in headers_l[j]:
                                weights.append(max(2.2, base[j]))
                                continue
                            scaled = 1.0 + min(content_w[j]/20.0, 6.0)
                            weights.append(max(base[j], scaled))
                        ws = sum(weights) or (ncols*1.0)
                        col_widths = [total_w * (w/ws) for w in weights]
                        t = Table(tbl_data, colWidths=col_widths, repeatRows=1)
                        t.setStyle(TableStyle([
                            ('BACKGROUND', (0, 0), (-1, 0), reportlab_colors.Color(0.3, 0.5, 0.7)),
                            ('TEXTCOLOR', (0, 0), (-1, 0), reportlab_colors.whitesmoke),
                            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                            ('FONTSIZE', (0, 0), (-1, -1), 6),
                            ('GRID', (0, 0), (-1, -1), 0.5, reportlab_colors.grey),
                            ('BACKGROUND', (0, 1), (-1, -1), reportlab_colors.Color(0.98, 0.98, 0.98)),
                            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [reportlab_colors.Color(0.98, 0.98, 0.98), reportlab_colors.Color(0.95, 0.95, 0.95)]),
                            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                            ('WORDWRAP', (0, 0), (-1, -1), True),
                            ('LEFTPADDING', (0, 0), (-1, -1), 3),
                            ('RIGHTPADDING', (0, 0), (-1, -1), 3),
                            ('MINIMUMHEIGHT', (0, 0), (-1, -1), 15),
                        ]))
                        story.append(t)
                    def _is_table_row(s: str) -> bool:
                        t = s.strip()
                        return (t.count('|') >= 2)

                    while idx < len(_lines):
                        if _is_table_row(_lines[idx]):
                            block = []
                            while idx < len(_lines) and _is_table_row(_lines[idx]):
                                block.append(_lines[idx].strip())
                                idx += 1
                            rows = []
                            for ln in block:
                                if set(ln.replace('|','').replace('-','').replace(':','').strip()) == set():
                                    continue
                                rows.append([c.strip() for c in ln.strip('|').split('|')])
                            if len(rows) >= 2:
                                render_table(rows)
                                story.append(Spacer(1,6))
                        else:
                            start = idx
                            while idx < len(_lines) and not (_lines[idx].strip().startswith('|') and '|' in _lines[idx]):
                                idx += 1
                            text = '\n'.join(_lines[start:idx]).strip()
                            if text:
                                story.append(Paragraph(text.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;').replace('\n','<br/>'), wrap_style))
                                story.append(Spacer(1,6))
        except Exception:
            pass

        # Update progress
        progress_bar.progress(90)
        status_text.text("💾 Finalizing PDF...")
        
        # Build PDF
        doc.build(story)
        
        # Get PDF data
        pdf_data = buffer.getvalue()
        buffer.close()
        
        # Update progress
        progress_bar.progress(100)
        status_text.text("✅ PDF generated successfully!")
        
        # Store PDF data in session state for download button
        st.session_state['pdf_buffer'] = pdf_data
        
        return True
        
    except Exception as e:
        st.error(f"Error generating PDF: {e}")
        return False

# -----------------------
# MA Filter Functions - COPIED FROM PAGE 1
# -----------------------
def calculate_ema(df, window):
    """
    Calculate Exponential Moving Average for a given window.
    
    Args:
        df: DataFrame with 'Close' column
        window: Number of periods for EMA calculation
        
    Returns:
        Series with EMA values
    """
    if df is None or not isinstance(df, pd.DataFrame):
        return None
    if 'Close' not in df.columns:
        return None
    # EMA uses standard formula: multiplier = 2 / (window + 1)
    return df['Close'].ewm(span=window, adjust=False, min_periods=window).mean()

def calculate_sma(df, window):
    """
    Calculate Simple Moving Average for a given window.
    
    Args:
        df: DataFrame with 'Close' column
        window: Number of periods for SMA calculation
        
    Returns:
        Series with SMA values
    """
    if df is None or not isinstance(df, pd.DataFrame):
        return None
    if 'Close' not in df.columns:
        return None
    return df['Close'].rolling(window=window, min_periods=window).mean()

def precompute_ma_columns(reindexed_data, ma_window, ma_type='SMA', ma_multiplier=1.48):
    """
    Precompute MA columns for all tickers once at the start.
    This is the key optimization - compute MA once instead of every day!
    
    Args:
        ma_multiplier: Multiplier to convert market days to calendar days (default 1.48)
                      Since data uses ffill, we need more calendar days to get market days
    """
    ma_col_name = f"MA_{ma_type}_{ma_window}"
    
    for ticker, df in reindexed_data.items():
        if df is None or not isinstance(df, pd.DataFrame) or 'Close' not in df.columns:
            continue
            
        # Only compute if column doesn't exist
        if ma_col_name not in df.columns:
            try:
                if ma_type == 'EMA':
                    df[ma_col_name] = df['Close'].ewm(span=ma_window, adjust=False, min_periods=ma_window).mean()
                else:  # SMA
                    # Apply multiplier to approximate market days from calendar days
                    adjusted_window = int(ma_window * ma_multiplier)
                    df[ma_col_name] = df['Close'].rolling(window=adjusted_window, min_periods=adjusted_window).mean()
            except Exception:
                # If MA cannot be computed, skip this ticker
                continue

def precompute_ma_crossings(reindexed_data, ma_window, ma_type='SMA', tolerance_percent=2.0, confirmation_days=3):
    """
    ULTRA OPTIMIZATION: Precompute ALL MA crossings once at the start!
    This eliminates the need to check crossings every day during backtest.
    
    Returns:
        dict: {date: {ticker: cross_info}} for all dates with confirmed crossings
    """
    ma_col_name = f"MA_{ma_type}_{ma_window}"
    crossings_data = {}
    tolerance_ratio = 1 + (tolerance_percent / 100.0)
    
    for ticker, df in reindexed_data.items():
        if df is None or ma_col_name not in df.columns:
            continue
            
        # Get price and MA series
        prices = df['Close']
        ma_values = df[ma_col_name]
        
        # Find all significant crossings
        for i in range(1, len(df)):
            if pd.isna(prices.iloc[i]) or pd.isna(ma_values.iloc[i]):
                continue
                
            current_price = prices.iloc[i]
            current_ma = ma_values.iloc[i]
            current_ratio = current_price / current_ma
            
            # Check if crossing is significant
            significant_above = current_ratio >= tolerance_ratio
            significant_below = current_ratio <= (1.0 / tolerance_ratio)
            
            if significant_above or significant_below:
                # Check confirmation
                if confirmation_days == 0:
                    # Immediate confirmation
                    date = df.index[i]
                    if date not in crossings_data:
                        crossings_data[date] = {}
                    crossings_data[date][ticker] = {
                        'type': 'above' if significant_above else 'below',
                        'price': current_price,
                        'ma': current_ma,
                        'ratio': current_ratio
                    }
                else:
                    # Check if crossing persists for confirmation_days
                    confirmed = True
                    for j in range(1, confirmation_days + 1):
                        if i - j < 0:
                            confirmed = False
                            break
                        hist_price = prices.iloc[i - j]
                        hist_ma = ma_values.iloc[i - j]
                        if pd.isna(hist_price) or pd.isna(hist_ma):
                            confirmed = False
                            break
                        hist_ratio = hist_price / hist_ma
                        if significant_above and hist_ratio < tolerance_ratio:
                            confirmed = False
                            break
                        if significant_below and hist_ratio > (1.0 / tolerance_ratio):
                            confirmed = False
                            break
                    
                    if confirmed:
                        date = df.index[i]
                        if date not in crossings_data:
                            crossings_data[date] = {}
                        crossings_data[date][ticker] = {
                            'type': 'above' if significant_above else 'below',
                            'price': current_price,
                            'ma': current_ma,
                            'ratio': current_ratio
                        }
    
    return crossings_data

def precompute_ma_filters(reindexed_data, ma_window, ma_type='SMA', ma_multiplier=1.48, stocks_config=None):
    """
    ULTRA OPTIMIZATION: Precompute ALL MA filter results for all dates!
    This eliminates the need to check MA filters every day during backtest.
    
    Returns:
        dict: {date: {ticker: is_above_ma}} for all dates and tickers
    """
    ma_col_name = f"MA_{ma_type}_{ma_window}"
    filter_results = {}
    
    # Create mappings from stocks_config
    include_in_ma = {}
    ma_reference = {}
    if stocks_config:
        for stock in stocks_config:
            ticker = stock.get('ticker')
            if ticker:
                include_in_ma[ticker] = stock.get('include_in_sma_filter', True)
                ref = stock.get('ma_reference_ticker', '').strip()
                if ref:
                    ref = resolve_ticker_alias(ref)
                ma_reference[ticker] = ref if ref else ticker
    
    # Get all unique dates from all tickers
    all_dates = set()
    for df in reindexed_data.values():
        if df is not None and isinstance(df, pd.DataFrame):
            all_dates.update(df.index)
    
    all_dates = sorted(list(all_dates))
    
    for date in all_dates:
        filter_results[date] = {}
        
        for ticker, df in reindexed_data.items():
            if df is None or not isinstance(df, pd.DataFrame) or 'Close' not in df.columns:
                filter_results[date][ticker] = True  # Include by default
                continue
            
            # Check if ticker should be included in MA filter
            is_included = include_in_ma.get(ticker, True)
            if not is_included:
                filter_results[date][ticker] = True  # Include if not in filter
                continue
            
            # Get reference ticker
            reference_ticker = ma_reference.get(ticker, ticker)
            df_ref = reindexed_data.get(reference_ticker)
            
            if df_ref is None or ma_col_name not in df_ref.columns:
                filter_results[date][ticker] = True  # Include by default
                continue
            
            # Check if we have enough data
            required_days = int(ma_window * ma_multiplier)
            df_ref_up_to_date = df_ref[df_ref.index <= date]
            if len(df_ref_up_to_date) < required_days:
                filter_results[date][ticker] = True  # Include by default
                continue
            
            try:
                # Get current price and MA
                if date in df_ref.index:
                    current_price = df_ref.loc[date, 'Close']
                    current_ma = df_ref.loc[date, ma_col_name]
                else:
                    current_price = df_ref_up_to_date['Close'].iloc[-1]
                    current_ma = df_ref_up_to_date[ma_col_name].iloc[-1]
                
                if pd.isna(current_price) or pd.isna(current_ma):
                    filter_results[date][ticker] = True  # Include by default
                else:
                    filter_results[date][ticker] = current_price >= current_ma
            except Exception:
                filter_results[date][ticker] = True  # Include by default
    
    return filter_results

def detect_ma_cross_with_anti_whipsaw(valid_assets, reindexed_data, date, ma_window, ma_type='SMA', config=None, stocks_config=None, tolerance_percent=2.0, confirmation_days=3):
    """
    Detect if any ticker has crossed its Moving Average with anti-whipsaw filtering.
    
    Args:
        valid_assets: List of tickers to check
        reindexed_data: Dict of ticker -> DataFrame
        date: Current date for checking
        ma_window: MA window in days (e.g., 200 for 200-day MA)
        ma_type: Type of moving average - 'SMA' or 'EMA'
        config: Optional config dict
        stocks_config: List of stock configs with include_in_ma_filter and ma_reference_ticker options
        tolerance_percent: Percentage band that price must exceed MA by (default 2.0%)
        confirmation_days: Number of days the crossing must persist (default 3)
        
    Returns:
        crossed_assets: List of tickers that crossed their MA with confirmation
        cross_details: Dict of ticker -> cross information
    """
    if not valid_assets or ma_window <= 0:
        return [], {}
    
    crossed_assets = []
    cross_details = {}
    
    # Create mappings from stocks_config
    include_in_ma = {}
    ma_reference = {}
    if stocks_config:
        for stock in stocks_config:
            ticker = stock.get('ticker')
            if ticker:
                include_in_ma[ticker] = stock.get('include_in_sma_filter', True)
                ref = stock.get('ma_reference_ticker', '').strip()
                if ref:
                    ref = resolve_ticker_alias(ref)
                ma_reference[ticker] = ref if ref else ticker
    
    for ticker in valid_assets:
        is_included = include_in_ma.get(ticker, True)
        if not is_included:
            continue
            
        reference_ticker = ma_reference.get(ticker, ticker)
        
        # Get reference ticker's data for MA calculation
        df_ref = reindexed_data.get(reference_ticker)
        if df_ref is None or not isinstance(df_ref, pd.DataFrame):
            continue
        
        # Get data up to current date
        df_ref_up_to_date = df_ref[df_ref.index <= date]
        
        # Need enough data for MA calculation + confirmation period
        min_required_days = ma_window + max(confirmation_days, 1)  # At least 1 day for MA calculation
        if len(df_ref_up_to_date) < min_required_days:
            continue
        
        # Calculate MA on the REFERENCE ticker
        if ma_type == 'EMA':
            ma = calculate_ema(df_ref_up_to_date, ma_window)
        else:  # Default to SMA
            ma = calculate_sma(df_ref_up_to_date, ma_window)
            
        if ma is None or len(ma) < confirmation_days + 1:
            continue
        
        try:
            # Get current price and MA
            current_price = df_ref_up_to_date['Close'].iloc[-1]
            current_ma = ma.iloc[-1]
            
            if pd.isna(current_price) or pd.isna(current_ma):
                continue
            
            # Check if price exceeds MA by tolerance percentage
            price_ma_ratio = current_price / current_ma
            tolerance_ratio = 1 + (tolerance_percent / 100.0)
            
            # Check if crossing is significant enough (above tolerance band)
            significant_above = price_ma_ratio >= tolerance_ratio
            significant_below = price_ma_ratio <= (1.0 / tolerance_ratio)
            
            if significant_above or significant_below:
                # Check if this crossing has persisted for confirmation_days
                crossing_confirmed = True
                cross_direction = "above" if significant_above else "below"
                
                # If confirmation_days = 0, no confirmation needed (immediate)
                if confirmation_days == 0:
                    crossing_confirmed = True
                else:
                    # Look back confirmation_days to see if crossing has been consistent
                    for i in range(1, confirmation_days + 1):
                        if len(df_ref_up_to_date) <= i or len(ma) <= i:
                            crossing_confirmed = False
                            break
                        
                        # Get historical data
                        hist_price = df_ref_up_to_date['Close'].iloc[-(i+1)]
                        hist_ma = ma.iloc[-(i+1)]
                        
                        if pd.isna(hist_price) or pd.isna(hist_ma):
                            crossing_confirmed = False
                            break
                        
                        # Check if historical crossing was in same direction
                        hist_ratio = hist_price / hist_ma
                        if cross_direction == "above":
                            if hist_ratio < tolerance_ratio:
                                crossing_confirmed = False
                                break
                        else:  # below
                            if hist_ratio > (1.0 / tolerance_ratio):
                                crossing_confirmed = False
                                break
                
                if crossing_confirmed:
                    crossed_assets.append(ticker)
                    cross_details[ticker] = {
                        'type': cross_direction,
                        'current_price': current_price,
                        'current_ma': current_ma,
                        'price_ma_ratio': price_ma_ratio,
                        'tolerance_ratio': tolerance_ratio,
                        'confirmation_days': confirmation_days,
                        'reference_ticker': reference_ticker
                    }
                
        except Exception as e:
            continue
    
    return crossed_assets, cross_details

def filter_assets_by_ma(valid_assets, reindexed_data, date, ma_window, ma_type='SMA', config=None, stocks_config=None):
    """
    Filter out assets that are below their Moving Average (SMA or EMA).
    Now supports using a different ticker's MA as reference!
    
    Args:
        valid_assets: List of tickers to filter
        reindexed_data: Dict of ticker -> DataFrame
        date: Current date for filtering
        ma_window: MA window in days (e.g., 200 for 200-day MA)
        ma_type: Type of moving average - 'SMA' or 'EMA'
        config: Optional config dict
        stocks_config: Optional stocks config for include_in_sma_filter and ma_reference_ticker settings
        
    Returns:
        filtered_assets: List of tickers above their MA
        excluded_assets: Dict of excluded tickers with reasons
    """
    filtered_assets = []
    excluded_assets = {}
    tickers_with_enough_data = []
    
    # Create mappings from stocks_config
    include_in_ma = {}
    ma_reference = {}
    if stocks_config:
        for stock in stocks_config:
            ticker = stock.get('ticker')
            if ticker:
                include_in_ma[ticker] = stock.get('include_in_sma_filter', True)
                # Get MA reference ticker (empty or None means use ticker itself)
                ref = stock.get('ma_reference_ticker', '').strip()
                # Apply same transformations as regular tickers for consistency
                if ref:
                    ref = ref.replace(",", ".").upper()
                    # Special conversion for Berkshire Hathaway
                    if ref == 'BRK.B':
                        ref = 'BRK-B'
                    elif ref == 'BRK.A':
                        ref = 'BRK-A'
                    # Resolve alias (e.g., TLTTR -> TLT_COMPLETE, GOLDX -> GOLD_COMPLETE)
                    ref = resolve_ticker_alias(ref)
                ma_reference[ticker] = ref if ref else ticker
    
    for ticker in valid_assets:
        is_included = include_in_ma.get(ticker, True)
        # Check if this ticker should be excluded from MA filter (not included)
        if not is_included:
            filtered_assets.append(ticker)
            continue
            
        # Get MA reference ticker (default to self)
        reference_ticker = ma_reference.get(ticker, ticker)
        
        # Get ticker's price data
        df = reindexed_data.get(ticker)
        if df is None or not isinstance(df, pd.DataFrame):
            continue
        
        # Get reference ticker's data for MA calculation
        df_ref = reindexed_data.get(reference_ticker)
        if df_ref is None or not isinstance(df_ref, pd.DataFrame):
            # Reference ticker not available, fallback to using ticker itself
            df_ref = df
            reference_ticker = ticker
        
        # Get data up to current date
        df_up_to_date = df[df.index <= date]
        df_ref_up_to_date = df_ref[df_ref.index <= date]
        
        if len(df_ref_up_to_date) < ma_window:
            # Not enough data to calculate MA on reference, include by default (no filter)
            filtered_assets.append(ticker)
            continue
        
        # Mark that this ticker has enough data for MA calculation
        tickers_with_enough_data.append(ticker)
        
        # Calculate MA on the REFERENCE ticker
        if ma_type == 'EMA':
            ma = calculate_ema(df_ref_up_to_date, ma_window)
        else:  # Default to SMA
            ma = calculate_sma(df_ref_up_to_date, ma_window)
            
        if ma is None:
            filtered_assets.append(ticker)
            continue
        
        try:
            # Get current price of REFERENCE TICKER and MA value of REFERENCE
            # CRITICAL: Use reference ticker's price, not the ticker itself!
            # Compare: reference price vs reference MA (same price scale)
            if len(df_ref_up_to_date) == 0:
                filtered_assets.append(ticker)
                continue
            current_price = df_ref_up_to_date['Close'].iloc[-1]
            current_ma = ma.iloc[-1] if hasattr(ma, 'iloc') else ma.loc[date]
            
            # Include only if REFERENCE ticker's price is above REFERENCE ticker's MA
            if current_price >= current_ma:
                filtered_assets.append(ticker)
            else:
                ref_label = f" (using {reference_ticker})" if reference_ticker != ticker else ""
                excluded_assets[ticker] = f"Below {ma_window}-day {ma_type}{ref_label} ({current_price:.2f} < {current_ma:.2f})"
        except:
            # If any error, include by default
            filtered_assets.append(ticker)
    
    # SIMPLE LOGIC: Return whatever assets are still active (above MA or excluded from filter)
    # NO "go to cash" logic - that's handled in the rebalancing
    return filtered_assets, excluded_assets

# -----------------------
# Single-backtest core (adapted from your code, robust)
# -----------------------

def parse_bool_from_json(value, default=False):
    """Normalize JSON boolean-like values into real Python booleans."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        cleaned = value.strip().lower()
        if cleaned in {"true", "1", "yes", "y", "on"}:
            return True
        if cleaned in {"false", "0", "no", "n", "off"}:
            return False
        return default
    if isinstance(value, (int, float)):
        return value != 0
    return default


def normalize_momentum_windows_discard_flags(momentum_windows):
    """Ensure discard flags are real bools on each window (JSON import / legacy configs)."""
    if not isinstance(momentum_windows, list):
        return
    for window in momentum_windows:
        if isinstance(window, dict):
            window['discard_if_negative'] = parse_bool_from_json(window.get('discard_if_negative', False), False)
            window['discard_unless_recent_positive'] = parse_bool_from_json(
                window.get('discard_unless_recent_positive', False), False
            )


def _momentum_return_between(df_t, start_ts, end_ts, include_div=False):
    """Total return between start_ts and end_ts (rebalance date), or None if not computable."""
    if not isinstance(df_t, pd.DataFrame) or "Close" not in df_t.columns:
        return None
    try:
        price_start_index = df_t.index.asof(start_ts)
        price_end_index = df_t.index.asof(end_ts)
    except Exception:
        return None
    if pd.isna(price_start_index) or pd.isna(price_end_index):
        return None
    price_start = df_t.loc[price_start_index, "Close"]
    price_end = df_t.loc[price_end_index, "Close"]
    if pd.isna(price_start) or pd.isna(price_end) or price_start == 0:
        return None
    if include_div and "Dividends" in df_t.columns:
        divs_in_period = df_t.loc[price_start_index:price_end_index, "Dividends"].fillna(0).sum()
        return ((price_end + divs_in_period) - price_start) / price_start
    return (price_end - price_start) / price_start


def _momentum_window_discards_negative(window, window_return, recent_return=None):
    """Exclude asset when discard_if_negative is set and this window's return is below zero."""
    if not isinstance(window, dict):
        return False
    discard_enabled = parse_bool_from_json(window.get("discard_if_negative", False), False)
    if not discard_enabled or window_return >= 0:
        return False
    unless_recent = parse_bool_from_json(window.get("discard_unless_recent_positive", False), False)
    if unless_recent and recent_return is not None and recent_return > 0:
        return False
    return True


def single_backtest(config, sim_index, reindexed_data):
    
    # ULTRA OPTIMIZATION: Precompute MA data if needed
    attach_mcap_close_lookup(config, reindexed_data)
    ma_crossings_data = None
    ma_filter_data = None
    if config.get('use_sma_filter', False) or config.get('ma_cross_rebalance', False):
        ma_window = config.get('sma_window', 200)
        ma_type = config.get('ma_type', 'SMA')
        ma_multiplier = config.get('ma_multiplier', 1.48)  # Default multiplier for market days
        precompute_ma_columns(reindexed_data, ma_window, ma_type, ma_multiplier)
        
        # ULTRA OPTIMIZATION: Precompute ALL MA filters if MA filter is enabled
        if config.get('use_sma_filter', False):
            ma_filter_data = precompute_ma_filters(reindexed_data, ma_window, ma_type, ma_multiplier, config.get('stocks', []))
        
        # ULTRA OPTIMIZATION: Precompute ALL MA crossings if MA cross rebalancing is enabled
        if config.get('ma_cross_rebalance', False):
            tolerance_percent = config.get('ma_tolerance_percent', 2.0)
            confirmation_days = config.get('ma_confirmation_days', 3)
            ma_crossings_data = precompute_ma_crossings(reindexed_data, ma_window, ma_type, tolerance_percent, confirmation_days)
    
    stocks_list = config.get('stocks', [])
    raw_tickers = [s.get('ticker') for s in stocks_list if s.get('ticker')]
    # Filter out tickers not present in reindexed_data to avoid crashes for invalid tickers
    if reindexed_data:
        tickers = [t for t in raw_tickers if t in reindexed_data]
    else:
        tickers = raw_tickers[:]
    missing_tickers = [t for t in raw_tickers if t not in tickers]
    if missing_tickers:
        # Log a warning and ignore unknown tickers
        print(f"[ALLOC WARN] Ignoring unknown or missing tickers: {missing_tickers}")
    # Handle duplicate tickers by summing their allocations
    allocations = {}
    include_dividends = {}
    for s in stocks_list:
        if s.get('ticker') and s.get('ticker') in tickers:
            ticker = s.get('ticker')
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
    
    # Apply threshold filters to initial allocations for non-momentum strategies
    use_momentum = config.get('use_momentum', True)
    
    if not use_momentum and allocations:
        # Apply MA / S&P 500 entry filters first (for non-momentum strategies)
        if config.get('use_sma_filter', False) or _universe_filters_active(config):
            ma_window = config.get('sma_window', 200)
            ma_type = config.get('ma_type', 'SMA')
            # Get list of current tickers (excluding CASH)
            current_tickers = [t for t in tickers if t != 'CASH']
            filtered_tickers = list(current_tickers)
            excluded_assets = {}
            
            # Use the simulation start date for MA filtering (ULTRA OPTIMIZED!)
            if config.get('use_sma_filter', False):
                if ma_filter_data is not None:
                    # ULTRA FAST: Use precomputed filter results!
                    filtered_tickers = [t for t in filtered_tickers if ma_filter_data.get(sim_index[0], {}).get(t, True)]
                else:
                    # Fallback to original method if not precomputed
                    filtered_tickers, excluded_assets = filter_assets_by_ma(current_tickers, reindexed_data, sim_index[0], ma_window, ma_type, config, config.get('stocks', []))
            filtered_tickers = filter_tickers_by_sp500_entry(filtered_tickers, sim_index[0], config)
            excluded_assets = {t: "Excluded by filter" for t in current_tickers if t not in filtered_tickers}
            
            # Redistribute allocations of excluded tickers proportionally among remaining tickers - EXACTLY LIKE PAGE 1
            if excluded_assets:
                excluded_ticker_list = list(excluded_assets.keys())
                
                # Calculate total allocation of excluded tickers
                excluded_allocation = sum(allocations.get(t, 0) for t in excluded_ticker_list)
                
                # Remove excluded tickers from current allocations
                for excluded_ticker in excluded_ticker_list:
                    if excluded_ticker in allocations:
                        del allocations[excluded_ticker]
                
                # If there are remaining tickers (excluding CASH), redistribute proportionally - EXACTLY LIKE PAGE 1
                remaining_tickers = [t for t in allocations.keys() if t != 'CASH']
                if remaining_tickers:
                    # Calculate total allocation of remaining tickers (excluding CASH)
                    remaining_allocation = sum(allocations.get(t, 0) for t in remaining_tickers)
                    
                    if remaining_allocation > 0:
                        # Redistribute excluded allocation proportionally
                        for ticker in remaining_tickers:
                            proportion = allocations[ticker] / remaining_allocation
                            allocations[ticker] += excluded_allocation * proportion
                    else:
                        # Equal distribution if no remaining allocation
                        equal_allocation = excluded_allocation / len(remaining_tickers)
                        for ticker in remaining_tickers:
                            allocations[ticker] = equal_allocation
                else:
                    # No remaining tickers, all goes to CASH
                    allocations = {'CASH': 1.0}
            
        
        use_max_allocation = config.get('use_max_allocation', False)
        max_allocation_percent = config.get('max_allocation_percent', 10.0)
        use_threshold = config.get('use_minimal_threshold', False)
        threshold_percent = config.get('minimal_threshold_percent', 2.0)
        
        # Build dictionary of individual ticker caps from stock configs
        individual_caps = {}
        for stock in config.get('stocks', []):
            ticker = stock.get('ticker', '')
            individual_cap = stock.get('max_allocation_percent', None)
            if individual_cap is not None and individual_cap > 0:
                individual_caps[ticker] = individual_cap / 100.0
        
        # Debug output
        
        # Apply allocation filters in correct order: Max Allocation -> Min Threshold -> Max Allocation (two-pass system)
        if (use_max_allocation or individual_caps):
            max_allocation_decimal = max_allocation_percent / 100.0
            
            # FIRST PASS: Apply maximum allocation filter (EXCLUDE CASH from max_allocation limit)
            capped_allocations = {}
            excess_allocation = 0.0
            
            for ticker, allocation in allocations.items():
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
                        capped_allocations[ticker] = allocation
            
            # Redistribute excess allocation proportionally to stocks below the cap
            if excess_allocation > 0:
                # Find stocks below the cap (include CASH as eligible for redistribution)
                below_cap_stocks = {}
                for ticker, allocation in capped_allocations.items():
                    if ticker == 'CASH':
                        below_cap_stocks[ticker] = allocation
                    else:
                        ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                        if allocation < ticker_cap:
                            below_cap_stocks[ticker] = allocation
                
                if below_cap_stocks:
                    total_below_cap = sum(below_cap_stocks.values())
                    if total_below_cap > 0:
                        # Redistribute excess proportionally
                        for ticker in below_cap_stocks:
                            proportion = below_cap_stocks[ticker] / total_below_cap
                            new_allocation = capped_allocations[ticker] + (excess_allocation * proportion)
                            # CASH can receive unlimited allocation, other stocks are capped
                            if ticker == 'CASH':
                                capped_allocations[ticker] = new_allocation
                            else:
                                ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                capped_allocations[ticker] = min(new_allocation, ticker_cap)
            
            allocations = capped_allocations
        
        # Apply minimal threshold filter
        if use_threshold:
            threshold_decimal = threshold_percent / 100.0
            
            # First: Filter out stocks below threshold
            filtered_allocations = {}
            for ticker, allocation in allocations.items():
                if allocation >= threshold_decimal:
                    # Keep stocks above or equal to threshold
                    filtered_allocations[ticker] = allocation
            
            # Then: Normalize remaining stocks to sum to 1
            if filtered_allocations:
                total_allocation = sum(filtered_allocations.values())
                if total_allocation > 0:
                    allocations = {ticker: allocation / total_allocation for ticker, allocation in filtered_allocations.items()}
                else:
                    allocations = {}
            else:
                # If no stocks meet threshold, keep original allocations
                pass  # allocations remain unchanged
        
        # SECOND PASS: Apply maximum allocation filter again (in case normalization created new excess)
        # Run if global cap is enabled OR any individual caps exist (parity with Page 1)
        if (use_max_allocation or individual_caps):
            max_allocation_decimal = max_allocation_percent / 100.0
            
            # Check if any stocks exceed the cap after threshold filtering and normalization (EXCLUDE CASH)
            capped_allocations = {}
            excess_allocation = 0.0
            
            for ticker, allocation in allocations.items():
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
                        capped_allocations[ticker] = allocation
            
            # Redistribute excess allocation proportionally to stocks below the cap
            if excess_allocation > 0:
                # Find stocks below the cap (include CASH as eligible for redistribution)
                below_cap_stocks = {}
                for ticker, allocation in capped_allocations.items():
                    if ticker == 'CASH':
                        below_cap_stocks[ticker] = allocation
                    else:
                        ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                        if allocation < ticker_cap:
                            below_cap_stocks[ticker] = allocation
                
                if below_cap_stocks:
                    total_below_cap = sum(below_cap_stocks.values())
                    if total_below_cap > 0:
                        # Redistribute excess proportionally
                        for ticker in below_cap_stocks:
                            proportion = below_cap_stocks[ticker] / total_below_cap
                            new_allocation = capped_allocations[ticker] + (excess_allocation * proportion)
                            # CASH can receive unlimited allocation, other stocks are capped
                            if ticker == 'CASH':
                                capped_allocations[ticker] = new_allocation
                            else:
                                ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                capped_allocations[ticker] = min(new_allocation, ticker_cap)
            
            allocations = capped_allocations
            
            # Final normalization to 100% in case not enough stocks to distribute excess
            total_alloc = sum(allocations.values())
            if total_alloc > 0:
                allocations = {ticker: allocation / total_alloc for ticker, allocation in allocations.items()}
        
        # Update tickers list to only include tickers with non-zero allocations
        tickers = [ticker for ticker, allocation in allocations.items() if allocation > 0]
        
        # Debug output after filtering
    
    benchmark_ticker = config.get('benchmark_ticker')
    initial_value = config.get('initial_value', 0)
    # Allocation tracker: ignore added cash for this mode. Use initial_value as current portfolio value.
    added_amount = 0
    added_frequency = 'none'
    # Map frequency to ensure compatibility with get_dates_by_freq
    raw_rebalancing_frequency = config.get('rebalancing_frequency', 'none')
    def map_frequency_for_backtest(freq):
        if freq is None:
            return 'Never'
        freq_map = {
            'Never': 'Never',
            'Weekly': 'Weekly',
            'Biweekly': 'Biweekly',
            'Monthly': 'Monthly',
            'Quarterly': 'Quarterly',
            'Semiannually': 'Semiannually',
            'Annually': 'Annually',
            # Legacy format mapping
            'none': 'Never',
            'week': 'Weekly',
            '2weeks': 'Biweekly',
            'month': 'Monthly',
            '3months': 'Quarterly',
            '6months': 'Semiannually',
            'year': 'Annually'
        }
        return freq_map.get(freq, 'Monthly')
    
    rebalancing_frequency = map_frequency_for_backtest(raw_rebalancing_frequency)
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
    # Respect start_with setting: 'oldest' (default) or 'all' (wait for all assets)
    start_with = config.get('start_with', 'oldest')
    # Precompute first-valid dates for each ticker to decide availability
    start_dates_config = {}
    for t in tickers:
        if t in reindexed_data and isinstance(reindexed_data.get(t), pd.DataFrame):
            fd = reindexed_data[t].first_valid_index()
            start_dates_config[t] = fd if fd is not None else pd.NaT
        else:
            start_dates_config[t] = pd.NaT
    dates_added = set()
    dates_rebal = sorted(get_dates_by_freq(rebalancing_frequency, sim_index[0], sim_index[-1], sim_index))
    
    # OPTIMIZATION: Precompute MA columns once at the start if MA filter is enabled
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
            ma_filter_data = precompute_ma_filters(reindexed_data, ma_window, ma_type, ma_multiplier, config.get('stocks', []))
        
        # ULTRA OPTIMIZATION: Precompute ALL MA crossings if MA cross rebalancing is enabled
        if config.get('ma_cross_rebalance', False):
            tolerance_percent = config.get('ma_tolerance_percent', 2.0)
            confirmation_days = config.get('ma_confirmation_days', 3)
            ma_crossings_data = precompute_ma_crossings(reindexed_data, ma_window, ma_type, tolerance_percent, confirmation_days)

    # Dictionaries to store historical data for new tables
    historical_allocations = {}
    historical_metrics = {}

    def calculate_momentum(date, current_assets, momentum_windows, stocks_config=None):
        cumulative_returns, valid_assets = {}, []
        
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
        
        filtered_windows = [w for w in momentum_windows if w.get("weight", 0) > 0]
        # Normalize weights so they sum to 1 (same as app.py)
        total_weight = sum(w.get("weight", 0) for w in filtered_windows)
        if total_weight == 0:
            normalized_weights = [0 for _ in filtered_windows]
        else:
            normalized_weights = [w.get("weight", 0) / total_weight for w in filtered_windows]
        # Only consider assets that exist in current_data (filtered earlier)
        candidate_assets = [t for t in assets_to_calculate if t in current_data]
        for t in candidate_assets:
            is_valid, asset_returns = True, 0.0
            df_t = current_data.get(t)
            if not (isinstance(df_t, pd.DataFrame) and 'Close' in df_t.columns and not df_t['Close'].dropna().empty):
                # no usable data for this ticker
                continue
            for idx, window in enumerate(filtered_windows):
                lookback, exclude = window.get("lookback", 0), window.get("exclude", 0)
                weight = normalized_weights[idx]
                start_mom = date - pd.Timedelta(days=lookback)
                end_mom = date - pd.Timedelta(days=exclude)
                sd = start_dates_config.get(t, pd.NaT)
                # If no start date or asset starts after required lookback, mark invalid
                if pd.isna(sd) or sd > start_mom:
                    is_valid = False
                    break
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
            if is_valid:
                cumulative_returns[t] = asset_returns
                valid_assets.append(t)
        return cumulative_returns, valid_assets

    def calculate_momentum_weights(returns, valid_assets, date, momentum_strategy='Classic', negative_momentum_strategy='Cash'):
        if not valid_assets: return {}, {}
        rets = {t: returns[t] for t in valid_assets if not pd.isna(returns[t])}
        if not rets: return {}, {}
        beta_vals, vol_vals = {}, {}
        metrics = {t: {} for t in tickers}
        if calc_beta or calc_volatility:
            df_bench = current_data.get(benchmark_ticker)
            if calc_beta:
                start_beta = date - pd.Timedelta(days=beta_window_days)
                end_beta = date - pd.Timedelta(days=exclude_days_beta)
            if calc_volatility:
                start_vol = date - pd.Timedelta(days=vol_window_days)
                end_vol = date - pd.Timedelta(days=exclude_days_vol)
            for t in valid_assets:
                df_t = current_data[t]
                if calc_beta and df_bench is not None:
                    mask_beta = (df_t.index >= start_beta) & (df_t.index <= end_beta)
                    returns_t_beta = df_t.loc[mask_beta, "Price_change"]
                    mask_bench_beta = (df_bench.index >= start_beta) & (df_bench.index <= end_beta)
                    returns_bench_beta = df_bench.loc[mask_bench_beta, "Price_change"]
                    if len(returns_t_beta) < 2 or len(returns_bench_beta) < 2:
                        beta_vals[t] = np.nan
                    else:
                        covariance = np.cov(returns_t_beta, returns_bench_beta)[0,1]
                        variance = np.var(returns_bench_beta)
                        beta_vals[t] = covariance/variance if variance>0 else np.nan
                    metrics[t]['Beta'] = beta_vals[t]
                if calc_volatility:
                    mask_vol = (df_t.index >= start_vol) & (df_t.index <= end_vol)
                    returns_t_vol = df_t.loc[mask_vol, "Price_change"]
                    if len(returns_t_vol) < 2:
                        vol_vals[t] = np.nan
                    else:
                        vol_vals[t] = returns_t_vol.std() * np.sqrt(365.25)
                    metrics[t]['Volatility'] = vol_vals[t]
        
        for t in rets:
            metrics[t]['Momentum'] = rets[t]

        # Compute initial weights from raw momentum scores (relative/classic) then apply
        # post-filtering by inverse volatility and inverse absolute beta (app.py approach).
        weights = {}
        # raw momentum values
        rets_keys = list(rets.keys())
        all_negative = all(r <= 0 for r in rets.values())
        
        # Calculate effective strategy for negative momentum (needed for equal weight logic)
        effective_strategy_for_equal_weight = None
        if all_negative:
            # Check if this is a special dynamic ticker (SP500TOP20, etc.)
            is_special = any(t in ['SP500TOP20', 'ZROX'] for t in rets_keys) or config.get('dynamic_portfolio_data') is not None
            effective_strategy_for_equal_weight = negative_momentum_strategy
            if is_special and negative_momentum_strategy == 'Cash':
                effective_strategy_for_equal_weight = 'Relative momentum'

        # Helper: detect relative mode from momentum_strategy string
        relative_mode = isinstance(momentum_strategy, str) and momentum_strategy.lower().startswith('relat')

        def calculate_near_zero_symmetric_momentum(returns, neutral_zone=0.05):
            """
            Relative momentum with neutral zone around 0 - IMPROVED VERSION
            
            Advantages:
            - Returns in [-5%, +5%] have very similar allocations
            - No bias from worst asset
            - Progressive compression of negative assets
            - Independent treatment of each ticker
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
                
                # Neutral zone: similar allocations for returns close to 0
                if abs(return_val) <= neutral_zone:
                    # In neutral zone: almost identical allocations
                    compression_factor = 1.0 - (abs(return_val) / neutral_zone) * 0.1
                else:
                    # Beyond neutral zone: progressive compression
                    if return_val < -neutral_zone:
                        # Negative beyond neutral zone
                        excess_negativity = abs(return_val) - neutral_zone
                        compression_factor = 0.9 * math.exp(-excess_negativity * 3.0)
                    else:
                        # Positive beyond neutral zone
                        compression_factor = 1.0
                
                compressed_scores[ticker] = shifted_val * compression_factor
            
            # Normalize
            sum_scores = sum(compressed_scores.values())
            weights = {t: compressed_scores[t] / sum_scores for t in compressed_scores}
            
            return weights

        if all_negative:
            if negative_momentum_strategy == 'Cash':
                weights = {t: 0 for t in rets_keys}
            elif negative_momentum_strategy == 'Equal weight':
                weights = {t: 1 / len(rets_keys) for t in rets_keys}
            elif negative_momentum_strategy == 'Relative momentum':
                # ANCIENNE LOGIQUE Relative Momentum
                min_score = min(rets.values())
                offset = -min_score + 0.01
                shifted = {t: max(0.01, rets[t] + offset) for t in rets_keys}
                ssum = sum(shifted.values())
                weights = {t: shifted[t] / ssum for t in shifted}
            elif negative_momentum_strategy == 'Near-Zero Symmetry':
                # NOUVELLE LOGIQUE Near-Zero Symmetry
                weights = calculate_near_zero_symmetric_momentum(rets)
        else:
            if relative_mode:
                if momentum_strategy == 'Relative Momentum':
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
                # Check user's selection for momentum strategy
                if momentum_strategy == 'Classic':
                    positive_scores = {t: s for t, s in rets.items() if s > 0}
                    if positive_scores:
                        sum_positive = sum(positive_scores.values())
                        weights = {t: positive_scores[t] / sum_positive for t in positive_scores}
                        for t in [t for t in rets_keys if rets.get(t, 0) <= 0]:
                            weights[t] = 0
                    else:
                        weights = {t: 0 for t in rets_keys}
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
                    positive_scores = {t: s for t, s in rets.items() if s > 0}
                    if positive_scores:
                        sum_positive = sum(positive_scores.values())
                        weights = {t: positive_scores[t] / sum_positive for t in positive_scores}
                        for t in [t for t in rets_keys if rets.get(t, 0) <= 0]:
                            weights[t] = 0
                    else:
                        weights = {t: 0 for t in rets_keys}

        # Apply post-filtering using inverse volatility and inverse absolute beta (like app.py)
        fallback_mode = all_negative and negative_momentum_strategy == 'Equal weight'
        if weights and (calc_volatility or calc_beta) and not fallback_mode:
            filtered_weights = {}
            for t, w in weights.items():
                if w > 0:
                    score = 1.0
                    if calc_volatility:
                        v = vol_vals.get(t, np.nan)
                        if not pd.isna(v) and v > 0:
                            score *= (1.0 / v)
                        else:
                            score *= 0
                    if calc_beta:
                        b = beta_vals.get(t, np.nan)
                        if not pd.isna(b):
                            abs_beta = abs(b)
                            if abs_beta > 0:
                                score *= (1.0 / abs_beta)
                            else:
                                score *= 1.0
                    filtered_weights[t] = w * score
            total_filtered = sum(filtered_weights.values())
            if total_filtered > 0:
                weights = {t: v / total_filtered for t, v in filtered_weights.items()}
            else:
                weights = {}

        # Apply allocation filters in correct order: Max Allocation -> Min Threshold -> Max Allocation (two-pass system)
        use_max_allocation = config.get('use_max_allocation', False)
        max_allocation_percent = config.get('max_allocation_percent', 10.0)
        use_threshold = config.get('use_minimal_threshold', False)
        threshold_percent = config.get('minimal_threshold_percent', 2.0)
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
            
            # FIRST PASS: Apply maximum allocation filter
            capped_weights = {}
            excess_weight = 0.0
            
            for ticker, weight in weights.items():
                # CASH is exempt from max_allocation limit
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
                # CASH is exempt from max_allocation limit
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

        # STEP 1: Apply Limit to Top N filter FIRST (keeps proportional weights)
        use_limit_to_top_n = config.get('use_limit_to_top_n', False)
        limit_to_top_n_tickers = config.get('limit_to_top_n_tickers', 10)
        should_apply_limit_to_top_n = False
        if use_limit_to_top_n and limit_to_top_n_tickers > 0 and weights:
            if all_negative:
                if effective_strategy_for_equal_weight in ['Relative momentum', 'Near-Zero Symmetry']:
                    should_apply_limit_to_top_n = True
            else:
                should_apply_limit_to_top_n = True
        if should_apply_limit_to_top_n:
            ticker_weights = [(ticker, weight) for ticker, weight in weights.items() if ticker != 'CASH' and weight > 0]
            ticker_weights.sort(key=lambda x: x[1], reverse=True)
            if ticker_weights:
                n_to_select = min(limit_to_top_n_tickers, len(ticker_weights))
                ranked_tickers = [ticker for ticker, _ in ticker_weights]
                sector_industry_map = st.session_state.get('alloc_sector_industry_map', {})
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
                new_weights = {}
                total_top_n_weight = 0.0
                for ticker in weights.keys():
                    if ticker == 'CASH':
                        new_weights[ticker] = weights.get(ticker, 0.0)
                    elif ticker in top_n_tickers:
                        new_weights[ticker] = weights.get(ticker, 0.0)
                        total_top_n_weight += weights.get(ticker, 0.0)
                    else:
                        new_weights[ticker] = 0.0
                cash_weight = new_weights.get('CASH', 0.0)
                if cash_weight > 0 and total_top_n_weight > 0:
                    for ticker in top_n_tickers:
                        ticker_weight = new_weights[ticker]
                        proportion = ticker_weight / total_top_n_weight if total_top_n_weight > 0 else 0.0
                        new_weights[ticker] += cash_weight * proportion
                    new_weights['CASH'] = 0.0
                total_weight = sum(new_weights.values())
                if total_weight > 0:
                    weights = {ticker: weight / total_weight for ticker, weight in new_weights.items()}
                else:
                    weights = new_weights

        # STEP 2: Apply Equal Weight filter AFTER Limit to Top N (equalize selected tickers)
        use_equal_weight = config.get('use_equal_weight', False)
        equal_weight_n_tickers = config.get('equal_weight_n_tickers', 10)
        should_apply_equal_weight = False
        if use_equal_weight and equal_weight_n_tickers > 0 and weights:
            if all_negative:
                if effective_strategy_for_equal_weight in ['Relative momentum', 'Near-Zero Symmetry']:
                    should_apply_equal_weight = True
            else:
                should_apply_equal_weight = True
        if should_apply_equal_weight:
            ticker_weights = [(ticker, weight) for ticker, weight in weights.items() if ticker != 'CASH' and weight > 0]
            if ticker_weights:
                if should_apply_limit_to_top_n:
                    top_n_tickers = [ticker for ticker, _ in ticker_weights]
                else:
                    ticker_weights.sort(key=lambda x: x[1], reverse=True)
                    n_to_select = min(equal_weight_n_tickers, len(ticker_weights))
                    ranked_tickers = [ticker for ticker, _ in ticker_weights]
                    sector_industry_map = st.session_state.get('alloc_sector_industry_map', {})
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
                equal_weight_per_ticker = 1.0 / len(top_n_tickers)
                new_weights = {}
                for ticker in weights.keys():
                    if ticker == 'CASH':
                        new_weights[ticker] = weights.get(ticker, 0.0)
                    elif ticker in top_n_tickers:
                        new_weights[ticker] = equal_weight_per_ticker
                    else:
                        new_weights[ticker] = 0.0
                cash_weight = new_weights.get('CASH', 0.0)
                if cash_weight > 0:
                    for ticker in top_n_tickers:
                        new_weights[ticker] += cash_weight / len(top_n_tickers)
                    new_weights['CASH'] = 0.0
                total_weight = sum(new_weights.values())
                if total_weight > 0:
                    weights = {ticker: weight / total_weight for ticker, weight in new_weights.items()}
                else:
                    weights = new_weights

        # STEP 3: Sector/industry caps without Top N / Equal Weight — exclude only (no fill)
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
                    sector_industry_map=st.session_state.get('alloc_sector_industry_map', {}),
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
        for t in weights:
            metrics[t]['Calculated_Weight'] = weights.get(t, 0)

        # Debug: print metrics summary for this rebal date when beta/vol modifiers are active
        if calc_beta or calc_volatility:
            try:
                debug_lines = [
                    f"[MOM DEBUG] Date: {date} | Ticker: {t} | Momentum: {metrics[t].get('Momentum')} | Beta: {metrics[t].get('Beta')} | Vol: {metrics[t].get('Volatility')} | Weight: {weights.get(t, metrics[t].get('Calculated_Weight'))}"
                    for t in rets_keys
                ]
                for ln in debug_lines:
                    print(ln)
            except Exception as e:
                pass

        return weights, metrics
        # --- MODIFIED LOGIC END ---

    values = {t: [0.0] for t in tickers}
    unallocated_cash = [0.0]
    unreinvested_cash = [0.0]
    portfolio_no_additions = [initial_value]
    
    # Initial allocation and metric storage
    if not use_momentum:
        # If start_with is 'oldest', only allocate to tickers that are available at the simulation start
        if start_with == 'oldest':
            available_at_start = [t for t in tickers if start_dates_config.get(t, pd.Timestamp.max) <= sim_index[0]]
            current_allocations = {t: allocations.get(t, 0) if t in available_at_start else 0 for t in tickers}
        else:
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
            
            # If no assets remain after MA filtering, go to cash
            if not filtered_tickers:
                current_allocations = {t: 0 for t in tickers}
            else:
                # Only keep allocations for filtered tickers, set others to 0
                filtered_allocations = {}
                for t in tickers:
                    if t in filtered_tickers:
                        filtered_allocations[t] = current_allocations.get(t, 0)
                    else:
                        filtered_allocations[t] = 0
                
                # Normalize filtered allocations to sum to 1
                total_filtered = sum(filtered_allocations.values())
                if total_filtered > 0:
                    current_allocations = {t: allocation / total_filtered for t, allocation in filtered_allocations.items()}
                else:
                    # If no filtered allocations, use equal weights for filtered tickers
                    equal_weight = 1.0 / len(filtered_tickers) if filtered_tickers else 0
                    current_allocations = {t: equal_weight if t in filtered_tickers else 0 for t in tickers}
        
        # Apply allocation filters in correct order: Max Allocation -> Min Threshold -> Max Allocation (two-pass system)
        use_max_allocation = config.get('use_max_allocation', False)
        max_allocation_percent = config.get('max_allocation_percent', 10.0)
        use_threshold = config.get('use_minimal_threshold', False)
        threshold_percent = config.get('minimal_threshold_percent', 2.0)
        
        if use_max_allocation and current_allocations:
            max_allocation_decimal = max_allocation_percent / 100.0
            
            # FIRST PASS: Apply maximum allocation filter
            capped_allocations = {}
            excess_allocation = 0.0
            
            for ticker, allocation in current_allocations.items():
                if allocation > max_allocation_decimal:
                    # Cap the allocation and collect excess
                    capped_allocations[ticker] = max_allocation_decimal
                    excess_allocation += (allocation - max_allocation_decimal)
                else:
                    # Keep original allocation
                    capped_allocations[ticker] = allocation
            
            # Redistribute excess allocation proportionally among stocks that are below the cap
            if excess_allocation > 0:
                # Find stocks that can receive more allocation (below the cap)
                eligible_stocks = {ticker: allocation for ticker, allocation in capped_allocations.items() 
                                 if allocation < max_allocation_decimal}
                
                if eligible_stocks:
                    # Calculate total allocation of eligible stocks
                    total_eligible_allocation = sum(eligible_stocks.values())
                    
                    if total_eligible_allocation > 0:
                        # Redistribute excess proportionally
                        for ticker in eligible_stocks:
                            proportion = eligible_stocks[ticker] / total_eligible_allocation
                            additional_allocation = excess_allocation * proportion
                            new_allocation = capped_allocations[ticker] + additional_allocation
                            
                            # Make sure we don't exceed the cap
                            capped_allocations[ticker] = min(new_allocation, max_allocation_decimal)
            
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
        if use_max_allocation and current_allocations:
            max_allocation_decimal = max_allocation_percent / 100.0
            
            # Check if any stocks exceed the cap after threshold filtering and normalization
            capped_allocations = {}
            excess_allocation = 0.0
            
            for ticker, allocation in current_allocations.items():
                if allocation > max_allocation_decimal:
                    # Cap the allocation and collect excess
                    capped_allocations[ticker] = max_allocation_decimal
                    excess_allocation += (allocation - max_allocation_decimal)
                else:
                    # Keep original allocation
                    capped_allocations[ticker] = allocation
            
            # Redistribute excess allocation proportionally among stocks that are below the cap
            if excess_allocation > 0:
                # Find stocks that can receive more allocation (below the cap)
                eligible_stocks = {ticker: allocation for ticker, allocation in capped_allocations.items() 
                                 if allocation < max_allocation_decimal}
                
                if eligible_stocks:
                    # Calculate total allocation of eligible stocks
                    total_eligible_allocation = sum(eligible_stocks.values())
                    
                    if total_eligible_allocation > 0:
                        # Redistribute excess proportionally
                        for ticker in eligible_stocks:
                            proportion = eligible_stocks[ticker] / total_eligible_allocation
                            additional_allocation = excess_allocation * proportion
                            new_allocation = capped_allocations[ticker] + additional_allocation
                            
                            # Make sure we don't exceed the cap
                            capped_allocations[ticker] = min(new_allocation, max_allocation_decimal)
            
            current_allocations = capped_allocations
    else:
        returns, valid_assets = calculate_momentum(sim_index[0], set(tickers), momentum_windows, config['stocks'])
        current_allocations, metrics_on_rebal = calculate_momentum_weights(
            returns, valid_assets, date=sim_index[0],
            momentum_strategy=config.get('momentum_strategy', 'Classic'),
            negative_momentum_strategy=config.get('negative_momentum_strategy', 'Cash')
        )
        historical_metrics[sim_index[0]] = metrics_on_rebal
    
    sum_alloc = sum(current_allocations.get(t,0) for t in tickers)
    if sum_alloc > 0:
        for t in tickers:
            values[t][0] = initial_value * current_allocations.get(t,0) / sum_alloc
        unallocated_cash[0] = 0
    else:
        unallocated_cash[0] = initial_value
    
    historical_allocations[sim_index[0]] = {t: values[t][0] / initial_value if initial_value > 0 else 0 for t in tickers}
    historical_allocations[sim_index[0]]['CASH'] = unallocated_cash[0] / initial_value if initial_value > 0 else 0
    
    for i in range(len(sim_index)):
        date = sim_index[i]
        if i == 0: continue
        
        date_prev = sim_index[i-1]
        total_unreinvested_dividends = 0
        total_portfolio_prev = sum(values[t][-1] for t in tickers) + unreinvested_cash[-1]
        daily_growth_factor = 1
        if total_portfolio_prev > 0:
            total_portfolio_current_before_changes = 0
            for t in tickers:
                df = reindexed_data[t]
                price_prev = df.loc[date_prev, "Close"]
                val_prev = values[t][-1]
                nb_shares = val_prev / price_prev if price_prev > 0 else 0
                # --- Dividend fix: find the correct trading day for dividend ---
                div = 0.0
                # CRITICAL FIX: For leveraged tickers, get dividends from the base ticker, not the leveraged ticker
                if "?L=" in t:
                    # For leveraged tickers, get dividend data from the base ticker
                    base_ticker, leverage = parse_leverage_ticker(t)
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
                    # CRITICAL FIX: For leveraged tickers, dividends should be handled differently
                    # When simulating leveraged ETFs, the dividend RATE should be the same as the base asset
                    if "?L=" in t:
                        # For leveraged tickers, get the base ticker's dividend rate (not amount)
                        base_ticker, leverage = parse_leverage_ticker(t)
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
                    val_new = val_prev * (1 + rate_of_return)
                else:
                    val_new = val_prev * (1 + var)
                    # If dividends are not included, do NOT add to unreinvested cash or anywhere else
                total_portfolio_current_before_changes += val_new
            total_portfolio_current_before_changes += unreinvested_cash[-1] + total_unreinvested_dividends
            daily_growth_factor = total_portfolio_current_before_changes / total_portfolio_prev
        for t in tickers:
            df = reindexed_data[t]
            price_prev = df.loc[date_prev, "Close"]
            val_prev = values[t][-1]
            # --- Dividend fix: find the correct trading day for dividend ---
            div = 0.0
            # CRITICAL FIX: For leveraged tickers, get dividends from the base ticker, not the leveraged ticker
            if "?L=" in t:
                # For leveraged tickers, get dividend data from the base ticker
                base_ticker, leverage = parse_leverage_ticker(t)
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
                # CRITICAL FIX: For leveraged tickers, dividends should be handled differently
                # When simulating leveraged ETFs, the dividend RATE should be the same as the base asset
                if "?L=" in t:
                    # For leveraged tickers, get the base ticker's dividend rate (not amount)
                    base_ticker, leverage = parse_leverage_ticker(t)
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
                val_new = val_prev * (1 + rate_of_return)
            else:
                val_new = val_prev * (1 + var)
            values[t].append(val_new)
        unallocated_cash.append(unallocated_cash[-1])
        unreinvested_cash.append(unreinvested_cash[-1] + total_unreinvested_dividends)
        portfolio_no_additions.append(portfolio_no_additions[-1] * daily_growth_factor)
        
        current_total = sum(values[t][-1] for t in tickers) + unallocated_cash[-1] + unreinvested_cash[-1]
        
        # Check if we should rebalance
        should_rebalance = False
        
        # First check if it's a regular rebalancing date - COPIED FROM PAGE 1
        # Normalize dates for comparison (remove timezone and time components)
        date_normalized = pd.Timestamp(date).normalize()
        dates_rebal_normalized = {pd.Timestamp(d).normalize() for d in dates_rebal}
        
        if date_normalized in dates_rebal_normalized and set(tickers):
            # If targeted rebalancing is enabled, check thresholds first
            if config.get('use_targeted_rebalancing', False):
                # Calculate current allocations as percentages
                current_total = sum(values[t][-1] for t in tickers)
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
        
        # Check for MA cross rebalancing (if enabled)
        ma_cross_rebalance = config.get('ma_cross_rebalance', False)
        if ma_cross_rebalance and config.get('use_sma_filter', False) and set(tickers):
            # Check if any ticker has crossed its MA with anti-whipsaw filtering
            ma_window = config.get('sma_window', 200)
            ma_type = config.get('ma_type', 'SMA')
            tolerance_percent = config.get('ma_tolerance_percent', 2.0)
            confirmation_days = config.get('ma_confirmation_days', 3)
            
            # ULTRA FAST: Use precomputed crossings if available!
            if ma_crossings_data is not None:
                if date in ma_crossings_data:
                    crossed_assets = list(ma_crossings_data[date].keys())
                    should_rebalance = True
                    print(f"[MA CROSS] Detected confirmed MA cross for {crossed_assets} at {date} (precomputed), triggering immediate rebalancing")
            else:
                # Fallback to original method if not precomputed
                crossed_assets, cross_details = detect_ma_cross_with_anti_whipsaw(
                    list(tickers), reindexed_data, date, ma_window, ma_type, config, config['stocks'],
                    tolerance_percent, confirmation_days
                )
                
                if crossed_assets:
                    should_rebalance = True
        
        if should_rebalance and set(tickers):
            if use_momentum:
                assets_to_calculate = filter_tickers_by_sp500_entry(tickers, date, config)
                if _universe_filters_active(config) and not assets_to_calculate:
                    for t in tickers:
                        values[t][-1] = 0
                    unallocated_cash[-1] = current_total
                    unreinvested_cash[-1] = 0
                else:
                    returns, valid_assets = calculate_momentum(date, set(assets_to_calculate), momentum_windows, config['stocks'])
                    if valid_assets:
                        weights, metrics_on_rebal = calculate_momentum_weights(
                            returns, valid_assets, date=date,
                            momentum_strategy=config.get('momentum_strategy', 'Classic'),
                            negative_momentum_strategy=config.get('negative_momentum_strategy', 'Cash')
                        )
                        historical_metrics[date] = metrics_on_rebal
                        if all(w == 0 for w in weights.values()):
                            # All cash: move total to unallocated_cash, set asset values to zero
                            for t in tickers:
                                values[t][-1] = 0
                            unallocated_cash[-1] = current_total
                            unreinvested_cash[-1] = 0
                        else:
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
                    elif _universe_filters_active(config):
                        for t in tickers:
                            values[t][-1] = 0
                        unallocated_cash[-1] = current_total
                        unreinvested_cash[-1] = 0
            else:
                # Non-momentum rebalancing: respect 'start_with' option
                
                # ALWAYS start with original allocations (like page 1)
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
                     
                     # Redistribute allocations of excluded tickers proportionally among remaining tickers - EXACTLY LIKE PAGE 1
                     if excluded_assets:
                         excluded_ticker_list = list(excluded_assets.keys())
                         
                         # Calculate total allocation of excluded tickers
                         excluded_allocation = sum(rebalance_allocations.get(t, 0) for t in excluded_ticker_list)
                         
                         # Remove excluded tickers from current allocations
                         for excluded_ticker in excluded_ticker_list:
                             if excluded_ticker in rebalance_allocations:
                                 del rebalance_allocations[excluded_ticker]
                         
                         # If there are remaining tickers (excluding CASH), redistribute proportionally - EXACTLY LIKE PAGE 1
                         remaining_tickers = [t for t in rebalance_allocations.keys() if t != 'CASH']
                         if remaining_tickers:
                             # Calculate total allocation of remaining tickers (excluding CASH)
                             remaining_allocation = sum(rebalance_allocations.get(t, 0) for t in remaining_tickers)
                             
                             if remaining_allocation > 0:
                                 # Redistribute excluded allocation proportionally
                                 for ticker in remaining_tickers:
                                     proportion = rebalance_allocations[ticker] / remaining_allocation
                                     rebalance_allocations[ticker] += excluded_allocation * proportion
                             else:
                                 # Equal distribution if no remaining allocation
                                 equal_allocation = excluded_allocation / len(remaining_tickers)
                                 for ticker in remaining_tickers:
                                     rebalance_allocations[ticker] = equal_allocation
                         else:
                             # No remaining tickers, go to cash
                             # Put everything in unallocated_cash
                             for t in tickers:
                                 values[t][-1] = 0
                             unallocated_cash[-1] = current_total
                             unreinvested_cash[-1] = 0
                             # Clear rebalance_allocations so rest of rebalancing logic is skipped
                             rebalance_allocations = {t: 0 for t in tickers}
                     
                     # DO NOT UPDATE allocations HERE - we need to keep original allocations for next rebalancing
                     # The filtered allocations are already in rebalance_allocations and will be used below
                
                if start_with == 'oldest':
                    # Only consider tickers that have data by this rebalancing date
                    available = [t for t in tickers if start_dates_config.get(t, pd.Timestamp.max) <= date]
                    sum_alloc_avail = sum(rebalance_allocations.get(t,0) for t in available)
                    if sum_alloc_avail > 0:
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
                                # Use target allocations (from rebalance_allocations which includes MA filtering)
                                current_proportions = {t: rebalance_allocations.get(t,0)/sum_alloc_avail for t in available}
                            
                            # Only distribute the new cash (unallocated_cash + unreinvested_cash)
                            cash_to_distribute = unallocated_cash[-1] + unreinvested_cash[-1]
                            for t in tickers:
                                if t in available:
                                    # Add new cash proportionally to existing holdings
                                    values[t][-1] += cash_to_distribute * current_proportions.get(t, 0)
                                else:
                                    # Keep existing value for unavailable tickers
                                    pass
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
                                    if t in available:
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
                                            # Not in targeted settings - keep current allocation
                                            target_allocations[t] = (values[t][-1] / current_total) if current_total > 0 else 0
                                    else:
                                        target_allocations[t] = 0
                                
                                # Calculate remaining allocation for non-targeted tickers
                                total_targeted = sum(target_allocations.values())
                                remaining_allocation = 1.0 - total_targeted
                                
                                # Get non-targeted tickers
                                non_targeted_tickers = [t for t in tickers if t in available and (t not in targeted_settings or not targeted_settings[t].get('enabled', False))]
                                
                                # Distribute remaining allocation PROPORTIONALLY to base allocations (not equally) - COPIED FROM PAGE 1
                                if non_targeted_tickers and remaining_allocation > 0:
                                    non_targeted_base_sum = sum(rebalance_allocations.get(t, 0) for t in non_targeted_tickers)
                                    if non_targeted_base_sum > 0:
                                        # Distribute proportionally to base allocations (from rebalance_allocations which includes MA filtering)
                                        for t in non_targeted_tickers:
                                            base_proportion = rebalance_allocations.get(t, 0) / non_targeted_base_sum
                                            target_allocations[t] = base_proportion * remaining_allocation
                                    else:
                                        # If no base allocations, distribute equally
                                        allocation_per_ticker = remaining_allocation / len(non_targeted_tickers)
                                        for t in non_targeted_tickers:
                                            target_allocations[t] = allocation_per_ticker
                                
                                # Apply target allocations
                                for t in tickers:
                                    values[t][-1] = current_total * target_allocations.get(t, 0)
                            else:
                                # Regular rebalancing - use base allocations (from rebalance_allocations which includes MA filtering)
                                for t in tickers:
                                    if t in available:
                                        weight = rebalance_allocations.get(t,0)/sum_alloc_avail
                                        values[t][-1] = current_total * weight
                                    else:
                                        values[t][-1] = 0
                            
                            unreinvested_cash[-1] = 0
                            unallocated_cash[-1] = 0
                    else:
                        # No assets available yet — keep everything as cash
                        for t in tickers:
                            values[t][-1] = 0
                        unreinvested_cash[-1] = 0
                        unallocated_cash[-1] = current_total
                else:
                    # NOTE: rebalance_allocations has already been initialized with MA filter applied at line 4933-4988
                    # We should NOT reapply MA filter here or reinitialize rebalance_allocations from allocations
                    
                    # Apply threshold filter for non-momentum strategies during rebalancing
                    use_threshold = config.get('use_minimal_threshold', False)
                    threshold_percent = config.get('minimal_threshold_percent', 2.0)
                    
                    if use_threshold:
                        threshold_decimal = threshold_percent / 100.0
                        
                        # First: Filter out stocks below threshold (use rebalance_allocations which already has MA filter applied)
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
                            # If no stocks meet threshold, keep existing rebalance_allocations
                            pass
                    
                    # Apply maximum allocation filter during rebalancing
                    use_max_allocation = config.get('use_max_allocation', False)
                    max_allocation_percent = config.get('max_allocation_percent', 10.0)
                    
                    if use_max_allocation and rebalance_allocations:
                        max_allocation_decimal = max_allocation_percent / 100.0
                        
                        # Cap individual stock allocations at maximum
                        capped_rebalance_allocations = {}
                        excess_allocation = 0.0
                        
                        for t in tickers:
                            allocation = rebalance_allocations.get(t, 0)
                            if allocation > max_allocation_decimal:
                                # Cap the allocation and collect excess
                                capped_rebalance_allocations[t] = max_allocation_decimal
                                excess_allocation += (allocation - max_allocation_decimal)
                            else:
                                # Keep original allocation
                                capped_rebalance_allocations[t] = allocation
                        
                        # Redistribute excess allocation proportionally among stocks that are below the cap
                        if excess_allocation > 0:
                            # Find stocks that can receive more allocation (below the cap)
                            eligible_stocks = {t: allocation for t, allocation in capped_rebalance_allocations.items() 
                                             if allocation < max_allocation_decimal}
                            
                            if eligible_stocks:
                                # Calculate total allocation of eligible stocks
                                total_eligible_allocation = sum(eligible_stocks.values())
                                
                                if total_eligible_allocation > 0:
                                    # Redistribute excess proportionally
                                    for t in eligible_stocks:
                                        proportion = eligible_stocks[t] / total_eligible_allocation
                                        additional_allocation = excess_allocation * proportion
                                        new_allocation = capped_rebalance_allocations[t] + additional_allocation
                                        
                                        # Make sure we don't exceed the cap
                                        capped_rebalance_allocations[t] = min(new_allocation, max_allocation_decimal)
                        
                        rebalance_allocations = capped_rebalance_allocations
                    
                    # Apply targeted rebalancing if enabled and thresholds are violated
                    if config.get('use_targeted_rebalancing', False) and should_rebalance:
                        targeted_settings = config.get('targeted_rebalancing_settings', {})
                        current_asset_values = {t: values[t][-1] for t in tickers}
                        current_total_value = sum(current_asset_values.values())
                        
                        if current_total_value > 0:
                            current_allocations = {t: v / current_total_value for t, v in current_asset_values.items()}
                            
                            # Apply targeted rebalancing
                            new_allocations = {}
                            
                            # Set allocations for tickers with targeted rebalancing
                            for ticker in tickers:
                                if ticker in targeted_settings and targeted_settings[ticker].get('enabled', False):
                                    settings = targeted_settings[ticker]
                                    min_alloc = settings.get('min_allocation', 0.0) / 100.0
                                    max_alloc = settings.get('max_allocation', 100.0) / 100.0
                                    current_alloc = current_allocations.get(ticker, 0.0)
                                    
                                    if current_alloc > max_alloc:
                                        new_allocations[ticker] = max_alloc
                                    elif current_alloc < min_alloc:
                                        new_allocations[ticker] = min_alloc
                                    else:
                                        new_allocations[ticker] = current_alloc
                                else:
                                    new_allocations[ticker] = current_allocations.get(ticker, 0.0)
                            
                            # Normalize to ensure allocations sum to 1.0
                            total_alloc = sum(new_allocations.values())
                            if total_alloc > 0:
                                rebalance_allocations = {t: alloc / total_alloc for t, alloc in new_allocations.items()}
                    
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
                                        # Not in targeted settings - keep current allocation
                                        target_allocations[t] = (values[t][-1] / current_total) if current_total > 0 else 0
                                
                                # Calculate remaining allocation for non-targeted tickers
                                total_targeted = sum(target_allocations.values())
                                remaining_allocation = 1.0 - total_targeted
                                
                                # Get non-targeted tickers
                                non_targeted_tickers = [t for t in tickers if (t not in targeted_settings or not targeted_settings[t].get('enabled', False))]
                                
                                # Distribute remaining allocation PROPORTIONALLY to base allocations (not equally) - COPIED FROM PAGE 1
                                if non_targeted_tickers and remaining_allocation > 0:
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
            
            # Store daily allocations for smooth allocation evolution charts (AFTER rebalancing)
            # Include ALL tickers in the portfolio, regardless of data availability at this specific date
            # This ensures no gaps in Historical Allocations for single tickers
            available_tickers_at_date = []
            for t in tickers:
                if t in reindexed_data:
                    # Check if ticker has data (with ffill, this should always be true)
                    try:
                        price_value = reindexed_data[t].loc[date]
                        # Handle case where loc returns a Series instead of scalar
                        if isinstance(price_value, pd.Series):
                            price_value = price_value.iloc[0] if len(price_value) > 0 else np.nan
                        # Include ticker even if price is NaN (due to ffill, this should be rare)
                        available_tickers_at_date.append(t)
                    except (KeyError, IndexError):
                        # If ticker doesn't have data at this date, still include it for consistency
                        available_tickers_at_date.append(t)
            else:
                    # Include ticker even if not in reindexed_data (shouldn't happen with ffill)
                    available_tickers_at_date.append(t)
            
            current_total_after_rebal = sum(values[t][-1] for t in available_tickers_at_date) + unallocated_cash[-1] + unreinvested_cash[-1]
            if current_total_after_rebal > 0:
                daily_allocs = {t: values[t][-1] / current_total_after_rebal for t in available_tickers_at_date}
                daily_allocs['CASH'] = (unallocated_cash[-1] + unreinvested_cash[-1]) / current_total_after_rebal
                historical_allocations[date] = daily_allocs

    # Store last allocation - ONLY APPLY MA FILTERS IF LAST DATE IS A REBALANCING DATE
    last_date = sim_index[-1]
    last_total = sum(values[t][-1] for t in tickers) + unallocated_cash[-1] + unreinvested_cash[-1]
    
    # Check if last date is a rebalancing date
    date_normalized = pd.Timestamp(last_date).normalize()
    dates_rebal_normalized = {pd.Timestamp(d).normalize() for d in dates_rebal}
    is_rebalancing_date = date_normalized in dates_rebal_normalized
    
    if last_total > 0:
        # Only apply MA filter if last date is actually a rebalancing date
        if config.get('use_sma_filter', False) and is_rebalancing_date and ma_filter_data is not None:
            # Get list of current tickers (excluding CASH)
            current_tickers = [t for t in tickers if t != 'CASH']
            # ULTRA FAST: Use precomputed filter results!
            filtered_tickers = [t for t in current_tickers if ma_filter_data.get(last_date, {}).get(t, True)]
            excluded_assets = {t: f"Below MA" for t in current_tickers if t not in filtered_tickers}
            
            # If no assets remain after MA filtering, go to cash
            if not filtered_tickers:
                last_allocs = {t: 0 for t in tickers}
                last_allocs['CASH'] = 1.0  # All cash
            else:
                # Only keep allocations for filtered tickers, set others to 0
                filtered_last_allocs = {}
                for t in tickers:
                    if t in filtered_tickers:
                        filtered_last_allocs[t] = values[t][-1] / last_total
                    else:
                        filtered_last_allocs[t] = 0
                
                # Normalize filtered allocations to sum to 1
                total_filtered = sum(filtered_last_allocs.values())
                if total_filtered > 0:
                    last_allocs = {t: allocation / total_filtered for t, allocation in filtered_last_allocs.items()}
                else:
                    # If no filtered allocations, use equal weights for filtered tickers
                    equal_weight = 1.0 / len(filtered_tickers) if filtered_tickers else 0
                    last_allocs = {t: equal_weight if t in filtered_tickers else 0 for t in tickers}
                
                last_allocs['CASH'] = unallocated_cash[-1] / last_total if last_total > 0 else 0
        else:
            # No MA filter or not a rebalancing date - use raw allocations (reflects last rebalancing)
            last_allocs = {t: values[t][-1] / last_total for t in tickers}
            last_allocs['CASH'] = unallocated_cash[-1] / last_total if last_total > 0 else 0
        
        historical_allocations[last_date] = last_allocs
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
            negative_momentum_strategy=config.get('negative_momentum_strategy', 'Cash')
        )
        # Add CASH line to metrics
        cash_weight = 1.0 if all(w == 0 for w in weights.values()) else 0.0
        metrics_on_rebal['CASH'] = {'Calculated_Weight': cash_weight}
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


# -----------------------
# Main App Logic
# -----------------------

from copy import deepcopy
# Use page-scoped session keys so this page does not share state with other pages
if 'alloc_portfolio_configs' not in st.session_state:
    # initialize from existing global configs if present, but deep-copy to avoid shared references
            st.session_state.alloc_portfolio_configs = deepcopy(st.session_state.get('alloc_portfolio_configs', default_configs))
if 'alloc_active_portfolio_index' not in st.session_state:
    st.session_state.alloc_active_portfolio_index = 0
if 'alloc_paste_json_text' not in st.session_state:
    st.session_state.alloc_paste_json_text = ""
if 'alloc_rerun_flag' not in st.session_state:
    st.session_state.alloc_rerun_flag = False

def add_portfolio_callback():
    new_portfolio = default_configs[1].copy()
    new_portfolio['name'] = f"New Portfolio {len(st.session_state.alloc_portfolio_configs) + 1}"
    st.session_state.alloc_portfolio_configs.append(new_portfolio)
    st.session_state.alloc_active_portfolio_index = len(st.session_state.alloc_portfolio_configs) - 1
    st.session_state.alloc_rerun_flag = True

def remove_portfolio_callback():
    if len(st.session_state.alloc_portfolio_configs) > 1:
        st.session_state.alloc_portfolio_configs.pop(st.session_state.alloc_active_portfolio_index)
        st.session_state.alloc_active_portfolio_index = max(0, st.session_state.alloc_active_portfolio_index - 1)
        st.session_state.alloc_rerun_flag = True

def add_stock_callback():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'].append({'ticker': '', 'allocation': 0.0, 'include_dividends': True, 'include_in_sma_filter': True, 'max_allocation_percent': None})
    st.session_state.alloc_rerun_flag = True

def remove_stock_callback(ticker):
    """Immediate stock removal callback"""
    try:
        active_portfolio = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]
        stocks = active_portfolio['stocks']
        
        # Find and remove the stock with matching ticker
        for i, stock in enumerate(stocks):
            if stock['ticker'] == ticker:
                stocks.pop(i)
                # If this was the last stock, add an empty one
                if len(stocks) == 0:
                    stocks.append({'ticker': '', 'allocation': 0.0, 'include_dividends': True})
                st.session_state.alloc_rerun_flag = True
                break
    except (IndexError, KeyError):
        pass

def normalize_stock_allocations_callback():
    if 'alloc_portfolio_configs' not in st.session_state or 'alloc_active_portfolio_index' not in st.session_state:
        return
    stocks = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks']
    valid_stocks = [s for s in stocks if s['ticker']]
    total_alloc = sum(s['allocation'] for s in valid_stocks)
    if total_alloc > 0:
        for idx, s in enumerate(stocks):
            if s['ticker']:
                s['allocation'] /= total_alloc
                alloc_key = f"alloc_input_alloc_{st.session_state.alloc_active_portfolio_index}_{idx}"
                st.session_state[alloc_key] = int(s['allocation'] * 100)
            else:
                s['allocation'] = 0.0
                alloc_key = f"alloc_input_alloc_{st.session_state.alloc_active_portfolio_index}_{idx}"
                st.session_state[alloc_key] = 0
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'] = stocks
    st.session_state.alloc_rerun_flag = True

def equal_stock_allocation_callback():
    if 'alloc_portfolio_configs' not in st.session_state or 'alloc_active_portfolio_index' not in st.session_state:
        return
    stocks = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks']
    valid_stocks = [s for s in stocks if s['ticker']]
    if valid_stocks:
        equal_weight = 1.0 / len(valid_stocks)
        for idx, s in enumerate(stocks):
            if s['ticker']:
                s['allocation'] = equal_weight
                alloc_key = f"alloc_input_alloc_{st.session_state.alloc_active_portfolio_index}_{idx}"
                st.session_state[alloc_key] = int(equal_weight * 100)
            else:
                s['allocation'] = 0.0
                alloc_key = f"alloc_input_alloc_{st.session_state.alloc_active_portfolio_index}_{idx}"
                st.session_state[alloc_key] = 0
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'] = stocks
    st.session_state.alloc_rerun_flag = True
    
def reset_portfolio_callback():
    current_name = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['name']
    default_cfg_found = next((cfg for cfg in default_configs if cfg['name'] == current_name), None)
    if default_cfg_found is None:
        default_cfg_found = default_configs[1].copy()
        default_cfg_found['name'] = current_name
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index] = default_cfg_found
    st.session_state.alloc_rerun_flag = True

def reset_stock_selection_callback():
    current_name = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['name']
    default_cfg_found = next((cfg for cfg in default_configs if cfg['name'] == current_name), None)
    if default_cfg_found is None:
        default_cfg_found = default_configs[1].copy()
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'] = default_cfg_found['stocks']
    st.session_state.alloc_rerun_flag = True

def reset_momentum_windows_callback():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['momentum_windows'] = [
        {"lookback": 365, "exclude": 30, "weight": 0.5, "discard_if_negative": False, "discard_unless_recent_positive": False},
        {"lookback": 180, "exclude": 30, "weight": 0.3, "discard_if_negative": False, "discard_unless_recent_positive": False},
        {"lookback": 120, "exclude": 30, "weight": 0.2, "discard_if_negative": False, "discard_unless_recent_positive": False},
    ]
    st.session_state.alloc_rerun_flag = True

def reset_beta_callback():
    # Reset beta lookback/exclude to defaults and enable beta calculation for alloc page
    idx = st.session_state.alloc_active_portfolio_index
    st.session_state.alloc_portfolio_configs[idx]['beta_window_days'] = 365
    st.session_state.alloc_portfolio_configs[idx]['exclude_days_beta'] = 30
    # Ensure checkbox state reflects enabled
    st.session_state.alloc_portfolio_configs[idx]['calc_beta'] = True
    st.session_state['alloc_active_calc_beta'] = True
    st.session_state.alloc_rerun_flag = True

def reset_vol_callback():
    # Reset volatility lookback/exclude to defaults and enable volatility calculation
    idx = st.session_state.alloc_active_portfolio_index
    st.session_state.alloc_portfolio_configs[idx]['vol_window_days'] = 365
    st.session_state.alloc_portfolio_configs[idx]['exclude_days_vol'] = 30
    st.session_state.alloc_portfolio_configs[idx]['calc_volatility'] = True
    st.session_state['alloc_active_calc_vol'] = True
    st.session_state.alloc_rerun_flag = True

def add_momentum_window_callback():
    # Append a new momentum window with modest defaults (alloc page)
    idx = st.session_state.alloc_active_portfolio_index
    cfg = st.session_state.alloc_portfolio_configs[idx]
    if 'momentum_windows' not in cfg:
        cfg['momentum_windows'] = []
    # default new window
    cfg['momentum_windows'].append({"lookback": 90, "exclude": 30, "weight": 0.1, "discard_if_negative": False, "discard_unless_recent_positive": False})
    st.session_state.alloc_portfolio_configs[idx] = cfg
    st.session_state.alloc_rerun_flag = True

def remove_momentum_window_callback():
    idx = st.session_state.alloc_active_portfolio_index
    cfg = st.session_state.alloc_portfolio_configs[idx]
    if 'momentum_windows' in cfg and cfg['momentum_windows']:
        cfg['momentum_windows'].pop()
        st.session_state.alloc_portfolio_configs[idx] = cfg
        st.session_state.alloc_rerun_flag = True

def update_momentum_discard_if_negative(index):
    idx = st.session_state.alloc_active_portfolio_index
    discard_key = f"alloc_discard_if_negative_{idx}_{index}"
    st.session_state.alloc_portfolio_configs[idx]['momentum_windows'][index]['discard_if_negative'] = parse_bool_from_json(
        st.session_state.get(discard_key, False), False
    )


def update_momentum_discard_unless_recent_positive(index):
    idx = st.session_state.alloc_active_portfolio_index
    unless_key = f"alloc_discard_unless_recent_positive_{idx}_{index}"
    st.session_state.alloc_portfolio_configs[idx]['momentum_windows'][index]['discard_unless_recent_positive'] = parse_bool_from_json(
        st.session_state.get(unless_key, False), False
    )


def normalize_momentum_weights_callback():
    # Use page-scoped configs for allocations page
    if 'alloc_portfolio_configs' not in st.session_state or 'alloc_active_portfolio_index' not in st.session_state:
        return
    active_portfolio = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]
    total_weight = sum(w['weight'] for w in active_portfolio.get('momentum_windows', []))
    if total_weight > 0:
        for idx, w in enumerate(active_portfolio.get('momentum_windows', [])):
            w['weight'] /= total_weight
            weight_key = f"alloc_weight_input_active_{st.session_state.alloc_active_portfolio_index}_{idx}"
            # Sanitize weight to prevent StreamlitValueAboveMaxError
            weight = w['weight']
            if isinstance(weight, (int, float)):
                # Convert decimal to percentage, ensuring it's within bounds
                weight_percentage = max(0.0, min(weight * 100.0, 100.0))
            else:
                # Invalid weight, set to default
                weight_percentage = 10.0
            st.session_state[weight_key] = int(weight_percentage)
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['momentum_windows'] = active_portfolio.get('momentum_windows', [])
    st.session_state.alloc_rerun_flag = True

def paste_json_callback():
    try:
        # Use the SAME parsing logic as successful PDF extraction
        raw_text = st.session_state.get('alloc_paste_json_text', '{}')
        
        # STEP 1: Try the exact same approach as PDF extraction (simple strip + parse)
        try:
            cleaned_text = raw_text.strip()
            json_data = json.loads(cleaned_text)
            st.success("✅ JSON parsed successfully using PDF-style parsing!")
        except json.JSONDecodeError:
            # STEP 2: If that fails, apply our advanced cleaning (fallback)
            st.info("🔧 Simple parsing failed, applying advanced PDF extraction fixes...")
            
            json_text = raw_text
            import re
            
            # Fix common PDF extraction issues
            # Pattern to find broken portfolio name lines like: "name": "Some Name "stocks":
            broken_pattern = r'"name":\s*"([^"]*?)"\s*"stocks":'
            # Replace with proper JSON structure: "name": "Some Name", "stocks":
            json_text = re.sub(broken_pattern, r'"name": "\1", "stocks":', json_text)
            
            # Fix truncated names that end abruptly without closing quote
            # Pattern: "name": "Some text without closing quote "stocks":
            truncated_pattern = r'"name":\s*"([^"]*?)\s+"stocks":'
            json_text = re.sub(truncated_pattern, r'"name": "\1", "stocks":', json_text)
            
            # Fix missing opening brace for portfolio objects
            # Pattern: }, "name": should be }, { "name":
            missing_brace_pattern = r'(},)\s*("name":)'
            json_text = re.sub(missing_brace_pattern, r'\1 {\n \2', json_text)
            
            json_data = json.loads(json_text)
            st.success("✅ JSON parsed successfully using advanced cleaning!")
        
        # Add missing fields for compatibility if they don't exist
        if 'collect_dividends_as_cash' not in json_data:
            json_data['collect_dividends_as_cash'] = False
        if 'exclude_from_cashflow_sync' not in json_data:
            json_data['exclude_from_cashflow_sync'] = False
        if 'exclude_from_rebalancing_sync' not in json_data:
            json_data['exclude_from_rebalancing_sync'] = False
        if 'use_minimal_threshold' not in json_data:
            json_data['use_minimal_threshold'] = False
        if 'minimal_threshold_percent' not in json_data:
            json_data['minimal_threshold_percent'] = 4.0
        if 'use_max_allocation' not in json_data:
            json_data['use_max_allocation'] = False
        if 'max_allocation_percent' not in json_data:
            json_data['max_allocation_percent'] = 20.0
        if 'use_equal_weight' not in json_data:
            json_data['use_equal_weight'] = False
        if 'equal_weight_n_tickers' not in json_data:
            json_data['equal_weight_n_tickers'] = 10
        if 'use_limit_to_top_n' not in json_data:
            json_data['use_limit_to_top_n'] = False
        if 'limit_to_top_n_tickers' not in json_data:
            json_data['limit_to_top_n_tickers'] = 10
        if 'use_sector_concentration_limit' not in json_data:
            json_data['use_sector_concentration_limit'] = False
        if 'max_tickers_per_sector' not in json_data:
            json_data['max_tickers_per_sector'] = 4
        if 'use_industry_concentration_limit' not in json_data:
            json_data['use_industry_concentration_limit'] = False
        if 'max_tickers_per_industry' not in json_data:
            json_data['max_tickers_per_industry'] = 2
        if 'unknown_counts_as_category' not in json_data:
            json_data['unknown_counts_as_category'] = True
        if 'exclude_before_sp500_entry' not in json_data:
            json_data['exclude_before_sp500_entry'] = False
        if 'use_min_market_cap_filter' not in json_data:
            json_data['use_min_market_cap_filter'] = False
        if 'min_market_cap_billions' not in json_data:
            json_data['min_market_cap_billions'] = 10.0
        
        # Debug: Show what we received
        st.info(f"Received JSON keys: {list(json_data.keys())}")
        if 'tickers' in json_data:
            st.info(f"Tickers in JSON: {json_data['tickers']}")
        if 'stocks' in json_data:
            st.info(f"Stocks in JSON: {json_data['stocks']}")
        if 'momentum_windows' in json_data:
            st.info(f"Momentum windows in JSON: {json_data['momentum_windows']}")
        if 'use_momentum' in json_data:
            st.info(f"Use momentum in JSON: {json_data['use_momentum']}")
        
        # Handle momentum strategy value mapping from other pages
        momentum_strategy = json_data.get('momentum_strategy', 'Classic')
        if momentum_strategy == 'Classic momentum':
            momentum_strategy = 'Classic'
        elif momentum_strategy == 'Relative momentum':
            momentum_strategy = 'Relative Momentum'
        elif momentum_strategy == 'Near-Zero Symmetry':
            momentum_strategy = 'Near-Zero Symmetry'
        elif momentum_strategy not in ['Classic', 'Relative Momentum', 'Near-Zero Symmetry']:
            momentum_strategy = 'Classic'  # Default fallback
        
        # Handle negative momentum strategy value mapping from other pages
        negative_momentum_strategy = json_data.get('negative_momentum_strategy', 'Cash')
        if negative_momentum_strategy == 'Go to cash':
            negative_momentum_strategy = 'Cash'
        elif negative_momentum_strategy == 'Near-Zero Symmetry':
            negative_momentum_strategy = 'Near-Zero Symmetry'
        elif negative_momentum_strategy not in ['Cash', 'Equal weight', 'Relative momentum', 'Near-Zero Symmetry']:
            negative_momentum_strategy = 'Cash'  # Default fallback
        
        # Handle stocks field - convert from legacy format if needed
        stocks = json_data.get('stocks', [])
        if not stocks and 'tickers' in json_data:
            # Convert legacy format (tickers, allocs, divs) to stocks format
            tickers = json_data.get('tickers', [])
            allocs = json_data.get('allocs', [])
            divs = json_data.get('divs', [])
            stocks = []
            
            # Ensure we have valid arrays
            if tickers and isinstance(tickers, list):
                for i in range(len(tickers)):
                    if tickers[i] and tickers[i].strip():  # Check for non-empty ticker
                        # Convert allocation from percentage (0-100) to decimal (0.0-1.0) format
                        allocation = 0.0
                        if i < len(allocs) and allocs[i] is not None:
                            alloc_value = float(allocs[i])
                            if alloc_value > 1.0:
                                # Already in percentage format, convert to decimal
                                allocation = alloc_value / 100.0
                            else:
                                # Already in decimal format, use as is
                                allocation = alloc_value
                        
                        # Keep original ticker for backtest (don't resolve aliases for portfolio)
                        original_ticker = tickers[i].strip()
                        stock = {
                            'ticker': original_ticker,  # Use original ticker for backtest
                            'allocation': allocation,
                            'include_dividends': bool(divs[i]) if i < len(divs) and divs[i] is not None else True
                        }
                        stocks.append(stock)
            
            # Debug output
            st.info(f"Converted {len(stocks)} stocks from legacy format: {[s['ticker'] for s in stocks]}")
        
        # Ensure all stocks have max_allocation_percent field
        for stock in stocks:
            if 'max_allocation_percent' not in stock:
                stock['max_allocation_percent'] = None
            if 'include_in_sma_filter' not in stock:
                stock['include_in_sma_filter'] = True
        
        # Sanitize momentum window weights to prevent StreamlitValueAboveMaxError
        momentum_windows = json_data.get('momentum_windows', [])
        for window in momentum_windows:
            if 'weight' in window:
                weight = window['weight']
                # If weight is a percentage (e.g., 50 for 50%), convert to decimal
                if isinstance(weight, (int, float)) and weight > 1.0:
                    # Cap at 100% and convert to decimal
                    weight = min(weight, 100.0) / 100.0
                elif isinstance(weight, (int, float)) and weight <= 1.0:
                    # Already in decimal format, ensure it's valid
                    weight = max(0.0, min(weight, 1.0))
                else:
                    # Invalid weight, set to default
                    weight = 0.1
                window['weight'] = weight
        normalize_momentum_windows_discard_flags(momentum_windows)
        
        # Map frequency values from app.py format to Allocations format
        def map_frequency(freq):
            if freq is None:
                return 'Never'
            freq_map = {
                'Never': 'Never',
                'Weekly': 'Weekly',
                'Biweekly': 'Biweekly',
                'Monthly': 'Monthly',
                'Quarterly': 'Quarterly',
                'Semiannually': 'Semiannually',
                'Annually': 'Annually',
                # Legacy format mapping
                'none': 'Never',
                'week': 'Weekly',
                '2weeks': 'Biweekly',
                'month': 'Monthly',
                '3months': 'Quarterly',
                '6months': 'Semiannually',
                'year': 'Annually'
            }
            return freq_map.get(freq, 'Monthly')
        
        # Allocations page specific: ensure all required fields are present
        # and ignore fields that are specific to other pages
        allocations_config = {
            'name': json_data.get('name', 'Allocation Portfolio'),
            'stocks': stocks,
            'benchmark_ticker': json_data.get('benchmark_ticker', '^GSPC'),
            'initial_value': json_data.get('initial_value', 10000),
            'added_amount': json_data.get('added_amount', 0),  # Allocations page typically doesn't use additions
            'added_frequency': map_frequency(json_data.get('added_frequency', 'Never')),  # Allocations page typically doesn't use additions
            'rebalancing_frequency': map_frequency(json_data.get('rebalancing_frequency', 'Monthly')),
            'start_date_user': json_data.get('start_date_user'),
            'end_date_user': json_data.get('end_date_user'),
            'start_with': json_data.get('start_with', 'oldest'),
            'use_momentum': json_data.get('use_momentum', True),
            'momentum_strategy': momentum_strategy,
            'negative_momentum_strategy': negative_momentum_strategy,
            'momentum_windows': momentum_windows,
            'use_minimal_threshold': json_data.get('use_minimal_threshold', False),
            'minimal_threshold_percent': json_data.get('minimal_threshold_percent', 4.0),
            'use_max_allocation': json_data.get('use_max_allocation', False),
            'max_allocation_percent': json_data.get('max_allocation_percent', 20.0),
            'use_equal_weight': json_data.get('use_equal_weight', False),
            'equal_weight_n_tickers': json_data.get('equal_weight_n_tickers', 10),
            'use_limit_to_top_n': json_data.get('use_limit_to_top_n', False),
            'limit_to_top_n_tickers': json_data.get('limit_to_top_n_tickers', 10),
            'use_sector_concentration_limit': parse_bool_from_json(json_data.get('use_sector_concentration_limit', False), False),
            'max_tickers_per_sector': json_data.get('max_tickers_per_sector', 4),
            'use_industry_concentration_limit': parse_bool_from_json(json_data.get('use_industry_concentration_limit', False), False),
            'max_tickers_per_industry': json_data.get('max_tickers_per_industry', 2),
            'unknown_counts_as_category': parse_bool_from_json(json_data.get('unknown_counts_as_category', True), True),
            'exclude_before_sp500_entry': parse_bool_from_json(json_data.get('exclude_before_sp500_entry', False), False),
            'use_min_market_cap_filter': parse_bool_from_json(json_data.get('use_min_market_cap_filter', False), False),
            'min_market_cap_billions': json_data.get('min_market_cap_billions', 10.0),
            'calc_beta': json_data.get('calc_beta', True),
            'calc_volatility': json_data.get('calc_volatility', True),
            'beta_window_days': json_data.get('beta_window_days', 365),
            'exclude_days_beta': json_data.get('exclude_days_beta', 30),
            'vol_window_days': json_data.get('vol_window_days', 365),
            'exclude_days_vol': json_data.get('exclude_days_vol', 30),
            'use_targeted_rebalancing': json_data.get('use_targeted_rebalancing', False),
            'targeted_rebalancing_settings': json_data.get('targeted_rebalancing_settings', {}),
            'use_sma_filter': json_data.get('use_sma_filter', False),
            'sma_window': json_data.get('sma_window', 200),
            'ma_type': json_data.get('ma_type', 'SMA'),
            'ma_multiplier': json_data.get('ma_multiplier', 1.48),
            'ma_cross_rebalance': json_data.get('ma_cross_rebalance', False),
            'ma_tolerance_percent': json_data.get('ma_tolerance_percent', 2.0),
            'ma_confirmation_days': json_data.get('ma_confirmation_days', 3),
        }
        
        st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index] = allocations_config
        
        # Update session state for threshold settings
        st.session_state['alloc_active_use_threshold'] = allocations_config.get('use_minimal_threshold', False)
        st.session_state['alloc_active_threshold_percent'] = allocations_config.get('minimal_threshold_percent', 4.0)
        st.session_state['alloc_active_use_max_allocation'] = allocations_config.get('use_max_allocation', False)
        st.session_state['alloc_active_max_allocation_percent'] = allocations_config.get('max_allocation_percent', 20.0)
        st.session_state['alloc_active_use_equal_weight'] = allocations_config.get('use_equal_weight', False)
        st.session_state['alloc_active_equal_weight_n_tickers'] = allocations_config.get('equal_weight_n_tickers', 10)
        st.session_state['alloc_active_exclude_before_sp500_entry'] = allocations_config.get('exclude_before_sp500_entry', False)
        st.session_state['alloc_active_use_min_market_cap_filter'] = allocations_config.get('use_min_market_cap_filter', False)
        try:
            st.session_state['alloc_active_min_market_cap_billions'] = float(allocations_config.get('min_market_cap_billions', 10.0) or 10.0)
        except Exception:
            st.session_state['alloc_active_min_market_cap_billions'] = 10.0
        
        # Update session state for MA filter settings
        st.session_state['alloc_active_use_sma_filter'] = allocations_config.get('use_sma_filter', False)
        st.session_state['alloc_active_sma_window'] = allocations_config.get('sma_window', 200)
        st.session_state['alloc_active_ma_type'] = allocations_config.get('ma_type', 'SMA')
        st.session_state['alloc_active_ma_multiplier'] = allocations_config.get('ma_multiplier', 1.48)
        st.session_state['alloc_active_ma_cross_rebalance'] = allocations_config.get('ma_cross_rebalance', False)
        st.session_state['alloc_active_ma_tolerance'] = allocations_config.get('ma_tolerance_percent', 2.0)
        st.session_state['alloc_active_ma_delay'] = allocations_config.get('ma_confirmation_days', 3)
        
        # Update session state for momentum settings (FIX FOR VISUAL BUG)
        st.session_state['alloc_active_use_momentum'] = allocations_config.get('use_momentum', True)
        st.session_state['alloc_active_momentum_strategy'] = allocations_config.get('momentum_strategy', 'Classic')
        st.session_state['alloc_active_negative_momentum_strategy'] = allocations_config.get('negative_momentum_strategy', 'Cash')
        st.session_state['alloc_active_calc_beta'] = allocations_config.get('calc_beta', False)
        st.session_state['alloc_active_calc_vol'] = allocations_config.get('calc_volatility', False)
        
        # Update portfolio name input field to match the imported portfolio
        st.session_state.alloc_portfolio_name = allocations_config.get('name', 'Allocation Portfolio')
        
        st.success("Portfolio configuration updated from JSON (Allocations page).")
        st.info(f"Final stocks list: {[s['ticker'] for s in allocations_config['stocks']]}")
        st.info(f"Final momentum windows: {allocations_config['momentum_windows']}")
        st.info(f"Final use_momentum: {allocations_config['use_momentum']}")
        st.info(f"Final threshold settings: use={allocations_config.get('use_minimal_threshold', False)}, percent={allocations_config.get('minimal_threshold_percent', 2.0)}")
        st.info(f"Final max allocation settings: use={allocations_config.get('use_max_allocation', False)}, percent={allocations_config.get('max_allocation_percent', 10.0)}")
    except json.JSONDecodeError:
        st.error("Invalid JSON format. Please check the text and try again.")
    except Exception as e:
        st.error(f"An error occurred: {e}")
    st.session_state.alloc_rerun_flag = True

def update_active_portfolio_index():
    # Allocation page: keep a page-scoped index. If a selector exists, respect it; otherwise default to 0
    selected_name = st.session_state.get('alloc_portfolio_selector', None)
    portfolio_configs = st.session_state.get('alloc_portfolio_configs', [])
    portfolio_names = [cfg.get('name', '') for cfg in portfolio_configs]
    if selected_name and selected_name in portfolio_names:
        st.session_state.alloc_active_portfolio_index = portfolio_names.index(selected_name)
    else:
        st.session_state.alloc_active_portfolio_index = 0 if portfolio_names else None
    
    # Update portfolio name input field to match the active portfolio
    if st.session_state.alloc_active_portfolio_index is not None and portfolio_configs:
        active_portfolio = portfolio_configs[st.session_state.alloc_active_portfolio_index]
        st.session_state.alloc_portfolio_name = active_portfolio.get('name', 'Allocation Portfolio')
    
    st.session_state.alloc_rerun_flag = True

def update_name():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['name'] = st.session_state.get('alloc_active_name', '')

def update_initial():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['initial_value'] = st.session_state.get('alloc_active_initial', 0)

def update_added_amount():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['added_amount'] = st.session_state.get('alloc_active_added_amount', 0)

def update_add_freq():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['added_frequency'] = st.session_state.get('alloc_active_add_freq', 'none')

def update_rebal_freq():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['rebalancing_frequency'] = st.session_state.get('alloc_active_rebal_freq', 'none')

def update_benchmark():
    # Convert benchmark ticker to uppercase and resolve alias
    benchmark_val = st.session_state.get('alloc_active_benchmark', '')
    # Convert commas to dots for decimal separators (like case conversion)
    converted_benchmark = benchmark_val.replace(",", ".")
    upper_benchmark = converted_benchmark.upper()
    # Keep original benchmark ticker in UI (NO conversion here)
    resolved_benchmark = upper_benchmark
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['benchmark_ticker'] = resolved_benchmark
    # Update the widget to show original ticker
    st.session_state['alloc_active_benchmark'] = resolved_benchmark

def update_use_momentum():
    current_val = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index].get('use_momentum', True)
    new_val = st.session_state.get('alloc_active_use_momentum', True)
    if current_val != new_val:
        st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['use_momentum'] = new_val
        if new_val:
            # When momentum is enabled, keep existing beta and volatility settings
            pass
            st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['momentum_windows'] = [
                {"lookback": 365, "exclude": 30, "weight": 0.5, "discard_if_negative": False, "discard_unless_recent_positive": False},
                {"lookback": 180, "exclude": 30, "weight": 0.3, "discard_if_negative": False, "discard_unless_recent_positive": False},
                {"lookback": 120, "exclude": 30, "weight": 0.2, "discard_if_negative": False, "discard_unless_recent_positive": False},
            ]
        else:
            st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['momentum_windows'] = []
        st.session_state.alloc_rerun_flag = True

def update_use_sma_filter():
    """Callback function for MA filter checkbox"""
    current_val = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index].get('use_sma_filter', False)
    new_val = st.session_state.alloc_active_use_sma_filter
    
    if current_val != new_val:
        portfolio = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]
        portfolio['use_sma_filter'] = new_val
        
        # If enabling MA filter, disable targeted rebalancing (mutually exclusive)
        if new_val:
            portfolio['use_targeted_rebalancing'] = False
            st.session_state['alloc_active_use_targeted_rebalancing'] = False
        
        st.session_state.alloc_rerun_flag = True

def update_use_targeted_rebalancing():
    """Callback function for targeted rebalancing checkbox - COPIED FROM PAGE 4"""
    current_val = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index].get('use_targeted_rebalancing', False)
    new_val = st.session_state.get('alloc_active_use_targeted_rebalancing', False)
    
    if current_val != new_val:
        portfolio = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]
        portfolio['use_targeted_rebalancing'] = new_val
        
        # If enabling targeted rebalancing, disable momentum and MA filter (mutually exclusive)
        if new_val:
            portfolio['use_momentum'] = False
            st.session_state['alloc_active_use_momentum'] = False
            portfolio['use_sma_filter'] = False
            st.session_state['alloc_active_use_sma_filter'] = False
        
        st.session_state.alloc_rerun_flag = True




def update_use_equal_weight():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['use_equal_weight'] = st.session_state.alloc_active_use_equal_weight

def update_equal_weight_n_tickers():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['equal_weight_n_tickers'] = st.session_state.alloc_active_equal_weight_n_tickers

def update_use_limit_to_top_n():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['use_limit_to_top_n'] = st.session_state.alloc_active_use_limit_to_top_n

def update_limit_to_top_n_tickers():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['limit_to_top_n_tickers'] = st.session_state.alloc_active_limit_to_top_n_tickers

def update_use_sector_concentration_limit():
    idx = st.session_state.alloc_active_portfolio_index
    st.session_state.alloc_portfolio_configs[idx]['use_sector_concentration_limit'] = st.session_state.alloc_active_use_sector_concentration_limit

def update_max_tickers_per_sector():
    idx = st.session_state.alloc_active_portfolio_index
    st.session_state.alloc_portfolio_configs[idx]['max_tickers_per_sector'] = st.session_state.alloc_active_max_tickers_per_sector

def update_use_industry_concentration_limit():
    idx = st.session_state.alloc_active_portfolio_index
    st.session_state.alloc_portfolio_configs[idx]['use_industry_concentration_limit'] = st.session_state.alloc_active_use_industry_concentration_limit

def update_max_tickers_per_industry():
    idx = st.session_state.alloc_active_portfolio_index
    st.session_state.alloc_portfolio_configs[idx]['max_tickers_per_industry'] = st.session_state.alloc_active_max_tickers_per_industry

def update_unknown_counts_as_category():
    idx = st.session_state.alloc_active_portfolio_index
    st.session_state.alloc_portfolio_configs[idx]['unknown_counts_as_category'] = st.session_state.alloc_active_unknown_counts_as_category

def update_exclude_before_sp500_entry():
    idx = st.session_state.alloc_active_portfolio_index
    st.session_state.alloc_portfolio_configs[idx]['exclude_before_sp500_entry'] = st.session_state.alloc_active_exclude_before_sp500_entry

def update_use_min_market_cap_filter():
    idx = st.session_state.alloc_active_portfolio_index
    st.session_state.alloc_portfolio_configs[idx]['use_min_market_cap_filter'] = st.session_state.alloc_active_use_min_market_cap_filter

def update_min_market_cap_billions():
    idx = st.session_state.alloc_active_portfolio_index
    st.session_state.alloc_portfolio_configs[idx]['min_market_cap_billions'] = st.session_state.alloc_active_min_market_cap_billions

def render_min_market_cap_filter_controls():
    portfolio = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]
    st.session_state["alloc_active_use_min_market_cap_filter"] = parse_bool_from_json(portfolio.get("use_min_market_cap_filter", False), False)
    try:
        st.session_state["alloc_active_min_market_cap_billions"] = float(portfolio.get("min_market_cap_billions", 10.0) or 10.0)
    except Exception:
        st.session_state["alloc_active_min_market_cap_billions"] = 10.0
    st.checkbox(
        "Exclude tickers below a market-cap threshold",
        key="alloc_active_use_min_market_cap_filter",
        on_change=update_use_min_market_cap_filter,
        help="At each rebalance, skip a ticker while estimated market cap is below the threshold. Uses today's Yahoo market cap (batched quote endpoint, 24h cache) scaled by the price history you already download: cap(date) ≈ cap_today × (price_date / price_today). Missing cap is excluded. Share issuance/buybacks make this a proxy, not CRSP.",
    )
    if st.session_state.get("alloc_active_use_min_market_cap_filter"):
        st.number_input(
            "Minimum market cap ($ billions)",
            min_value=0.1,
            max_value=10000.0,
            step=0.5,
            key="alloc_active_min_market_cap_billions",
            on_change=update_min_market_cap_billions,
            help="Example: 10 = only buy names whose estimated cap is at least $10 billion on that rebalance date.",
        )

def load_sp500_tickers_into_bulk_box():
    """Fill the bulk ticker box from Wikipedia. Runs as on_click so the widget key is set before render."""
    payload, err = fetch_sp500_wikipedia_constituents()
    if payload and payload.get("copy_string"):
        text = payload["copy_string"]
        st.session_state.alloc_bulk_tickers = text
        st.session_state.alloc_bulk_ticker_input = text
        st.session_state.alloc_sp500_load_error = None
    else:
        st.session_state.alloc_sp500_load_error = err or "Could not load Wikipedia S&P 500 list"


def load_us_market_tickers_into_bulk_box():
    """Fill the bulk ticker box from Nasdaq Trader. Runs as on_click so the widget key is set before render."""
    payload, err = fetch_us_listed_common_stocks()
    if payload and payload.get("copy_string"):
        text = payload["copy_string"]
        st.session_state.alloc_bulk_tickers = text
        st.session_state.alloc_bulk_ticker_input = text
        st.session_state.alloc_us_market_load_error = None
    else:
        st.session_state.alloc_us_market_load_error = err or "Could not load US listed common stocks"

def update_calc_beta():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['calc_beta'] = st.session_state.get('alloc_active_calc_beta', True)

def update_beta_window():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['beta_window_days'] = st.session_state.get('alloc_active_beta_window', 365)

def update_beta_exclude():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['exclude_days_beta'] = st.session_state.get('alloc_active_beta_exclude', 30)

def update_calc_vol():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['calc_volatility'] = st.session_state.get('alloc_active_calc_vol', True)

def update_vol_window():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['vol_window_days'] = st.session_state.get('alloc_active_vol_window', 365)

def update_vol_exclude():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['exclude_days_vol'] = st.session_state.get('alloc_active_vol_exclude', 30)

def update_use_threshold():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['use_minimal_threshold'] = st.session_state.alloc_active_use_threshold

def update_threshold_percent():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['minimal_threshold_percent'] = st.session_state.alloc_active_threshold_percent
def update_use_max_allocation():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['use_max_allocation'] = st.session_state.alloc_active_use_max_allocation

def update_max_allocation_percent():
    st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['max_allocation_percent'] = st.session_state.alloc_active_max_allocation_percent

# Sidebar simplified for single-portfolio allocation tracker
st.sidebar.title("Allocation Tracker")



# Work with the first portfolio as active (single-portfolio mode). Keep inputs accessible.
active_portfolio = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]
# Do not show portfolio name in allocation tracker. Keep a page-scoped session key for compatibility.
if "alloc_active_name" not in st.session_state:
    st.session_state["alloc_active_name"] = active_portfolio['name']

# Portfolio is always in USD - no currency selector needed
# Handle pending portfolio value updates from currency converter
if "_pending_portfolio_value" in st.session_state:
    st.session_state["alloc_active_initial"] = st.session_state["_pending_portfolio_value"]
    del st.session_state["_pending_portfolio_value"]

col_left, col_right = st.columns([1, 1])
with col_left:
    if "alloc_active_initial" not in st.session_state:
        # Treat this as the current portfolio value (not a backtest initial cash)
        st.session_state["alloc_active_initial"] = int(active_portfolio.get('initial_value', 0))
    
    # Portfolio value input - no currency specification, uses ticker's native currency
    st.number_input(
        "Portfolio Value",
        min_value=0,
        step=1000,
        format="%d",
        key="alloc_active_initial",
        on_change=update_initial,
        help="Total portfolio value. Shares are calculated using each ticker's price in its native currency (USD for US stocks, CAD for Canadian stocks, etc.). Use the currency converter below to convert from other currencies."
    )
    
    # Currency converter - convert and apply to portfolio value
    with st.expander("💱 Currency Converter", expanded=False):
        currency_options = ['CAD', 'EUR', 'GBP', 'JPY', 'AUD', 'CHF', 'USD']
        col_from, col_to = st.columns([1, 1])
        with col_from:
            from_curr = st.selectbox(
                "From Currency",
                currency_options,
                key="conv_from",
                index=0,  # Default to CAD
                help="Select the currency you want to convert from"
            )
        with col_to:
            to_curr = st.selectbox(
                "To Currency",
                currency_options,
                key="conv_to",
                index=6,  # Default to USD
                help="Select the currency you want to convert to"
            )
        
        conv_amount = st.number_input(
            "Amount",
            min_value=0,
            value=0,
            step=100,
            format="%d",
            key="conv_amount_input",
            help=f"Enter the amount in {from_curr} to convert to {to_curr}"
        )
        
        # Clear cache button
        if st.button("🗑️ Clear Exchange Rate Cache", key="clear_exchange_cache", help="Clear cached exchange rates to force fresh API calls"):
            cache_dir = '.streamlit/exchange_rate_cache'
            if os.path.exists(cache_dir):
                try:
                    disk_cache = dc.Cache(cache_dir)
                    disk_cache.clear()
                    # Set flag to force refresh on next call
                    st.session_state["_force_refresh_exchange_rate"] = True
                    st.success("✅ Exchange rate cache cleared! Refreshing rates...")
                    st.rerun()
                except Exception as e:
                    st.error(f"Error clearing cache: {e}")
            else:
                st.info("Cache directory does not exist (no cache to clear)")
        
        # Auto-convert and display result (only if amount > 0)
        if conv_amount > 0:
            try:
                # Check if we need to force refresh (but don't delete cache here - let get_exchange_rate handle it)
                force_refresh = st.session_state.get("_force_refresh_exchange_rate", False)
                if force_refresh:
                    # Clear the flag
                    del st.session_state["_force_refresh_exchange_rate"]
                
                # Get exchange rate (will use cache if available, otherwise fetch from API)
                # Pass force_refresh flag to get_exchange_rate if needed
                # Cache is valid for 4 hours, so no unnecessary API calls
                rate_result = get_exchange_rate(from_curr, to_curr, force_refresh=force_refresh)
                # Extract rate, date, and cache status
                if isinstance(rate_result, tuple) and len(rate_result) >= 2:
                    rate = float(rate_result[0])
                    rate_date = rate_result[1]
                    from_cache = rate_result[2] if len(rate_result) >= 3 else False
                else:
                    # Fallback if not a tuple
                    rate = float(rate_result) if not isinstance(rate_result, tuple) else float(rate_result[0])
                    rate_date = datetime.now()
                    from_cache = False
                
                # Ensure rate is a float
                rate = float(rate)
                converted = convert_currency(conv_amount, from_curr, to_curr)
                
                # Ensure converted is a float
                converted = float(converted)
                
                # Format date
                if isinstance(rate_date, pd.Timestamp):
                    rate_date_str = rate_date.strftime("%Y-%m-%d %H:%M:%S")
                elif hasattr(rate_date, 'strftime'):
                    rate_date_str = rate_date.strftime("%Y-%m-%d %H:%M:%S")
                else:
                    rate_date_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                
                # Display cache status
                cache_status = "✅ Using cache" if from_cache else "🔄 Live rate"
                
                st.info(f"**{conv_amount:,} {from_curr} = {converted:,.2f} {to_curr}**\n\n"
                       f"Rate: 1 {from_curr} = {rate:.4f} {to_curr}\n"
                       f"Rate Date: {rate_date_str}\n"
                       f"Status: {cache_status}")
                
                # Button to use converted value as portfolio value
                if st.button(f"Use {converted:,.2f} {to_curr} as Portfolio Value", key="use_converted"):
                    # Store value in temporary key that will be used on next rerun
                    st.session_state["_pending_portfolio_value"] = int(converted)
                    st.rerun()
            except Exception as e:
                st.error(f"Conversion error: {e}")
        else:
            st.caption("Enter an amount above to see the conversion")

# Removed Added Amount / Added Frequency UI - allocation tracker is not running periodic additions

# Swap positions: show Rebalancing Frequency first, then Added Frequency.
# Use two equal-width columns and make selectboxes use the container width so they match visually.
col_freq_rebal, col_freq_add = st.columns([1, 1])
freq_options = ["Never", "Weekly", "Biweekly", "Monthly", "Quarterly", "Semiannually", "Annually"]
with col_freq_rebal:
    if "alloc_active_rebal_freq" not in st.session_state:
        st.session_state["alloc_active_rebal_freq"] = active_portfolio['rebalancing_frequency']
    st.selectbox("Rebalancing Frequency", freq_options, key="alloc_active_rebal_freq", on_change=update_rebal_freq, help="How often the portfolio is rebalanced.")
# Note: Added Frequency removed for allocation tracker

# Rebalancing and Added Frequency explanation removed for allocation tracker UI

if "alloc_active_benchmark" not in st.session_state:
    st.session_state["alloc_active_benchmark"] = active_portfolio['benchmark_ticker']
st.text_input("Benchmark Ticker (default: ^GSPC, starts 1927-12-30, used for beta calculation. Use SPYSIM for earlier dates, starts 1885-03-01)", key="alloc_active_benchmark", on_change=update_benchmark)

st.subheader("Tickers")
col_ticker_buttons = st.columns([0.3, 0.3, 0.3, 0.1])
with col_ticker_buttons[0]:
    if st.button("Normalize Tickers %", on_click=normalize_stock_allocations_callback, use_container_width=True):
        pass
with col_ticker_buttons[1]:
    if st.button("Equal Allocation %", on_click=equal_stock_allocation_callback, use_container_width=True):
        pass
with col_ticker_buttons[2]:
    if st.button("Reset Tickers", on_click=reset_stock_selection_callback, use_container_width=True):
        pass

# Calculate live total ticker allocation
valid_tickers = [s for s in st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'] if s['ticker']]
total_ticker_allocation = sum(s['allocation'] for s in valid_tickers)

if active_portfolio['use_momentum']:
    st.info("Ticker allocations are not used directly for Momentum strategies.")
else:
    if abs(total_ticker_allocation - 1.0) > 0.001:
        st.warning(f"Total ticker allocation is {total_ticker_allocation*100:.2f}%, not 100%. Click 'Normalize' to fix.")
    else:
        st.success(f"Total ticker allocation is {total_ticker_allocation*100:.2f}%.")

def update_stock_allocation(index):
    try:
        key = f"alloc_input_alloc_{st.session_state.alloc_active_portfolio_index}_{index}"
        val = st.session_state.get(key, None)
        if val is None:
            return
        st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'][index]['allocation'] = float(val) / 100.0
    except Exception:
        # Ignore transient errors (e.g., active_portfolio_index changed); UI will reflect state on next render
        return


def update_stock_ticker(index):
    try:
        key = f"alloc_ticker_{st.session_state.alloc_active_portfolio_index}_{index}"
        val = st.session_state.get(key, None)
        if val is None:
            # key not yet initialized (race condition). Skip update; the widget's key will be present on next rerender.
            return
        
        
        # Convert commas to dots for decimal separators (like case conversion)
        converted_val = val.replace(",", ".")
        
        # Convert the input value to uppercase
        upper_val = converted_val.upper()
        
        # Special conversion for Berkshire Hathaway tickers for Yahoo Finance compatibility
        if upper_val == 'BRK.B':
            upper_val = 'BRK-B'
        elif upper_val == 'BRK.A':
            upper_val = 'BRK-A'

        # CRITICAL: Keep original ticker for backtest (don't resolve aliases for portfolio)
        original_ticker = upper_val
        
        # Update the portfolio configuration with the original ticker (with leverage/expense)
        st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'][index]['ticker'] = original_ticker
        
        # IMPORTANT: Force UI update by setting the widget's session_state value
        # This ensures the original ticker is displayed immediately in the text_input
        st.session_state[key] = original_ticker
        
        # Auto-disable dividends for negative leverage (inverse ETFs)
        if '?L=-' in original_ticker:
            st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'][index]['include_dividends'] = False
            # Also update the checkbox UI state
            div_key = f"alloc_div_{st.session_state.alloc_active_portfolio_index}_{index}"
            st.session_state[div_key] = False
        
        # Use the EXACT same method as "Special Long-Term Tickers" buttons (line 10001)
        # Set rerun flag instead of calling st.rerun() directly
        st.session_state.alloc_rerun_flag = True
    except Exception:
        # Defensive: if portfolio index or structure changed, skip silently
        return


def update_ma_reference_ticker(stock_index):
    """Callback function when MA reference ticker changes"""
    ma_ref_key = f"alloc_ma_reference_{st.session_state.alloc_active_portfolio_index}_{stock_index}"
    new_value = st.session_state.get(ma_ref_key, '').strip()
    
    # Apply EXACTLY the same transformations as regular tickers
    # Convert commas to dots for decimal separators
    new_value = new_value.replace(",", ".")
    
    # Convert to uppercase
    new_value = new_value.upper()
    
    # Special conversion for Berkshire Hathaway tickers for Yahoo Finance compatibility
    if new_value == 'BRK.B':
        new_value = 'BRK-B'
    elif new_value == 'BRK.A':
        new_value = 'BRK-A'
    
    # CRITICAL: Keep original ticker for backtest (don't resolve aliases for portfolio)
    if new_value:  # Only process if not empty
        original_value = new_value
    else:
        original_value = new_value
    
    # Update session state with original value for display
    st.session_state[ma_ref_key] = original_value
    
    # Update the stock config
    portfolio = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]
    if stock_index < len(portfolio['stocks']):
        old_value = portfolio['stocks'][stock_index].get('ma_reference_ticker', '')
        if original_value != old_value:
            portfolio['stocks'][stock_index]['ma_reference_ticker'] = original_value
            st.session_state.alloc_rerun_flag = True


def update_stock_dividends(index):
    try:
        key = f"alloc_div_{st.session_state.alloc_active_portfolio_index}_{index}"
        val = st.session_state.get(key, None)
        if val is None:
            return
        st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'][index]['include_dividends'] = bool(val)
    except Exception:
        return

# Update active_portfolio
active_portfolio = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]

# Initialize MA filter state
if "alloc_active_use_sma_filter" not in st.session_state:
    st.session_state["alloc_active_use_sma_filter"] = active_portfolio.get('use_sma_filter', False)
if "alloc_active_sma_window" not in st.session_state:
    st.session_state["alloc_active_sma_window"] = active_portfolio.get('sma_window', 200)
 
for i in range(len(active_portfolio['stocks'])):
    stock = active_portfolio['stocks'][i]
    col_t, col_a, col_d, col_sma, col_b = st.columns([0.2, 0.2, 0.25, 0.25, 0.1])
    with col_t:
        ticker_key = f"alloc_ticker_{st.session_state.alloc_active_portfolio_index}_{i}"
        # Always sync the session state with the portfolio config to show resolved ticker
        st.session_state[ticker_key] = stock['ticker']
        st.text_input("Ticker", key=ticker_key, label_visibility="visible", on_change=update_stock_ticker, args=(i,))
    with col_a:
        use_mom = st.session_state.get('alloc_active_use_momentum', active_portfolio.get('use_momentum', True))
        if not use_mom:
            alloc_key = f"alloc_input_alloc_{st.session_state.alloc_active_portfolio_index}_{i}"
            if alloc_key not in st.session_state:
                st.session_state[alloc_key] = int(stock['allocation'] * 100)
            st.number_input("Allocation %", min_value=0, step=1, format="%d", key=alloc_key, label_visibility="visible", on_change=update_stock_allocation, args=(i,))
            if st.session_state[alloc_key] != int(stock['allocation'] * 100):
                st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'][i]['allocation'] = st.session_state[alloc_key] / 100.0
        else:
            # Show Max Cap % field when momentum is active
            max_cap_key = f"alloc_max_cap_{st.session_state.alloc_active_portfolio_index}_{i}"
            # Ensure max_allocation_percent key exists
            if 'max_allocation_percent' not in stock:
                stock['max_allocation_percent'] = None
            
            if max_cap_key not in st.session_state:
                st.session_state[max_cap_key] = int(stock['max_allocation_percent']) if stock['max_allocation_percent'] is not None else 0
            
            max_cap_value = st.number_input(
                "Max Cap %", 
                min_value=0, 
                max_value=100,
                step=1, 
                format="%d", 
                key=max_cap_key, 
                label_visibility="visible",
                help="Individual cap for this ticker (0 = no cap, uses global cap if enabled). This overrides the Min and Max Threshold filters for this specific ticker."
            )
            
            # Update the portfolio config
            if max_cap_value > 0:
                st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'][i]['max_allocation_percent'] = float(max_cap_value)
            else:
                st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'][i]['max_allocation_percent'] = None
    with col_d:
        div_key = f"alloc_div_{st.session_state.alloc_active_portfolio_index}_{i}"
        # Ensure include_dividends key exists with default value
        if 'include_dividends' not in stock:
            stock['include_dividends'] = True
        
        # Auto-disable dividends for negative leverage (inverse ETFs) ONLY on first display
        # Don't override if user has explicitly set a value
        if '?L=-' in stock['ticker'] and div_key not in st.session_state:
            stock['include_dividends'] = False
        
        if div_key not in st.session_state:
            st.session_state[div_key] = stock['include_dividends']
        st.checkbox("Reinvest Dividends", key=div_key)
        if st.session_state[div_key] != stock['include_dividends']:
            st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'][i]['include_dividends'] = st.session_state[div_key]
        
    with col_sma:
        # MA Filter selection - EXACT SAME LOGIC AS PAGE 1
        if st.session_state.get("alloc_active_use_sma_filter", False):
            sma_key = f"alloc_include_sma_{st.session_state.alloc_active_portfolio_index}_{i}"
            # Ensure include_in_sma_filter key exists with default value
            if 'include_in_sma_filter' not in stock:
                stock['include_in_sma_filter'] = True
            
            if sma_key not in st.session_state:
                st.session_state[sma_key] = stock['include_in_sma_filter']
            st.checkbox("Include in MA Filter", key=sma_key, help="Uncheck to exclude this ticker from the Moving Average filter")
            if st.session_state[sma_key] != stock['include_in_sma_filter']:
                st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'][i]['include_in_sma_filter'] = st.session_state[sma_key]
            
            # MA Reference Ticker - allows using another ticker's MA for filtering
            ma_ref_key = f"alloc_ma_reference_{st.session_state.alloc_active_portfolio_index}_{i}"
            if 'ma_reference_ticker' not in stock:
                stock['ma_reference_ticker'] = ""  # Empty = use own ticker
            
            if ma_ref_key not in st.session_state:
                st.session_state[ma_ref_key] = stock.get('ma_reference_ticker', '')
            
            # Always sync the session state with the portfolio config to show resolved ticker
            st.session_state[ma_ref_key] = stock.get('ma_reference_ticker', '')
            
            st.text_input(
                "MA Reference Ticker",
                key=ma_ref_key,
                placeholder=f"Leave empty for {stock['ticker']}",
                help=f"Optional: Use another ticker's MA (e.g., SPY for SSO, QQQ for TQQQ). Leave empty to use {stock['ticker']}'s own MA.",
                label_visibility="visible",
                on_change=update_ma_reference_ticker,
                args=(i,)
            )
            
            if st.session_state[ma_ref_key] != stock.get('ma_reference_ticker', ''):
                st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]['stocks'][i]['ma_reference_ticker'] = st.session_state[ma_ref_key]
            
        else:
            st.write("")
        
    with col_b:
        st.write("")
        if st.button("Remove", key=f"alloc_rem_stock_{st.session_state.alloc_active_portfolio_index}_{i}_{stock['ticker']}_{id(stock)}", on_click=remove_stock_callback, args=(stock['ticker'],)):
            pass

if st.button("Add Ticker", on_click=add_stock_callback):
    pass

# Bulk Leverage Controls
with st.expander("🔧 Bulk Leverage Controls", expanded=False):
    def apply_bulk_leverage_callback():
        """Apply leverage and expense ratio to selected tickers in the current portfolio"""
        try:
            portfolio_index = st.session_state.alloc_active_portfolio_index
            portfolio = st.session_state.alloc_portfolio_configs[portfolio_index]
            
            leverage_value = st.session_state.get('bulk_leverage_value', 1.0)
            expense_ratio_value = st.session_state.get('bulk_expense_ratio_value', 1.0)
            selected_tickers = st.session_state.get('bulk_selected_tickers', [])
            
            # Check if any tickers are selected
            if not selected_tickers:
                st.toast("⚠️ Please select at least one ticker to apply leverage to.")
                return
            
            applied_count = 0
            for i, stock in enumerate(portfolio['stocks']):
                current_ticker = stock['ticker']
                
                # Check if this ticker should be modified
                base_ticker, _, _ = parse_ticker_parameters(current_ticker)
                if base_ticker in selected_tickers or current_ticker in selected_tickers:
                    # Parse current ticker to get base ticker
                    base_ticker, _, _ = parse_ticker_parameters(current_ticker)
                    
                    # Create new ticker with leverage and expense ratio
                    new_ticker = base_ticker
                    if leverage_value != 1.0:
                        new_ticker += f"?L={leverage_value}"
                    if expense_ratio_value != 0.0:
                        new_ticker += f"?E={expense_ratio_value}"
                    
                    # Update the ticker in the portfolio
                    st.session_state.alloc_portfolio_configs[portfolio_index]['stocks'][i]['ticker'] = new_ticker
                    
                    # Update the session state for the text input
                    ticker_key = f"alloc_ticker_{portfolio_index}_{i}"
                    st.session_state[ticker_key] = new_ticker
                    
                    # If leverage is negative (short position), uncheck dividends checkbox
                    # User can manually re-check it if desired
                    if leverage_value < 0:
                        st.session_state.alloc_portfolio_configs[portfolio_index]['stocks'][i]['include_dividends'] = False
                        div_key = f"alloc_div_{portfolio_index}_{i}"
                        st.session_state[div_key] = False
                    
                    applied_count += 1
            
            if applied_count > 0:
                st.toast(f"✅ Applied {leverage_value}x leverage and {expense_ratio_value}% expense ratio to {applied_count} ticker(s)!")
            else:
                st.warning("⚠️ No tickers were selected for modification.")
            
        except Exception as e:
            st.error(f"Error applying bulk leverage: {str(e)}")

    def remove_bulk_leverage_callback():
        """Remove all leverage and expense ratio from selected tickers"""
        try:
            portfolio_index = st.session_state.alloc_active_portfolio_index
            portfolio = st.session_state.alloc_portfolio_configs[portfolio_index]
            selected_tickers = st.session_state.get('bulk_selected_tickers', [])
            
            # Check if any tickers are selected
            if not selected_tickers:
                st.toast("⚠️ Please select at least one ticker to remove leverage from.")
                return
            
            removed_count = 0
            for i, stock in enumerate(portfolio['stocks']):
                current_ticker = stock['ticker']
                
                # Check if this ticker should be modified
                base_ticker, _, _ = parse_ticker_parameters(current_ticker)
                if base_ticker in selected_tickers or current_ticker in selected_tickers:
                    # Parse current ticker to get base ticker
                    base_ticker, _, _ = parse_ticker_parameters(current_ticker)
                    
                    # Update the ticker to base ticker (no leverage, no expense ratio)
                    st.session_state.alloc_portfolio_configs[portfolio_index]['stocks'][i]['ticker'] = base_ticker
                    
                    # Update the session state for the text input
                    ticker_key = f"alloc_ticker_{portfolio_index}_{i}"
                    st.session_state[ticker_key] = base_ticker
                    
                    removed_count += 1
            
            if removed_count > 0:
                st.toast(f"✅ Removed leverage and expense ratio from {removed_count} ticker(s)!")
            else:
                st.warning("⚠️ No tickers were selected for modification.")
            
        except Exception as e:
            st.error(f"Error removing leverage: {str(e)}")

    # Get current portfolio tickers for selection
    portfolio_index = st.session_state.alloc_active_portfolio_index
    portfolio = st.session_state.alloc_portfolio_configs[portfolio_index]
    available_tickers = [stock['ticker'] for stock in portfolio['stocks']]
    
    # Initialize selected tickers if not exists
    if 'bulk_selected_tickers' not in st.session_state:
        st.session_state.bulk_selected_tickers = []
    
    # Ticker selection interface
    st.markdown("**Select Tickers to Modify:**")
    
    # Quick selection buttons
    col_quick1, col_quick2 = st.columns([1, 1])
    
    with col_quick1:
        if st.button("Select All", key="page2_select_all_tickers", use_container_width=True):
            st.session_state.bulk_selected_tickers = available_tickers.copy()
            st.rerun()
    
    with col_quick2:
        if st.button("Clear Selection", key="page2_clear_all_tickers", use_container_width=True):
            st.session_state.bulk_selected_tickers = []
            st.rerun()
    
    # Individual ticker selection
    if available_tickers:
        st.markdown("**Individual Ticker Selection:**")
        
        # Create checkboxes for each ticker
        for i, ticker in enumerate(available_tickers):
            base_ticker, leverage, expense = parse_ticker_parameters(ticker)
            display_text = f"{base_ticker}"
            if leverage != 1.0 or expense > 0.0:
                display_text += f" (L:{leverage}x, E:{expense}%)"
            
            # Use checkbox state directly
            checkbox_key = f"page2_bulk_ticker_select_{i}"
            is_checked = st.checkbox(
                display_text, 
                value=ticker in st.session_state.bulk_selected_tickers,
                key=checkbox_key
            )
            
            # Update selection based on checkbox state
            if is_checked and ticker not in st.session_state.bulk_selected_tickers:
                st.session_state.bulk_selected_tickers.append(ticker)
            elif not is_checked and ticker in st.session_state.bulk_selected_tickers:
                st.session_state.bulk_selected_tickers.remove(ticker)
    else:
        st.info("No tickers available in the current portfolio.")
    
    # Show selected tickers count
    selected_count = len(st.session_state.bulk_selected_tickers)
    if selected_count > 0:
        st.success(f"📊 {selected_count} ticker(s) selected for bulk operations")
    else:
        st.warning("⚠️ No tickers selected - please select tickers before applying bulk operations")

    # Bulk leverage controls
    st.markdown("---")
    st.markdown("**Leverage & Expense Ratio Settings:**")
    
    col1, col2, col3, col4 = st.columns([1.2, 1.2, 1, 1])

    with col1:
        st.number_input(
            "Leverage",
            value=2.0,
            step=0.1,
            format="%.1f",
            key="bulk_leverage_value",
            help="Leverage multiplier (e.g., 2.0 for 2x leverage, -3.0 for -3x inverse)"
        )

    with col2:
        st.number_input(
            "Expense Ratio (%)",
            value=1.0,
            step=0.01,
            format="%.2f",
            key="bulk_expense_ratio_value",
            help="Annual expense ratio in percentage (e.g., 0.84 for 0.84%, can be negative)"
        )

    with col3:
        if st.button("Apply to Selected", on_click=apply_bulk_leverage_callback, type="primary"):
            pass

    with col4:
        if st.button("Remove from Selected", on_click=remove_bulk_leverage_callback, type="secondary"):
            pass


# Special tickers and leverage guide sections
with st.expander("🍁 Canadian Tickers & Custom Mappings", expanded=False):
    st.markdown("### 🍁 Compatible Canadian Tickers (30+ companies)")
    st.markdown("""
    **Retail & Food:**
    - **DLMAF** → DOL.TO (Dollarama), **LBLCF** → L.TO (Loblaw)
    - **ANCTF** → ATD.TO (Couche-Tard), **MRU** → MRU.TO (Metro)
    
    **Tech & Software:**
    - **CNSWF** → CSU.TO (Constellation), **TOITF** → TOI.V (Topicus), **LMGIF** → LMN.V (Lumine)
    - **CLS** → CLS.TO (Celestica), **CGI** → GIB-A.TO (CGI), **DSGX** → DSG.TO (Descartes)
    - **MDALF** → MDA.TO (MDA)
    
    **Finance & Investment:**
    - **BN** → BN.TO (Brookfield Corp), **BAM** → BAM.TO (Brookfield Asset Mgmt)
    - **FRFHF** → FFH.TO (Fairfax), **POW/PWCDF** → POW.TO (Power Corp)
    
    **Energy & Infrastructure:**
    - **ENB** → ENB.TO (Enbridge), **TRP** → TRP.TO (TC Energy)
    - **CNQ** → CNQ.TO (Canadian Natural), **SU** → SU.TO (Suncor)
    
    **Transportation:**
    - **CP** → CP.TO (Canadian Pacific), **CNI** → CNR.TO (Canadian National)
    
    **Crypto Mining:**
    - **BITF** → BITF.TO (Bitfarms)
    
    **Big 6 Banks:**
    - **RY** → RY.TO (Royal), **TD** → TD.TO (TD Bank), **BNS** → BNS.TO (Scotiabank)
    - **BMO** → BMO.TO (BMO), **CM** → CM.TO (CIBC), **NA** → NA.TO (National Bank)
    """)
    
    st.markdown("---")
    st.markdown("### ➕ Add Custom Canadian Ticker Mapping")
    st.markdown("Add a ticker mapping for this backtest session (e.g., Power Corp: POW.TO)")
    
    col1, col2, col3 = st.columns([2, 2, 1])
    with col1:
        custom_usd = st.text_input("USD/OTC Ticker (e.g., PWCDF or POW)", key="alloc_custom_usd_ticker", help="Ticker you'll use in portfolio")
    with col2:
        custom_cad = st.text_input("TSX Ticker (e.g., POW.TO)", key="alloc_custom_cad_ticker", help="Corresponding TSX ticker for data")
    with col3:
        st.markdown("<br>", unsafe_allow_html=True)
        if st.button("Add Mapping", key="alloc_add_custom_mapping", type="primary"):
            if custom_usd and custom_cad:
                # Initialize custom mappings in session state if not exists
                if 'alloc_custom_ticker_mappings' not in st.session_state:
                    st.session_state.alloc_custom_ticker_mappings = {}
                
                # Add the mapping
                st.session_state.alloc_custom_ticker_mappings[custom_usd.upper()] = custom_cad.upper()
                st.success(f"✅ Added: {custom_usd.upper()} → {custom_cad.upper()}")
                st.rerun()
            else:
                st.warning("⚠️ Please fill both fields")
    
    # Display current custom mappings
    if 'alloc_custom_ticker_mappings' in st.session_state and st.session_state.alloc_custom_ticker_mappings:
        st.markdown("**Current Custom Mappings:**")
        for usd_tick, cad_tick in st.session_state.alloc_custom_ticker_mappings.items():
            col_a, col_b = st.columns([4, 1])
            with col_a:
                st.text(f"• {usd_tick} → {cad_tick}")
            with col_b:
                if st.button("🗑️", key=f"alloc_remove_{usd_tick}", help="Remove mapping"):
                    del st.session_state.alloc_custom_ticker_mappings[usd_tick]
                    st.rerun()

# Special Tickers Section
if 'alloc_special_tickers_force_open_once' not in st.session_state:
    st.session_state.alloc_special_tickers_force_open_once = False

force_open_special_tickers = st.session_state.alloc_special_tickers_force_open_once

with st.expander("🎯 Special Long-Term Tickers", expanded=force_open_special_tickers):
    st.markdown("**Quick access to ticker aliases that the system accepts:**")
    
    # Get the actual ticker aliases from the function
    aliases = get_ticker_aliases()
    
    col1, col2, col3 = st.columns(3)
    
    with col1:
        st.markdown("**📈 Stock Indices**")
        stock_mapping = {
            'S&P 500 (No Dividend) (1927+)': ('SPYND', '^GSPC'),
            'S&P 500 (Total Return) (1988+)': ('SPYTR', '^SP500TR'), 
            'NASDAQ (No Dividend) (1971+)': ('QQQND', '^IXIC'),
            'NASDAQ 100 (1985+)': ('NDX', '^NDX'),
            'Dow Jones (1992+)': ('DOW', '^DJI')
        }
        
        for name, (alias, ticker) in stock_mapping.items():
            if st.button(f"➕ {name}", key=f"add_stock_{ticker}", help=f"Add {alias} → {ticker}"):
                # Ensure portfolio configs exist
                if 'alloc_portfolio_configs' not in st.session_state:
                    st.session_state.alloc_portfolio_configs = default_configs
                if 'alloc_active_portfolio_index' not in st.session_state:
                    st.session_state.alloc_active_portfolio_index = 0
                
                portfolio_index = st.session_state.alloc_active_portfolio_index
                # Keep original ticker for backtest (don't resolve aliases for portfolio)
                original_ticker = alias
                st.session_state.alloc_portfolio_configs[portfolio_index]['stocks'].append({
                    'ticker': original_ticker,  # Add the original ticker for backtest
                    'allocation': 0.0, 
                    'include_dividends': True,
                    'include_in_sma_filter': True,
                    'max_allocation_percent': None
                })
                # Keep expander open and rerun immediately
                st.session_state.alloc_special_tickers_force_open_once = True
                st.rerun()
    
    with col2:
        st.markdown("**🏭 Sector Indices**")
        sector_mapping = {
            'Technology (XLK) (1990+)': ('XLKND', '^SP500-45'),
            'Healthcare (XLV) (1990+)': ('XLVND', '^SP500-35'),
            'Consumer Staples (XLP) (1990+)': ('XLPND', '^SP500-30'),
            'Financials (XLF) (1990+)': ('XLFND', '^SP500-40'),
            'Energy (XLE) (1990+)': ('XLEND', '^SP500-10'),
            'Industrials (XLI) (1990+)': ('XLIND', '^SP500-20'),
            'Consumer Discretionary (XLY) (1990+)': ('XLYND', '^SP500-25'),
            'Materials (XLB) (1990+)': ('XLBND', '^SP500-15'),
            'Utilities (XLU) (1990+)': ('XLUND', '^SP500-55'),
            'Real Estate (XLRE) (1990+)': ('XLREND', '^SP500-60'),
            'Communication Services (XLC) (1990+)': ('XLCND', '^SP500-50')
        }
        
        for name, (alias, ticker) in sector_mapping.items():
            if st.button(f"➕ {name}", key=f"add_sector_{ticker}", help=f"Add {alias} → {ticker}"):
                 # Ensure portfolio configs exist
                 if 'alloc_portfolio_configs' not in st.session_state:
                     st.session_state.alloc_portfolio_configs = default_configs
                 if 'alloc_active_portfolio_index' not in st.session_state:
                     st.session_state.alloc_active_portfolio_index = 0
                 
                 portfolio_index = st.session_state.alloc_active_portfolio_index
                 # Keep original ticker for backtest (don't resolve aliases for portfolio)
                 original_ticker = alias
                 st.session_state.alloc_portfolio_configs[portfolio_index]['stocks'].append({
                     'ticker': original_ticker,  # Add the original ticker for backtest
                     'allocation': 0.0, 
                     'include_dividends': True
                 })
                 st.session_state.alloc_special_tickers_force_open_once = True
                 st.rerun()
    
    with col3:
        st.markdown("**🔬 Synthetic Tickers**")
        synthetic_tickers = {
            # Ordered by asset class: Stocks → Bonds → Gold → Managed Futures → Bitcoin
            'Complete S&P 500 Simulation (1885+)': ('SPYSIM', 'SPYSIM_COMPLETE'),
            'Dynamic S&P 500 Top 20 (Historical)': ('SP500TOP20', 'SP500TOP20'),
            'Cash Simulator (ZEROX)': ('ZEROX', 'ZEROX'),
            'Complete TBILL Dataset (1948+)': ('TBILL', 'TBILL_COMPLETE'),
            'Complete IEF Dataset (1962+)': ('IEFTR', 'IEF_COMPLETE'),
            'Complete TLT Dataset (1962+)': ('TLTTR', 'TLT_COMPLETE'),
            'Complete ZROZ Dataset (1962+)': ('ZROZX', 'ZROZ_COMPLETE'),
            'Complete Gold Simulation (1968+)': ('GOLDSIM', 'GOLDSIM_COMPLETE'),
            'Complete Gold Dataset (1975+)': ('GOLDX', 'GOLD_COMPLETE'),
            'Complete KMLM Dataset (1992+)': ('KMLMX', 'KMLM_COMPLETE'),
            'Complete DBMF Dataset (2000+)': ('DBMFX', 'DBMF_COMPLETE'),
            'Complete Bitcoin Dataset (2010+)': ('BITCOINX', 'BTC_COMPLETE'),
            
            # Leveraged & Inverse ETFs (Synthetic) - NASDAQ-100 versions
            'Simulated TQQQ (3x QQQ) (1985+)': ('TQQQND', '^NDX?L=3?E=0.95'),
            'Simulated QLD (2x QQQ) (1985+)': ('QLDND', '^NDX?L=2?E=0.95'),
            'Simulated PSQ (-1x QQQ) (1985+)': ('PSQND', '^NDX?L=-1?E=0.95'),
            'Simulated QID (-2x QQQ) (1985+)': ('QIDND', '^NDX?L=-2?E=0.95'),
            'Simulated SQQQ (-3x QQQ) (1985+)': ('SQQQND', '^NDX?L=-3?E=0.95'),
            
            # Leveraged & Inverse ETFs (Synthetic) - NASDAQ Composite versions (longer history)
            'Simulated TQQQ-IXIC (3x IXIC) (1971+)': ('TQQQIXIC', '^IXIC?L=3?E=0.95'),
            'Simulated QLD-IXIC (2x IXIC) (1971+)': ('QLDIXIC', '^IXIC?L=2?E=0.95'),
            'Simulated PSQ-IXIC (-1x IXIC) (1971+)': ('PSQIXIC', '^IXIC?L=-1?E=0.95'),
            'Simulated QID-IXIC (-2x IXIC) (1971+)': ('QIDIXIC', '^IXIC?L=-2?E=0.95'),
            'Simulated SQQQ-IXIC (-3x IXIC) (1971+)': ('SQQQIXIC', '^IXIC?L=-3?E=0.95'),
            
            # S&P 500 leveraged/inverse (unchanged)
            'Simulated SPXL (3x SPY) (1988+)': ('SPXLTR', '^SP500TR?L=3?E=1.00'),
            'Simulated UPRO (3x SPY) (1988+)': ('UPROTR', '^SP500TR?L=3?E=0.91'),
            'Simulated SSO (2x SPY) (1988+)': ('SSOTR', '^SP500TR?L=2?E=0.91'),
            'Simulated SH (-1x SPY) (1927+)': ('SHND', '^GSPC?L=-1?E=0.89'),
            'Simulated SDS (-2x SPY) (1927+)': ('SDSND', '^GSPC?L=-2?E=0.91'),
            'Simulated SPXU (-3x SPY) (1927+)': ('SPXUND', '^GSPC?L=-3?E=1.00')
        }
        
        for name, (alias, ticker) in synthetic_tickers.items():
            # Custom help text for different ticker types
            if alias == 'SP500TOP20':
                help_text = "Add SP500TOP20 → SP500TOP20 - BETA ticker: Dynamic portfolio of top 20 S&P 500 companies rebalanced annually based on historical market cap data"
            elif alias == 'ZEROX':
                help_text = "Add ZEROX → ZEROX - Cash Simulator: Simulates a cash position that does nothing (no price movement, no dividends)"
            elif 'IXIC' in ticker:
                # Special warning for IXIC versions
                help_text = f"Add {alias} → {ticker} ⚠️ WARNING: This tracks NASDAQ Composite (broader index), NOT NASDAQ-100 like the real ETF!"
            else:
                help_text = f"Add {alias} → {ticker}"
            
            if st.button(f"➕ {name}", key=f"add_synthetic_{ticker}", help=help_text):
                # Ensure portfolio configs exist
                if 'alloc_portfolio_configs' not in st.session_state:
                    st.session_state.alloc_portfolio_configs = default_configs
                if 'alloc_active_portfolio_index' not in st.session_state:
                    st.session_state.alloc_active_portfolio_index = 0
                
                portfolio_index = st.session_state.alloc_active_portfolio_index
                # Keep original ticker for backtest (don't resolve aliases for portfolio)
                original_ticker = alias
                # Auto-disable dividends for negative leverage (inverse ETFs)
                include_divs = False if '?L=-' in original_ticker else True
                st.session_state.alloc_portfolio_configs[portfolio_index]['stocks'].append({
                    'ticker': original_ticker,  # Add the original ticker
                    'allocation': 0.0, 
                    'include_dividends': include_divs,
                    'include_in_sma_filter': True,
                    'max_allocation_percent': None
                })
                # Keep expander open and rerun immediately
                st.session_state.alloc_special_tickers_force_open_once = True
                st.rerun()
    
    st.markdown("---")
    
    # Ticker Aliases Section INSIDE the expander
    st.markdown("**💡 Ticker Aliases:** You can also use these shortcuts in the text input below:")
    st.markdown("- `SPX` → `^GSPC` (S&P 500 Price, 1927+), `SPXTR` → `^SP500TR` (S&P 500 Total Return, 1988+)")
    st.markdown("- `SPYTR` → `^SP500TR` (S&P 500 Total Return, 1988+), `QQQTR` → `^NDX` (NASDAQ 100, 1985+)")
    st.markdown("- `TLTETF` → `TLT` (20+ Year Treasury ETF, 2002+), `IEFETF` → `IEF` (7-10 Year Treasury ETF, 2002+)")
    st.markdown("- `ZROZX` → `ZROZ` (25+ Year Zero Coupon Treasury, 2009+), `GOVZTR` → `GOVZ` (25+ Year Treasury STRIPS, 2020+)")
    st.markdown("- `TNX` → `^TNX` (10Y Treasury Yield, 1962+), `TYX` → `^TYX` (30Y Treasury Yield, 1977+)")
    st.markdown("- `TBILL3M` → `^IRX` (3M Treasury Yield, 1960+), `SHY` → `SHY` (1-3 Year Treasury ETF, 2002+)")
    st.markdown("- `ZEROX` (Cash doing nothing - zero return), `GOLDX` → `GC=F` (Gold Futures, 2000+), `XAU` → `^XAU` (Gold & Silver Index, 1983+)")
    st.markdown("**🍁 Canadian Ticker Mappings:** USD OTC → Canadian TSX (for better data quality):")
    st.markdown("- `MDALF` → `MDA.TO` (MDA Ltd), `KRKNF` → `PNG.TO` (Kraken Robotics)")
    st.markdown("- `CNSWF` → `TOI.TO` (Constellation Software), `TOITF` → `TOI.TO` (Constellation Software)")
    st.markdown("- `LMGIF` → `LMN.TO` (Lumine Group), `DLMAF` → `DOL.TO` (Dollarama)")
    st.markdown("- `FRFHF` → `FFH.TO` (Fairfax Financial)")

if force_open_special_tickers:
    st.session_state.alloc_special_tickers_force_open_once = False


with st.expander("⚡ Leverage & Expense Ratio Guide", expanded=False):
    st.markdown("""
    **Leverage Format:** Use `TICKER?L=N` where N is the leverage multiplier
    **Expense Ratio Format:** Use `TICKER?E=N` where N is the annual expense ratio percentage
    
    **Examples:**
    - **SPY?L=2** - 2x leveraged S&P 500
    - **QQQ?L=3?E=0.84** - 3x leveraged NASDAQ-100 with 0.84% expense ratio (like TQQQ)
    - **QQQ?E=1** - QQQ with 1% expense ratio
    - **TLT?L=2?E=0.5** - 2x leveraged 20+ Year Treasury with 0.5% expense ratio
    - **SPY?E=2?L=3** - Order doesn't matter: 3x leveraged S&P 500 with 2% expense ratio
    - **QQQ?E=5** - QQQ with 5% expense ratio (high fee for testing)
    
    **Parameter Combinations:**
    - **QQQ?L=3?E=0.84** - Simulates TQQQ (3x QQQ with 0.84% expense ratio)
    - **SPY?L=2?E=0.95** - Simulates SSO (2x SPY with 0.95% expense ratio)
    - **QQQ?E=0.2** - Simulates QQQ with 0.2% expense ratio
    
    **Important Notes:**
    - **Daily Reset:** Leverage resets daily (like real leveraged ETFs)
    - **Cost Drag:** Includes daily cost drag = (leverage - 1) × risk-free rate
    - **Expense Drag:** Daily expense ratio drag = annual_expense_ratio / 365.25
    - **Volatility Decay:** High volatility can cause significant decay over time
    - **Risk Warning:** Leveraged products are high-risk and can lose value quickly
    
    **Real Leveraged ETFs for Reference:**
    - **SSO** - 2x S&P 500 (ProShares)
    - **UPRO** - 3x S&P 500 (ProShares)
    - **TQQQ** - 3x NASDAQ-100 (ProShares)
    - **TMF** - 3x 20+ Year Treasury (Direxion)
    
    **Best Practices:**
    - Use for short-term strategies or hedging
    - Avoid holding for extended periods due to decay
    - Consider the underlying asset's volatility
    - Monitor risk-free rate changes affecting cost drag
    """)

# Bulk ticker input section
with st.expander("📝 Bulk Ticker Input", expanded=False):
    st.markdown("**Enter multiple tickers separated by spaces or commas:**")
    
    # Initialize bulk ticker input in session state
    if 'alloc_bulk_tickers' not in st.session_state:
        st.session_state.alloc_bulk_tickers = ""
    
    # Auto-populate bulk ticker input with current tickers (only if user hasn't entered anything)
    portfolio_index = st.session_state.alloc_active_portfolio_index
    current_tickers = [stock['ticker'] for stock in st.session_state.alloc_portfolio_configs[portfolio_index]['stocks'] if stock['ticker']]
    if current_tickers:
        current_ticker_string = ' '.join(current_tickers)
        # Only auto-populate if the bulk ticker field is empty or matches the current portfolio
        if not st.session_state.alloc_bulk_tickers or st.session_state.alloc_bulk_tickers == current_ticker_string:
            st.session_state.alloc_bulk_tickers = current_ticker_string
    
    # Text area for bulk ticker input
    bulk_tickers = st.text_area(
        "Tickers (e.g., SPY QQQ GLD TLT or SPY,QQQ,GLD,TLT)",
        value=st.session_state.alloc_bulk_tickers,
        key="alloc_bulk_ticker_input",
        height=100,
        help="Enter ticker symbols separated by spaces or commas. Choose 'Replace All' to replace all tickers or 'Add to Existing' to add new tickers."
    )
    
    # Action buttons
    col_replace, col_add, col_fetch, col_copy = st.columns([1, 1, 1, 1])
    
    with col_replace:
        if st.button("🔄 Replace All", key="alloc_fill_tickers_btn", type="secondary"):
            if bulk_tickers.strip():
                # Parse tickers (split by comma or space)
                ticker_list = []
            for ticker in bulk_tickers.replace(',', ' ').split():
                ticker = ticker.strip().upper()
                if ticker:
                        # Special conversion for Berkshire Hathaway tickers for Yahoo Finance compatibility
                        if ticker == 'BRK.B':
                            ticker = 'BRK-B'
                        elif ticker == 'BRK.A':
                            ticker = 'BRK-A'
                        ticker_list.append(ticker)
            
            if ticker_list:
                portfolio_index = st.session_state.alloc_active_portfolio_index
                current_stocks = st.session_state.alloc_portfolio_configs[portfolio_index]['stocks'].copy()
                
                # Replace tickers - new ones get 0% allocation
                new_stocks = []
                
                for i, ticker in enumerate(ticker_list):
                    # Keep original ticker for backtest (don't resolve aliases for portfolio)
                    original_ticker = ticker
                    if i < len(current_stocks):
                        # Use existing allocation if available
                        new_stocks.append({
                            'ticker': original_ticker,  # Use original ticker
                            'allocation': current_stocks[i]['allocation'],
                            'include_dividends': current_stocks[i]['include_dividends']
                        })
                    else:
                        # New tickers get 0% allocation
                        new_stocks.append({
                            'ticker': original_ticker,  # Use original ticker
                            'allocation': 0.0,
                            'include_dividends': True
                        })
                
                # Update the portfolio with new stocks
                st.session_state.alloc_portfolio_configs[portfolio_index]['stocks'] = new_stocks
                
                # Update the active_portfolio reference to match session state
                active_portfolio['stocks'] = new_stocks
                
                # Clear any existing session state keys for individual ticker inputs to force refresh
                for key in list(st.session_state.keys()):
                    if key.startswith(f"alloc_ticker_{portfolio_index}_") or key.startswith(f"alloc_input_alloc_{portfolio_index}_"):
                        del st.session_state[key]
                
                    st.success(f"✅ Replaced all tickers with: {', '.join(ticker_list)}")
                st.info("💡 **Note:** Existing allocations preserved. Adjust allocations manually if needed.")
                
                # Force immediate rerun to refresh the UI
                st.rerun()
            else:
                st.warning("⚠️ No valid tickers found in input.")
    
    with col_add:
        if st.button("➕ Add to Existing", key="alloc_add_tickers_btn", type="secondary"):
            if bulk_tickers.strip():
                # Parse tickers (split by comma or space)
                ticker_list = []
                for ticker in bulk_tickers.replace(',', ' ').split():
                    ticker = ticker.strip().upper()
                    if ticker:
                        # Special conversion for Berkshire Hathaway tickers for Yahoo Finance compatibility
                        if ticker == 'BRK.B':
                            ticker = 'BRK-B'
                        elif ticker == 'BRK.A':
                            ticker = 'BRK-A'
                        ticker_list.append(ticker)
                
                if ticker_list:
                    portfolio_index = st.session_state.alloc_active_portfolio_index
                    current_stocks = st.session_state.alloc_portfolio_configs[portfolio_index]['stocks'].copy()
                    
                    # Add new tickers to existing ones
                    for ticker in ticker_list:
                        # Keep original ticker for backtest (don't resolve aliases for portfolio)
                        original_ticker = ticker
                        # Check if ticker already exists
                        ticker_exists = any(stock['ticker'] == original_ticker for stock in current_stocks)
                        if not ticker_exists:
                            current_stocks.append({
                                'ticker': original_ticker,  # Use original ticker
                                'allocation': 0.0,
                                'include_dividends': True
                            })
                    
                    # Update the portfolio with combined stocks
                    st.session_state.alloc_portfolio_configs[portfolio_index]['stocks'] = current_stocks
                    
                    # Update the active_portfolio reference to match session state
                    active_portfolio['stocks'] = current_stocks
                    
                    # Clear any existing session state keys for individual ticker inputs to force refresh
                    for key in list(st.session_state.keys()):
                        if key.startswith(f"alloc_ticker_{portfolio_index}_") or key.startswith(f"alloc_input_alloc_{portfolio_index}_"):
                            del st.session_state[key]
                    
                    st.success(f"✅ Added new tickers: {', '.join(ticker_list)}")
                    st.info("💡 **Note:** New tickers added with 0% allocation. Adjust allocations manually if needed.")
                    
                    # Force immediate rerun to refresh the UI
                    st.rerun()
                else:
                    st.warning("⚠️ No valid tickers found in input.")
    
    with col_fetch:
        if st.button("🔍 Fetch Tickers", key="alloc_fetch_tickers_btn", type="secondary"):
            # Get current tickers from the active portfolio
            portfolio_index = st.session_state.alloc_active_portfolio_index
            current_tickers = [stock['ticker'] for stock in st.session_state.alloc_portfolio_configs[portfolio_index]['stocks'] if stock['ticker']]
            
            if current_tickers:
                # Update the bulk ticker input with current tickers
                current_ticker_string = ' '.join(current_tickers)
                st.session_state.alloc_bulk_tickers = current_ticker_string
                st.success(f"✅ Fetched {len(current_tickers)} tickers: {current_ticker_string}")
                st.rerun()
            else:
                st.warning("⚠️ No tickers found in the current portfolio.")
    
    with col_copy:
        if bulk_tickers.strip():
            # Create a custom button with direct copy functionality
            import streamlit.components.v1 as components
            
            # JavaScript function to copy and show feedback
            copy_js = f"""
            <script>
            function copyTickers() {{
                navigator.clipboard.writeText({json.dumps(bulk_tickers.strip())}).then(function() {{
                    // Show success feedback
                    const button = document.querySelector('#copy-tickers-btn');
                    const originalText = button.innerHTML;
                    button.innerHTML = '✅ Copied!';
                    button.style.backgroundColor = '#28a745';
                    setTimeout(function() {{
                        button.innerHTML = originalText;
                        button.style.backgroundColor = '';
                    }}, 2000);
                }}).catch(function(err) {{
                    alert('Failed to copy: ' + err);
                }});
            }}
            </script>
            <button id="copy-tickers-btn" onclick="copyTickers()" style="
                background-color: #6c757d;
                color: white;
                border: none;
                padding: 8px 16px;
                border-radius: 4px;
                cursor: pointer;
                width: 100%;
                font-size: 14px;
            ">📋 Copy</button>
            """
            components.html(copy_js, height=50)
        else:
            st.button("📋 Copy", key="alloc_copy_tickers_btn", type="secondary", disabled=True)
            st.warning("⚠️ No tickers to copy. Please enter some tickers first.")

    st.markdown("**S&P 500 (Wikipedia — tickers + entry dates only, one request, 24h cache)**")
    sp500_wiki, sp500_wiki_err = fetch_sp500_wikipedia_constituents()
    if sp500_wiki_err:
        st.caption(f"Could not load Wikipedia S&P 500 list: {sp500_wiki_err}")
    elif sp500_wiki:
        n_sp500 = len(sp500_wiki.get("tickers") or [])
        all_sp500_string = sp500_wiki.get("copy_string") or ""
        col_copy_sp500, col_load_sp500 = st.columns([1, 1])
        with col_copy_sp500:
            import streamlit.components.v1 as components
            copy_all_title = f"Copy all {n_sp500} S&P 500 tickers (space-separated)"
            copy_all_html = f"""
            <html><body style="margin:0;padding:0;">
            <button onclick='navigator.clipboard.writeText({json.dumps(all_sp500_string)});'
                    title="{copy_all_title}"
                    style='background-color: rgb(49, 51, 63); color: rgb(250, 250, 250); border: 1px solid rgba(250, 250, 250, 0.2);
                           padding: 0.25rem 0.75rem; border-radius: 0.5rem; cursor: pointer; width: 100%; min-height: 2.5rem;
                           font-size: 1rem; font-family: "Source Sans Pro", sans-serif; font-weight: 400; line-height: 1.6; box-sizing: border-box;'>
            📋 Copy All S&P 500 Tickers
            </button>
            </body></html>
            """
            components.html(copy_all_html, height=42)
        with col_load_sp500:
            st.button(
                "📥 Load S&P 500 into box",
                key="alloc_load_sp500_tickers_btn",
                type="secondary",
                help="Puts the current Wikipedia S&P 500 list into the ticker box so you can Replace All or Add.",
                on_click=load_sp500_tickers_into_bulk_box,
            )
        if st.session_state.get("alloc_sp500_load_error"):
            st.caption(f"Could not load Wikipedia S&P 500 list: {st.session_state.alloc_sp500_load_error}")
        else:
            st.caption(f"{n_sp500} current constituents. Copy is the same as page 10 — no market data loaded.")
        date_added = sp500_wiki.get("date_added") or {}
        tickers_list = sp500_wiki.get("tickers") or []
        n_with_date = sum(
            1 for t in tickers_list
            if date_added.get(t) or date_added.get(str(t).replace("-", "."))
        )
        with st.expander(f"View S&P 500 entry dates ({n_with_date}/{len(tickers_list)} with a date)", expanded=False):
            table_rows = []
            for t in tickers_list:
                d = date_added.get(t) or date_added.get(str(t).replace("-", ".")) or "no date"
                table_rows.append({"Ticker": t, "Date added": d})
            if table_rows:
                st.caption("Full Wikipedia list. Sort by clicking a header; type in the table search to jump to a ticker.")
                st.dataframe(
                    pd.DataFrame(table_rows),
                    hide_index=True,
                    use_container_width=True,
                    height=min(38 * len(table_rows) + 40, 720),
                )
            else:
                st.caption("No tickers in the Wikipedia list.")

    st.markdown("**US listed common stocks (Nasdaq Trader — NYSE/NASDAQ/AMEX, no dates)**")
    us_market, us_market_err = fetch_us_listed_common_stocks()
    if us_market_err:
        st.caption(f"Could not load US listed common stocks: {us_market_err}")
    elif us_market:
        n_us = len(us_market.get("tickers") or [])
        all_us_string = us_market.get("copy_string") or ""
        col_copy_us, col_load_us = st.columns([1, 1])
        with col_copy_us:
            import streamlit.components.v1 as components
            copy_us_title = f"Copy all {n_us} US listed common stocks (space-separated)"
            copy_us_html = f"""
            <html><body style="margin:0;padding:0;">
            <button onclick='navigator.clipboard.writeText({json.dumps(all_us_string)});'
                    title="{copy_us_title}"
                    style='background-color: rgb(49, 51, 63); color: rgb(250, 250, 250); border: 1px solid rgba(250, 250, 250, 0.2);
                           padding: 0.25rem 0.75rem; border-radius: 0.5rem; cursor: pointer; width: 100%; min-height: 2.5rem;
                           font-size: 1rem; font-family: "Source Sans Pro", sans-serif; font-weight: 400; line-height: 1.6; box-sizing: border-box;'>
            📋 Copy All US Listed Tickers
            </button>
            </body></html>
            """
            components.html(copy_us_html, height=42)
        with col_load_us:
            st.button(
                "📥 Load US listed into box",
                key="alloc_load_us_market_tickers_btn",
                type="secondary",
                help="Puts NYSE/NASDAQ/AMEX common stocks into the ticker box. No inclusion dates. Includes microcaps.",
                on_click=load_us_market_tickers_into_bulk_box,
            )
        if st.session_state.get("alloc_us_market_load_error"):
            st.caption(f"Could not load US listed common stocks: {st.session_state.alloc_us_market_load_error}")
        else:
            st.caption(
                f"{n_us} common stocks after dropping ETFs, test issues, warrants, rights, units, and preferreds. "
                "Wikipedia has no all-US list; this is the Nasdaq Trader symbol directory (two text files, 24h cache). "
                "No entry dates. Includes microcaps and SPACs. A backtest of this universe will download thousands of Yahoo series."
            )

# Leverage Summary Section
leveraged_tickers = []
for stock in active_portfolio['stocks']:
    if "?L=" in stock['ticker'] or "?E=" in stock['ticker']:
        try:
            base_ticker, leverage, expense_ratio = parse_ticker_parameters(stock['ticker'])
            leveraged_tickers.append((base_ticker, leverage))
        except:
            pass

if leveraged_tickers:
    st.markdown("---")
    st.markdown("### 🚀 Leverage Summary")
    
    # ALWAYS get current risk-free rate for accurate display (more precise than historical rates!)
    try:
        # Get current risk-free rate for accurate display
        risk_free_data = get_risk_free_rate_robust([pd.Timestamp.now()])
        if not risk_free_data.empty:
            daily_rf = risk_free_data.iloc[0]
            annual_rf = ((1 + daily_rf)**365.25 - 1) * 100  # Convert daily to annual percentage (compounded)
        else:
            daily_rf = 0.000105  # fallback
            annual_rf = 3.86  # fallback annual rate
    except Exception as e:
        daily_rf = 0.000105  # fallback
        annual_rf = 3.86  # fallback annual rate
    
    # Group by leverage level
    leverage_groups = {}
    for base_ticker, leverage in leveraged_tickers:
        if leverage not in leverage_groups:
            leverage_groups[leverage] = []
        leverage_groups[leverage].append(base_ticker)
    
    for leverage in sorted(leverage_groups.keys()):
        base_tickers = leverage_groups[leverage]
        daily_drag = (leverage - 1) * daily_rf * 100
        st.markdown(f"🚀 **{leverage}x leverage** on {', '.join(base_tickers)}")
        st.markdown(f"📉 **Daily drag:** {daily_drag:.4f}% (RF: {annual_rf:.2f}%)")

st.subheader("Strategy")
if "alloc_active_use_momentum" not in st.session_state:
    st.session_state["alloc_active_use_momentum"] = active_portfolio['use_momentum']
if "alloc_active_use_threshold" not in st.session_state:
    st.session_state["alloc_active_use_threshold"] = active_portfolio.get('use_minimal_threshold', False)
if "alloc_active_threshold_percent" not in st.session_state:
    st.session_state["alloc_active_threshold_percent"] = active_portfolio.get('minimal_threshold_percent', 4.0)
if "alloc_active_use_max_allocation" not in st.session_state:
    st.session_state["alloc_active_use_max_allocation"] = active_portfolio.get('use_max_allocation', False)
if "alloc_active_max_allocation_percent" not in st.session_state:
    st.session_state["alloc_active_max_allocation_percent"] = active_portfolio.get('max_allocation_percent', 20.0)
# Only show momentum strategy if targeted rebalancing is disabled
if not active_portfolio.get('use_targeted_rebalancing', False):
    st.checkbox("Use Momentum Strategy", key="alloc_active_use_momentum", on_change=update_use_momentum, help="Enables momentum-based weighting of stocks.")
    if not st.session_state.get("alloc_active_use_momentum", False):
        st.session_state["alloc_active_exclude_before_sp500_entry"] = active_portfolio.get("exclude_before_sp500_entry", False)
        st.checkbox(
            "Exclude tickers before S&P 500 entry date",
            key="alloc_active_exclude_before_sp500_entry",
            on_change=update_exclude_before_sp500_entry,
            help="Uses Wikipedia Date added (one request, no Yahoo). At each rebalance the ticker is skipped until that date so you do not treat a pre-index small/mid cap as if it were already in the S&P 500. ETFs and tickers not on today's S&P 500 list stay eligible."
        )
        render_min_market_cap_filter_controls()
else:
    # Hide momentum strategy when targeted rebalancing is enabled
    st.session_state["alloc_active_use_momentum"] = False

if active_portfolio['use_momentum']:
    st.markdown("---")
    col_mom_options, col_beta_vol = st.columns(2)
    with col_mom_options:
        st.markdown("**Momentum Strategy Options**")
        
        # Initialize or sync with imported values
        momentum_key = f"momentum_strategy_{st.session_state.alloc_active_portfolio_index}"
        negative_momentum_key = f"negative_momentum_strategy_{st.session_state.alloc_active_portfolio_index}"
        
        # CRITICAL: Sync session state BEFORE creating selectboxes to avoid double-click issue
        if 'alloc_active_momentum_strategy' in st.session_state:
            # Update both session state and portfolio config
            st.session_state[momentum_key] = st.session_state['alloc_active_momentum_strategy']
            active_portfolio['momentum_strategy'] = st.session_state['alloc_active_momentum_strategy']
            # Clear the temp session state to prevent conflicts
            del st.session_state['alloc_active_momentum_strategy']
        
        if 'alloc_active_negative_momentum_strategy' in st.session_state:
            # Update both session state and portfolio config
            st.session_state[negative_momentum_key] = st.session_state['alloc_active_negative_momentum_strategy']
            active_portfolio['negative_momentum_strategy'] = st.session_state['alloc_active_negative_momentum_strategy']
            # Clear the temp session state to prevent conflicts
            del st.session_state['alloc_active_negative_momentum_strategy']
        
        momentum_strategy = st.selectbox(
            "Momentum strategy when NOT all negative:",
            ["Classic", "Relative Momentum", "Near-Zero Symmetry"],
            index=["Classic", "Relative Momentum", "Near-Zero Symmetry"].index(active_portfolio.get('momentum_strategy', 'Classic')),
            key=momentum_key,
            help="Classic: Uses absolute momentum values. Only assets with positive momentum get allocated, weighted by their momentum strength. Assets with negative momentum get 0% allocation.\n\nRelative Momentum: Shifts all momentum scores to be positive by adding an offset, then allocates proportionally. This ensures all assets get some allocation even when all have negative momentum.\n\nNear-Zero Symmetry: Creates a neutral zone around 0% momentum (±5%). Assets in this zone get similar allocations, while negative assets get progressively compressed allocations."
        )
        negative_momentum_strategy = st.selectbox(
            "Strategy when ALL momentum scores are negative:",
            ["Cash", "Equal weight", "Relative momentum", "Near-Zero Symmetry"],
            index=["Cash", "Equal weight", "Relative momentum", "Near-Zero Symmetry"].index(active_portfolio.get('negative_momentum_strategy', 'Cash')),
            key=negative_momentum_key,
            help="Cash: All assets get 0% allocation, portfolio goes to 100% cash when all momentum scores are negative.\n\nEqual weight: All assets get equal allocation (1/n) regardless of their negative momentum values.\n\nRelative momentum: Shifts all negative momentum scores to be positive by adding an offset, then allocates proportionally based on relative performance.\n\nNear-Zero Symmetry: Creates a neutral zone around 0% momentum (±5%). Assets in this zone get similar allocations, while more negative assets get progressively compressed allocations."
        )
        active_portfolio['momentum_strategy'] = momentum_strategy
        active_portfolio['negative_momentum_strategy'] = negative_momentum_strategy
        
        st.markdown("---")
        
        # Equal Weight option - SAME PATTERN AS MAX ALLOCATION
        # ALWAYS sync equal weight settings from portfolio (not just if not present)
        st.session_state["alloc_active_use_equal_weight"] = active_portfolio.get('use_equal_weight', False)
        st.session_state["alloc_active_equal_weight_n_tickers"] = active_portfolio.get('equal_weight_n_tickers', 10)
        
        st.checkbox(
            "Equal Weight Top N Tickers",
            key="alloc_active_use_equal_weight",
            on_change=update_use_equal_weight,
            help="When enabled, takes the top N tickers by momentum weight and assigns them equal weights (1/N each). The momentum strategy is still used to select and rank the tickers."
        )
        
        if st.session_state.get("alloc_active_use_equal_weight", False):
            st.number_input(
                "Number of Top Tickers to Equal Weight",
                min_value=1,
                max_value=100,
                key="alloc_active_equal_weight_n_tickers",
                on_change=update_equal_weight_n_tickers,
                help="Select the top N tickers by momentum weight to receive equal allocation."
            )
        
        st.markdown("---")
        
        # Limit to Top N option - SAME PATTERN AS EQUAL WEIGHT
        # ALWAYS sync limit to top N settings from portfolio (not just if not present)
        st.session_state["alloc_active_use_limit_to_top_n"] = active_portfolio.get('use_limit_to_top_n', False)
        st.session_state["alloc_active_limit_to_top_n_tickers"] = active_portfolio.get('limit_to_top_n_tickers', 10)
        
        st.checkbox(
            "Limit to Top N Tickers",
            key="alloc_active_use_limit_to_top_n",
            on_change=update_use_limit_to_top_n,
            help="When enabled, takes the top N tickers by momentum weight and keeps their proportional weights (unlike equal weight). The momentum strategy is still used to select and rank the tickers."
        )
        
        if st.session_state.get("alloc_active_use_limit_to_top_n", False):
            st.number_input(
                "Number of Top Tickers to Keep",
                min_value=1,
                max_value=100,
                key="alloc_active_limit_to_top_n_tickers",
                on_change=update_limit_to_top_n_tickers,
                help="Select the top N tickers by momentum weight to keep (with proportional weights)."
            )

        # Sector / industry concentration caps
        st.session_state["alloc_active_use_sector_concentration_limit"] = active_portfolio.get('use_sector_concentration_limit', False)
        st.session_state["alloc_active_max_tickers_per_sector"] = active_portfolio.get('max_tickers_per_sector', 4)
        st.session_state["alloc_active_use_industry_concentration_limit"] = active_portfolio.get('use_industry_concentration_limit', False)
        st.session_state["alloc_active_max_tickers_per_industry"] = active_portfolio.get('max_tickers_per_industry', 2)
        st.session_state["alloc_active_unknown_counts_as_category"] = active_portfolio.get('unknown_counts_as_category', True)
        st.session_state["alloc_active_exclude_before_sp500_entry"] = active_portfolio.get('exclude_before_sp500_entry', False)

        st.checkbox(
            "Limit tickers per sector",
            key="alloc_active_use_sector_concentration_limit",
            on_change=update_use_sector_concentration_limit,
            help="Skip lower-ranked tickers once a sector hits the max. With Top N / Equal Weight: fill remaining slots so you still reach N when possible. Without them: excluded tickers stay out (portfolio can be smaller)."
        )
        if st.session_state.get("alloc_active_use_sector_concentration_limit", False):
            st.number_input(
                "Max tickers per sector",
                min_value=1,
                max_value=100,
                key="alloc_active_max_tickers_per_sector",
                on_change=update_max_tickers_per_sector,
                help="Maximum holdings from the same Yahoo Finance sector (e.g. Technology)."
            )

        st.checkbox(
            "Limit tickers per industry (category)",
            key="alloc_active_use_industry_concentration_limit",
            on_change=update_use_industry_concentration_limit,
            help="Same idea as sector limit, for Yahoo industry/category (e.g. Semiconductors). Optional — not required to use Top N or Equal Weight."
        )
        if st.session_state.get("alloc_active_use_industry_concentration_limit", False):
            st.number_input(
                "Max tickers per industry",
                min_value=1,
                max_value=100,
                key="alloc_active_max_tickers_per_industry",
                on_change=update_max_tickers_per_industry,
                help="Maximum holdings from the same industry/category."
            )

        if st.session_state.get("alloc_active_use_sector_concentration_limit", False) or st.session_state.get("alloc_active_use_industry_concentration_limit", False):
            st.checkbox(
                "Count Unknown sector/industry toward the limit",
                key="alloc_active_unknown_counts_as_category",
                on_change=update_unknown_counts_as_category,
                help="When checked, tickers with missing Yahoo sector/industry share one 'Unknown' bucket and are capped like any other category. When unchecked, Unknown tickers are exempt from sector/industry caps."
            )

        st.checkbox(
            "Exclude tickers before S&P 500 entry date",
            key="alloc_active_exclude_before_sp500_entry",
            on_change=update_exclude_before_sp500_entry,
            help="Uses Wikipedia Date added (one request, no Yahoo). At each rebalance the ticker is skipped until that date so you do not treat a pre-index small/mid cap as if it were already in the S&P 500. ETFs and tickers not on today's S&P 500 list stay eligible. Momentum lookback still uses prices from before inclusion."
        )
        render_min_market_cap_filter_controls()
        
        st.markdown("💡 **Note:** These options control how weights are assigned based on momentum scores.")

    with col_beta_vol:
        if "alloc_active_calc_beta" not in st.session_state:
            st.session_state["alloc_active_calc_beta"] = active_portfolio.get('calc_beta', False)
        st.checkbox("Include Beta in momentum weighting", key="alloc_active_calc_beta", on_change=update_calc_beta, help="Penalizes high-beta stocks by reducing their allocation. Stocks with Beta > 1.0 (more volatile than market) get lower weights, while stocks with Beta < 1.0 (less volatile) get higher weights. This reduces portfolio risk by favoring stable stocks.")
        if st.session_state.get('alloc_active_calc_beta', False):
            if "alloc_active_beta_window" not in st.session_state:
                st.session_state["alloc_active_beta_window"] = active_portfolio['beta_window_days']
            if "alloc_active_beta_exclude" not in st.session_state:
                st.session_state["alloc_active_beta_exclude"] = active_portfolio['exclude_days_beta']
            st.number_input("Beta Lookback (days)", min_value=1, key="alloc_active_beta_window", on_change=update_beta_window)
            st.number_input("Beta Exclude (days)", min_value=0, key="alloc_active_beta_exclude", on_change=update_beta_exclude)
            if st.button("Reset Beta", on_click=reset_beta_callback):
                pass
        if "alloc_active_calc_vol" not in st.session_state:
            st.session_state["alloc_active_calc_vol"] = active_portfolio.get('calc_volatility', False)
        st.checkbox("Include Volatility in momentum weighting", key="alloc_active_calc_vol", on_change=update_calc_vol, help="Penalizes high-volatility stocks by reducing their allocation. Stocks with high price swings get lower weights, while stable stocks get higher weights. This reduces portfolio risk by favoring less volatile investments.")
        if st.session_state.get('alloc_active_calc_vol', False):
            if "alloc_active_vol_window" not in st.session_state:
                st.session_state["alloc_active_vol_window"] = active_portfolio['vol_window_days']
            if "alloc_active_vol_exclude" not in st.session_state:
                st.session_state["alloc_active_vol_exclude"] = active_portfolio['exclude_days_vol']
            st.number_input("Volatility Lookback (days)", min_value=1, key="alloc_active_vol_window", on_change=update_vol_window)
            st.number_input("Volatility Exclude (days)", min_value=0, key="alloc_active_vol_exclude", on_change=update_vol_exclude)
            if st.button("Reset Volatility", on_click=reset_vol_callback):
                pass
    
    
    st.markdown("---")
    st.subheader("Momentum Windows")
    col_reset, col_norm, col_addrem = st.columns([0.4, 0.4, 0.2])
    with col_reset:
        if st.button("Reset Momentum Windows", on_click=reset_momentum_windows_callback):
            pass
    with col_norm:
        if st.button("Normalize Weights to 100%", on_click=normalize_momentum_weights_callback):
            pass
    with col_addrem:
        if st.button("Add Window", on_click=add_momentum_window_callback):
            pass
        if st.button("Remove Window", on_click=remove_momentum_window_callback):
            pass

    total_weight = sum(w['weight'] for w in active_portfolio['momentum_windows'])
    if abs(total_weight - 1.0) > 0.001:
        st.warning(f"Current total weight is {total_weight*100:.2f}%, not 100%. Click 'Normalize Weights' to fix.")
    else:
        st.success(f"Total weight is {total_weight*100:.2f}%.")

    def update_momentum_lookback(index):
        key = f"alloc_lookback_active_{st.session_state.alloc_active_portfolio_index}_{index}"
        momentum_windows = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index].get('momentum_windows', [])
        if index < len(momentum_windows):
            momentum_windows[index]['lookback'] = st.session_state.get(key, None)

    def update_momentum_exclude(index):
        key = f"alloc_exclude_active_{st.session_state.alloc_active_portfolio_index}_{index}"
        momentum_windows = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index].get('momentum_windows', [])
        if index < len(momentum_windows):
            momentum_windows[index]['exclude'] = st.session_state.get(key, None)
    
    def update_momentum_weight(index):
        key = f"alloc_weight_input_active_{st.session_state.alloc_active_portfolio_index}_{index}"
        val = st.session_state.get(key, None)
        if val is None:
            return
        momentum_windows = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index].get('momentum_windows', [])
        if index < len(momentum_windows):
            momentum_windows[index]['weight'] = val / 100.0

    # Allow the user to remove momentum windows down to zero.
    # Previously the UI forced a minimum of 3 windows which prevented removing them.
    # If no windows exist, show an informational message and allow adding via the button.
    if len(active_portfolio.get('momentum_windows', [])) == 0:
        st.info("No momentum windows configured. Click 'Add Window' to create momentum lookback windows.")
    col_headers = st.columns(5)
    with col_headers[0]:
        st.markdown("**Lookback (days)**")
    with col_headers[1]:
        st.markdown("**Exclude (days)**")
    with col_headers[2]:
        st.markdown("**Weight %**")
    with col_headers[3]:
        st.markdown("**Discard if negative**")
    with col_headers[4]:
        st.markdown("**Unless recent +**")

    for j in range(len(active_portfolio.get('momentum_windows', []))):
        with st.container():
            col_mw1, col_mw2, col_mw3, col_mw4, col_mw5 = st.columns(5)
            portfolio_index = st.session_state.alloc_active_portfolio_index
            lookback_key = f"alloc_lookback_active_{portfolio_index}_{j}"
            exclude_key = f"alloc_exclude_active_{portfolio_index}_{j}"
            weight_key = f"alloc_weight_input_active_{portfolio_index}_{j}"
            discard_key = f"alloc_discard_if_negative_{portfolio_index}_{j}"
            unless_key = f"alloc_discard_unless_recent_positive_{portfolio_index}_{j}"
            
            # Initialize session state values if not present
            if lookback_key not in st.session_state:
                st.session_state[lookback_key] = int(active_portfolio['momentum_windows'][j]['lookback'])
            if exclude_key not in st.session_state:
                st.session_state[exclude_key] = int(active_portfolio['momentum_windows'][j]['exclude'])
            if weight_key not in st.session_state:
                # Sanitize weight to prevent StreamlitValueAboveMaxError
                weight = active_portfolio['momentum_windows'][j]['weight']
                if isinstance(weight, (int, float)):
                    # If weight is already a percentage (e.g., 50 for 50%), use it directly
                    if weight > 1.0:
                        # Cap at 100% and use as percentage
                        weight_percentage = min(weight, 100.0)
                    else:
                        # Convert decimal to percentage
                        weight_percentage = weight * 100.0
                else:
                    # Invalid weight, set to default
                    weight_percentage = 10.0
                st.session_state[weight_key] = int(weight_percentage)
            
            st.session_state[discard_key] = parse_bool_from_json(
                active_portfolio['momentum_windows'][j].get('discard_if_negative', False), False
            )
            st.session_state[unless_key] = parse_bool_from_json(
                active_portfolio['momentum_windows'][j].get('discard_unless_recent_positive', False), False
            )
            
            with col_mw1:
                st.number_input(f"Lookback {j+1}", min_value=1, key=lookback_key, label_visibility="collapsed", on_change=update_momentum_lookback, args=(j,))
            with col_mw2:
                st.number_input(f"Exclude {j+1}", min_value=0, key=exclude_key, label_visibility="collapsed", on_change=update_momentum_exclude, args=(j,))
            with col_mw3:
                st.number_input(f"Weight {j+1}", min_value=0, max_value=100, step=1, format="%d", key=weight_key, label_visibility="collapsed", on_change=update_momentum_weight, args=(j,))
            with col_mw4:
                st.checkbox(
                    f"Discard if negative {j+1}",
                    key=discard_key,
                    label_visibility="collapsed",
                    on_change=update_momentum_discard_if_negative,
                    args=(j,),
                    help="If checked, exclude the stock at rebalance when this window's momentum return is negative.",
                )
            with col_mw5:
                st.checkbox(
                    f"Unless recent positive {j+1}",
                    key=unless_key,
                    label_visibility="collapsed",
                    on_change=update_momentum_discard_unless_recent_positive,
                    args=(j,),
                    help=(
                        "Only with Discard if negative. Uses return from Exclude days to rebalance date "
                        "(e.g. 120–30 window with exclude 30 → checks 30–0). Cancels expulsion when that recent return is positive."
                    ),
                )
else:
    # Don't clear momentum_windows - they should persist when momentum is disabled
    # so they're available when momentum is re-enabled or for variant generation
    
    active_portfolio['momentum_windows'] = []

# Minimal Threshold Filter Section (only available when momentum is enabled)
if active_portfolio['use_momentum']:
    st.markdown("---")
    st.subheader("Minimal Threshold Filter")

    # ALWAYS sync threshold settings from portfolio (not just if not present)
    # Only sync if session state doesn't exist or if we're not in the middle of an import
    if "alloc_active_use_threshold" not in st.session_state or not st.session_state.get('alloc_rerun_flag', False):
        st.session_state["alloc_active_use_threshold"] = active_portfolio.get('use_minimal_threshold', False)
        st.session_state["alloc_active_threshold_percent"] = active_portfolio.get('minimal_threshold_percent', 4.0)

    st.checkbox(
        "Enable Minimal Threshold Filter", 
        key="alloc_active_use_threshold", 
        on_change=update_use_threshold,
        help="Exclude stocks with allocations below the threshold percentage and normalize remaining allocations to 100%"
    )

    if st.session_state.get("alloc_active_use_threshold", False):
        st.number_input(
            "Minimal Threshold (%)", 
            min_value=0.1, 
            max_value=50.0, 
            step=0.1,
            key="alloc_active_threshold_percent", 
            on_change=update_threshold_percent,
            help="Stocks with allocations below this percentage will be excluded and their weight redistributed to remaining stocks"
        )

    # Maximum Allocation Filter Section (only available when momentum is enabled)
    st.markdown("---")
    st.subheader("Maximum Allocation Filter")

    # ALWAYS sync maximum allocation settings from portfolio (not just if not present)
    # Only sync if session state doesn't exist or if we're not in the middle of an import
    if "alloc_active_use_max_allocation" not in st.session_state or not st.session_state.get('alloc_rerun_flag', False):
        st.session_state["alloc_active_use_max_allocation"] = active_portfolio.get('use_max_allocation', False)
        st.session_state["alloc_active_max_allocation_percent"] = active_portfolio.get('max_allocation_percent', 20.0)

    st.checkbox(
        "Enable Maximum Allocation Filter", 
        key="alloc_active_use_max_allocation", 
        on_change=update_use_max_allocation,
        help="Cap individual stock allocations at the maximum percentage and redistribute excess weight to other stocks"
    )

    if st.session_state.get("alloc_active_use_max_allocation", False):
        st.number_input(
            "Maximum Allocation (%)", 
            min_value=1.0, 
            max_value=100.0, 
            step=0.1,
            key="alloc_active_max_allocation_percent", 
            on_change=update_max_allocation_percent,
            help="Individual stocks will be capped at this maximum allocation percentage"
        )

# MA Filter Section (SMA/EMA) - EXACTLY SAME AS PAGE 1
# Only show MA filter if targeted rebalancing is disabled
if not st.session_state.get("alloc_active_use_targeted_rebalancing", False):
    st.markdown("---")
    st.subheader("MA Filter")

    # Initialize MA filter state
    if "alloc_active_use_sma_filter" not in st.session_state:
        st.session_state["alloc_active_use_sma_filter"] = active_portfolio.get('use_sma_filter', False)

    st.checkbox(
        "Enable MA Filter", 
        key="alloc_active_use_sma_filter",
        on_change=update_use_sma_filter,
        help="MA Filter means the tickers with MA filter will be excluded when price below MA at rebalancing. This helps avoid buying assets that are in a downtrend."
    )

    # MA controls (only show when MA filter is enabled)
    if st.session_state.get("alloc_active_use_sma_filter", False):
        col_ma_type, col_ma_window = st.columns([1, 1])
        
        with col_ma_type:
            # MA type selector
            # Initialize MA type state
            if "alloc_active_ma_type" not in st.session_state:
                st.session_state["alloc_active_ma_type"] = active_portfolio.get('ma_type', 'SMA')
            
            ma_type = st.selectbox("MA Type", 
                                   options=["SMA", "EMA"], 
                                   index=0 if st.session_state.get("alloc_active_ma_type", "SMA") == "SMA" else 1,
                                   key="alloc_active_ma_type",
                                   help="SMA (Simple Moving Average): Equal weight to all prices in the window. EMA (Exponential Moving Average): More weight to recent prices, reacts faster to price changes.")
            active_portfolio['ma_type'] = ma_type
        
        with col_ma_window:
            # MA window input
            # Initialize MA window state
            if "alloc_active_sma_window" not in st.session_state:
                st.session_state["alloc_active_sma_window"] = active_portfolio.get('sma_window', 200)
            
            ma_window = st.number_input(
                "MA Window (days)",
                min_value=10,
                max_value=500,
                value=st.session_state.get("alloc_active_sma_window", 200),
                step=10,
                key="alloc_active_sma_window",
                help="Number of days to calculate the moving average. Longer windows = smoother trend, shorter windows = more responsive to price changes."
            )
            active_portfolio['sma_window'] = ma_window
        
        # MA Multiplier input
        # Initialize MA multiplier state
        if "alloc_active_ma_multiplier" not in st.session_state:
            st.session_state["alloc_active_ma_multiplier"] = active_portfolio.get('ma_multiplier', 1.48)
        
        ma_multiplier = st.number_input(
            "MA Multiplier",
            min_value=1.0,
            max_value=3.0,
            value=st.session_state.get("alloc_active_ma_multiplier", 1.48),
            help="Multiplier to convert market days to calendar days. 1.48 means 200 market days = 296 calendar days (accounts for weekends and holidays).",
            step=0.01,
            key="alloc_active_ma_multiplier"
        )
        active_portfolio['ma_multiplier'] = ma_multiplier
        
        # MA Cross Rebalancing Section
        st.markdown("**MA Cross Rebalancing:**")
        
        # Initialize MA cross rebalance state
        if "alloc_active_ma_cross_rebalance" not in st.session_state:
            st.session_state["alloc_active_ma_cross_rebalance"] = active_portfolio.get('ma_cross_rebalance', False)
        
        ma_cross_rebalance = st.checkbox(
            "Immediate Rebalance on MA Cross",
            key="alloc_active_ma_cross_rebalance",
            help="Rebalance portfolio immediately when any ticker crosses its moving average, in addition to regular rebalancing schedule. This allows faster response to trend changes."
        )
        active_portfolio['ma_cross_rebalance'] = ma_cross_rebalance
        
        # Anti-whipsaw options (only show when MA cross rebalancing is enabled)
        if ma_cross_rebalance:
            st.markdown("**Anti-Whipsaw Settings:**")
            
            col_band, col_delay = st.columns(2)
            
            with col_band:
                # Tolerance band percentage
                if "alloc_active_ma_tolerance" not in st.session_state:
                    st.session_state["alloc_active_ma_tolerance"] = active_portfolio.get('ma_tolerance_percent', 2.0)
                
                tolerance_percent = st.number_input(
                    "Tolerance Band (%)",
                    min_value=0.0,
                    max_value=10.0,
                    value=st.session_state.get("alloc_active_ma_tolerance", 2.0),
                    help="Tolerance band around the moving average. Only trigger rebalancing if price moves beyond this percentage from the MA. Prevents whipsaw from small price fluctuations.",
                    step=0.1,
                    key="alloc_active_ma_tolerance"
                )
                active_portfolio['ma_tolerance_percent'] = tolerance_percent
            
            with col_delay:
                # Confirmation delay in days
                if "alloc_active_ma_delay" not in st.session_state:
                    st.session_state["alloc_active_ma_delay"] = active_portfolio.get('ma_confirmation_days', 3)
                
                confirmation_days = st.number_input(
                    "Confirmation Delay (days)",
                    min_value=0,
                    max_value=10,
                    value=st.session_state.get("alloc_active_ma_delay", 3),
                    help="Number of days to wait before confirming an MA cross. Prevents false signals from temporary price movements. Higher values = more conservative approach.",
                    step=1,
                    key="alloc_active_ma_delay"
                )
                active_portfolio['ma_confirmation_days'] = confirmation_days
        else:
            # Set default values when disabled
            active_portfolio['ma_tolerance_percent'] = 2.0
            active_portfolio['ma_confirmation_days'] = 3

    # Store MA filter state
    active_portfolio['use_sma_filter'] = st.session_state.get('alloc_active_use_sma_filter', False)
else:
    # Hide MA filter when targeted rebalancing is enabled
    # Don't modify session state directly - let the checkbox handle it
    active_portfolio['use_sma_filter'] = False

# Targeted Rebalancing Section (COPIED FROM PAGE 4)
# Only show targeted rebalancing if momentum AND MA filter are disabled
if not st.session_state.get('alloc_active_use_momentum', False) and not st.session_state.get("alloc_active_use_sma_filter", False):
    st.markdown("---")
    st.subheader("Targeted Rebalancing")

    # Initialize targeted rebalancing state (COPIED FROM PAGE 4)
    if "alloc_active_use_targeted_rebalancing" not in st.session_state:
        st.session_state["alloc_active_use_targeted_rebalancing"] = active_portfolio.get('use_targeted_rebalancing', False)

    st.checkbox(
        "Enable Targeted Rebalancing", 
        key="alloc_active_use_targeted_rebalancing", 
        on_change=update_use_targeted_rebalancing,
        help="Rebalance at the next scheduled rebalancing date when ticker allocations exceed min/max thresholds. Does not trigger immediate rebalancing, only checks thresholds on rebalance dates."
    )
    
    # Update active portfolio with current targeted rebalancing state
    active_portfolio['use_targeted_rebalancing'] = st.session_state.get("alloc_active_use_targeted_rebalancing", False)
else:
    # Hide targeted rebalancing when momentum or MA filter is enabled
    # Don't modify session state directly - let the checkbox handle it
    active_portfolio['use_targeted_rebalancing'] = False

if st.session_state.get("alloc_active_use_targeted_rebalancing", False):
    st.markdown("**Configure allocation limits for each ticker:**")
    
    # Get current tickers
    stocks_list = active_portfolio.get('stocks', [])
    current_tickers = [s['ticker'] for s in stocks_list if s.get('ticker')]
    
    if current_tickers:
        # Initialize settings if not exists
        if 'targeted_rebalancing_settings' not in active_portfolio:
            active_portfolio['targeted_rebalancing_settings'] = {}
        
        # Create columns for ticker settings
        cols = st.columns(min(len(current_tickers), 3))
        
        for i, ticker in enumerate(current_tickers):
            with cols[i % 3]:
                st.markdown(f"**{ticker}**")
                
                # Initialize default settings for this ticker
                if ticker not in active_portfolio['targeted_rebalancing_settings']:
                    active_portfolio['targeted_rebalancing_settings'][ticker] = {
                        'enabled': False,
                        'min_allocation': 0.0,
                        'max_allocation': 100.0
                    }
                
                # Enable/disable checkbox
                enabled = st.checkbox(
                    "Enable", 
                    value=active_portfolio['targeted_rebalancing_settings'][ticker]['enabled'],
                    key=f"targeted_enabled_{ticker}",
                    help=f"Enable targeted rebalancing for {ticker}"
                )
                active_portfolio['targeted_rebalancing_settings'][ticker]['enabled'] = enabled
                
                if enabled:
                    # Max allocation (on top)
                    max_alloc = st.number_input(
                        "Max %", 
                        min_value=0.0, 
                        max_value=100.0, 
                        step=0.1,
                        value=active_portfolio['targeted_rebalancing_settings'][ticker]['max_allocation'],
                        key=f"targeted_max_{ticker}",
                        help=f"Maximum allocation percentage for {ticker}"
                    )
                    active_portfolio['targeted_rebalancing_settings'][ticker]['max_allocation'] = max_alloc
                    
                    # Min allocation (below)
                    min_alloc = st.number_input(
                        "Min %", 
                        min_value=0.0, 
                        max_value=100.0, 
                        step=0.1,
                        value=active_portfolio['targeted_rebalancing_settings'][ticker]['min_allocation'],
                        key=f"targeted_min_{ticker}",
                        help=f"Minimum allocation percentage for {ticker}"
                    )
                    active_portfolio['targeted_rebalancing_settings'][ticker]['min_allocation'] = min_alloc
                    
                    # Validation
                    if min_alloc >= max_alloc:
                        st.error(f"Min must be less than Max for {ticker}")
    else:
        st.info("Add tickers to configure targeted rebalancing settings.")

with st.expander("JSON Configuration (Copy & Paste)", expanded=False):
    # Clean portfolio config for export by removing unused settings
    cleaned_config = active_portfolio.copy()
    cleaned_config.pop('use_relative_momentum', None)
    cleaned_config.pop('equal_if_all_negative', None)
    
    # Ensure targeted rebalancing settings are included
    cleaned_config['use_targeted_rebalancing'] = active_portfolio.get('use_targeted_rebalancing', False)
    cleaned_config['targeted_rebalancing_settings'] = active_portfolio.get('targeted_rebalancing_settings', {})
    
    # Ensure threshold and max allocation settings are included
    cleaned_config['use_minimal_threshold'] = active_portfolio.get('use_minimal_threshold', False)
    cleaned_config['minimal_threshold_percent'] = active_portfolio.get('minimal_threshold_percent', 4.0)
    cleaned_config['use_max_allocation'] = active_portfolio.get('use_max_allocation', False)
    cleaned_config['max_allocation_percent'] = active_portfolio.get('max_allocation_percent', 20.0)
    cleaned_config['use_equal_weight'] = active_portfolio.get('use_equal_weight', False)
    cleaned_config['equal_weight_n_tickers'] = active_portfolio.get('equal_weight_n_tickers', 10)
    cleaned_config['use_limit_to_top_n'] = active_portfolio.get('use_limit_to_top_n', False)
    cleaned_config['limit_to_top_n_tickers'] = active_portfolio.get('limit_to_top_n_tickers', 10)
    cleaned_config['use_sector_concentration_limit'] = active_portfolio.get('use_sector_concentration_limit', False)
    cleaned_config['max_tickers_per_sector'] = active_portfolio.get('max_tickers_per_sector', 4)
    cleaned_config['use_industry_concentration_limit'] = active_portfolio.get('use_industry_concentration_limit', False)
    cleaned_config['max_tickers_per_industry'] = active_portfolio.get('max_tickers_per_industry', 2)
    cleaned_config['unknown_counts_as_category'] = active_portfolio.get('unknown_counts_as_category', True)
    cleaned_config['exclude_before_sp500_entry'] = st.session_state.get(
        'alloc_active_exclude_before_sp500_entry',
        active_portfolio.get('exclude_before_sp500_entry', False),
    )
    cleaned_config['use_min_market_cap_filter'] = st.session_state.get(
        'alloc_active_use_min_market_cap_filter',
        active_portfolio.get('use_min_market_cap_filter', False),
    )
    cleaned_config['min_market_cap_billions'] = st.session_state.get(
        'alloc_active_min_market_cap_billions',
        active_portfolio.get('min_market_cap_billions', 10.0),
    )
    cleaned_config.pop('_sp500_date_added', None)
    cleaned_config.pop('_mcap_price_scale', None)
    cleaned_config.pop('_mcap_close_series', None)
    cleaned_config.pop('_market_cap_today', None)
    
    # Ensure MA filter settings are included
    cleaned_config['use_sma_filter'] = st.session_state.get('alloc_active_use_sma_filter', False)
    cleaned_config['sma_window'] = st.session_state.get('alloc_active_sma_window', 200)
    cleaned_config['ma_type'] = st.session_state.get('alloc_active_ma_type', 'SMA')
    cleaned_config['ma_multiplier'] = st.session_state.get('alloc_active_ma_multiplier', 1.48)
    
    # Also update the active portfolio to keep it in sync
    active_portfolio['use_sma_filter'] = st.session_state.get('alloc_active_use_sma_filter', False)
    active_portfolio['sma_window'] = st.session_state.get('alloc_active_sma_window', 200)
    active_portfolio['ma_type'] = st.session_state.get('alloc_active_ma_type', 'SMA')
    active_portfolio['ma_multiplier'] = st.session_state.get('alloc_active_ma_multiplier', 1.48)
    
    normalize_momentum_windows_discard_flags(cleaned_config.get('momentum_windows', []))
    
    config_json = json.dumps(cleaned_config, indent=4)
    st.code(config_json, language='json')
    # Fixed JSON copy button
    import streamlit.components.v1 as components
    copy_html = f"""
    <button onclick='navigator.clipboard.writeText({json.dumps(config_json)});' style='margin-bottom:10px;'>Copy to Clipboard</button>
    """
    components.html(copy_html, height=40)
    
    # Add PDF download button for JSON
    def generate_json_pdf(custom_name=""):
        """Generate a PDF with pure JSON content only for easy CTRL+A / CTRL+V copying."""
        from reportlab.lib.pagesizes import letter, A4
        from reportlab.platypus import SimpleDocTemplate, Preformatted
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        import io
        from datetime import datetime
        
        # Create PDF buffer
        buffer = io.BytesIO()
        
        # Add proper PDF metadata
        portfolio_name = active_portfolio.get('name', 'Portfolio')
        
        # Use custom name if provided, otherwise use portfolio name
        if custom_name.strip():
            title = f"Allocations - {custom_name.strip()} - JSON Configuration"
            subject = f"JSON Configuration: {custom_name.strip()}"
        else:
            title = f"Allocations - {portfolio_name} - JSON Configuration"
            subject = f"JSON Configuration for {portfolio_name}"
        
        doc = SimpleDocTemplate(
            buffer, 
            pagesize=A4, 
            rightMargin=36, 
            leftMargin=36, 
            topMargin=36, 
            bottomMargin=36,
            title=title,
            author="Portfolio Backtest System",
            subject=subject,
            creator="Allocations Application"
        )
        story = []
        
        # Pure JSON style - just monospace text
        json_style = ParagraphStyle(
            'PureJSONStyle',
            fontName='Courier',
            fontSize=10,
            leading=12,
            leftIndent=0,
            rightIndent=0,
            spaceAfter=0,
            spaceBefore=0
        )
        
        # Add only the JSON content - no headers, no instructions, just pure JSON
        json_lines = config_json.split('\n')
        for line in json_lines:
            story.append(Preformatted(line, json_style))
        
        # Build PDF
        doc.build(story)
        pdf_data = buffer.getvalue()
        buffer.close()
        
        return pdf_data
    
    # Optional custom PDF name for individual portfolio
    custom_individual_pdf_name = st.text_input(
        "📝 Custom Portfolio JSON PDF Name (optional):", 
        value="",
        placeholder=f"e.g., {active_portfolio.get('name', 'Portfolio')} Allocation Config, Asset Setup Analysis",
        help="Leave empty to use automatic naming based on portfolio name",
        key="alloc_individual_custom_pdf_name"
    )
    
    if st.button("📄 Download JSON as PDF", help="Download a PDF containing the JSON configuration for easy copying", key="alloc_json_pdf_btn"):
        try:
            pdf_data = generate_json_pdf(custom_individual_pdf_name)
            
            # Generate filename based on custom name or default
            if custom_individual_pdf_name.strip():
                clean_name = custom_individual_pdf_name.strip().replace(' ', '_').replace('/', '_').replace('\\', '_')
                filename = f"{clean_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
            else:
                filename = f"allocations_config_{active_portfolio.get('name', 'portfolio').replace(' ', '_')}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
            
            st.download_button(
                label="💾 Download Allocations JSON PDF",
                data=pdf_data,
                file_name=filename,
                mime="application/pdf",
                key="alloc_json_pdf_download",
            )
            st.success("PDF generated successfully! Click the download button above.")
        except Exception as e:
            st.error(f"Error generating PDF: {str(e)}")
    

    st.text_area("Paste JSON Here to Update Portfolio", key="alloc_paste_json_text", height=200)
    st.button("Update with Pasted JSON", on_click=paste_json_callback)
    
    # Add PDF drag and drop functionality
    st.markdown("**OR** 📎 **Drag & Drop JSON PDF:**")
    
    def extract_json_from_pdf_alloc(pdf_file):
        """Extract JSON content from a PDF file."""
        try:
            # Try pdfplumber first (more reliable)
            try:
                import pdfplumber
                import io
                
                # Read PDF content with pdfplumber
                pdf_bytes = io.BytesIO(pdf_file.read())
                text_content = ""
                
                with pdfplumber.open(pdf_bytes) as pdf:
                    for page in pdf.pages:
                        text_content += page.extract_text() or ""
                        
            except ImportError:
                # Fallback to PyPDF2 if pdfplumber not available
                try:
                    import PyPDF2
                    import io
                    
                    # Reset file pointer
                    pdf_file.seek(0)
                    pdf_reader = PyPDF2.PdfReader(io.BytesIO(pdf_file.read()))
                    
                    # Extract text from all pages
                    text_content = ""
                    for page in pdf_reader.pages:
                        text_content += page.extract_text()
                        
                except ImportError:
                    return None, "PDF extraction libraries not available. Please install 'pip install PyPDF2' or 'pip install pdfplumber'"
            
            # Clean up the text and try to parse as JSON
            cleaned_text = text_content.strip()
            
            # Try to parse as JSON
            import json
            json_data = json.loads(cleaned_text)
            return json_data, None
            
        except json.JSONDecodeError as e:
            return None, f"Invalid JSON in PDF: {str(e)}"
        except Exception as e:
            return None, str(e)
    
    uploaded_pdf = st.file_uploader(
        "Drop your JSON PDF here", 
        type=['pdf'], 
        help="Upload a JSON PDF file generated by this app to automatically load the configuration",
        key="alloc_individual_pdf_upload"
    )
    
    if uploaded_pdf is not None:
        json_data, error = extract_json_from_pdf_alloc(uploaded_pdf)
        if json_data:
            # Store the extracted JSON in a different session state key to avoid widget conflicts
            st.session_state["alloc_extracted_json"] = json.dumps(json_data, indent=4)
            st.success(f"✅ Successfully extracted JSON from {uploaded_pdf.name}")
            st.info("👇 Click the button below to load the JSON into the text area.")
            def load_extracted_json():
                st.session_state["alloc_paste_json_text"] = st.session_state["alloc_extracted_json"]
            
            st.button("📋 Load Extracted JSON", key="load_extracted_json", on_click=load_extracted_json)
        else:
            st.error(f"❌ Failed to extract JSON from PDF: {error}")
            st.info("💡 Make sure the PDF contains valid JSON content (generated by this app)")

# Validation constants
_TOTAL_TOL = 1.0
_ALLOC_TOL = 1.0

# Clear ticker cache button
if st.sidebar.button("🗑️ Clear Ticker Cache", 
                    help="Clear the 4-hour ticker cache to force fresh data downloads", 
                    use_container_width=True):
    total_cleared = clear_all_yahoo_caches()
    
    if total_cleared > 0:
        st.sidebar.success(f"✅ Cleared {total_cleared} cached items (tickers + PE/valuations)")
    else:
        st.sidebar.info("No cache to clear")

# Clear all portfolios button - quick access for single portfolio pages
if st.sidebar.button("🗑️ Clear All Portfolios", key="alloc_clear_all_portfolios_immediate", 
                    help="Delete ALL portfolios and create a blank one", use_container_width=True):
    # Clear all portfolios and create a single blank portfolio
    st.session_state.alloc_portfolio_configs = [{
        'name': 'New Portfolio 1',
        'stocks': [],
        'benchmark_ticker': '^GSPC',
        'initial_value': 10000,
        'added_amount': 0,
        'added_frequency': 'none',
        'rebalancing_frequency': 'Monthly',
        'start_with': 'oldest',
        'first_rebalance_strategy': 'rebalancing_date',
        'use_momentum': False,
        'momentum_strategy': 'Classic',
        'negative_momentum_strategy': 'Cash',
        'momentum_windows': [
            {"lookback": 365, "exclude": 30, "weight": 1.0}
        ],
        'calc_beta': False,
        'beta_window_days': 365,
        'exclude_days_beta': 30,
        'calc_volatility': False,
        'vol_window_days': 365,
        'exclude_days_vol': 30,
        'use_minimal_threshold': False,
        'minimal_threshold_percent': 4.0,
        'use_max_allocation': False,
        'max_allocation_percent': 20.0,
        'exclude_before_sp500_entry': False,
        'use_min_market_cap_filter': False,
        'min_market_cap_billions': 10.0,
        'collect_dividends_as_cash': False,
        'start_date_user': None,
        'end_date_user': None,
        'fusion_portfolio': {'enabled': False, 'selected_portfolios': [], 'allocations': {}}
    }]
    st.session_state.alloc_active_portfolio_index = 0
    st.success("✅ All portfolios cleared! Created 'New Portfolio 1'")
    st.rerun()

# Clear All Outputs Function
def clear_all_outputs():
    """Clear all backtest results and outputs while preserving portfolio configurations"""
    # Clear all result data
    st.session_state.multi_all_results = None
    st.session_state.multi_all_allocations = None
    st.session_state.multi_all_metrics = None
    st.session_state.multi_backtest_all_drawdowns = None
    st.session_state.multi_backtest_stats_df_display = None
    st.session_state.multi_backtest_all_years = None
    st.session_state.multi_backtest_portfolio_key_map = {}
    st.session_state.multi_backtest_ran = False
    
    # Clear allocations page specific data
    st.session_state.alloc_all_allocations = None
    st.session_state.alloc_all_metrics = None
    st.session_state.alloc_snapshot_data = None
    
    # Clear any processing flags
    for key in list(st.session_state.keys()):
        if key.startswith("processing_portfolio_"):
            del st.session_state[key]
    
    # Clear any stored data
    if 'raw_data' in st.session_state:
        del st.session_state['raw_data']
    
    st.success("✅ All outputs cleared! Portfolio configurations preserved.")

# Clear All Outputs Button
if st.sidebar.button("🗑️ Clear All Outputs", type="secondary", help="Clear all charts and results while keeping portfolio configurations", use_container_width=True):
    clear_all_outputs()
    st.rerun()

# Cancel Run Button
if st.sidebar.button("🛑 Cancel Run", type="secondary", help="Stop current backtest execution gracefully", use_container_width=True):
    st.session_state.hard_kill_requested = True
    st.toast("🛑 **CANCELLING** - Stopping backtest execution...", icon="⏹️")
    st.rerun()

# Emergency Kill Button
if st.sidebar.button("🚨 EMERGENCY KILL", type="secondary", help="Force terminate all processes immediately - Use for crashes, freezes, or unresponsive states", use_container_width=True):
    st.toast("🚨 **EMERGENCY KILL** - Force terminating all processes...", icon="💥")
    emergency_kill()

def calculate_minimum_lookback_days(portfolios):
    """
    Calculate the minimum data period needed for a backtest.
    Returns number of days to fetch (instead of period="max").
    """
    max_lookback = 0
    
    for config in portfolios:
        # Check momentum windows
        if config.get('use_momentum') and config.get('momentum_windows'):
            for window in config['momentum_windows']:
                lookback = window.get('lookback', 0)
                if lookback > max_lookback:
                    max_lookback = lookback
        
        # Check beta window
        if config.get('calc_beta'):
            beta_lookback = config.get('beta_window_days', 0)
            if beta_lookback > max_lookback:
                max_lookback = beta_lookback
        
        # Check volatility window
        if config.get('calc_volatility'):
            vol_lookback = config.get('vol_window_days', 0)
            if vol_lookback > max_lookback:
                max_lookback = vol_lookback
    
    # Add buffer: max lookback + 700 days extra for safety
    # This ensures we have enough data even with excludes, market holidays, and recent tickers
    total_days_needed = max_lookback + 700
    
    return total_days_needed

# Move Run Backtest to the first sidebar to make it conspicuous and separate from config
if st.sidebar.button("🚀 Run Backtest", type="primary", use_container_width=True):
    # Reset kill request when starting new backtest
    st.session_state.hard_kill_requested = False
    
    # Update active portfolio config with current session state values before running backtest
    active_portfolio = st.session_state.alloc_portfolio_configs[st.session_state.alloc_active_portfolio_index]
    active_portfolio['use_minimal_threshold'] = st.session_state.get('alloc_active_use_threshold', False)
    active_portfolio['minimal_threshold_percent'] = st.session_state.get('alloc_active_threshold_percent', 4.0)
    active_portfolio['use_max_allocation'] = st.session_state.get('alloc_active_use_max_allocation', False)
    active_portfolio['max_allocation_percent'] = st.session_state.get('alloc_active_max_allocation_percent', 20.0)
    
    # Debug output
    
    # Pre-backtest validation check for all portfolios
    # Prefer the allocations page configs when present so this page's edits are included
    configs_to_run = st.session_state.get('alloc_portfolio_configs', [])
    # Local alias used throughout the run block
    portfolio_list = configs_to_run
    # Set flag to show metrics after running backtest
    st.session_state['alloc_backtest_run'] = True
    valid_configs = True
    validation_errors = []
    
    for cfg in configs_to_run:
        if cfg['use_momentum']:
            total_momentum_weight = sum(w['weight'] for w in cfg['momentum_windows'])
            if abs(total_momentum_weight - 1.0) > (_TOTAL_TOL / 100.0):
                validation_errors.append(f"Portfolio '{cfg['name']}' has momentum enabled but the total momentum weight is {total_momentum_weight*100:.2f}% (must be 100%)")
                valid_configs = False
        else:
            valid_stocks_for_cfg = [s for s in cfg['stocks'] if s['ticker']]
            total_stock_allocation = sum(s['allocation'] for s in valid_stocks_for_cfg)
            if abs(total_stock_allocation - 1.0) > (_ALLOC_TOL / 100.0):
                validation_errors.append(f"Portfolio '{cfg['name']}' is not using momentum, but the total ticker allocation is {total_ticker_allocation*100:.2f}% (must be 100%)")
                valid_configs = False
                
    # Initialize progress bar
    progress_bar = st.empty()
    
    if not valid_configs:
        for error in validation_errors:
            st.error(error)
        # Don't run the backtest, but continue showing the UI
        progress_bar.empty()
        st.stop()
    else:
        # Show standalone popup notification that code is really running
        st.toast("**Code is running!** Starting backtest...", icon="🚀")
        
        progress_bar.progress(0, text="Starting backtest...")
        
        # Check for kill request
        check_kill_request()
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        all_tickers = sorted(list(set(s['ticker'] for cfg in portfolio_list for s in cfg['stocks'] if s['ticker']) | set(cfg.get('benchmark_ticker') for cfg in portfolio_list if 'benchmark_ticker' in cfg)))
        all_tickers = [t for t in all_tickers if t]
        
        # CRITICAL FIX: Add base tickers for leveraged tickers to ensure dividend data is available
        base_tickers_to_add = set()
        for ticker in all_tickers:
            if "?L=" in ticker:
                base_ticker, leverage = parse_leverage_ticker(ticker)
                base_tickers_to_add.add(base_ticker)

        # Add base tickers to the list if they're not already there
        for base_ticker in base_tickers_to_add:
            if base_ticker not in all_tickers:
                all_tickers.append(base_ticker)
        
        # CRITICAL FIX: Add MA reference tickers to ensure they are downloaded
        ma_reference_tickers_to_add = set()
        for cfg in portfolio_list:
            # Only collect MA reference tickers if MA filter is enabled
            if cfg.get('use_sma_filter', False):
                for stock in cfg.get('stocks', []):
                    ma_ref_ticker = stock.get('ma_reference_ticker', '').strip()
                    # If a custom reference ticker is specified (not empty)
                    if ma_ref_ticker:
                        # Resolve aliases (e.g., TLTTR -> TLT_COMPLETE, GOLDX -> GOLD_COMPLETE)
                        resolved_ma_ref = resolve_ticker_alias(ma_ref_ticker)
                        if resolved_ma_ref not in all_tickers:
                            ma_reference_tickers_to_add.add(resolved_ma_ref)
        
        # Add MA reference tickers to the download list
        for ma_ref_ticker in ma_reference_tickers_to_add:
            if ma_ref_ticker not in all_tickers:
                all_tickers.append(ma_ref_ticker)
        
        print("Downloading data for all tickers...")
        data = {}
        invalid_tickers = []
        # OPTIMIZED: Batch download with smart fallback
        progress_text = f"Downloading data for {len(all_tickers)} tickers (batch mode)..."
        progress_bar.progress(0.1, text=progress_text)
        
        # Check for kill request before batch
        check_kill_request()
        
        # OPTIMIZATION: Calculate minimum lookback period needed
        min_days_needed = calculate_minimum_lookback_days(portfolio_list)
        print(f"📊 OPTIMIZATION: Only loading last {min_days_needed} days of data (instead of all history)")
        print(f"   Max lookback window: {min_days_needed - 365} days + 365 days buffer")
        
        # Convert days to period string for yfinance
        # yfinance accepts: "1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"
        if min_days_needed <= 5:
            period_to_use = "5d"
        elif min_days_needed <= 30:
            period_to_use = "1mo"
        elif min_days_needed <= 90:
            period_to_use = "3mo"
        elif min_days_needed <= 180:
            period_to_use = "6mo"
        elif min_days_needed <= 365:
            period_to_use = "1y"
        elif min_days_needed <= 730:
            period_to_use = "2y"
        elif min_days_needed <= 1825:
            period_to_use = "5y"
        elif min_days_needed <= 3650:
            period_to_use = "10y"
        else:
            period_to_use = "max"  # For very long lookback windows
        
        print(f"   Using period: '{period_to_use}' for yfinance")

        # One consolidated yahooquery batch for portfolio + standard benchmark symbols (warm session merge).
        _alloc_benchmark_universe = [
            'SPY', 'QQQ', 'SPMO', 'VTI', 'VT', 'SSO', 'QLD', 'BITCOIN',
        ]
        _info_prefetch = sorted(set(all_tickers) | set(_alloc_benchmark_universe))
        get_multiple_tickers_info_batch(_info_prefetch)

        # BATCH DOWNLOAD - Use get_multiple_tickers_batch for ALL tickers (portfolio + benchmark) - SAME AS PAGE 1
        batch_results = get_multiple_tickers_batch(all_tickers, period=period_to_use, auto_adjust=False)
        
        # Show API efficiency message
        api_call_count = st.session_state.get('api_call_count', 0)
        # st.success(f"🚀 **API Efficiency**: Downloaded data for {len(all_tickers)} tickers using **{api_call_count} batch call(s)** (PE data TRUE BATCHED with yahooquery)")
        
        # Process batch results
        for i, t in enumerate(all_tickers):
            progress_text = f"Processing {t} ({i+1}/{len(all_tickers)})..."
            progress_bar.progress((i + 1) / (len(all_tickers) + len(portfolio_list)), text=progress_text)
            
            hist = batch_results.get(t, pd.DataFrame())
            
            # Enhanced validation like page 1
            if hist.empty or not hasattr(hist, 'Close') or hist['Close'].isna().all():
                st.warning(f"⚠️ {t}: No valid data (empty or all NaN)")
                invalid_tickers.append(t)
                continue
            
            try:
                # Force tz-naive for hist (like Backtest_Engine.py)
                hist = hist.copy()
                hist.index = hist.index.tz_localize(None)
                
                hist["Price_change"] = hist["Close"].pct_change(fill_method=None).fillna(0)
                data[t] = hist
                print(f"Data loaded for {t} from {data[t].index[0].date()}")
            except Exception as e:
                print(f"Error loading {t}: {e}")
                invalid_tickers.append(t)
        
        # Display invalid ticker warnings in Streamlit UI
        if invalid_tickers:
            # Separate portfolio tickers from benchmark tickers
            portfolio_tickers = set(s['ticker'] for cfg in portfolio_list for s in cfg['stocks'] if s['ticker'])
            benchmark_tickers = set(cfg.get('benchmark_ticker') for cfg in portfolio_list if 'benchmark_ticker' in cfg)
            
            portfolio_invalid = [t for t in invalid_tickers if t in portfolio_tickers]
            benchmark_invalid = [t for t in invalid_tickers if t in benchmark_tickers]
            
            if portfolio_invalid:
                st.warning(f"The following portfolio tickers are invalid and will be skipped: {', '.join(portfolio_invalid)}")
            if benchmark_invalid:
                st.warning(f"The following benchmark tickers are invalid and will be skipped: {', '.join(benchmark_invalid)}")
        
        # BULLETPROOF VALIDATION: Check for valid tickers and stop gracefully if none
        if not data:
            if invalid_tickers and len(invalid_tickers) == len(all_tickers):
                st.error(f"❌ **No valid tickers found!** All tickers are invalid: {', '.join(invalid_tickers)}. Please check your ticker symbols and try again.")
            else:
                st.error("❌ **No valid tickers found!** No data downloaded; aborting.")
            progress_bar.empty()
            st.session_state.alloc_all_results = None
            st.session_state.alloc_all_allocations = None
            st.session_state.alloc_all_metrics = None
            st.stop()
        else:
            # Check if any portfolio has valid tickers
            all_portfolio_tickers = set()
            for cfg in portfolio_list:
                portfolio_tickers = [s['ticker'] for s in cfg['stocks'] if s['ticker']]
                all_portfolio_tickers.update(portfolio_tickers)
            
            # Check for non-USD tickers and display currency warning
            check_currency_warning(list(all_portfolio_tickers))
            
            valid_portfolio_tickers = [t for t in all_portfolio_tickers if t in data]
            if not valid_portfolio_tickers:
                st.error(f"❌ **No valid tickers found!** No valid portfolio tickers found. Invalid tickers: {', '.join(all_portfolio_tickers)}. Please check your ticker symbols and try again.")
                progress_bar.empty()
                st.session_state.alloc_all_results = None
                st.session_state.alloc_all_allocations = None
                st.session_state.alloc_all_metrics = None
                st.stop()
            else:
                # Persist raw downloaded price data so later recomputations can access benchmark series
                st.session_state.alloc_raw_data = data
                common_start = max(df.first_valid_index() for df in data.values())
                common_end = min(df.last_valid_index() for df in data.values())
                print()
                all_results = {}
                all_drawdowns = {}
                all_stats = {}
                all_allocations = {}
                all_metrics = {}
                # Map portfolio index (0-based) to the unique key used in the result dicts
                portfolio_key_map = {}

                # Prefetch Yahoo sector + industry once if any portfolio uses concentration limits
                needs_sector_map = any(
                    cfg.get('use_sector_concentration_limit') or cfg.get('use_industry_concentration_limit')
                    for cfg in portfolio_list
                )
                if needs_sector_map:
                    sector_tickers = sorted({
                        s['ticker']
                        for cfg in portfolio_list
                        for s in cfg.get('stocks', [])
                        if s.get('ticker')
                    })
                    with st.spinner(f"Loading sector/industry for {len(sector_tickers)} tickers..."):
                        st.session_state.alloc_sector_industry_map = fetch_sector_industry_map(sector_tickers)
                    known = sum(
                        1 for m in st.session_state.alloc_sector_industry_map.values()
                        if m.get('sector') not in (None, '', 'Unknown')
                    )
                    st.caption(f"Sector/industry map: {known}/{len(sector_tickers)} tickers with Yahoo sector.")
                else:
                    st.session_state.alloc_sector_industry_map = {}

                needs_sp500_map = any(
                    cfg.get('exclude_before_sp500_entry')
                    for cfg in portfolio_list
                )
                if needs_sp500_map:
                    with st.spinner("Loading S&P 500 tickers and entry dates from Wikipedia..."):
                        sp500_payload, sp500_err = fetch_sp500_wikipedia_constituents()
                    if sp500_err or not sp500_payload:
                        st.warning(
                            f"Could not load Wikipedia S&P 500 entry dates ({sp500_err}). "
                            "The before-entry filter is skipped for this run."
                        )
                        date_map = {}
                    else:
                        date_map = sp500_payload.get("date_added") or {}
                        st.caption(
                            f"S&P 500 Wikipedia: {len(sp500_payload.get('tickers') or [])} tickers + entry dates "
                            "(page-local urllib, 24h cache, no Yahoo, no http_requests)."
                        )
                    st.session_state.alloc_sp500_date_added = date_map
                    for cfg in portfolio_list:
                        if cfg.get('exclude_before_sp500_entry'):
                            cfg['_sp500_date_added'] = date_map
                else:
                    st.session_state.alloc_sp500_date_added = {}

                needs_mcap_map = any(
                    cfg.get('use_min_market_cap_filter')
                    for cfg in portfolio_list
                )
                if needs_mcap_map:
                    mcap_tickers = sorted({
                        s['ticker']
                        for cfg in portfolio_list
                        if cfg.get('use_min_market_cap_filter')
                        for s in cfg.get('stocks', [])
                        if s.get('ticker')
                    })
                    with st.spinner(f"Loading current market caps for {len(mcap_tickers)} tickers (Yahoo quote batch)..."):
                        scale_map, mcap_err = fetch_yahoo_quote_market_caps(mcap_tickers)
                    if mcap_err and not scale_map:
                        st.warning(
                            f"Could not load Yahoo market caps ({mcap_err}). "
                            "The market-cap filter is skipped for this run."
                        )
                        scale_map = {}
                    else:
                        st.caption(
                            f"Market-cap proxy: {len(scale_map)}/{len(mcap_tickers)} tickers with a Yahoo cap "
                            "(chunked quote endpoint, 24h cache, not one request per ticker)."
                        )
                    st.session_state.alloc_mcap_price_scale = scale_map
                    for cfg in portfolio_list:
                        if cfg.get('use_min_market_cap_filter'):
                            cfg['_mcap_price_scale'] = scale_map
                else:
                    st.session_state.alloc_mcap_price_scale = {}
                
                for i, cfg in enumerate(portfolio_list, start=1):
                    progress_text = f"Running backtest for {cfg.get('name', f'Backtest {i}')} ({i}/{len(portfolio_list)})..."
                    progress_bar.progress((len(all_tickers) + i) / (len(all_tickers) + len(portfolio_list)), text=progress_text)
                    name = cfg.get('name', f'Backtest {i}')
                    # Ensure unique key for storage to avoid overwriting when duplicate names exist
                    base_name = name
                    unique_name = base_name
                    suffix = 1
                    while unique_name in all_results or unique_name in all_allocations:
                        unique_name = f"{base_name} ({suffix})"
                        suffix += 1
                    print(f"\nRunning backtest {i}/{len(portfolio_list)}: {name}")
                    # Separate asset tickers from benchmark. Do NOT use benchmark when
                    # computing start/end/simulation dates or available-rebalance logic.
                    asset_tickers = [s['ticker'] for s in cfg['stocks'] if s['ticker']]
                    asset_tickers = [t for t in asset_tickers if t in data and t is not None]
                    benchmark_local = cfg.get('benchmark_ticker')
                    benchmark_in_data = benchmark_local if benchmark_local in data else None
                    tickers_for_config = asset_tickers
                    # Build the list of tickers whose data we will reindex (include benchmark if present)
                    data_tickers = list(asset_tickers)
                    if benchmark_in_data:
                        data_tickers.append(benchmark_in_data)
                    if not tickers_for_config:
                        # Check if this is because all tickers are invalid
                        original_asset_tickers = [s['ticker'] for s in cfg['stocks'] if s['ticker']]
                        missing_tickers = [t for t in original_asset_tickers if t not in data]
                        if missing_tickers:
                            print(f"  No available asset tickers for {name}; invalid tickers: {missing_tickers}. Skipping.")
                        else:
                            print(f"  No available asset tickers for {name}; skipping.")
                        continue
                    if cfg.get('start_with') == 'all':
                        # Start only when all asset tickers have data
                        final_start = max(data[t].first_valid_index() for t in tickers_for_config)
                    else:
                        # 'oldest' -> start at the earliest asset ticker date so assets can be added over time
                        final_start = min(data[t].first_valid_index() for t in tickers_for_config)
                    if cfg.get('start_date_user'):
                        user_start = pd.to_datetime(cfg['start_date_user'])
                        final_start = max(final_start, user_start)
                    # Preserve previous global alignment only for 'all' mode; do NOT force 'oldest' back to global latest
                    if cfg.get('start_with') == 'all':
                        final_start = max(final_start, common_start)
                    if cfg.get('end_date_user'):
                        final_end = min(pd.to_datetime(cfg['end_date_user']), min(data[t].last_valid_index() for t in tickers_for_config))
                    else:
                        final_end = min(data[t].last_valid_index() for t in tickers_for_config)
                    if final_start > final_end:
                        print(f"  Start date {final_start.date()} is after end date {final_end.date()}. Skipping {name}.")
                        continue
                    
                    simulation_index = pd.date_range(start=final_start, end=final_end, freq='D')
                    print(f"  Simulation period for {name}: {final_start.date()} to {final_end.date()}\n")
                    data_reindexed_for_config = {}
                    invalid_tickers = []
                    for t in data_tickers:
                        if t in data:  # Only process tickers that have data
                            df = data[t].reindex(simulation_index)
                            df["Close"] = df["Close"].ffill()
                            df["Dividends"] = df["Dividends"].fillna(0)
                            df["Price_change"] = df["Close"].pct_change(fill_method=None).fillna(0)
                            data_reindexed_for_config[t] = df
                        else:
                            invalid_tickers.append(t)
                            print(f"Warning: Invalid ticker '{t}' - no data available, skipping reindexing")
                    
                    # Display invalid ticker warnings in Streamlit UI
                    if invalid_tickers:
                        st.warning(f"The following tickers are invalid and will be skipped: {', '.join(invalid_tickers)}")
                    total_series, total_series_no_additions, historical_allocations, historical_metrics = single_backtest(cfg, simulation_index, data_reindexed_for_config)
                    # Store both series under the unique key for later use
                    all_results[unique_name] = {
                        'no_additions': total_series_no_additions,
                        'with_additions': total_series
                    }
                    all_allocations[unique_name] = historical_allocations
                    all_metrics[unique_name] = historical_metrics
                    # Remember mapping from portfolio index (0-based) to unique key
                    portfolio_key_map[i-1] = unique_name
                # --- PATCHED CASH FLOW LOGIC ---
                # Track cash flows as pandas Series indexed by date
                cash_flows = pd.Series(0.0, index=total_series.index)
                # Initial investment: negative cash flow on first date
                if len(total_series.index) > 0:
                    cash_flows.iloc[0] = -cfg.get('initial_value', 0)
                # No periodic additions for allocation tracker
                # Final value: positive cash flow on last date for MWRR
                if len(total_series.index) > 0:
                    cash_flows.iloc[-1] += total_series.iloc[-1]
                # Get benchmark returns for stats calculation
                benchmark_returns = None
                if cfg['benchmark_ticker'] and cfg['benchmark_ticker'] in data_reindexed_for_config:
                    benchmark_returns = data_reindexed_for_config[cfg['benchmark_ticker']]['Price_change']
                # Ensure benchmark_returns is a pandas Series aligned to total_series
                if benchmark_returns is not None:
                    benchmark_returns = pd.Series(benchmark_returns, index=total_series.index).dropna()
                # Ensure cash_flows is a pandas Series indexed by date, with initial investment and additions
                cash_flows = pd.Series(cash_flows, index=total_series.index)
                # Align for stats calculation
                # Track cash flows for MWRR exactly as in app.py
                # Initial investment: negative cash flow on first date
                mwrr_cash_flows = pd.Series(0.0, index=total_series.index)
                if len(total_series.index) > 0:
                    mwrr_cash_flows.iloc[0] = -cfg.get('initial_value', 0)
                # Periodic additions: negative cash flow on their respective dates
                dates_added = get_dates_by_freq(cfg.get('added_frequency'), total_series.index[0], total_series.index[-1], total_series.index)
                for d in dates_added:
                    if d in mwrr_cash_flows.index and d != mwrr_cash_flows.index[0]:
                        mwrr_cash_flows.loc[d] -= cfg.get('added_amount', 0)
                # Final value: positive cash flow on last date for MWRR
                if len(total_series.index) > 0:
                    mwrr_cash_flows.iloc[-1] += total_series.iloc[-1]

                # Use the no-additions series returned by single_backtest (do NOT reconstruct it here)
                # total_series_no_additions is returned by single_backtest and already represents the portfolio value without added cash.

                # Calculate statistics
                # Use total_series_no_additions for all stats except MWRR
                stats_values = total_series_no_additions.values
                stats_dates = total_series_no_additions.index
                stats_returns = pd.Series(stats_values, index=stats_dates).pct_change().fillna(0)
                cagr = calculate_cagr(stats_values, stats_dates)
                max_dd, drawdowns = calculate_max_drawdown(stats_values)
                vol = calculate_volatility(stats_returns)
                sharpe = np.nan if stats_returns.std() == 0 else stats_returns.mean() * 365.25 / (stats_returns.std() * np.sqrt(365.25))
                sortino = calculate_sortino(stats_returns)
                ulcer = calculate_ulcer_index(stats_values)
                upi = calculate_upi(cagr, ulcer)
                # --- Beta calculation (copied from app.py) ---
                beta = np.nan
                if benchmark_returns is not None:
                    portfolio_returns = stats_returns.copy()
                    benchmark_returns_series = pd.Series(benchmark_returns, index=stats_dates).dropna()
                    common_idx = portfolio_returns.index.intersection(benchmark_returns_series.index)
                    if len(common_idx) >= 2:
                        pr = portfolio_returns.reindex(common_idx).dropna()
                        br = benchmark_returns_series.reindex(common_idx).dropna()
                        common_idx = pr.index.intersection(br.index)
                        if len(common_idx) >= 2 and br.loc[common_idx].var() != 0:
                            cov = pr.loc[common_idx].cov(br.loc[common_idx])
                            var = br.loc[common_idx].var()
                            beta = cov / var
                # MWRR uses the full backtest with additions
                mwrr = calculate_mwrr(total_series, mwrr_cash_flows, total_series.index)
                def scale_pct(val):
                    if val is None or np.isnan(val):
                        return np.nan
                    # Only scale if value is between -1 and 1 (decimal)
                    if -1.5 < val < 1.5:
                        return val * 100
                    return val

                def clamp_stat(val, stat_type):
                    if val is None or np.isnan(val):
                        return "N/A"
                    v = scale_pct(val)
                    # Clamp ranges for each stat type
                    if stat_type in ["CAGR", "Volatility", "MWRR"]:
                        if v > 100:
                            return "N/A"
                    if stat_type == "MaxDrawdown":
                        if v < -100 or v > 0:
                            return "N/A"
                    return f"{v:.2f}%" if stat_type in ["CAGR", "MaxDrawdown", "Volatility", "MWRR"] else f"{v:.3f}" if isinstance(v, float) else v

                stats = {
                    "CAGR": clamp_stat(cagr, "CAGR"),
                    "MaxDrawdown": clamp_stat(max_dd, "MaxDrawdown"),
                    "Volatility": clamp_stat(vol, "Volatility"),
                    "Sharpe": clamp_stat(sharpe / 100 if isinstance(sharpe, (int, float)) and pd.notna(sharpe) else sharpe, "Sharpe"),
                    "Sortino": clamp_stat(sortino / 100 if isinstance(sortino, (int, float)) and pd.notna(sortino) else sortino, "Sortino"),
                    "UlcerIndex": clamp_stat(ulcer, "UlcerIndex"),
                    "UPI": clamp_stat(upi / 100 if isinstance(upi, (int, float)) and pd.notna(upi) else upi, "UPI"),
                    "Beta": clamp_stat(beta / 100 if isinstance(beta, (int, float)) and pd.notna(beta) else beta, "Beta"),
                    "MWRR": clamp_stat(mwrr, "MWRR"),
                }
                all_stats[name] = stats
                all_drawdowns[name] = pd.Series(drawdowns, index=stats_dates)
            progress_bar.progress(100, text="Backtests complete!")
            
            # DEBUG: Final API call summary
            final_api_count = st.session_state.get('api_call_count', 0)
            # st.success(f"🎯 **FINAL API SUMMARY**: **{final_api_count} total API calls** made during this session (includes: price data batch + PE data batch + risk-free rate + individual tickers + benchmark data)")
            
            print("\n" + "="*80)
            print(" " * 25 + "FINAL PERFORMANCE STATISTICS")
            print("="*80 + "\n")
            stats_df = pd.DataFrame(all_stats).T
            def fmt_pct(x):
                if isinstance(x, (int, float)) and pd.notna(x):
                    return f"{x*100:.2f}%"
                if isinstance(x, str):
                    return x
                return "N/A"
            def fmt_num(x, prec=3):
                if isinstance(x, (int, float)) and pd.notna(x):
                    return f"{x:.3f}"
                if isinstance(x, str):
                    return x
                return "N/A"
            if not stats_df.empty:
                stats_df_display = stats_df.copy()
                stats_df_display.rename(columns={'MaxDrawdown': 'Max Drawdown', 'UlcerIndex': 'Ulcer Index'}, inplace=True)
                stats_df_display['CAGR'] = stats_df_display['CAGR'].apply(lambda x: fmt_pct(x))
                stats_df_display['Max Drawdown'] = stats_df_display['Max Drawdown'].apply(lambda x: fmt_pct(x))
                stats_df_display['Volatility'] = stats_df_display['Volatility'].apply(lambda x: fmt_pct(x))
                # Ensure MWRR is the last column, Beta immediately before it
                if 'Beta' in stats_df_display.columns and 'MWRR' in stats_df_display.columns:
                    cols = list(stats_df_display.columns)
                    # Remove Beta and MWRR
                    beta_col = cols.pop(cols.index('Beta'))
                    mwrr_col = cols.pop(cols.index('MWRR'))
                    # Insert Beta before MWRR at the end
                    cols.append(beta_col)
                    cols.append(mwrr_col)
                    stats_df_display = stats_df_display[cols]
                stats_df_display['MWRR'] = stats_df_display['MWRR'].apply(lambda x: fmt_pct(x))
                stats_df_display['Sharpe'] = stats_df_display['Sharpe'].apply(lambda x: fmt_num(x))
                stats_df_display['Sortino'] = stats_df_display['Sortino'].apply(lambda x: fmt_num(x))
                stats_df_display['Ulcer Index'] = stats_df_display['Ulcer Index'].apply(lambda x: fmt_num(x))
                stats_df_display['UPI'] = stats_df_display['UPI'].apply(lambda x: fmt_num(x))
                if 'Beta' in stats_df_display.columns:
                    stats_df_display['Beta'] = stats_df_display['Beta'].apply(lambda x: fmt_num(x))
                print(stats_df_display.to_string())
            else:
                print("No stats to display.")
            # Yearly performance section (interactive table below)
            all_years = {}
            for name, ser in all_results.items():
                # Use the with-additions series for yearly performance (user requested)
                yearly = ser['with_additions'].resample('YE').last()
                all_years[name] = yearly
            years = sorted(list(set(y.year for ser in all_years.values() for y in ser.index)))
            names = list(all_years.keys())
            
            # Print console log yearly table correctly
            col_width = 22
            header_format = "{:<6} |" + "".join([" {:^" + str(col_width*2+1) + "} |" for _ in names])
            row_format = "{:<6} |" + "".join([" {:>" + str(col_width) + "} {:>" + str(col_width) + "} |" for _ in names])
            
            print(header_format.format("Year", *names))
            print("-" * (6 + 3 + (col_width*2+1 + 3)*len(names)))
            print(row_format.format(" ", *[item for pair in [('% Change', 'Final Value')] * len(names) for item in pair]))
            print("=" * (6 + 3 + (col_width*2+1 + 3)*len(names)))
            
            for y in years:
                row_items = [f"{y}"]
                for nm in names:
                    ser = all_years[nm]
                    ser_year = ser[ser.index.year == y]
                    
                    # Corrected logic for yearly performance calculation
                    start_val_for_year = None
                    if y == min(years):
                        config_for_name = next((c for c in portfolio_list if c['name'] == nm), None)
                        if config_for_name:
                            initial_val_of_config = config_for_name['initial_value']
                            if initial_val_of_config > 0:
                                start_val_for_year = initial_val_of_config
                    else:
                        prev_year = y - 1
                        prev_ser_year = all_years[nm][all_years[nm].index.year == prev_year]
                        if not prev_ser_year.empty:
                            start_val_for_year = prev_ser_year.iloc[-1]
                        
                    if not ser_year.empty and start_val_for_year is not None:
                        end_val = ser_year.iloc[-1]
                        if start_val_for_year > 0:
                            pct = f"{(end_val - start_val_for_year) / start_val_for_year * 100:.2f}%"
                            final_val = f"${end_val:,.2f}"
                        else:
                            pct = "N/A"
                            final_val = "N/A"
                    else:
                        pct = "N/A"
                        final_val = "N/A"
                        
                    row_items.extend([pct, final_val])
                print(row_format.format(*row_items))
            print("\n" + "="*80)
    
            # console output captured previously is no longer shown on the page
            st.session_state.alloc_all_results = all_results
            st.session_state.alloc_all_drawdowns = all_drawdowns
            if 'stats_df_display' in locals():
                st.session_state.alloc_stats_df_display = stats_df_display
            st.session_state.alloc_all_years = all_years
            st.session_state.alloc_all_allocations = all_allocations
            # Save a snapshot used by the allocations UI so charts/tables remain static until rerun
            try:
                # compute today_weights_map (target weights as-if rebalanced at final snapshot date)
                today_weights_map = {}
                for pname, allocs in all_allocations.items():
                    try:
                        alloc_dates = sorted(list(allocs.keys()))
                        final_d = alloc_dates[-1]
                        metrics_local = all_metrics.get(pname, {})
                        
                        # Check if momentum is used for this portfolio
                        portfolio_cfg = next((cfg for cfg in portfolio_list if cfg.get('name') == pname), None)
                        use_momentum = portfolio_cfg.get('use_momentum', True) if portfolio_cfg else True
                        
                        if final_d in metrics_local:
                            if use_momentum:
                                # extract Calculated_Weight if present (momentum-based)
                                weights = {t: v.get('Calculated_Weight', 0) for t, v in metrics_local[final_d].items()}
                                # normalize (ensure sums to 1 excluding CASH)
                                sumw = sum(w for k, w in weights.items() if k != 'CASH')
                                if sumw > 0:
                                    norm = {k: (w / sumw) if k != 'CASH' else weights.get('CASH', 0) for k, w in weights.items()}
                                else:
                                    norm = weights
                                today_weights_map[pname] = norm
                            else:
                                # Use user-defined allocations from portfolio config - COPIED FROM PAGE 1
                                weights = {}
                                for stock in portfolio_cfg.get('stocks', []):
                                    ticker = stock.get('ticker', '').strip()
                                    if ticker:
                                        weights[ticker] = stock.get('allocation', 0)
                                
                                # Apply MA filter even when momentum is disabled
                                if portfolio_cfg.get('use_sma_filter', False):
                                    ma_window = portfolio_cfg.get('sma_window', 200)
                                    ma_type = portfolio_cfg.get('ma_type', 'SMA')
                                    # Get list of current tickers (excluding CASH)
                                    current_tickers = [t for t in weights.keys() if t != 'CASH']
                                    
                                    # Apply MA filter using data (ULTRA OPTIMIZED!)
                                    try:
                                        # ULTRA FAST: Use precomputed filter results if available!
                                        if hasattr(portfolio_cfg, '_ma_filter_data') and portfolio_cfg._ma_filter_data is not None:
                                            filtered_tickers = [t for t in current_tickers if portfolio_cfg._ma_filter_data.get(final_d, {}).get(t, True)]
                                            excluded_assets = {t: f"Below MA" for t in current_tickers if t not in filtered_tickers}
                                        else:
                                            # Fallback to original method if not precomputed
                                            filtered_tickers, excluded_assets = filter_assets_by_ma(current_tickers, data, final_d, ma_window, ma_type, portfolio_cfg, portfolio_cfg.get('stocks', []))
                                        
                                        # Redistribute allocations of excluded tickers
                                        if excluded_assets:
                                            excluded_ticker_list = list(excluded_assets.keys())
                                            excluded_allocation = sum(weights.get(t, 0) for t in excluded_ticker_list)
                                            
                                            # Remove excluded tickers
                                            for excluded_ticker in excluded_ticker_list:
                                                if excluded_ticker in weights:
                                                    del weights[excluded_ticker]
                                            
                                            # Redistribute to remaining tickers
                                            remaining_tickers = [t for t in weights.keys() if t != 'CASH']
                                            if remaining_tickers:
                                                remaining_allocation = sum(weights.get(t, 0) for t in remaining_tickers)
                                                if remaining_allocation > 0:
                                                    for ticker in remaining_tickers:
                                                        proportion = weights[ticker] / remaining_allocation
                                                        weights[ticker] += excluded_allocation * proportion
                                                else:
                                                    # Equal distribution
                                                    equal_allocation = excluded_allocation / len(remaining_tickers)
                                                    for ticker in remaining_tickers:
                                                        weights[ticker] = equal_allocation
                                            else:
                                                # No remaining tickers, all goes to CASH
                                                weights = {'CASH': 1.0}
                                    except Exception as e:
                                        # If MA filter fails, keep original allocations
                                        pass
                                
                                # Add CASH if needed (after MA / S&P 500 entry filters)
                                if _universe_filters_active(portfolio_cfg):
                                    current_tickers = [t for t in weights.keys() if t != 'CASH']
                                    filtered_tickers = filter_tickers_by_sp500_entry(current_tickers, final_d, portfolio_cfg)
                                    excluded_ticker_list = [t for t in current_tickers if t not in filtered_tickers]
                                    if excluded_ticker_list:
                                        excluded_allocation = sum(weights.get(t, 0) for t in excluded_ticker_list)
                                        for t in excluded_ticker_list:
                                            weights[t] = 0
                                        remaining_tickers = [t for t in weights.keys() if t != 'CASH' and weights.get(t, 0) > 0]
                                        if remaining_tickers:
                                            remaining_allocation = sum(weights.get(t, 0) for t in remaining_tickers)
                                            if remaining_allocation > 0:
                                                for ticker in remaining_tickers:
                                                    proportion = weights[ticker] / remaining_allocation
                                                    weights[ticker] += excluded_allocation * proportion
                                            else:
                                                equal_allocation = excluded_allocation / len(remaining_tickers)
                                                for ticker in remaining_tickers:
                                                    weights[ticker] = equal_allocation
                                        else:
                                            weights = {'CASH': 1.0}

                                if 'CASH' not in weights:
                                    total_alloc = sum(weights.values())
                                    if total_alloc < 1.0:
                                        weights['CASH'] = 1.0 - total_alloc
                                    else:
                                        weights['CASH'] = 0
                                
                                # For targeted rebalancing: check if rebalancing would be triggered today
                                # If no rebalancing needed, show current allocation instead of target allocation
                                if portfolio_cfg.get('use_targeted_rebalancing', False):
                                    # Get current allocation from historical_allocations (drifted)
                                    current_alloc = allocs.get(final_d, {})
                                    
                                    # Check if any threshold is exceeded
                                    targeted_settings = portfolio_cfg.get('targeted_rebalancing_settings', {})
                                    threshold_exceeded = False
                                    
                                    for ticker in current_alloc.keys():
                                        if ticker != 'CASH' and ticker in targeted_settings and targeted_settings[ticker].get('enabled', False):
                                            current_allocation_pct = current_alloc.get(ticker, 0) * 100
                                            max_threshold = targeted_settings[ticker].get('max_allocation', 100.0)
                                            min_threshold = targeted_settings[ticker].get('min_allocation', 0.0)
                                            
                                            # Check if allocation exceeds max or falls below min threshold
                                            if current_allocation_pct > max_threshold or current_allocation_pct < min_threshold:
                                                threshold_exceeded = True
                                                break
                                    
                                    # If no threshold exceeded, use current (drifted) allocation instead of target
                                    if not threshold_exceeded and current_alloc:
                                        weights = current_alloc.copy()
                                
                                today_weights_map[pname] = weights
                        else:
                            # fallback: use allocation snapshot at final date but convert market-value alloc to target weights (exclude CASH then renormalize)
                            final_alloc = allocs.get(final_d, {})
                            noncash = {k: v for k, v in final_alloc.items() if k != 'CASH'}
                            s = sum(noncash.values())
                            if s > 0:
                                norm = {k: (v / s) for k, v in noncash.items()}
                                norm['CASH'] = final_alloc.get('CASH', 0)
                            else:
                                norm = final_alloc
                            today_weights_map[pname] = norm
                    except Exception:
                        today_weights_map[pname] = {}

                st.session_state.alloc_snapshot_data = {
                    'raw_data': data,
                    'portfolio_configs': portfolio_list,
                    'all_allocations': all_allocations,
                    'all_metrics': all_metrics,
                    'today_weights_map': today_weights_map
                }
            except Exception:
                pass
            st.session_state.alloc_all_metrics = all_metrics
            # Save portfolio index -> unique key mapping so UI selectors can reference results reliably
            st.session_state.alloc_portfolio_key_map = portfolio_key_map
            st.session_state.alloc_backtest_run = True
            
            # ===================================================================
            # Calculate and store PE immediately after backtest
            # ===================================================================
            try:
                # Get the today_weights for the active portfolio
                active_name = active_portfolio.get('name')
                if active_name in today_weights_map:
                    today_weights = today_weights_map[active_name]
                    
                    # Get portfolio value
                    active_idx = st.session_state.alloc_active_portfolio_index
                    portfolio_value = float(st.session_state.get('alloc_active_initial', active_portfolio.get('initial_value', 0) or 0))
                    
                    # Get ticker info in batch
                    tickers = [tk for tk in today_weights.keys() if tk != 'CASH']
                    if tickers:
                        all_infos = get_multiple_tickers_info_batch(tickers)
                        
                        # DEBUG: Show API calls after PE data download
                        # st.info(f"🔍 **DEBUG**: After PE data download - Total API calls so far: **{st.session_state.get('api_call_count', 0)}**")
                        
                        # Build rows with PE data
                        rows = []
                        for ticker in tickers:
                            info = all_infos.get(ticker, {})
                            
                            # Fallback for PE if batch doesn't have it
                            pe_ratio = info.get('trailingPE')
                            if pe_ratio is None:
                                try:
                                    fallback_info = get_ticker_info(ticker)
                                    pe_ratio = fallback_info.get('trailingPE') if fallback_info else None
                                except:
                                    pe_ratio = None
                            
                            alloc_pct = float(today_weights.get(ticker, 0))
                            allocation_value = portfolio_value * alloc_pct
                            total_val = allocation_value
                            pct_of_portfolio = (total_val / portfolio_value * 100) if portfolio_value > 0 else 0
                            
                            rows.append({
                                'Ticker': ticker,
                                'P/E Ratio': pe_ratio,
                                'Forward P/E': info.get('forwardPE'),
                                'Beta': info.get('beta'),
                                '% of Portfolio': pct_of_portfolio
                            })
                        
                        if rows:
                            df_temp = pd.DataFrame(rows)
                            
                            # Calculate weighted averages
                            def weighted_average(df, column, weight_column='% of Portfolio'):
                                if column not in df.columns or weight_column not in df.columns:
                                    return None
                                # Convert column to numeric, coercing errors to NaN
                                df_numeric = df.copy()
                                df_numeric[column] = pd.to_numeric(df_numeric[column], errors='coerce')
                                df_numeric[weight_column] = pd.to_numeric(df_numeric[weight_column], errors='coerce')
                                
                                # First filter for non-null values
                                valid_mask = df_numeric[column].notna() & df_numeric[weight_column].notna()
                                # Then apply numeric filters only on valid (non-null) rows
                                if 'P/E' in column or 'PE' in column:
                                    valid_mask = valid_mask & (df_numeric[column] > 0) & (df_numeric[column] <= 1000)
                                elif column == 'Beta':
                                    valid_mask = valid_mask & (df_numeric[column] >= -5) & (df_numeric[column] <= 5)
                                if valid_mask.sum() == 0:
                                    return None
                                valid_df = df_numeric[valid_mask]
                                result = (valid_df[column] * valid_df[weight_column] / 100).sum() / (valid_df[weight_column].sum() / 100)
                                return result
                            
                            # Calculate and store PE, Forward PE, and Beta
                            st.session_state.portfolio_pe = weighted_average(df_temp, 'P/E Ratio')
                            st.session_state.portfolio_forward_pe = weighted_average(df_temp, 'Forward P/E')
                            st.session_state.portfolio_beta = weighted_average(df_temp, 'Beta')
                            
                            # Store snapshot of tickers for photo fixe
                            st.session_state.backtest_stocks_snapshot = tickers
                    
            except Exception as e:
                pass

# Sidebar JSON export/import for ALL portfolios
def paste_all_json_callback():
    txt = st.session_state.get('alloc_paste_all_json_text', '')
    if not txt:
        st.warning('No JSON provided')
        return
    try:
        # Use the SAME parsing logic as successful PDF extraction
        raw_text = txt
        
        # STEP 1: Try the exact same approach as PDF extraction (simple strip + parse)
        try:
            cleaned_text = raw_text.strip()
            obj = json.loads(cleaned_text)
            st.success("✅ Multi-portfolio JSON parsed successfully using PDF-style parsing!")
        except json.JSONDecodeError:
            # STEP 2: If that fails, apply our advanced cleaning (fallback)
            st.info("🔧 Simple parsing failed, applying advanced PDF extraction fixes...")
            
            json_text = raw_text
            import re
            
            # Fix broken portfolio name lines
            broken_pattern = r'"name":\s*"([^"]*?)"\s*"stocks":'
            json_text = re.sub(broken_pattern, r'"name": "\1", "stocks":', json_text)
            
            # Fix truncated names
            truncated_pattern = r'"name":\s*"([^"]*?)\s+"stocks":'
            json_text = re.sub(truncated_pattern, r'"name": "\1", "stocks":', json_text)
            
            # Fix missing opening brace for portfolio objects
            missing_brace_pattern = r'(},)\s*("name":)'
            json_text = re.sub(missing_brace_pattern, r'\1 {\n \2', json_text)
            
            obj = json.loads(json_text)
            st.success("✅ Multi-portfolio JSON parsed successfully using advanced cleaning!")
        
        # Add missing fields for compatibility if they don't exist
        if isinstance(obj, list):
            for portfolio in obj:
                # Add missing fields with default values
                if 'collect_dividends_as_cash' not in portfolio:
                    portfolio['collect_dividends_as_cash'] = False
                if 'exclude_from_cashflow_sync' not in portfolio:
                    portfolio['exclude_from_cashflow_sync'] = False
                if 'exclude_from_rebalancing_sync' not in portfolio:
                    portfolio['exclude_from_rebalancing_sync'] = False
                if 'use_minimal_threshold' not in portfolio:
                    portfolio['use_minimal_threshold'] = False
                if 'minimal_threshold_percent' not in portfolio:
                    portfolio['minimal_threshold_percent'] = 4.0
                if 'use_max_allocation' not in portfolio:
                    portfolio['use_max_allocation'] = False
                if 'max_allocation_percent' not in portfolio:
                    portfolio['max_allocation_percent'] = 20.0
                if 'use_equal_weight' not in portfolio:
                    portfolio['use_equal_weight'] = False
                if 'equal_weight_n_tickers' not in portfolio:
                    portfolio['equal_weight_n_tickers'] = 10
                if 'use_limit_to_top_n' not in portfolio:
                    portfolio['use_limit_to_top_n'] = False
                if 'limit_to_top_n_tickers' not in portfolio:
                    portfolio['limit_to_top_n_tickers'] = 10
                if 'use_sector_concentration_limit' not in portfolio:
                    portfolio['use_sector_concentration_limit'] = False
                if 'max_tickers_per_sector' not in portfolio:
                    portfolio['max_tickers_per_sector'] = 4
                if 'use_industry_concentration_limit' not in portfolio:
                    portfolio['use_industry_concentration_limit'] = False
                if 'max_tickers_per_industry' not in portfolio:
                    portfolio['max_tickers_per_industry'] = 2
                if 'unknown_counts_as_category' not in portfolio:
                    portfolio['unknown_counts_as_category'] = True
                if 'exclude_before_sp500_entry' not in portfolio:
                    portfolio['exclude_before_sp500_entry'] = False
                if 'use_min_market_cap_filter' not in portfolio:
                    portfolio['use_min_market_cap_filter'] = False
                if 'min_market_cap_billions' not in portfolio:
                    portfolio['min_market_cap_billions'] = 10.0
        if isinstance(obj, list):
            # Process each portfolio configuration for Allocations page
            processed_configs = []
            for cfg in obj:
                if not isinstance(cfg, dict) or 'name' not in cfg:
                    st.error('Invalid portfolio configuration structure.')
                    return
                
                # Handle momentum strategy value mapping from other pages
                momentum_strategy = cfg.get('momentum_strategy', 'Classic')
                if momentum_strategy == 'Classic momentum':
                    momentum_strategy = 'Classic'
                elif momentum_strategy == 'Relative momentum':
                    momentum_strategy = 'Relative Momentum'
                elif momentum_strategy == 'Near-Zero Symmetry':
                    momentum_strategy = 'Near-Zero Symmetry'
                elif momentum_strategy not in ['Classic', 'Relative Momentum', 'Near-Zero Symmetry']:
                    momentum_strategy = 'Classic'  # Default fallback
                
                # Handle negative momentum strategy value mapping from other pages
                negative_momentum_strategy = cfg.get('negative_momentum_strategy', 'Cash')
                if negative_momentum_strategy == 'Go to cash':
                    negative_momentum_strategy = 'Cash'
                elif negative_momentum_strategy == 'Near-Zero Symmetry':
                    negative_momentum_strategy = 'Near-Zero Symmetry'
                elif negative_momentum_strategy not in ['Cash', 'Equal weight', 'Relative momentum', 'Near-Zero Symmetry']:
                    negative_momentum_strategy = 'Cash'  # Default fallback
                
                # Handle stocks field - convert from legacy format if needed
                stocks = cfg.get('stocks', [])
                if not stocks and 'tickers' in cfg:
                    # Convert legacy format (tickers, allocs, divs) to stocks format
                    tickers = cfg.get('tickers', [])
                    allocs = cfg.get('allocs', [])
                    divs = cfg.get('divs', [])
                    stocks = []
                    
                    # Ensure we have valid arrays
                    if tickers and isinstance(tickers, list):
                        for i in range(len(tickers)):
                            if tickers[i] and tickers[i].strip():  # Check for non-empty ticker
                                # Convert allocation from percentage (0-100) to decimal (0.0-1.0) format
                                allocation = 0.0
                                if i < len(allocs) and allocs[i] is not None:
                                    alloc_value = float(allocs[i])
                                    if alloc_value > 1.0:
                                        # Already in percentage format, convert to decimal
                                        allocation = alloc_value / 100.0
                                    else:
                                        # Already in decimal format, use as is
                                        allocation = alloc_value
                                
                                # Keep original ticker for backtest (don't resolve aliases for portfolio)
                                original_ticker = tickers[i].strip()
                                stock = {
                                    'ticker': original_ticker,  # Use original ticker
                                    'allocation': allocation,
                                    'include_dividends': bool(divs[i]) if i < len(divs) and divs[i] is not None else True
                                }
                                stocks.append(stock)
            
            # Process each portfolio configuration for Allocations page (existing logic)
            processed_configs = []
            for cfg in obj:
                if not isinstance(cfg, dict) or 'name' not in cfg:
                    st.error('Invalid portfolio configuration structure.')
                    return
                
                # Handle momentum strategy value mapping from other pages
                momentum_strategy = cfg.get('momentum_strategy', 'Classic')
                if momentum_strategy == 'Classic momentum':
                    momentum_strategy = 'Classic'
                elif momentum_strategy == 'Relative momentum':
                    momentum_strategy = 'Relative Momentum'
                elif momentum_strategy == 'Near-Zero Symmetry':
                    momentum_strategy = 'Near-Zero Symmetry'
                elif momentum_strategy not in ['Classic', 'Relative Momentum', 'Near-Zero Symmetry']:
                    momentum_strategy = 'Classic'  # Default fallback
                
                # Handle negative momentum strategy value mapping from other pages
                negative_momentum_strategy = cfg.get('negative_momentum_strategy', 'Cash')
                if negative_momentum_strategy == 'Go to cash':
                    negative_momentum_strategy = 'Cash'
                elif negative_momentum_strategy == 'Near-Zero Symmetry':
                    negative_momentum_strategy = 'Near-Zero Symmetry'
                elif negative_momentum_strategy not in ['Cash', 'Equal weight', 'Relative momentum', 'Near-Zero Symmetry']:
                    negative_momentum_strategy = 'Cash'  # Default fallback
                

                
                # Sanitize momentum window weights to prevent StreamlitValueAboveMaxError
                momentum_windows = cfg.get('momentum_windows', [])
                for window in momentum_windows:
                    if 'weight' in window:
                        weight = window['weight']
                        # If weight is a percentage (e.g., 50 for 50%), convert to decimal
                        if isinstance(weight, (int, float)) and weight > 1.0:
                            # Cap at 100% and convert to decimal
                            weight = min(weight, 100.0) / 100.0
                        elif isinstance(weight, (int, float)) and weight <= 1.0:
                            # Already in decimal format, ensure it's valid
                            weight = max(0.0, min(weight, 1.0))
                        else:
                            # Invalid weight, set to default
                            weight = 0.1
                        window['weight'] = weight
                normalize_momentum_windows_discard_flags(momentum_windows)
                
                # Debug: Show what we received for this portfolio
                if 'momentum_windows' in cfg:
                    st.info(f"Momentum windows for {cfg.get('name', 'Unknown')}: {cfg['momentum_windows']}")
                if 'use_momentum' in cfg:
                    st.info(f"Use momentum for {cfg.get('name', 'Unknown')}: {cfg['use_momentum']}")
                
                # Map frequency values from app.py format to Allocations format
                def map_frequency(freq):
                    if freq is None:
                        return 'Never'
                    freq_map = {
                        'Never': 'Never',
                        'Weekly': 'Weekly',
                        'Biweekly': 'Biweekly',
                        'Monthly': 'Monthly',
                        'Quarterly': 'Quarterly',
                        'Semiannually': 'Semiannually',
                        'Annually': 'Annually',
                        # Legacy format mapping
                        'none': 'Never',
                        'week': 'Weekly',
                        '2weeks': 'Biweekly',
                        'month': 'Monthly',
                        '3months': 'Quarterly',
                        '6months': 'Semiannually',
                        'year': 'Annually'
                    }
                    return freq_map.get(freq, 'Monthly')
                
                # Allocations page specific: ensure all required fields are present
                # and ignore fields that are specific to other pages
                allocations_config = {
                    'name': cfg.get('name', 'Allocation Portfolio'),
                    'stocks': stocks,
                    'benchmark_ticker': cfg.get('benchmark_ticker', '^GSPC'),
                    'initial_value': cfg.get('initial_value', 10000),
                    'added_amount': cfg.get('added_amount', 0),  # Allocations page typically doesn't use additions
                    'added_frequency': map_frequency(cfg.get('added_frequency', 'Never')),  # Allocations page typically doesn't use additions
                                          'rebalancing_frequency': map_frequency(cfg.get('rebalancing_frequency', 'Monthly')),
                      'start_date_user': cfg.get('start_date_user'),
                      'end_date_user': cfg.get('end_date_user'),
                      'start_with': cfg.get('start_with', 'oldest'),
                      'use_momentum': cfg.get('use_momentum', True),
                    'momentum_strategy': momentum_strategy,
                    'negative_momentum_strategy': negative_momentum_strategy,
                    'momentum_windows': momentum_windows,
                    'calc_beta': cfg.get('calc_beta', True),
                    'calc_volatility': cfg.get('calc_volatility', True),
                    'beta_window_days': cfg.get('beta_window_days', 365),
                    'exclude_days_beta': cfg.get('exclude_days_beta', 30),
                    'vol_window_days': cfg.get('vol_window_days', 365),
                    'exclude_days_vol': cfg.get('exclude_days_vol', 30),
                    'use_targeted_rebalancing': cfg.get('use_targeted_rebalancing', False),
                    'targeted_rebalancing_settings': cfg.get('targeted_rebalancing_settings', {}),
                    'use_minimal_threshold': cfg.get('use_minimal_threshold', False),
                    'minimal_threshold_percent': cfg.get('minimal_threshold_percent', 4.0),
                    'use_max_allocation': cfg.get('use_max_allocation', False),
                    'max_allocation_percent': cfg.get('max_allocation_percent', 20.0),
                    'use_equal_weight': cfg.get('use_equal_weight', False),
                    'equal_weight_n_tickers': cfg.get('equal_weight_n_tickers', 10),
                    'use_limit_to_top_n': cfg.get('use_limit_to_top_n', False),
                    'limit_to_top_n_tickers': cfg.get('limit_to_top_n_tickers', 10),
                    'use_sector_concentration_limit': parse_bool_from_json(cfg.get('use_sector_concentration_limit', False), False),
                    'max_tickers_per_sector': cfg.get('max_tickers_per_sector', 4),
                    'use_industry_concentration_limit': parse_bool_from_json(cfg.get('use_industry_concentration_limit', False), False),
                    'max_tickers_per_industry': cfg.get('max_tickers_per_industry', 2),
                    'unknown_counts_as_category': parse_bool_from_json(cfg.get('unknown_counts_as_category', True), True),
                    'exclude_before_sp500_entry': parse_bool_from_json(cfg.get('exclude_before_sp500_entry', False), False),
                    'use_min_market_cap_filter': parse_bool_from_json(cfg.get('use_min_market_cap_filter', False), False),
                    'min_market_cap_billions': cfg.get('min_market_cap_billions', 10.0),
                }
                processed_configs.append(allocations_config)
            
            st.session_state.alloc_portfolio_configs = processed_configs
            # Reset active selection and derived mappings so the UI reflects the new configs
            if processed_configs:
                st.session_state.alloc_active_portfolio_index = 0
                st.session_state.alloc_portfolio_selector = processed_configs[0].get('name', '')
                # Update portfolio name input field to match the first imported portfolio
                st.session_state.alloc_portfolio_name = processed_configs[0].get('name', 'Allocation Portfolio')
                # Mirror several active_* widget defaults so the UI selectboxes/inputs update
                st.session_state['alloc_active_name'] = processed_configs[0].get('name', '')
                st.session_state['alloc_active_initial'] = int(processed_configs[0].get('initial_value', 0) or 0)
                st.session_state['alloc_active_added_amount'] = int(processed_configs[0].get('added_amount', 0) or 0)
                st.session_state['alloc_active_rebal_freq'] = processed_configs[0].get('rebalancing_frequency', 'month')
                st.session_state['alloc_active_add_freq'] = processed_configs[0].get('added_frequency', 'none')
                st.session_state['alloc_active_benchmark'] = processed_configs[0].get('benchmark_ticker', '')
                st.session_state['alloc_active_use_momentum'] = bool(processed_configs[0].get('use_momentum', True))
                
                
            else:
                st.session_state.alloc_active_portfolio_index = None
                st.session_state.alloc_portfolio_selector = ''
            st.session_state.alloc_portfolio_key_map = {}
            st.session_state.alloc_backtest_run = False
            st.success('All portfolio configurations updated from JSON (Allocations page).')
            # Debug: Show final momentum windows for first portfolio
            if processed_configs:
                st.info(f"Final momentum windows for first portfolio: {processed_configs[0]['momentum_windows']}")
                st.info(f"Final use_momentum for first portfolio: {processed_configs[0]['use_momentum']}")
            # Force a rerun so widgets rebuild with the new configs
            try:
                st.experimental_rerun()
            except Exception:
                # In some environments experimental rerun may raise; setting a rerun flag is a fallback
                st.session_state.alloc_rerun_flag = True
        else:
            st.error('JSON must be a list of portfolio configurations.')
    except Exception as e:
        st.error(f'Failed to parse JSON: {e}')





# Simplified display for allocation tracker: only allocation pies and rebalancing metrics are shown
active_name = active_portfolio.get('name')
if st.session_state.get('alloc_backtest_run', False):
    st.subheader("Allocation & Rebalancing Metrics")
    

    allocs_for_portfolio = st.session_state.get('alloc_all_allocations', {}).get(active_name) if st.session_state.get('alloc_all_allocations') else None
    metrics_for_portfolio = st.session_state.get('alloc_all_metrics', {}).get(active_name) if st.session_state.get('alloc_all_metrics') else None

    if not allocs_for_portfolio and not metrics_for_portfolio:
        st.info("No allocation or rebalancing history available. If you have precomputed allocation snapshots, store them in session state keys `alloc_all_allocations` and `alloc_all_metrics` under this portfolio name.")
    else:
        # --- Calculate timer variables for rebalancing timer ---
        last_rebal_date = None
        rebalancing_frequency = 'none'
        
        if allocs_for_portfolio and active_portfolio:
            try:
                # Get the last rebalance date from allocation history
                alloc_dates = sorted(list(allocs_for_portfolio.keys()))
                if len(alloc_dates) > 1:
                    last_rebal_date = alloc_dates[-2]  # Second to last date (excluding today/yesterday)
                else:
                    last_rebal_date = alloc_dates[-1] if alloc_dates else None
                
                # Get rebalancing frequency from active portfolio
                rebalancing_frequency = active_portfolio.get('rebalancing_frequency', 'none')
                # Convert to lowercase and map to function expectations
                rebalancing_frequency = rebalancing_frequency.lower()
                # Map frequency names to what the function expects
                frequency_mapping = {
                    'monthly': 'month',
                    'weekly': 'week',
                    'bi-weekly': '2weeks',
                    'biweekly': '2weeks',
                    'quarterly': '3months',
                    'semi-annually': '6months',
                    'semiannually': '6months',
                    'annually': 'year',
                    'yearly': 'year',
                    'market_day': 'market_day',
                    'calendar_day': 'calendar_day',
                    'never': 'none',
                    'none': 'none'
                }
                rebalancing_frequency = frequency_mapping.get(rebalancing_frequency, rebalancing_frequency)
            except Exception as e:
                pass  # Silently ignore timer calculation errors
        
        # --- Rebalance as of Today (static snapshot from last Run Backtests) ---
        snapshot = st.session_state.get('alloc_snapshot_data', {})
        today_weights_map = snapshot.get('today_weights_map', {}) if snapshot else {}
        
        # Check if momentum is used for this portfolio
        use_momentum = active_portfolio.get('use_momentum', True) if active_portfolio else True
        
        if snapshot and active_name in today_weights_map:
            today_weights = today_weights_map.get(active_name, {})
            
            # If momentum is not used, use the initial target allocation from portfolio configuration
            if not use_momentum and (not today_weights or all(v == 0 for v in today_weights.values())):
                # Use the target allocation from portfolio configuration (same as initial allocation)
                if active_portfolio and active_portfolio.get('stocks'):
                    today_weights = {}
                    total_allocation = sum(stock.get('allocation', 0) for stock in active_portfolio['stocks'] if stock.get('ticker'))
                    
                    if total_allocation > 0:
                        # Build raw allocations from portfolio config
                        raw_allocations = {}
                        for stock in active_portfolio['stocks']:
                            ticker = stock.get('ticker', '').strip()
                            allocation = stock.get('allocation', 0)
                            if ticker and allocation > 0:
                                raw_allocations[ticker] = allocation / total_allocation
                        
                        # Apply threshold filters to the raw allocations
                        use_max_allocation = active_portfolio.get('use_max_allocation', False)
                        max_allocation_percent = active_portfolio.get('max_allocation_percent', 10.0)
                        use_threshold = active_portfolio.get('use_minimal_threshold', False)
                        threshold_percent = active_portfolio.get('minimal_threshold_percent', 2.0)
                        
                        
                        # Build dictionary of individual ticker caps from stock configs
                        individual_caps = {}
                        for stock in active_portfolio.get('stocks', []):
                            ticker = stock.get('ticker', '')
                            individual_cap = stock.get('max_allocation_percent', None)
                            if individual_cap is not None and individual_cap > 0:
                                individual_caps[ticker] = individual_cap / 100.0
                        
                        # Apply allocation filters in correct order: Max Allocation -> Min Threshold -> Max Allocation (two-pass system)
                        filtered_allocations = raw_allocations.copy()
                        
                        if (use_max_allocation or individual_caps):
                            max_allocation_decimal = max_allocation_percent / 100.0
                            
                            # FIRST PASS: Apply maximum allocation filter
                            capped_allocations = {}
                            excess_allocation = 0.0
                            
                            for ticker, allocation in filtered_allocations.items():
                                # Use individual cap if available, otherwise use global cap
                                ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                
                                if allocation > ticker_cap:
                                    # Cap the allocation and collect excess
                                    capped_allocations[ticker] = ticker_cap
                                    excess_allocation += (allocation - ticker_cap)
                                else:
                                    capped_allocations[ticker] = allocation
                            
                            # Redistribute excess allocation proportionally to stocks below the cap
                            if excess_allocation > 0:
                                # Find stocks below the cap (using individual caps)
                                below_cap_stocks = {}
                                for ticker, allocation in capped_allocations.items():
                                    ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                    if allocation < ticker_cap:
                                        below_cap_stocks[ticker] = allocation
                                
                                if below_cap_stocks:
                                    total_below_cap = sum(below_cap_stocks.values())
                                    if total_below_cap > 0:
                                        # Redistribute excess proportionally
                                        for ticker in below_cap_stocks:
                                            proportion = below_cap_stocks[ticker] / total_below_cap
                                            new_allocation = capped_allocations[ticker] + (excess_allocation * proportion)
                                            ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                            capped_allocations[ticker] = min(new_allocation, ticker_cap)
                            
                            filtered_allocations = capped_allocations
                        
                        # Apply minimal threshold filter
                        if use_threshold:
                            threshold_decimal = threshold_percent / 100.0
                            
                            # First: Filter out stocks below threshold
                            threshold_filtered_allocations = {}
                            for ticker, allocation in filtered_allocations.items():
                                if allocation >= threshold_decimal:
                                    # Keep stocks above or equal to threshold
                                    threshold_filtered_allocations[ticker] = allocation
                            
                            # Then: Normalize remaining stocks to sum to 1
                            if threshold_filtered_allocations:
                                total_allocation = sum(threshold_filtered_allocations.values())
                                if total_allocation > 0:
                                    filtered_allocations = {ticker: allocation / total_allocation for ticker, allocation in threshold_filtered_allocations.items()}
                                else:
                                    filtered_allocations = {}
                            else:
                                # If no stocks meet threshold, keep original allocations
                                pass  # filtered_allocations remain unchanged
                        
                        # SECOND PASS: Apply maximum allocation filter again (in case normalization created new excess)
                        if (use_max_allocation or individual_caps):
                            max_allocation_decimal = max_allocation_percent / 100.0
                            
                            # Check if any stocks exceed the cap after threshold filtering and normalization
                            capped_allocations = {}
                            excess_allocation = 0.0
                            
                            for ticker, allocation in filtered_allocations.items():
                                # Use individual cap if available, otherwise use global cap
                                ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                
                                if allocation > ticker_cap:
                                    # Cap the allocation and collect excess
                                    capped_allocations[ticker] = ticker_cap
                                    excess_allocation += (allocation - ticker_cap)
                                else:
                                    capped_allocations[ticker] = allocation
                            
                            # Redistribute excess allocation proportionally to stocks below the cap
                            if excess_allocation > 0:
                                # Find stocks below the cap (using individual caps)
                                below_cap_stocks = {}
                                for ticker, allocation in capped_allocations.items():
                                    ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                    if allocation < ticker_cap:
                                        below_cap_stocks[ticker] = allocation
                                
                                if below_cap_stocks:
                                    total_below_cap = sum(below_cap_stocks.values())
                                    if total_below_cap > 0:
                                        # Redistribute excess proportionally
                                        for ticker in below_cap_stocks:
                                            proportion = below_cap_stocks[ticker] / total_below_cap
                                            new_allocation = capped_allocations[ticker] + (excess_allocation * proportion)
                                            ticker_cap = individual_caps.get(ticker, max_allocation_decimal if use_max_allocation else float('inf'))
                                            capped_allocations[ticker] = min(new_allocation, ticker_cap)
                            
                            filtered_allocations = capped_allocations
                        
                        # Use the filtered allocations as today_weights
                        today_weights = filtered_allocations
                    
                    # If no valid stocks or allocations, leave today_weights empty (will show info message)
            
            labels_today = [k for k, v in sorted(today_weights.items(), key=lambda x: (-x[1], x[0])) if v > 0]
            vals_today = [float(today_weights[k]) * 100 for k in labels_today]
            
            # Handle case where momentum goes to cash (all assets have negative momentum)
            # If no labels or all values are very small, show 100% CASH
            if not labels_today or sum(vals_today) < 0.1:
                labels_today = ['CASH']
                vals_today = [100.0]
            
            # --- REBALANCING TIMER SECTION (moved above pie chart) ---
            if last_rebal_date and rebalancing_frequency != 'none':
                # Ensure last_rebal_date is a naive datetime object
                import pandas as pd
                if isinstance(last_rebal_date, str):
                    last_rebal_date = pd.to_datetime(last_rebal_date)
                if hasattr(last_rebal_date, 'tzinfo') and last_rebal_date.tzinfo is not None:
                    last_rebal_date = last_rebal_date.replace(tzinfo=None)
                
                next_date, time_until, next_rebalance_datetime = calculate_next_rebalance_date(
                    rebalancing_frequency, last_rebal_date
                )
                
                if next_date and time_until:
                    st.markdown("---")
                    st.markdown("**⏰ Next Rebalance Timer**")
                    
                    # Create columns for timer display
                    col1, col2, col3 = st.columns(3)
                    
                    with col1:
                        st.metric(
                            label="Time Until Next Rebalance",
                            value=format_time_until(time_until),
                            delta=None
                        )
                    
                    with col2:
                        st.metric(
                            label="Target Rebalance Date",
                            value=next_date.strftime("%B %d, %Y"),
                            delta=None
                        )
                    
                    with col3:
                        st.metric(
                            label="Rebalancing Frequency",
                            value=rebalancing_frequency.replace('_', ' ').title(),
                            delta=None
                        )
                    
                    # Add a progress bar showing progress to next rebalance
                    if rebalancing_frequency in ['week', '2weeks', 'month', '3months', '6months', 'year']:
                        # Calculate progress percentage
                        if hasattr(last_rebal_date, 'to_pydatetime'):
                            last_rebal_datetime = last_rebal_date.to_pydatetime()
                        else:
                            last_rebal_datetime = last_rebal_date
                        
                        total_period = (next_rebalance_datetime - last_rebal_datetime).total_seconds()
                        elapsed_period = (datetime.now() - last_rebal_datetime).total_seconds()
                        progress = min(max(elapsed_period / total_period, 0), 1)
                        
                        st.progress(progress, text=f"Progress to next rebalance: {progress:.1%}")
            
            if labels_today and vals_today:
                st.markdown(f"## Rebalance as of Today ({pd.Timestamp.now().strftime('%Y-%m-%d')})")
                
                # Check if targeted rebalancing is enabled for this portfolio and show warning
                if active_portfolio.get('use_targeted_rebalancing', False):
                    targeted_settings = active_portfolio.get('targeted_rebalancing_settings', {})
                    enabled_tickers = [ticker for ticker, settings in targeted_settings.items() if settings.get('enabled', False)]
                    
                    if enabled_tickers:
                        st.warning(f"""
                        ⚠️ **Important Notice for Targeted Rebalancing Strategy**
                        
                        This portfolio uses **Targeted Rebalancing** for: {', '.join(enabled_tickers)}
                        
                        **Unlike momentum strategies**, the "Target Allocation if Rebalanced Today" depends on the **backtest start date**. 
                        The allocation shown here reflects what would happen if rebalanced today based on the current portfolio state, 
                        but this is **not a standalone strategy** that can be copied independently.
                        
                        **Key Points:**
                        - The allocation depends on when the backtest started
                        - It's based on the current portfolio drift from initial allocations
                        - This is **not** a momentum-based allocation like other strategies
                        """)
                
                fig_today = go.Figure(data=[go.Pie(
                    labels=labels_today,
                    values=vals_today,
                    hole=0.35
                )])
                fig_today.update_traces(textinfo='percent+label')
                fig_today.update_layout(template='plotly_dark', margin=dict(t=10), height=600)
                st.plotly_chart(fig_today, key=f"alloc_today_chart_{active_name}")
                try:
                    progress_bar.empty()
                except Exception:
                    pass
            
            # static shares table

            # Define build_table_from_alloc before usage
            def build_table_from_alloc(alloc_dict, price_date, label):
                rows = []
                # Use portfolio_value from session state or active_portfolio (current portfolio value)
                try:
                    portfolio_value = float(st.session_state.get('alloc_active_initial', active_portfolio.get('initial_value', 0) or 0))
                except Exception:
                    portfolio_value = active_portfolio.get('initial_value', 0) or 0
                # Use raw_data from snapshot or session state
                snapshot = st.session_state.get('alloc_snapshot_data', {})
                raw_data = snapshot.get('raw_data') if snapshot and snapshot.get('raw_data') is not None else st.session_state.get('alloc_raw_data', {})
                def _price_on_or_before(df, target_date):
                    try:
                        idx = df.index[df.index <= pd.to_datetime(target_date)]
                        if len(idx) == 0:
                            return None
                        return float(df.loc[idx[-1], 'Close'])
                    except Exception:
                        return None
                for tk in sorted(alloc_dict.keys()):
                    alloc_pct = float(alloc_dict.get(tk, 0))
                    if tk == 'CASH':
                        price = None
                        shares = 0.0
                        total_val = portfolio_value * alloc_pct
                    else:
                        # IMPORTANT: Always fetch price using original ticker (not converted)
                        # Even if raw_data contains converted ticker, get price from original to preserve currency
                        base_ticker, _ = parse_leverage_ticker(tk)
                        price = None
                        
                        # Try to get price from original ticker first (preserves currency)
                        try:
                            original_hist = get_ticker_data(base_ticker, period='1d')
                            if original_hist is not None and not original_hist.empty:
                                if price_date is None:
                                    price = float(original_hist['Close'].iloc[-1])
                                else:
                                    price = _price_on_or_before(original_hist, price_date)
                        except Exception:
                            pass
                        
                        # Fallback: Use raw_data if original ticker fetch fails
                        if price is None:
                            df = raw_data.get(tk)
                            # Ensure df is a valid DataFrame with Close prices before accessing
                            if isinstance(df, pd.DataFrame) and 'Close' in df.columns and not df['Close'].dropna().empty:
                                if price_date is None:
                                    try:
                                        price = float(df['Close'].iloc[-1])
                                    except Exception:
                                        price = None
                                else:
                                    price = _price_on_or_before(df, price_date)
                        try:
                            if price and price > 0:
                                # No currency conversion - use portfolio value directly with ticker's native price
                                # Portfolio value is just a number, ticker price is in its native currency
                                allocation_value = portfolio_value * alloc_pct
                                # allow fractional shares shown to 1 decimal place
                                shares = round(allocation_value / price, 1)
                                total_val = shares * price
                            else:
                                shares = 0.0
                                total_val = portfolio_value * alloc_pct
                        except Exception:
                            shares = 0.0
                            total_val = portfolio_value * alloc_pct
                    
                    pct_of_port = (total_val / portfolio_value * 100) if portfolio_value > 0 else 0
                    rows.append({
                        'Ticker': tk,
                        'Allocation %': alloc_pct * 100,
                        'Price ($)': price if price is not None else float('nan'),
                        'Shares': shares,
                        'Total Value ($)': total_val,
                        '% of Portfolio': pct_of_port,
                    })
                df_table = pd.DataFrame(rows).set_index('Ticker')
                # Decide whether to show CASH row: hide if Total Value is zero or Shares zero/NaN
                df_display = df_table.copy()
                show_cash = False
                if 'CASH' in df_display.index:
                    cash_val = None
                    if 'Total Value ($)' in df_display.columns:
                        cash_val = df_display.at['CASH', 'Total Value ($)']
                    elif 'Shares' in df_display.columns:
                        cash_val = df_display.at['CASH', 'Shares']
                    try:
                        show_cash = bool(cash_val and not pd.isna(cash_val) and cash_val != 0)
                    except Exception:
                        show_cash = False
                    if not show_cash:
                        df_display = df_display.drop('CASH')
                
                # Hide positions with zero allocation
                try:
                    df_display = df_display[df_display['Allocation %'] > 0.0001]
                except Exception:
                    pass

                # Add total row
                total_alloc_pct = df_display['Allocation %'].sum()
                total_value = df_display['Total Value ($)'].sum()
                total_port_pct = df_display['% of Portfolio'].sum()
                
                total_row = pd.DataFrame({
                    'Allocation %': [total_alloc_pct],
                    'Price ($)': [float('nan')],
                    'Shares': [float('nan')],
                    'Total Value ($)': [total_value],
                    '% of Portfolio': [total_port_pct]
                }, index=['TOTAL'])
                
                df_display = pd.concat([df_display, total_row])

                fmt = {
                    'Allocation %': '{:,.1f}%',
                    'Price ($)': '${:,.2f}',
                    'Shares': '{:,.1f}',
                    'Total Value ($)': '${:,.2f}',
                    '% of Portfolio': '{:,.2f}%'
                }
                try:
                    if label:
                        st.markdown(f"**{label}**")
                    sty = df_display.style.format(fmt)
                    
                    # Highlight CASH row if present
                    if 'CASH' in df_table.index and show_cash:
                        def _highlight_cash_row(s):
                            if s.name == 'CASH':
                                return ['background-color: #006400; color: white; font-weight: bold;' for _ in s]
                            return [''] * len(s)
                        sty = sty.apply(_highlight_cash_row, axis=1)
                    
                    # Highlight TOTAL row
                    def _highlight_total_row(s):
                        if s.name == 'TOTAL':
                            return ['background-color: #1f4e79; color: white; font-weight: bold;' for _ in s]
                        return [''] * len(s)
                    sty = sty.apply(_highlight_total_row, axis=1)
                    
                    st.dataframe(sty, )
                except Exception:
                    st.dataframe(df_display, )
                
                # Add comprehensive portfolio data table right after the main allocation table
                build_comprehensive_portfolio_table(alloc_dict, portfolio_value)
            
            # Add comprehensive portfolio data table
            def build_comprehensive_portfolio_table(alloc_dict, portfolio_value):
                """
                Build a comprehensive table with all available financial indicators from Yahoo Finance
                """
                st.markdown("### Comprehensive Portfolio Data")
                st.caption("Detailed financial indicators for each position")
                
                # Get current date for data freshness
                current_date = pd.Timestamp.now().strftime('%Y-%m-%d')
                
                # Create progress bar for data fetching
                progress_bar = st.progress(0)
                status_text = st.empty()
                
                rows = []
                tickers = [tk for tk in alloc_dict.keys() if tk != 'CASH']
                total_tickers = len(tickers)
                
                # OPTIMIZATION: Batch fetch all ticker infos at once (much faster!)
                status_text.text(f"Fetching data for {total_tickers} tickers in batch...")
                progress_bar.progress(0.1)
                all_infos = get_multiple_tickers_info_batch(tickers)
                
                # DEBUG: Show API calls after PE data download
                # st.info(f"🔍 **DEBUG**: After PE data download (2nd call) - Total API calls so far: **{st.session_state.get('api_call_count', 0)}**")
                
                for i, ticker in enumerate(tickers):
                    status_text.text(f"Processing {ticker}... ({i+1}/{total_tickers})")
                    progress_bar.progress((i + 1) / total_tickers)
                    
                    try:
                        # Get info from batch results
                        info = all_infos.get(ticker, {})
                        
                        # IMPORTANT: Price should ALWAYS use the original ticker (not converted)
                        # Conversion to Canadian ticker (DLMAF → DOL.TO) is ONLY for stats/info, NOT for price
                        # If user enters DLMAF, they want USD price. If they enter DOL.TO, they want CAD price.
                        base_ticker, _ = parse_leverage_ticker(ticker)
                        is_canadian_original = any(base_ticker.upper().endswith(suffix) for suffix in ['.TO', '.V', '.CN'])
                        resolved_for_stats = resolve_ticker_alias(base_ticker, for_stats=True)
                        was_converted = resolved_for_stats != base_ticker.upper()
                        
                        # ALWAYS fetch price using original ticker (not converted ticker)
                        # This ensures USD tickers show USD prices, CAD tickers show CAD prices
                        current_price = None
                        try:
                            # Use original ticker for price (preserves currency)
                            original_hist = get_ticker_data(base_ticker, period='1d')
                            if original_hist is not None and not original_hist.empty:
                                current_price = original_hist['Close'].iloc[-1]
                        except Exception:
                            pass
                        
                        # Fallback: If original ticker fails, try info dict (but this may be in wrong currency)
                        if current_price is None:
                            current_price = info.get('currentPrice', info.get('regularMarketPrice', info.get('price', info.get('lastPrice', info.get('close', None)))))
                        
                        # Final fallback: For leveraged tickers (NVDL → NVDA), use valuation function
                        if current_price is None:
                            try:
                                # Only use this for leveraged tickers, not for currency conversion
                                hist_data = get_ticker_data_for_valuation(ticker, period='1d')
                                if hist_data is not None and not hist_data.empty:
                                    current_price = hist_data['Close'].iloc[-1]
                            except Exception:
                                pass
                        
                        # Calculate allocation values
                        alloc_pct = float(alloc_dict.get(ticker, 0))
                        allocation_value = portfolio_value * alloc_pct
                        shares = round(allocation_value / current_price, 1) if current_price and current_price > 0 else 0
                        total_val = shares * current_price if current_price else allocation_value
                        
                        # Determine if this is an ETF or stock for intelligent data handling
                        quote_type = info.get('quoteType', '').lower()
                        is_etf = quote_type in ['etf', 'fund']
                        is_commodity = ticker in ['GLD', 'SLV', 'USO', 'UNG'] or 'gold' in info.get('longName', '').lower()
                        
                        # Extract all available financial indicators with intelligent handling
                        # Get custom sector and industry for special tickers (ETFs, indices, etc.)
                        custom_sector = get_custom_sector_for_ticker(ticker)
                        sector = custom_sector if custom_sector else info.get('sector', info.get('sector', info.get('industrySector', 'N/A')))
                        
                        custom_industry = get_custom_industry_for_ticker(ticker)
                        industry = custom_industry if custom_industry else info.get('industry', info.get('industry', info.get('industryClassification', 'N/A')))
                        
                        row = {
                            'Ticker': ticker,
                            'Company Name': info.get('longName', info.get('shortName', info.get('companyName', info.get('name', info.get('displayName', info.get('title', 'N/A')))))),
                            'Sector': sector,
                            'Industry': industry,
                            'Current Price ($)': current_price,
                            'Allocation %': alloc_pct * 100,
                            'Shares': shares,
                            'Total Value ($)': total_val,
                            '% of Portfolio': (total_val / portfolio_value * 100) if portfolio_value > 0 else 0,
                            
                            # Valuation Metrics (not applicable for commodities/ETFs)
                            'Market Cap ($B)': info.get('marketCap', info.get('totalAssets', info.get('marketCapitalization', 0))) / 1e9 if (info.get('marketCap') or info.get('totalAssets') or info.get('marketCapitalization')) and not is_commodity else None,
                            'Enterprise Value ($B)': info.get('enterpriseValue', info.get('enterpriseValue', info.get('enterpriseValue', 0))) / 1e9 if info.get('enterpriseValue') and not is_commodity else None,
                            'P/E Ratio': info.get('trailingPE', info.get('priceEarnings', info.get('pe', info.get('peRatio', None)))),
                            'Forward P/E': info.get('forwardPE', info.get('forwardPE', info.get('forwardPE', info.get('forwardPERatio', None)))) if not is_commodity else None,
                            'PEG Ratio': None,  # Will be calculated below with fallback strategies
                            'Price/Book': info.get('priceToBook', info.get('priceBook', info.get('pb', info.get('pbRatio', None)))) if not is_commodity else None,
                            'Price/Sales': info.get('priceToSalesTrailing12Months', info.get('priceToSales', info.get('ps', info.get('psRatio', None)))) if not is_commodity else None,
                            'Price/Cash Flow': info.get('priceToCashflow', info.get('priceCashflow', info.get('pcf', info.get('pcfRatio', None)))) if not is_commodity else None,
                            'EV/EBITDA': info.get('enterpriseToEbitda', info.get('evToEbitda', info.get('evEbitda', info.get('evEbitdaRatio', None)))) if not is_commodity else None,
                            
                            # Additional Valuation Metrics
                            'Free Cash Flow ($B)': info.get('freeCashflow', 0) / 1e9 if info.get('freeCashflow') and not is_commodity else None,
                            'FCF Yield (%)': None,  # Will be calculated below
                            'Price/FCF': None,  # Will be calculated below
                            'Shares Outstanding (M)': info.get('sharesOutstanding', 0) / 1e6 if info.get('sharesOutstanding') and not is_commodity else None,
                            'Float Shares (M)': info.get('floatShares', 0) / 1e6 if info.get('floatShares') and not is_commodity else None,
                            'Revenue TTM ($B)': info.get('totalRevenue', 0) / 1e9 if info.get('totalRevenue') and not is_commodity else None,
                            'Earnings TTM ($B)': (info.get('trailingEps', 0) * info.get('sharesOutstanding', 0)) / 1e9 if info.get('trailingEps') and info.get('sharesOutstanding') and not is_commodity else None,
                            
                            # Financial Health (not applicable for commodities/ETFs)
                            'Debt/Equity': info.get('debtToEquity', info.get('debtToEquity', info.get('debtEquity', info.get('debtEquityRatio', None)))) if not is_commodity else None,
                            'Current Ratio': info.get('currentRatio', info.get('currentRatio', info.get('currentRatio', info.get('currentRatioRatio', None)))) if not is_commodity else None,
                            'Quick Ratio': info.get('quickRatio', info.get('quickRatio', info.get('quickRatio', info.get('quickRatioRatio', None)))) if not is_commodity else None,
                            'ROE (%)': info.get('returnOnEquity', info.get('roe', info.get('returnOnEquity', info.get('returnOnEquity', info.get('roe', info.get('returnOnEquity', 0)))))) * 100 if (info.get('returnOnEquity') or info.get('roe') or info.get('returnOnEquity') or info.get('returnOnEquity') or info.get('roe') or info.get('returnOnEquity')) and not is_commodity else None,
                            'ROA (%)': info.get('returnOnAssets', info.get('roa', info.get('returnOnAssets', info.get('returnOnAssets', info.get('roa', info.get('returnOnAssets', 0)))))) * 100 if (info.get('returnOnAssets') or info.get('roa') or info.get('returnOnAssets') or info.get('returnOnAssets') or info.get('roa') or info.get('returnOnAssets')) and not is_commodity else None,
                            'ROIC (%)': info.get('returnOnInvestedCapital', info.get('roic', info.get('returnOnInvestedCapital', info.get('returnOnInvestedCapital', info.get('roic', info.get('returnOnInvestedCapital', 0)))))) * 100 if (info.get('returnOnInvestedCapital') or info.get('roic') or info.get('returnOnInvestedCapital') or info.get('returnOnInvestedCapital') or info.get('roic') or info.get('returnOnInvestedCapital')) and not is_commodity else None,
                            
                            # Additional Financial Health Metrics
                            'Total Debt ($B)': info.get('totalDebt', 0) / 1e9 if info.get('totalDebt') and not is_commodity else None,
                            'Net Debt ($B)': None,  # Will be calculated below
                            'Working Capital ($B)': None,  # Will be calculated below
                            'Interest Coverage': None,  # Will be calculated below
                            
                            # Growth Metrics (not applicable for commodities/ETFs)
                            'Revenue Growth (%)': info.get('revenueGrowth', info.get('revenueGrowth', info.get('revenueGrowthRate', 0))) * 100 if (info.get('revenueGrowth') or info.get('revenueGrowth') or info.get('revenueGrowthRate')) and not is_commodity else None,
                            'Earnings Growth (%)': info.get('earningsGrowth', info.get('earningsGrowth', info.get('earningsGrowthRate', info.get('earningsGrowth', info.get('earningsGrowth', info.get('earningsGrowthRate', 0)))))) * 100 if (info.get('earningsGrowth') or info.get('earningsGrowth') or info.get('earningsGrowthRate') or info.get('earningsGrowth') or info.get('earningsGrowth') or info.get('earningsGrowthRate')) and not is_commodity else None,
                            'EPS Growth (%)': info.get('earningsQuarterlyGrowth', info.get('epsGrowth', info.get('earningsGrowth', info.get('earningsQuarterlyGrowth', info.get('epsGrowth', info.get('earningsGrowth', 0)))))) * 100 if (info.get('earningsQuarterlyGrowth') or info.get('epsGrowth') or info.get('earningsGrowth') or info.get('earningsQuarterlyGrowth') or info.get('epsGrowth') or info.get('earningsGrowth')) and not is_commodity else None,
                            
                            # Dividend Information (available for ETFs and some stocks)
                            # Yahoo Finance returns dividend yield as decimal (0.0002 for 0.02%)
                            'Dividend Yield (%)': info.get('dividendYield', info.get('dividendRate', info.get('yield', 0))) if (info.get('dividendYield') or info.get('dividendRate') or info.get('yield')) else None,
                            'Dividend Rate ($)': info.get('dividendRate', info.get('dividend', info.get('dividendRate', info.get('dividend', info.get('dividendRate', info.get('dividend', info.get('dividendRate', info.get('dividend', None)))))))),
                            'Payout Ratio (%)': info.get('payoutRatio', info.get('payoutRatio', info.get('payoutRatio', info.get('payoutRatio', info.get('payoutRatio', info.get('payoutRatio', info.get('payoutRatio', info.get('payoutRatio', 0)))))))) * 100 if (info.get('payoutRatio') or info.get('payoutRatio') or info.get('payoutRatio') or info.get('payoutRatio') or info.get('payoutRatio') or info.get('payoutRatio') or info.get('payoutRatio') or info.get('payoutRatio')) and not is_commodity else None,
                            '5Y Dividend Growth (%)': info.get('fiveYearAvgDividendYield', info.get('dividendGrowth', info.get('dividendGrowth', info.get('dividendGrowth', info.get('fiveYearAvgDividendYield', info.get('dividendGrowth', info.get('dividendGrowth', info.get('dividendGrowth', 0)))))))) if (info.get('fiveYearAvgDividendYield') or info.get('dividendGrowth') or info.get('dividendGrowth') or info.get('dividendGrowth') or info.get('fiveYearAvgDividendYield') or info.get('dividendGrowth') or info.get('dividendGrowth') or info.get('dividendGrowth')) else None,
                            
                            # Trading Metrics (available for all securities)
                            '52W High ($)': info.get('fiftyTwoWeekHigh', info.get('52WeekHigh', info.get('52WeekHigh', info.get('fiftyTwoWeekHigh', info.get('fiftyTwoWeekHigh', info.get('52WeekHigh', info.get('52WeekHigh', info.get('fiftyTwoWeekHigh', None)))))))),
                            '52W Low ($)': info.get('fiftyTwoWeekLow', info.get('52WeekLow', info.get('52WeekLow', info.get('fiftyTwoWeekLow', info.get('fiftyTwoWeekLow', info.get('52WeekLow', info.get('52WeekLow', info.get('fiftyTwoWeekLow', None)))))))),
                            '50D MA ($)': info.get('fiftyDayAverage', info.get('50DayAverage', info.get('50DayAverage', info.get('fiftyDayAverage', info.get('fiftyDayAverage', info.get('50DayAverage', info.get('50DayAverage', info.get('fiftyDayAverage', None)))))))),
                            '200D MA ($)': info.get('twoHundredDayAverage', info.get('200DayAverage', info.get('200DayAverage', info.get('twoHundredDayAverage', info.get('twoHundredDayAverage', info.get('200DayAverage', info.get('200DayAverage', info.get('twoHundredDayAverage', None)))))))),
                            'Beta': info.get('beta', info.get('beta3Year', info.get('beta5Year', info.get('beta', info.get('beta', info.get('beta3Year', info.get('beta5Year', info.get('beta', None)))))))),
                            'Volume': info.get('volume', info.get('regularMarketVolume', info.get('volume', info.get('regularMarketVolume', info.get('volume', info.get('regularMarketVolume', None)))))),
                            'Avg Volume': info.get('averageVolume', info.get('avgVolume', info.get('averageVolume', info.get('avgVolume', info.get('averageVolume', info.get('avgVolume', None)))))),
                            
                            # Analyst Ratings (not available for commodities/ETFs)
                            'Analyst Rating': info.get('recommendationKey', info.get('recommendationMean', info.get('recommendationKey', info.get('recommendationMean', info.get('recommendationKey', info.get('recommendationMean', 'N/A')))))).title() if (info.get('recommendationKey') or info.get('recommendationMean') or info.get('recommendationKey') or info.get('recommendationMean') or info.get('recommendationKey') or info.get('recommendationMean')) and not is_commodity else 'N/A',
                            'Target Price ($)': info.get('targetMeanPrice', info.get('targetHighPrice', info.get('targetPrice', info.get('targetMeanPrice', info.get('targetMeanPrice', info.get('targetHighPrice', None)))))) if not is_commodity else None,
                            'Target High ($)': info.get('targetHighPrice', info.get('targetHighPrice', info.get('targetHigh', info.get('targetHighPrice', info.get('targetHighPrice', info.get('targetHigh', None)))))) if not is_commodity else None,
                            'Target Low ($)': info.get('targetLowPrice', info.get('targetLowPrice', info.get('targetLow', info.get('targetLowPrice', info.get('targetLowPrice', info.get('targetLow', None)))))) if not is_commodity else None,
                            
                            # Additional Metrics (not applicable for commodities/ETFs)
                            'Book Value ($)': info.get('bookValue', info.get('bookValuePerShare', info.get('bookValue', info.get('bookValuePerShare', info.get('bookValue', info.get('bookValuePerShare', None)))))) if not is_commodity else None,
                            'Cash per Share ($)': info.get('totalCashPerShare', info.get('cashPerShare', info.get('cashPerShare', info.get('cashPerShare', info.get('totalCashPerShare', info.get('cashPerShare', None)))))) if not is_commodity else None,
                            'Revenue per Share ($)': info.get('revenuePerShare', info.get('revenuePerShare', info.get('revenuePerShare', info.get('revenuePerShare', info.get('revenuePerShare', info.get('revenuePerShare', None)))))) if not is_commodity else None,
                            'Profit Margin (%)': info.get('profitMargins', info.get('profitMargin', info.get('profitMargins', info.get('profitMargin', info.get('profitMargins', info.get('profitMargin', 0)))))) * 100 if (info.get('profitMargins') or info.get('profitMargin') or info.get('profitMargins') or info.get('profitMargin') or info.get('profitMargins') or info.get('profitMargin')) and not is_commodity else None,
                            'Operating Margin (%)': info.get('operatingMargins', info.get('operatingMargin', info.get('operatingMargins', info.get('operatingMargin', info.get('operatingMargins', info.get('operatingMargin', 0)))))) * 100 if (info.get('operatingMargins') or info.get('operatingMargin') or info.get('operatingMargins') or info.get('operatingMargin') or info.get('operatingMargins') or info.get('operatingMargin')) and not is_commodity else None,
                            'Gross Margin (%)': info.get('grossMargins', info.get('grossMargin', info.get('grossMargins', info.get('grossMargin', info.get('grossMargins', info.get('grossMargin', 0)))))) * 100 if (info.get('grossMargins') or info.get('grossMargin') or info.get('grossMargins') or info.get('grossMargin') or info.get('grossMargins') or info.get('grossMargin')) and not is_commodity else None,
                        }
                        
                        # Fallback for PE if not available in batch data
                        if row.get('P/E Ratio') is None:
                            try:
                                fallback_info = get_ticker_info(ticker)
                                if fallback_info and fallback_info.get('trailingPE'):
                                    row['P/E Ratio'] = fallback_info.get('trailingPE')
                            except:
                                pass
                        
                        # Simple PEG Ratio calculation: P/E ÷ Earnings Growth
                        pe_ratio = info.get('trailingPE')
                        earnings_growth = info.get('earningsGrowth')
                        peg_ratio = None
                        peg_source = "N/A"
                        
                        if not is_commodity and pe_ratio and pe_ratio > 0 and earnings_growth and earnings_growth > 0:
                            # Standard PEG Ratio calculation: P/E ÷ Earnings Growth Rate
                            # Yahoo Finance returns growth as decimal (0.15 = 15% growth)
                            # We need to convert to percentage for PEG calculation
                            growth_percentage = earnings_growth * 100
                            
                            peg_ratio = pe_ratio / growth_percentage
                            peg_source = "P/E ÷ Earnings Growth"
                        
                        # Calculate FCF Yield and Price/FCF
                        free_cashflow = info.get('freeCashflow')
                        market_cap = info.get('marketCap')
                        if not is_commodity and free_cashflow and market_cap and market_cap > 0:
                            # FCF Yield = Free Cash Flow / Market Cap
                            fcf_yield = (free_cashflow / market_cap) * 100
                            row['FCF Yield (%)'] = fcf_yield
                            
                            # Price/FCF = Market Cap / Free Cash Flow
                            if free_cashflow > 0:
                                price_fcf = market_cap / free_cashflow
                                row['Price/FCF'] = price_fcf
                        
                        # Calculate Net Debt (Total Debt - Cash and Cash Equivalents)
                        total_debt = info.get('totalDebt')
                        total_cash = info.get('totalCash', 0)
                        if not is_commodity and total_debt is not None:
                            net_debt = (total_debt - total_cash) / 1e9
                            row['Net Debt ($B)'] = net_debt if net_debt >= 0 else 0
                        
                        # Calculate Working Capital (Current Assets - Current Liabilities)
                        current_assets = info.get('totalCurrentAssets', 0)
                        current_liabilities = info.get('totalCurrentLiabilities', 0)
                        if not is_commodity and current_assets and current_liabilities:
                            working_capital = (current_assets - current_liabilities) / 1e9
                            row['Working Capital ($B)'] = working_capital
                        
                        # Calculate Interest Coverage (EBIT / Interest Expense)
                        ebit = info.get('ebit', 0)
                        interest_expense = info.get('interestExpense', 0)
                        if not is_commodity and ebit and interest_expense and interest_expense > 0:
                            interest_coverage = ebit / interest_expense
                            row['Interest Coverage'] = interest_coverage
                        elif not is_commodity and interest_expense == 0 and ebit:
                            # No interest expense = excellent coverage
                            row['Interest Coverage'] = float('inf') if ebit > 0 else None
                        
                        # Price/Book will be calculated AFTER dual-class adjustment
                        
                        # Calculate EV/EBITDA manually to ensure consistency
                        enterprise_value = row.get('Enterprise Value ($B)')
                        ebitda = info.get('ebitda')
                        if enterprise_value and ebitda and ebitda > 0:
                            # Convert Enterprise Value from billions to actual value for calculation
                            ev_actual = enterprise_value * 1e9
                            row['EV/EBITDA'] = ev_actual / ebitda
                        
                        # Update the row with calculated PEG ratio and source
                        row['PEG Ratio'] = peg_ratio
                        row['PEG Source'] = peg_source
                        
                        # Define per-share fields for dual-class share adjustments
                        per_share_fields = ['Book Value ($)', 'Cash per Share ($)', 'Revenue per Share ($)']
                        
                        # Fix for dual-class shares - detect and adjust for share class differences
                        # This handles cases where Yahoo Finance returns same per-share data for different share classes
                        if current_price and current_price > 0:
                            # Store the current row data for comparison with other shares of same company
                            company_base = ticker.split('-')[0] if '-' in ticker else ticker
                            if company_base not in st.session_state:
                                st.session_state[company_base] = {}
                            
                            # Store reference data for this share class
                            st.session_state[company_base][ticker] = {
                                'price': current_price,
                                'per_share_data': {field: row[field] for field in per_share_fields if row[field]},
                                'enterprise_value': row.get('Enterprise Value ($B)')
                            }
                            
                            # Check if we have data for another share class of the same company
                            for other_ticker, other_data in st.session_state[company_base].items():
                                if other_ticker != ticker and other_data['price'] > 0:
                                    price_ratio = current_price / other_data['price']
                                    
                                    # If price ratio is significantly different (>10x), adjust per-share metrics
                                    # Use the higher-priced share class as reference to avoid scaling issues
                                    if price_ratio > 10 or price_ratio < 0.1:
                                        # Only adjust if current share class has lower price (use higher price as reference)
                                        if current_price and other_data['price'] and current_price < other_data['price']:
                                            for field in per_share_fields:
                                                if row[field] and other_data['per_share_data'].get(field):
                                                    # Use the price ratio to adjust the per-share values
                                                    row[field] = other_data['per_share_data'][field] * price_ratio
                                            
                                            # Also ensure Enterprise Value is consistent between share classes
                                            # Enterprise Value should be the same for both share classes of the same company
                                            if other_data.get('enterprise_value') is not None:
                                                row['Enterprise Value ($B)'] = other_data['enterprise_value']
                                                # Also recalculate EV/EBITDA with the corrected Enterprise Value
                                                ebitda = info.get('ebitda')
                                                if ebitda and ebitda > 0:
                                                    ev_actual = row['Enterprise Value ($B)'] * 1e9
                                                    row['EV/EBITDA'] = ev_actual / ebitda
                                        break
                        
                        # Calculate Price/Book ratio AFTER dual-class adjustment
                        book_value = row.get('Book Value ($)')
                        if current_price and book_value and book_value > 0:
                            row['Price/Book'] = current_price / book_value
                        elif current_price and book_value == 0:
                            row['Price/Book'] = None  # Explicitly set to None if book value is 0
                        
                        # Use Yahoo Finance data directly - no manual scaling fixes
                        # This ensures we get the most accurate data from Yahoo Finance
                        
                        # No manual calculations needed - use Yahoo Finance data directly
                        rows.append(row)
                        
                    except Exception as e:
                        st.warning(f"Error fetching data for {ticker}: {str(e)}")
                        # Add basic row with available data
                        alloc_pct = float(alloc_dict.get(ticker, 0))
                        allocation_value = portfolio_value * alloc_pct
                        rows.append({
                            'Ticker': ticker,
                            'Company Name': 'Error fetching data',
                            'Current Price ($)': None,
                            'Allocation %': alloc_pct * 100,
                            'Shares': 0,
                            'Total Value ($)': allocation_value,
                            '% of Portfolio': (allocation_value / portfolio_value * 100) if portfolio_value > 0 else 0,
                        })
                
                # Clear progress indicators
                progress_bar.empty()
                if 'status_text' in locals():
                    status_text.empty()
                
                if rows:
                    df_comprehensive = pd.DataFrame(rows)
                    # Store in session state for PDF generation
                    st.session_state.df_comprehensive = df_comprehensive
                    

                    
                    # Calculate portfolio-weighted metrics BEFORE formatting
                    def weighted_average(df, column, weight_column='% of Portfolio'):
                        """Calculate weighted average, handling NaN values and filtering invalid values"""
                        # Check if columns exist in DataFrame
                        if column not in df.columns or weight_column not in df.columns:
                            return None
                        
                        # Base mask for valid (non-NaN) values
                        valid_mask = df[column].notna() & df[weight_column].notna()
                        
                        # Special handling for PE ratios and similar valuation metrics
                        if 'P/E' in column or 'PE' in column or 'PEG' in column:
                            # Filter out negative or extremely high PE values that are likely errors
                            # Negative PE means negative earnings (company losing money)
                            # Very high PE (>1000) is usually a data error or near-zero earnings
                            valid_mask = valid_mask & (df[column] > 0) & (df[column] <= 1000)
                        elif column == 'Beta':
                            # Filter out extreme beta values (likely data errors)
                            valid_mask = valid_mask & (df[column] >= -5) & (df[column] <= 5)
                        elif 'Ratio' in column and column != 'PEG Ratio':
                            # For other ratios, filter out negative values (usually data errors)
                            valid_mask = valid_mask & (df[column] >= 0)
                        
                        if valid_mask.sum() == 0:
                            return None
                            
                        valid_df = df[valid_mask]
                        # Since weight_column is already in percentage, we divide by 100 to get decimal weights
                        result = (valid_df[column] * valid_df[weight_column] / 100).sum() / (valid_df[weight_column].sum() / 100)
                        
                        return result
                    
                    # Calculate all portfolio-weighted metrics first
                    portfolio_pe = weighted_average(df_comprehensive, 'P/E Ratio')
                    portfolio_pb = weighted_average(df_comprehensive, 'Price/Book')
                    portfolio_beta = weighted_average(df_comprehensive, 'Beta')
                    portfolio_peg = weighted_average(df_comprehensive, 'PEG Ratio')
                    portfolio_ps = weighted_average(df_comprehensive, 'Price/Sales')
                    portfolio_ev_ebitda = weighted_average(df_comprehensive, 'EV/EBITDA')
                    portfolio_price_fcf = weighted_average(df_comprehensive, 'Price/FCF')
                    portfolio_fcf_yield = weighted_average(df_comprehensive, 'FCF Yield (%)')
                    portfolio_interest_coverage = weighted_average(df_comprehensive, 'Interest Coverage')
                    portfolio_roe = weighted_average(df_comprehensive, 'ROE (%)')
                    portfolio_roa = weighted_average(df_comprehensive, 'ROA (%)')
                    portfolio_roic = weighted_average(df_comprehensive, 'ROIC (%)')
                    portfolio_debt_equity = weighted_average(df_comprehensive, 'Debt/Equity')
                    portfolio_current_ratio = weighted_average(df_comprehensive, 'Current Ratio')
                    portfolio_quick_ratio = weighted_average(df_comprehensive, 'Quick Ratio')
                    portfolio_profit_margin = weighted_average(df_comprehensive, 'Profit Margin (%)')
                    portfolio_operating_margin = weighted_average(df_comprehensive, 'Operating Margin (%)')
                    portfolio_gross_margin = weighted_average(df_comprehensive, 'Gross Margin (%)')
                    portfolio_revenue_growth = weighted_average(df_comprehensive, 'Revenue Growth (%)')
                    portfolio_earnings_growth = weighted_average(df_comprehensive, 'Earnings Growth (%)')
                    portfolio_eps_growth = weighted_average(df_comprehensive, 'EPS Growth (%)')
                    portfolio_dividend_yield = weighted_average(df_comprehensive, 'Dividend Yield (%)')
                    
                    portfolio_payout_ratio = weighted_average(df_comprehensive, 'Payout Ratio (%)')
                    portfolio_dividend_growth = weighted_average(df_comprehensive, '5Y Dividend Growth (%)')
                    portfolio_market_cap = weighted_average(df_comprehensive, 'Market Cap ($B)')
                    portfolio_enterprise_value = weighted_average(df_comprehensive, 'Enterprise Value ($B)')
                    portfolio_forward_pe = weighted_average(df_comprehensive, 'Forward P/E')
                    
                    # Store portfolio metrics in session state for PDF generation
                    st.session_state.portfolio_pe = portfolio_pe
                    st.session_state.portfolio_pb = portfolio_pb
                    st.session_state.portfolio_beta = portfolio_beta
                    st.session_state.portfolio_peg = portfolio_peg
                    st.session_state.portfolio_ps = portfolio_ps
                    st.session_state.portfolio_ev_ebitda = portfolio_ev_ebitda
                    st.session_state.portfolio_price_fcf = portfolio_price_fcf
                    st.session_state.portfolio_fcf_yield = portfolio_fcf_yield
                    st.session_state.portfolio_interest_coverage = portfolio_interest_coverage
                    st.session_state.portfolio_roe = portfolio_roe
                    st.session_state.portfolio_roa = portfolio_roa
                    st.session_state.portfolio_roic = portfolio_roic
                    st.session_state.portfolio_debt_equity = portfolio_debt_equity
                    st.session_state.portfolio_current_ratio = portfolio_current_ratio
                    st.session_state.portfolio_quick_ratio = portfolio_quick_ratio
                    st.session_state.portfolio_profit_margin = portfolio_profit_margin
                    st.session_state.portfolio_operating_margin = portfolio_operating_margin
                    st.session_state.portfolio_gross_margin = portfolio_gross_margin
                    st.session_state.portfolio_revenue_growth = portfolio_revenue_growth
                    st.session_state.portfolio_earnings_growth = portfolio_earnings_growth
                    st.session_state.portfolio_eps_growth = portfolio_eps_growth
                    st.session_state.portfolio_dividend_yield = portfolio_dividend_yield
                    st.session_state.portfolio_payout_ratio = portfolio_payout_ratio
                    st.session_state.portfolio_dividend_growth = portfolio_dividend_growth
                    st.session_state.portfolio_market_cap = portfolio_market_cap
                    st.session_state.portfolio_enterprise_value = portfolio_enterprise_value
                    st.session_state.portfolio_forward_pe = portfolio_forward_pe
                    
                    # Calculate sector and industry breakdowns using ACTUAL portfolio allocations, not market values
                    sector_data = pd.Series(dtype=float)
                    industry_data = pd.Series(dtype=float)
                    
                    # Use 'Allocation %' column instead of '% of Portfolio' for accurate sector/industry breakdown
                    if 'Sector' in df_comprehensive.columns and 'Allocation %' in df_comprehensive.columns:
                        sector_data = df_comprehensive.groupby('Sector')['Allocation %'].sum().sort_values(ascending=False)
                    
                    if 'Industry' in df_comprehensive.columns and 'Allocation %' in df_comprehensive.columns:
                        industry_data = df_comprehensive.groupby('Industry')['Allocation %'].sum().sort_values(ascending=False)
                    
                    # Store sector and industry data in session state for PDF generation
                    st.session_state.sector_data = sector_data
                    st.session_state.industry_data = industry_data
                    
                    # Format the dataframe with safe formatting
                    def safe_format(value, format_str):
                        """Safely format values, handling NaN and None"""
                        if pd.isna(value) or value is None:
                            return 'N/A'
                        try:
                            if format_str.startswith('${:,.2f}'):
                                return f"${value:,.2f}"
                            elif format_str.startswith('{:,.2f}%'):
                                return f"{value:,.2f}%"
                            elif format_str.startswith('{:,.0f}'):
                                return f"{value:,.0f}"
                            elif format_str.startswith('{:,.2f}'):
                                return f"{value:,.2f}"
                            else:
                                return str(value)
                        except (ValueError, TypeError):
                            return 'N/A'
                    
                    # Apply safe formatting to all numeric columns
                    for col in df_comprehensive.columns:
                        if col in ['Ticker', 'Company Name', 'Sector', 'Industry', 'Analyst Rating']:
                            continue
                        elif col in ['Allocation %', 'ROE (%)', 'ROA (%)', 'ROIC (%)', 'Revenue Growth (%)', 
                                   'Earnings Growth (%)', 'EPS Growth (%)', 'Dividend Yield (%)', 
                                   'Payout Ratio (%)', '5Y Dividend Growth (%)', 'Profit Margin (%)', 
                                   'Operating Margin (%)', 'Gross Margin (%)', 'FCF Yield (%)', '% of Portfolio']:
                            df_comprehensive[col] = df_comprehensive[col].apply(lambda x: safe_format(x, '{:,.2f}%'))
                        elif col in ['Current Price ($)', 'Total Value ($)', '52W High ($)', '52W Low ($)', 
                                   '50D MA ($)', '200D MA ($)', 'Target Price ($)', 'Target High ($)', 
                                   'Target Low ($)', 'Book Value ($)', 'Cash per Share ($)', 
                                   'Revenue per Share ($)', 'Dividend Rate ($)']:
                            df_comprehensive[col] = df_comprehensive[col].apply(lambda x: safe_format(x, '${:,.2f}'))
                        elif col in ['Market Cap ($B)', 'Enterprise Value ($B)', 'Free Cash Flow ($B)', 
                                   'Total Debt ($B)', 'Net Debt ($B)', 'Working Capital ($B)', 
                                   'Revenue TTM ($B)', 'Earnings TTM ($B)']:
                            df_comprehensive[col] = df_comprehensive[col].apply(lambda x: safe_format(x, '${:,.2f}B'))
                        elif col in ['Shares Outstanding (M)', 'Float Shares (M)']:
                            df_comprehensive[col] = df_comprehensive[col].apply(lambda x: safe_format(x, '{:,.2f}M'))
                        elif col in ['Volume', 'Avg Volume']:
                            df_comprehensive[col] = df_comprehensive[col].apply(lambda x: safe_format(x, '{:,.0f}'))
                        else:
                            df_comprehensive[col] = df_comprehensive[col].apply(lambda x: safe_format(x, '{:,.2f}'))
                    
                    # Display the comprehensive table
                    st.markdown(f"**Data as of {current_date}**")
                    
                    # Create tabs for different metric categories
                    tab1, tab2, tab3, tab4, tab5 = st.tabs(["📈 Overview", "💰 Valuation", "🏥 Financial Health", "📊 Growth & Dividends", "📈 Technical"])
                    
                    with tab1:
                        # Overview tab - basic info and key metrics
                        overview_cols = ['Ticker', 'Company Name', 'Sector', 'Industry', 'Current Price ($)', 
                                       'Allocation %', 'Shares', 'Total Value ($)', '% of Portfolio', 
                                       'Market Cap ($B)', 'P/E Ratio', 'PEG Ratio', 'PEG Source', 'Beta', 'Analyst Rating']
                        df_overview = df_comprehensive[overview_cols].copy()
                        st.dataframe(df_overview, )
                    
                    with tab2:
                        # Valuation tab - all valuation metrics
                        valuation_cols = ['Ticker', 'Current Price ($)', 'Market Cap ($B)', 'Enterprise Value ($B)',
                                        'P/E Ratio', 'Forward P/E', 'PEG Ratio', 'PEG Source', 'Price/Book', 'Price/Sales',
                                        'Price/Cash Flow', 'Price/FCF', 'EV/EBITDA', 'FCF Yield (%)', 
                                        'Free Cash Flow ($B)', 'Shares Outstanding (M)', 'Float Shares (M)',
                                        'Revenue TTM ($B)', 'Earnings TTM ($B)',
                                        'Book Value ($)', 'Cash per Share ($)', 'Revenue per Share ($)', 
                                        'Target Price ($)', 'Target High ($)', 'Target Low ($)']
                        # Filter to only include columns that exist
                        valuation_cols = [col for col in valuation_cols if col in df_comprehensive.columns]
                        df_valuation = df_comprehensive[valuation_cols].copy()
                        st.dataframe(df_valuation, )
                    
                    with tab3:
                        # Financial Health tab - ratios and margins
                        health_cols = ['Ticker', 'Debt/Equity', 'Total Debt ($B)', 'Net Debt ($B)', 
                                     'Current Ratio', 'Quick Ratio', 'Working Capital ($B)', 'Interest Coverage',
                                     'ROE (%)', 'ROA (%)', 'ROIC (%)', 'Profit Margin (%)', 'Operating Margin (%)', 
                                     'Gross Margin (%)']
                        # Filter to only include columns that exist
                        health_cols = [col for col in health_cols if col in df_comprehensive.columns]
                        df_health = df_comprehensive[health_cols].copy()
                        st.dataframe(df_health, )
                    
                    with tab4:
                        # Growth & Dividends tab
                        growth_cols = ['Ticker', 'Revenue Growth (%)', 'Earnings Growth (%)', 'EPS Growth (%)',
                                     'Dividend Yield (%)', 'Dividend Rate ($)', 'Payout Ratio (%)', 
                                     '5Y Dividend Growth (%)']
                        df_growth = df_comprehensive[growth_cols].copy()
                        st.dataframe(df_growth, )
                    
                    with tab5:
                        # Technical tab - price levels and volume
                        technical_cols = ['Ticker', 'Current Price ($)', '52W High ($)', '52W Low ($)', 
                                        '50D MA ($)', '200D MA ($)', 'Beta', 'Volume', 'Avg Volume']
                        df_technical = df_comprehensive[technical_cols].copy()
                        st.dataframe(df_technical, )
                    
                    # Add portfolio-weighted summary statistics in collapsible section
                    with st.expander("📊 Portfolio-Weighted Summary Statistics", expanded=True):
                        st.markdown("*Metrics weighted by portfolio allocation - represents the total portfolio characteristics*")
                        
                        # Add data accuracy warning
                        st.warning("⚠️ **Data Accuracy Notice:** Portfolio metrics (PE, Beta, etc.) are calculated from available data and may not accurately represent the portfolio if some ticker data is missing, outdated, or incorrect. These metrics should be used as indicative values for portfolio analysis.")
                        
                        # Create a comprehensive summary table
                        summary_data = []
                        
                        # Valuation metrics
                        if portfolio_pe is not None:
                            summary_data.append({"Category": "Valuation", "Metric": "P/E Ratio", "Value": f"{portfolio_pe:.2f}", "Description": "Price-to-Earnings ratio weighted by portfolio allocation"})
                        if portfolio_forward_pe is not None:
                            summary_data.append({"Category": "Valuation", "Metric": "Forward P/E", "Value": f"{portfolio_forward_pe:.2f}", "Description": "Forward Price-to-Earnings ratio weighted by portfolio allocation"})
                        if portfolio_pb is not None:
                            summary_data.append({"Category": "Valuation", "Metric": "Price/Book", "Value": f"{portfolio_pb:.2f}", "Description": "Price-to-Book ratio weighted by portfolio allocation"})
                        if portfolio_peg is not None:
                            summary_data.append({"Category": "Valuation", "Metric": "PEG Ratio", "Value": f"{portfolio_peg:.2f}", "Description": "P/E to Growth ratio weighted by portfolio allocation (calculated from best available source)"})
                        if portfolio_ps is not None:
                            summary_data.append({"Category": "Valuation", "Metric": "Price/Sales", "Value": f"{portfolio_ps:.2f}", "Description": "Price-to-Sales ratio weighted by portfolio allocation"})
                        if portfolio_ev_ebitda is not None:
                            summary_data.append({"Category": "Valuation", "Metric": "EV/EBITDA", "Value": f"{portfolio_ev_ebitda:.2f}", "Description": "Enterprise Value to EBITDA ratio weighted by portfolio allocation"})
                        
                        # Risk metrics
                        if portfolio_beta is not None:
                            summary_data.append({"Category": "Risk", "Metric": "Beta", "Value": f"{portfolio_beta:.2f}", "Description": "Portfolio volatility relative to market (1.0 = market average)"})
                        
                        # Profitability metrics
                        if portfolio_roe is not None:
                            summary_data.append({"Category": "Profitability", "Metric": "ROE (%)", "Value": f"{portfolio_roe:.2f}%", "Description": "Return on Equity weighted by portfolio allocation"})
                        if portfolio_roa is not None:
                            summary_data.append({"Category": "Profitability", "Metric": "ROA (%)", "Value": f"{portfolio_roa:.2f}%", "Description": "Return on Assets weighted by portfolio allocation"})
                        if portfolio_profit_margin is not None:
                            summary_data.append({"Category": "Profitability", "Metric": "Profit Margin (%)", "Value": f"{portfolio_profit_margin:.2f}%", "Description": "Net profit margin weighted by portfolio allocation"})
                        if portfolio_operating_margin is not None:
                            summary_data.append({"Category": "Profitability", "Metric": "Operating Margin (%)", "Value": f"{portfolio_operating_margin:.2f}%", "Description": "Operating profit margin weighted by portfolio allocation"})
                        if portfolio_gross_margin is not None:
                            summary_data.append({"Category": "Profitability", "Metric": "Gross Margin (%)", "Value": f"{portfolio_gross_margin:.2f}%", "Description": "Gross profit margin weighted by portfolio allocation"})
                        
                        # Growth metrics
                        if portfolio_revenue_growth is not None:
                            summary_data.append({"Category": "Growth", "Metric": "Revenue Growth (%)", "Value": f"{portfolio_revenue_growth:.2f}%", "Description": "Revenue growth rate weighted by portfolio allocation"})
                        if portfolio_earnings_growth is not None:
                            summary_data.append({"Category": "Growth", "Metric": "Earnings Growth (%)", "Value": f"{portfolio_earnings_growth:.2f}%", "Description": "Earnings growth rate weighted by portfolio allocation"})
                        if portfolio_eps_growth is not None:
                            summary_data.append({"Category": "Growth", "Metric": "EPS Growth (%)", "Value": f"{portfolio_eps_growth:.2f}%", "Description": "Earnings per share growth rate weighted by portfolio allocation"})
                        
                        # Dividend metrics
                        if portfolio_dividend_yield is not None:
                            summary_data.append({"Category": "Dividends", "Metric": "Dividend Yield (%)", "Value": f"{portfolio_dividend_yield:.2f}%", "Description": "Dividend yield weighted by portfolio allocation"})
                        if portfolio_payout_ratio is not None:
                            summary_data.append({"Category": "Dividends", "Metric": "Payout Ratio (%)", "Value": f"{portfolio_payout_ratio:.2f}%", "Description": "Dividend payout ratio weighted by portfolio allocation"})
                        
                        # Size metrics
                        if portfolio_market_cap is not None:
                            summary_data.append({"Category": "Size", "Metric": "Market Cap ($B)", "Value": f"${portfolio_market_cap:.2f}B", "Description": "Market capitalization weighted by portfolio allocation"})
                        if portfolio_enterprise_value is not None:
                            summary_data.append({"Category": "Size", "Metric": "Enterprise Value ($B)", "Value": f"${portfolio_enterprise_value:.2f}B", "Description": "Enterprise value weighted by portfolio allocation"})
                        
                        if summary_data:
                            summary_df = pd.DataFrame(summary_data)
                            st.dataframe(summary_df, hide_index=True)
                            
                            # Add interpretation
                            st.markdown("**📈 Portfolio Interpretation:**")
                            if portfolio_beta is not None:
                                if portfolio_beta < 0.8:
                                    st.success(f"**Low Risk Portfolio** - Beta {portfolio_beta:.2f} indicates lower volatility than market")
                                elif portfolio_beta < 1.2:
                                    st.info(f"**Moderate Risk Portfolio** - Beta {portfolio_beta:.2f} indicates market-average volatility")
                                else:
                                    st.warning(f"**High Risk Portfolio** - Beta {portfolio_beta:.2f} indicates higher volatility than market")
                            
                            if portfolio_pe is not None:
                                if portfolio_pe < 15:
                                    st.success(f"**Undervalued Portfolio** - P/E {portfolio_pe:.2f} suggests attractive valuations")
                                elif portfolio_pe < 25:
                                    st.info(f"**Fairly Valued Portfolio** - P/E {portfolio_pe:.2f} suggests reasonable valuations")
                                else:
                                    st.warning(f"**Potentially Overvalued Portfolio** - P/E {portfolio_pe:.2f} suggests high valuations")
                        else:
                            st.warning("No portfolio-weighted metrics available for display.")
                    
                    # Add portfolio composition analysis
                    st.markdown("### 🏢 Portfolio Composition Analysis")
                    
                    # Create a nice table for sector and industry breakdown
                    col1, col2 = st.columns(2)
                    
                    with col1:
                        # Sector breakdown with table and pie chart
                        if not sector_data.empty:
                            st.markdown("**📊 Sector Allocation**")
                            
                            # Create sector table
                            sector_df = pd.DataFrame({
                                'Sector': sector_data.index,
                                'Allocation (%)': sector_data.values
                            }).round(2)
                            
                            # Display table
                            st.dataframe(sector_df, hide_index=True)
                            
                            # Create modern donut chart for sectors (filter out 0% allocations)
                            if len(sector_data) > 0:
                                # Filter out sectors with 0% allocation
                                sector_data_filtered = sector_data[sector_data > 0]
                                
                                if len(sector_data_filtered) > 0:
                                    fig_sector = go.Figure(data=[go.Pie(
                                        labels=sector_data_filtered.index,
                                        values=sector_data_filtered.values,
                                        hole=0.45,  # Donut hole
                                        marker=dict(
                                            colors=['#2E5090', '#4A90E2', '#7CB342', '#FFA726', '#5C6BC0', 
                                                   '#26A69A', '#AB47BC', '#FF7043', '#66BB6A', '#42A5F5',
                                                   '#8D6E63', '#78909C', '#EC407A', '#9CCC65', '#FFCA28'],
                                            line=dict(color='#37474F', width=1.5)
                                        ),
                                        textposition='auto',
                                        textfont=dict(size=11, color='white', family='Segoe UI'),
                                        hovertemplate='<b>%{label}</b><br>%{value:.2f}%<br><extra></extra>'
                                    )])
                                    fig_sector.update_traces(textinfo='percent+label')
                                    fig_sector.update_layout(
                                        title=dict(
                                            text="Sector Distribution",
                                            font=dict(size=16, color='white')
                                        ),
                                        height=450,
                                        showlegend=True,
                                        legend=dict(
                                            orientation="v",
                                            yanchor="middle",
                                            y=0.5,
                                            xanchor="left",
                                            x=1.05,
                                            font=dict(size=11)
                                        ),
                                        margin=dict(t=60, b=40, l=20, r=120),
                                        template='plotly_dark',
                                        paper_bgcolor='rgba(0,0,0,0)',
                                        plot_bgcolor='rgba(0,0,0,0)'
                                    )
                                    st.plotly_chart(fig_sector, )
                    
                    with col2:
                        # Industry breakdown with table and pie chart
                        if not industry_data.empty:
                            st.markdown("**🏭 Industry Allocation**")
                            
                            # Create industry table
                            industry_df = pd.DataFrame({
                                'Industry': industry_data.index,
                                'Allocation (%)': industry_data.values
                            }).round(2)
                            
                            # Display table
                            st.dataframe(industry_df, hide_index=True)
                            
                            # Create modern donut chart for industries (filter out 0% allocations)
                            if len(industry_data) > 0:
                                # Filter out industries with 0% allocation
                                industry_data_filtered = industry_data[industry_data > 0]
                                
                                if len(industry_data_filtered) > 0:
                                    fig_industry = go.Figure(data=[go.Pie(
                                        labels=industry_data_filtered.index,
                                        values=industry_data_filtered.values,
                                        hole=0.45,  # Donut hole
                                        marker=dict(
                                            colors=['#2E5090', '#4A90E2', '#7CB342', '#FFA726', '#5C6BC0', 
                                                   '#26A69A', '#AB47BC', '#FF7043', '#66BB6A', '#42A5F5',
                                                   '#8D6E63', '#78909C', '#EC407A', '#9CCC65', '#FFCA28',
                                                   '#5D4037', '#546E7A', '#8E24AA', '#43A047', '#FB8C00',
                                                   '#3949AB', '#00897B', '#E53935', '#6D4C41', '#00ACC1'],
                                            line=dict(color='#37474F', width=1.5)
                                        ),
                                        textposition='auto',
                                        textfont=dict(size=11, color='white', family='Segoe UI'),
                                        hovertemplate='<b>%{label}</b><br>%{value:.2f}%<br><extra></extra>'
                                    )])
                                    fig_industry.update_traces(textinfo='percent+label')
                                    fig_industry.update_layout(
                                        title=dict(
                                            text="Industry Distribution",
                                            font=dict(size=16, color='white')
                                        ),
                                        height=450,
                                        showlegend=True,
                                        legend=dict(
                                            orientation="v",
                                            yanchor="middle",
                                            y=0.5,
                                            xanchor="left",
                                            x=1.05,
                                            font=dict(size=11)
                                        ),
                                        margin=dict(t=60, b=40, l=20, r=120),
                                        template='plotly_dark',
                                        paper_bgcolor='rgba(0,0,0,0)',
                                        plot_bgcolor='rgba(0,0,0,0)'
                                    )
                                    st.plotly_chart(fig_industry, )
                    
                    # Portfolio risk metrics
                    st.markdown("### ⚠️ Portfolio Risk Metrics")
                    col1, col2, col3, col4 = st.columns(4)
                    
                    with col1:
                        # Beta analysis
                        if portfolio_beta is not None and not pd.isna(portfolio_beta):
                            if portfolio_beta < 0.8:
                                beta_risk = "Low Risk"
                                beta_color = "green"
                            elif portfolio_beta < 1.2:
                                beta_risk = "Balanced Risk"
                                beta_color = "green"
                            elif portfolio_beta < 1.5:
                                beta_risk = "Moderate Risk"
                                beta_color = "orange"
                            else:
                                beta_risk = "High Risk"
                                beta_color = "red"
                            st.metric("Portfolio Risk Level", beta_risk)
                            st.markdown(f"<span style='color: {beta_color}'>Beta: {portfolio_beta:.2f}</span>", unsafe_allow_html=True)
                        else:
                            st.metric("Portfolio Risk Level", "NA")
                            st.markdown("<span style='color: gray'>Beta: NA</span>", unsafe_allow_html=True)
                    
                    with col2:
                        # Current P/E analysis
                        if portfolio_pe is not None and not pd.isna(portfolio_pe):
                            if portfolio_pe < 15:
                                pe_rating = "Undervalued"
                                pe_color = "green"
                            elif portfolio_pe < 25:
                                pe_rating = "Fair Value"
                                pe_color = "lime"
                            elif portfolio_pe < 35:
                                pe_rating = "Expensive"
                                pe_color = "orange"
                            else:
                                pe_rating = "Overvalued"
                                pe_color = "red"
                            st.metric("Current P/E Rating", pe_rating)
                            st.markdown(f"<span style='color: {pe_color}'>P/E: {portfolio_pe:.2f}</span>", unsafe_allow_html=True)
                        else:
                            st.metric("Current P/E Rating", "NA")
                            st.markdown("<span style='color: gray'>P/E: NA</span>", unsafe_allow_html=True)
                    
                    with col3:
                        # Forward P/E analysis
                        if portfolio_forward_pe is not None and not pd.isna(portfolio_forward_pe):
                            if portfolio_forward_pe < 15:
                                fpe_rating = "Undervalued"
                                fpe_color = "green"
                            elif portfolio_forward_pe < 25:
                                fpe_rating = "Fair Value"
                                fpe_color = "lime"
                            elif portfolio_forward_pe < 35:
                                fpe_rating = "Expensive"
                                fpe_color = "orange"
                            else:
                                fpe_rating = "Overvalued"
                                fpe_color = "red"
                            st.metric("Forward P/E Rating", fpe_rating)
                            st.markdown(f"<span style='color: {fpe_color}'>Forward P/E: {portfolio_forward_pe:.2f}</span>", unsafe_allow_html=True)
                        else:
                            st.metric("Forward P/E Rating", "NA")
                            st.markdown("<span style='color: gray'>Forward P/E: NA</span>", unsafe_allow_html=True)
                    
                    with col4:
                        # Dividend analysis
                        if portfolio_dividend_yield is not None and not pd.isna(portfolio_dividend_yield):
                            if portfolio_dividend_yield > 5:
                                div_rating = "Very High Yield"
                            elif portfolio_dividend_yield > 3:
                                div_rating = "Good Yield"
                            elif portfolio_dividend_yield > 1.5:
                                div_rating = "Moderate Yield"
                            else:
                                div_rating = "Low Yield"
                            st.metric("Dividend Rating", div_rating)
                            st.write(f"Yield: {portfolio_dividend_yield:.2f}%")
                        else:
                            st.metric("Dividend Rating", "NA")
                            st.write("Yield: NA")
                
                else:
                    st.warning("No portfolio data available to display.")
                
                # Add professional data explanation
                with st.expander("🔍 Data Sources & Methodology", expanded=False):
                    st.markdown("### Financial Data Information")
                    
                    st.markdown("**📊 Data Source**: All financial metrics are sourced directly from Yahoo Finance API")
                    st.markdown("**📈 Portfolio Metrics**: Weighted averages calculated based on portfolio allocation percentages")
                    st.markdown("**📊 Data Availability**: Some metrics may show N/A for securities where data is unavailable")
                    
                    st.markdown("**📊 Valuation Guidelines:**")
                    st.markdown("- **P/E Ratio**: <15 = undervalued, 15-25 = fair, >25 = potentially overvalued")
                    st.markdown("- **PEG Ratio**: <1 = undervalued, 1-2 = fair, >2 = potentially overvalued")
                    st.markdown("- **Price/Book**: <1 = potentially undervalued, 1-3 = fair, >3 = potentially overvalued")
                    st.markdown("- **Dividend Yield**: Low yield is not necessarily bad (growth stocks often have low yields)")
                    
                    st.markdown("**🔍 PEG Ratio Calculation:**")
                    st.markdown("- **Formula**: P/E Ratio ÷ Earnings Growth Rate")
                    st.markdown("- **What it measures**: Price relative to earnings growth (lower = better value)")
                    st.markdown("- **Source**: Direct calculation using Yahoo Finance data")
                    st.markdown("- **Realistic ranges**: <1.0 (undervalued), 1.0-1.5 (fair), >2.0 (overvalued)")
        
        # Add Benchmark Comparison Table
        st.markdown("### Benchmark Comparison")
        # Clarify that figures are approximate snapshots
        st.caption("Approximate price-return snapshots using calendar lookbacks; may differ from total-return or month-end sources.")
        
        # PE is now calculated directly and always up-to-date - no warning needed
        
        def calculate_benchmark_returns(available_data=None, preloaded_info=None):
            """Calculate returns for benchmark tickers"""
            try:
                # Use the same active_name as Portfolio Weighted Returns
                active_name = active_portfolio.get('name') if active_portfolio else None
                
                # Get raw data
                snapshot = st.session_state.get('alloc_snapshot_data', {})
                raw_data = snapshot.get('raw_data') if snapshot and snapshot.get('raw_data') is not None else st.session_state.get('alloc_raw_data', {})
                
                today = pd.Timestamp.now().date()
                
                # Calculate different period returns using calendar-day lookbacks
                periods = {
                    '1W': 7,      # 7 calendar days
                    '1M': 30,     # 30 calendar days per month (more representative)
                    '3M': 90,     # ~90 calendar days per quarter
                    '6M': 180,    # ~180 calendar days per half year
                    '1Y': 365     # ~365 calendar days per year
                }

                def get_value_days_ago(series, days):
                    """Return the value at or before last_date - days from a datetime-indexed Series/DataFrame column."""
                    if series is None or len(series) == 0:
                        return None
                    last_date = pd.to_datetime(series.index[-1])
                    target_date = last_date - pd.Timedelta(days=days)
                    # Ensure datetime index
                    idx = pd.to_datetime(series.index)
                    series.index = idx
                    prior = series.loc[:target_date]
                    if len(prior) == 0:
                        return series.iloc[0]
                    return prior.iloc[-1]

                # Benchmark tickers to compare (in specific order)
                benchmark_tickers = ['SPY', 'QQQ', 'SPMO', 'VTI', 'VT', 'SSO', 'QLD', 'BITCOIN']
                
                # Use preloaded info if available (for performance)
                if preloaded_info is None:
                    preloaded_info = {}
                
                benchmark_data = []
                
                # Use available_data passed as parameter (already prepared outside)
                
                # available_data is already prepared outside this function
                
                # Add PORTFOLIO row first for comparison (using same raw data as Current method)
                portfolio_returns_dict = {}
                
                # Use same method as Current portfolio for consistency
                try:
                    # Get current weights from snapshot
                    snapshot = st.session_state.get('alloc_snapshot_data', {})
                    today_weights_map = snapshot.get('today_weights_map', {}) if snapshot else {}
                    current_weights = today_weights_map.get(active_name, {})
                    if not current_weights:
                        current_weights = {**today_weights_map.get(active_name, {}), 'CASH': today_weights_map.get(active_name, {}).get('CASH', 0)}
                    
                    for period_name, days in periods.items():
                        try:
                            weighted_return = 0.0
                            total_weight = 0.0
                            
                            for ticker, weight in current_weights.items():
                                if ticker == 'CASH' or weight <= 0:
                                    continue
                                    
                                if ticker in raw_data and not raw_data[ticker].empty:
                                    df = raw_data[ticker].copy()
                                    if 'Close' not in df.columns or len(df) < days + 1:
                                        continue
                                    
                                    try:
                                        # Ensure datetime index
                                        df.index = pd.to_datetime(df.index)
                                        current_price = df['Close'].iloc[-1]
                                        past_price = get_value_days_ago(df['Close'], days)
                                        
                                        if past_price is not None and past_price > 0:
                                            return_pct = ((current_price - past_price) / past_price) * 100
                                            weighted_return += return_pct * weight
                                            total_weight += weight
                                    except Exception:
                                        continue
                            
                            if total_weight > 0:
                                final_return = weighted_return / total_weight
                                portfolio_returns_dict[period_name] = f"{final_return:+.2f}%"
                            else:
                                portfolio_returns_dict[period_name] = 'N/A'
                                
                        except Exception:
                            portfolio_returns_dict[period_name] = 'N/A'
                            
                except Exception as e:
                    # Fallback: all N/A if error
                    for period_name in periods.keys():
                        portfolio_returns_dict[period_name] = 'N/A'
                
                # Copy EXACTLY the same data as Portfolio Weighted Returns table
                portfolio_returns_dict = {}
                try:
                    # Get EXACT same data as Portfolio Weighted Returns table
                    all_results = st.session_state.get('alloc_all_results', {})
                    if active_name in all_results:
                        portfolio_result = all_results[active_name]
                        total_series = portfolio_result.get('no_additions', None)
                        if total_series is not None and len(total_series) > 0:
                            # Calculate returns using calendar days (same method as benchmarks for consistency)
                            historical_returns = {}
                            try:
                                # Ensure datetime index for calendar-day calculations
                                portfolio_series = total_series.copy()
                                portfolio_series.index = pd.to_datetime(portfolio_series.index)
                                
                                for period_name, days in periods.items():
                                    try:
                                        current_price = portfolio_series.iloc[-1]
                                        past_price = get_value_days_ago(portfolio_series, days)
                                        if past_price is not None and past_price > 0:
                                            return_pct = ((current_price - past_price) / past_price) * 100
                                            historical_returns[period_name] = f"{return_pct:+.2f}%"
                                        else:
                                            historical_returns[period_name] = 'N/A'
                                    except Exception:
                                        historical_returns[period_name] = 'N/A'
                            except Exception:
                                # Fallback to old method if datetime conversion fails
                                for period_name, days in periods.items():
                                    try:
                                        if len(total_series) >= days:
                                            current_value = total_series.iloc[-1]
                                            historical_value = total_series.iloc[-days] if len(total_series) >= days else total_series.iloc[0]
                                            if historical_value > 0:
                                                historical_return = (current_value - historical_value) / historical_value * 100
                                                historical_returns[period_name] = f"{historical_return:+.2f}%"
                                        else:
                                            historical_returns[period_name] = 'N/A'
                                    except Exception:
                                        historical_returns[period_name] = 'N/A'
                            
                            # Copy historical returns to portfolio_returns_dict
                            for period_name, return_value in historical_returns.items():
                                portfolio_returns_dict[period_name] = return_value
                            
                            # Add PORTFOLIO as first row
                            portfolio_returns_dict['Ticker'] = 'PORTFOLIO (Historical)'
                        else:
                            # Fallback if no data
                            portfolio_returns_dict = {
                                'Ticker': 'PORTFOLIO (Historical)',
                                'PE': 'N/A',
                                'Volatility': 'N/A',
                                'Beta': 'N/A'
                            }
                            for period_name in periods.keys():
                                portfolio_returns_dict[period_name] = 'N/A'
                    else:
                        # Fallback if no results
                        portfolio_returns_dict = {
                            'Ticker': 'PORTFOLIO (Historical)',
                            'PE': 'N/A',
                            'Volatility': 'N/A',
                            'Beta': 'N/A'
                        }
                        for period_name in periods.keys():
                            portfolio_returns_dict[period_name] = 'N/A'
                            
                except Exception as e:
                    print(f"[PORTFOLIO DEBUG] Error getting backtest results: {e}")
                    # Fallback: all N/A if error
                    portfolio_returns_dict = {
                        'Ticker': 'PORTFOLIO (Historical)',
                        'PE': 'N/A',
                        'Volatility': 'N/A',
                        'Beta': 'N/A'
                    }
                    for period_name in periods.keys():
                        portfolio_returns_dict[period_name] = 'N/A'
                
                # Get PE, Volatility, and Beta EXACTLY like the first table
                portfolio_pe_calculated = 'N/A'
                try:
                    # Get EXACT same data as Portfolio Weighted Returns table
                    all_results = st.session_state.get('alloc_all_results', {})
                    if active_name in all_results:
                        portfolio_result = all_results[active_name]
                        total_series = portfolio_result.get('no_additions', None)
                        if total_series is not None and len(total_series) > 0:
                            # Get PE from session state
                            session_pe = getattr(st.session_state, 'portfolio_pe', None)
                            if session_pe is not None and not pd.isna(session_pe):
                                portfolio_pe_calculated = f"{session_pe:.2f}"
                        else:
                            # EMERGENCY FALLBACK: Calculate PE directly from portfolio config (like performance does)
                            if active_portfolio and 'stocks' in active_portfolio:
                                portfolio_tickers = [stock['ticker'] for stock in active_portfolio['stocks'] if stock.get('ticker')]
                                portfolio_allocations = {stock['ticker']: stock.get('allocation', 0) for stock in active_portfolio['stocks'] if stock.get('ticker')}
                                
                                if portfolio_tickers:
                                    # Fetch fresh info for portfolio tickers
                                    portfolio_info = get_multiple_tickers_info_batch(portfolio_tickers)
                                    
                                    # Calculate weighted PE
                                    total_weighted_pe = 0.0
                                    total_weight = 0.0
                                    valid_pe_count = 0
                                    
                                    for ticker in portfolio_tickers:
                                        weight = portfolio_allocations.get(ticker, 0)
                                        if weight <= 0:
                                            continue
                                            
                                        info = portfolio_info.get(ticker, {})
                                        pe = info.get('trailingPE')
                                        
                                        if pe is not None and pe > 0 and pe <= 1000:
                                            total_weighted_pe += pe * weight
                                            total_weight += weight
                                            valid_pe_count += 1
                                    
                                    if total_weight > 0 and valid_pe_count > 0:
                                        weighted_pe = total_weighted_pe / total_weight
                                        portfolio_pe_calculated = f"{weighted_pe:.2f}"
                    else:
                        pass
                    
                    # Fallback to df_comprehensive if available (but this is secondary)
                    if portfolio_pe_calculated == 'N/A' and hasattr(st.session_state, 'df_comprehensive') and st.session_state.df_comprehensive is not None:
                        df_comp = st.session_state.df_comprehensive
                        if not df_comp.empty and 'P/E Ratio' in df_comp.columns and '% of Portfolio' in df_comp.columns:
                            # Convert PE Ratio to numeric, replacing 'N/A' with NaN
                            pe_numeric = pd.to_numeric(df_comp['P/E Ratio'], errors='coerce')
                            
                            # Convert % of Portfolio to numeric, handling percentage strings like '24.83%'
                            portfolio_pct_str = df_comp['% of Portfolio'].astype(str)
                            portfolio_pct_numeric = portfolio_pct_str.str.replace('%', '').apply(pd.to_numeric, errors='coerce')
                            
                            # Apply same logic as weighted_average function
                            valid_mask = pe_numeric.notna() & portfolio_pct_numeric.notna()
                            valid_mask = valid_mask & (pe_numeric > 0) & (pe_numeric <= 1000)
                            
                            if valid_mask.sum() > 0:
                                valid_pe_numeric = pe_numeric[valid_mask]
                                valid_portfolio_pct = portfolio_pct_numeric[valid_mask]
                                
                                # Calculate weighted average (weights are already in percentage)
                                weighted_pe = (valid_pe_numeric * valid_portfolio_pct / 100).sum() / (valid_portfolio_pct.sum() / 100)
                                portfolio_pe_calculated = f"{weighted_pe:.2f}"
                            else:
                                pass
                        else:
                            pass
                    else:
                        # TEMPORARY: Check if we have session state PE as fallback
                        session_pe = getattr(st.session_state, 'portfolio_pe', None)
                        if session_pe is not None and not pd.isna(session_pe):
                            portfolio_pe_calculated = f"{session_pe:.2f}"
                        else:
                            pass
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    pass
                # Calculate Volatility and Beta EXACTLY like the first table
                portfolio_volatility = 'N/A'
                portfolio_beta = 'N/A'
                last_365_days = None
                try:
                    # Use backtest data for volatility - align with SPY dates to match benchmarks
                    all_results = st.session_state.get('alloc_all_results', {})
                    if active_name in all_results:
                        portfolio_result = all_results[active_name]
                        total_series = portfolio_result.get('no_additions', None)
                        if total_series is not None and len(total_series) > 60:
                            # Get SPY data to align dates (same trading days as benchmarks)
                            spy_reference = None
                            # Get available_data from function scope (passed as parameter)
                            if 'available_data' in locals() and available_data and 'SPY' in available_data and not available_data['SPY'].empty:
                                spy_reference = available_data['SPY'].copy()
                                spy_reference.index = pd.to_datetime(spy_reference.index)
                            else:
                                # Fallback: try to get from raw_data
                                raw_data = st.session_state.get('alloc_raw_data', {})
                                if raw_data and 'SPY' in raw_data and not raw_data['SPY'].empty:
                                    spy_reference = raw_data['SPY'].copy()
                                    spy_reference.index = pd.to_datetime(spy_reference.index)
                            
                            # Use last 365 calendar days (backtest has ffill so includes weekends)
                            try:
                                portfolio_series = total_series.copy()
                                portfolio_series.index = pd.to_datetime(portfolio_series.index)
                                # Simple: last 365 calendar days from the last date
                                start_date = portfolio_series.index[-1] - pd.Timedelta(days=365)
                                portfolio_window = portfolio_series.loc[start_date:]
                                
                                # Align with SPY trading days if available (like beta does)
                                if spy_reference is not None and len(spy_reference) > 0:
                                    # Get SPY dates in the same period
                                    spy_window = spy_reference['Close'].loc[start_date:] if 'Close' in spy_reference.columns else None
                                    if spy_window is not None and len(spy_window) > 0:
                                        # Align portfolio to SPY trading days (same as beta logic)
                                        portfolio_aligned = portfolio_window.reindex(spy_window.index, method='ffill')
                                        portfolio_returns_series = portfolio_aligned.pct_change().dropna()
                                        
                                        # Only use dates where both have data
                                        common_dates = portfolio_returns_series.index.intersection(spy_window.index)
                                        if len(common_dates) >= 60:
                                            portfolio_returns_series = portfolio_returns_series.reindex(common_dates).dropna()
                                else:
                                    # Fallback: use all portfolio dates
                                    portfolio_returns_series = portfolio_window.pct_change().dropna()
                                
                                if len(portfolio_returns_series) >= 60:  # Allow some flexibility
                                    # Annualize using 365.25 for consistency with benchmarks
                                    portfolio_vol = portfolio_returns_series.std() * np.sqrt(365.25) * 100
                                    portfolio_volatility = f"{portfolio_vol:.2f}%"
                                    
                                    # Store window for beta calculation
                                    last_365_days = portfolio_window
                                else:
                                    # Fallback to old method if not enough data
                                    if len(total_series) > 365:
                                        last_365_days = total_series.tail(365)
                                        returns = last_365_days.pct_change().dropna()
                                        if len(returns) > 1:
                                            vol = calculate_volatility(returns)
                                            if not np.isnan(vol):
                                                portfolio_volatility = f"{vol * 100:.2f}%"
                            except Exception:
                                # Fallback: use old method if datetime conversion fails
                                if len(total_series) > 365:
                                    last_365_days = total_series.tail(365)
                                    returns = last_365_days.pct_change().dropna()
                                    if len(returns) > 1:
                                        vol = calculate_volatility(returns)
                                        if not np.isnan(vol):
                                            portfolio_volatility = f"{vol * 100:.2f}%"
                        elif total_series is not None and len(total_series) > 365:
                            # Fallback: use old method if series is too short for calendar method
                            last_365_days = total_series.tail(365)
                            returns = last_365_days.pct_change().dropna()
                            if len(returns) > 1:
                                vol = calculate_volatility(returns)
                                if not np.isnan(vol):
                                    portfolio_volatility = f"{vol * 100:.2f}%"
                        
                        # Calculate beta against benchmark ticker (same logic for all cases)
                        if last_365_days is not None:
                            try:
                                benchmark_ticker = active_portfolio.get('benchmark_ticker', '^GSPC')
                                benchmark_data_beta = None
                                raw_data = st.session_state.get('alloc_raw_data', {})
                                
                                if benchmark_ticker in raw_data and not raw_data[benchmark_ticker].empty:
                                    benchmark_data_beta = raw_data[benchmark_ticker]
                                elif benchmark_ticker in all_results:
                                    benchmark_data_beta = all_results[benchmark_ticker]
                                
                                if benchmark_data_beta is not None and isinstance(benchmark_data_beta, pd.DataFrame) and 'Close' in benchmark_data_beta.columns:
                                    benchmark_series = benchmark_data_beta['Close']
                                    benchmark_series_filled = benchmark_series.reindex(last_365_days.index, method='ffill')
                                    portfolio_aligned = last_365_days.reindex(benchmark_series_filled.index).dropna()
                                    benchmark_aligned = benchmark_series_filled.reindex(portfolio_aligned.index).dropna()
                                    
                                    if len(portfolio_aligned) > 1 and len(benchmark_aligned) > 1:
                                        portfolio_returns = portfolio_aligned.pct_change().fillna(0)
                                        benchmark_returns = benchmark_aligned.pct_change().fillna(0)
                                        common_idx = portfolio_returns.index.intersection(benchmark_returns.index)
                                        if len(common_idx) >= 2:
                                            pr = portfolio_returns.reindex(common_idx).dropna()
                                            br = benchmark_returns.reindex(common_idx).dropna()
                                            common_idx2 = pr.index.intersection(br.index)
                                            if len(common_idx2) >= 2 and br.loc[common_idx2].var() != 0:
                                                cov = pr.loc[common_idx2].cov(br.loc[common_idx2])
                                                var = br.loc[common_idx2].var()
                                                beta = cov / var
                                                if not np.isnan(beta):
                                                    portfolio_beta = f"{beta:.2f}"
                            except Exception:
                                pass
                except Exception:
                    pass
                
                portfolio_returns_dict['PE'] = portfolio_pe_calculated
                portfolio_returns_dict['Volatility'] = portfolio_volatility
                portfolio_returns_dict['Beta'] = portfolio_beta
                
                benchmark_data.append(portfolio_returns_dict)
                
                # Calculate returns for all available benchmarks
                for ticker in benchmark_tickers:
                    if ticker not in available_data:
                        continue
                    
                    df = available_data[ticker]
                    if df is None or 'Close' not in df.columns:
                        continue
                    
                    ticker_returns = {'Ticker': ticker}
                    
                    # Get PE ratio for this benchmark ticker from preloaded info
                    ticker_pe = 'N/A'
                    try:
                        info = preloaded_info.get(ticker, {})
                        ticker_pe = _format_trailing_pe_for_display(info)
                        if ticker_pe == 'N/A':
                            try:
                                fallback_info = get_ticker_info(ticker)
                                ticker_pe = _format_trailing_pe_for_display(fallback_info)
                            except Exception:
                                ticker_pe = 'N/A'
                    except Exception:
                        pass
                    
                    ticker_returns['PE'] = ticker_pe
                    
                    # Ensure datetime index
                    df_local = df.copy()
                    df_local.index = pd.to_datetime(df_local.index)
                    for period_name, days in periods.items():
                        try:
                            current_price = df_local['Close'].iloc[-1]
                            past_price = get_value_days_ago(df_local['Close'], days)
                            if past_price is not None and past_price > 0:
                                return_pct = ((current_price - past_price) / past_price) * 100
                                ticker_returns[period_name] = f"{return_pct:+.2f}%"
                            else:
                                ticker_returns[period_name] = 'N/A'
                        except Exception:
                            ticker_returns[period_name] = 'N/A'
                    
                    # Calculate Volatility and Beta for this ticker (last 365 calendar days)
                    ticker_volatility = 'N/A'
                    ticker_beta = 'N/A'
                    try:
                        if len(df) >= 60:  # Allow flexibility for weekends/holidays
                            # Use last 365 calendar days (same as performance calculations)
                            df_local = df.copy()
                            df_local.index = pd.to_datetime(df_local.index)
                            start_date = df_local.index[-1] - pd.Timedelta(days=365)
                            ticker_window = df_local['Close'].loc[start_date:]
                            ticker_returns_series = ticker_window.pct_change().dropna()
                            if len(ticker_returns_series) >= 60:  # Allow some flexibility
                                # Annualize using 365 for consistency
                                ticker_vol = ticker_returns_series.std() * np.sqrt(365.25) * 100
                                ticker_volatility = f"{ticker_vol:.2f}%"
                                
                                if ticker == 'SPY':
                                    ticker_beta = "1.00"
                                elif 'SPY' in available_data and not available_data['SPY'].empty:
                                    spy_data = available_data['SPY'].copy()
                                    if 'Close' in spy_data.columns and len(spy_data) >= 60:
                                        spy_data.index = pd.to_datetime(spy_data.index)
                                        spy_close = spy_data['Close']
                                        spy_ret_window = spy_close.loc[start_date:]
                                        spy_returns = spy_ret_window.pct_change().dropna()
                                        # Align on common dates
                                        common_idx = ticker_returns_series.index.intersection(spy_returns.index)
                                        if len(common_idx) >= 60:
                                            ticker_ret = ticker_returns_series.reindex(common_idx).dropna()
                                            spy_ret = spy_returns.reindex(common_idx).dropna()
                                            
                                            # Simple beta = correlation * (ticker_vol / market_vol)
                                            correlation = ticker_ret.corr(spy_ret)
                                            ticker_vol = ticker_ret.std()
                                            spy_vol = spy_ret.std()
                                            
                                            if spy_vol > 0 and not np.isnan(correlation):
                                                beta = correlation * (ticker_vol / spy_vol)
                                                ticker_beta = f"{beta:.2f}"
                                            else:
                                                ticker_beta = "1.00"
                    except Exception:
                        pass
                    
                    ticker_returns['Volatility'] = ticker_volatility
                    ticker_returns['Beta'] = ticker_beta
                    benchmark_data.append(ticker_returns)
                
                if benchmark_data:
                    df_benchmark = pd.DataFrame(benchmark_data)
                    # Reorder columns to put Ticker first, then PE, then periods, then Volatility and Beta at the end
                    period_cols = [col for col in df_benchmark.columns if col not in ['Ticker', 'PE', 'Volatility', 'Beta']]
                    columns = ['Ticker', 'PE'] + period_cols + ['Volatility', 'Beta']
                    df_benchmark = df_benchmark[columns]
                    return df_benchmark
                
            except Exception as e:
                pass
                return None
        
        # Get available data for benchmark calculations
        snapshot = st.session_state.get('alloc_snapshot_data', {})
        raw_data = snapshot.get('raw_data') if snapshot and snapshot.get('raw_data') is not None else st.session_state.get('alloc_raw_data', {})
        
        # Prepare available_data for benchmark calculations
        available_data = {}
        benchmark_tickers = ['SPY', 'QQQ', 'SPMO', 'VTI', 'VT', 'SSO', 'QLD', 'BITCOIN']
        
        for ticker in benchmark_tickers:
            if raw_data and ticker in raw_data and not raw_data[ticker].empty:
                available_data[ticker] = raw_data[ticker].copy()
        
        # Download missing benchmarks if needed
        missing_tickers = [ticker for ticker in benchmark_tickers if ticker not in available_data]
        if missing_tickers:
            try:
                # Handle BITCOIN specially
                if 'BITCOIN' in missing_tickers:
                    try:
                        from Complete_Tickers.BITCOIN_COMPLETE_TICKER import create_bitcoin_complete_ticker
                        bitcoin_data = create_bitcoin_complete_ticker()
                        if bitcoin_data is not None and not bitcoin_data.empty:
                            available_data['BITCOIN'] = bitcoin_data
                        missing_tickers.remove('BITCOIN')
                    except Exception:
                        pass
                
                # Download other missing tickers
                if missing_tickers:
                    import yfinance as yf
                    batch_data = get_batch_download_with_cache(missing_tickers, period="2y", interval="1d", progress=False, group_by='ticker')
                    if not batch_data.empty:
                        for ticker in missing_tickers:
                            if ticker in batch_data.columns.get_level_values(0):
                                df = batch_data[ticker].copy()
                                if df is not None and not df.empty and 'Close' in df.columns:
                                    available_data[ticker] = df
            except Exception:
                pass
        
        # Preload benchmark ticker info BEFORE calculating returns to ensure PE ratios are available immediately
        # NUCLEAR OPTION: Portfolio PE is already calculated and stored in session state, no need to preload portfolio tickers!
        benchmark_tickers_to_preload = ['SPY', 'QQQ', 'SPMO', 'VTI', 'VT', 'SSO', 'QLD', 'BITCOIN']
        preloaded_benchmark_info = get_multiple_tickers_info_batch(benchmark_tickers_to_preload)
        
        # DEBUG: Show API calls after benchmark PE data download
        # st.info(f"🔍 **DEBUG**: After benchmark PE data download - Total API calls so far: **{st.session_state.get('api_call_count', 0)}**")
        
        benchmark_df = calculate_benchmark_returns(available_data, preloaded_benchmark_info)
        if benchmark_df is not None and not benchmark_df.empty:
            try:
                st.session_state['benchmark_comparison_df'] = benchmark_df.copy()
            except Exception:
                pass
            # Style the dataframe
            styled_benchmark = benchmark_df.style
            
            # Apply coloring to each column separately
            for col in benchmark_df.columns:
                if col == 'PE':
                    def style_pe(val):
                        if isinstance(val, str) and val != 'N/A' and not val.endswith('%'):
                            try:
                                pe_val = float(val)
                                if pe_val >= 35:
                                    return 'color: #ff4444; font-weight: bold'  # Red for PE >= 35 (Overvalued)
                                elif pe_val >= 25:
                                    return 'color: #ffaa00; font-weight: bold'  # Orange for PE 25-35 (Expensive)
                                elif pe_val >= 15:
                                    return 'color: #00ff00; font-weight: bold'  # Green for PE 15-25 (Fair Value)
                                else:
                                    return 'color: #00ff00; font-weight: bold'  # Green for PE < 15 (Undervalued)
                            except:
                                pass
                        return ''
                    styled_benchmark = styled_benchmark.applymap(style_pe, subset=[col])
                elif col not in ['Ticker', 'Beta', 'Volatility']:
                    def style_returns(val):
                        if isinstance(val, str) and val.endswith('%'):
                            try:
                                num_val = float(val.replace('%', '').replace('+', ''))
                                if num_val > 0:
                                    return 'color: #00ff00; font-weight: bold'
                                elif num_val < 0:
                                    return 'color: #ff4444; font-weight: bold'
                            except:
                                pass
                        return ''
                    styled_benchmark = styled_benchmark.applymap(style_returns, subset=[col])
            
            # Highlight the PORTFOLIO row in benchmark table
            def highlight_benchmark_portfolio_row(row):
                if 'PORTFOLIO' in row['Ticker']:
                    return ['background-color: #333333; font-weight: bold; border: 2px solid #ffff00' for _ in row]
                return ['' for _ in row]
            
            # Apply row highlighting
            styled_benchmark = styled_benchmark.apply(highlight_benchmark_portfolio_row, axis=1)
            
            # Add custom CSS for uniform column widths
            st.markdown("""
            <style>
            /* Uniform column widths for Benchmark Comparison table */
            .stDataFrame table {
                table-layout: fixed !important;
                width: 100% !important;
            }
            .stDataFrame table th:nth-child(1),
            .stDataFrame table td:nth-child(1) {
                width: 15% !important; /* Ticker column */
            }
            .stDataFrame table th:nth-child(2),
            .stDataFrame table td:nth-child(2) {
                width: 8% !important; /* PE column */
            }
            .stDataFrame table th:nth-child(n+3),
            .stDataFrame table td:nth-child(n+3) {
                width: 11% !important; /* Period columns (7 columns = 77% / 7) */
            }
            </style>
            """, unsafe_allow_html=True)
            
            st.dataframe(styled_benchmark, )
        else:
            st.info("Benchmark data not available.")
        
        st.markdown("---")
        st.markdown("### Shares if Rebalanced Today (Snapshot)")
        st.caption("Current allocation weights converted to actual share quantities at today's prices")
        build_table_from_alloc({**today_weights, 'CASH': today_weights.get('CASH', 0)}, None, "")

        # ======================
        # AI Analysis (LLM) — placed after Shares Snapshot (same as page 5)
        # ======================
        try:
            st.markdown("---")
            st.subheader("🤖 AI Analysis (LLM) — Target Allocation Today")
            st.caption("Qualitative/sector assessment over the current target selection and weights.")
            st.markdown(
                """
                <style>
                div[data-testid='stDataFrame'] div[role='gridcell'] {
                    white-space: normal !important;
                    overflow: visible !important;
                    text-overflow: clip !important;
                }
                div[data-testid='stDataFrame'] { width: 100% !important; }
                </style>
                """,
                unsafe_allow_html=True,
            )

            snapshot = st.session_state.get('alloc_snapshot_data', {}) or {}
            today_weights_map = snapshot.get('today_weights_map', {}) or {}
            portfolio_list = snapshot.get('portfolio_configs', []) or []
            all_metrics = snapshot.get('all_metrics', {}) or {}

            if today_weights_map:
                names = list(today_weights_map.keys())
                active_name = st.session_state.get('alloc_portfolio_configs', [{}])[st.session_state.get('alloc_active_portfolio_index', 0)].get('name') if st.session_state.get('alloc_portfolio_configs') else None
                default_idx = names.index(active_name) if active_name in names else 0
                sel_name = st.selectbox("Portfolio to analyze", names, index=default_idx)

                def build_payload(port_name):
                    cfg = next((c for c in portfolio_list if c.get('name') == port_name), {})
                    weights = today_weights_map.get(port_name, {})
                    metrics_map = all_metrics.get(port_name, {})
                    final_date = max(metrics_map.keys()) if metrics_map else None
                    metrics_on_final = metrics_map.get(final_date, {}) if final_date else {}
                    items = []
                    for t, w in weights.items():
                        if t and t != 'CASH' and w > 0:
                            item = {'ticker': t, 'weight': float(w)}
                            m = metrics_on_final.get(t, {}) if isinstance(metrics_on_final, dict) else {}
                            for k in ['Momentum', 'Beta', 'Volatility']:
                                if k in m and m[k] is not None:
                                    try:
                                        item[k.lower()] = float(m[k])
                                    except Exception:
                                        pass
                            items.append(item)
                    return {
                        'portfolio_name': port_name,
                        'as_of': str(final_date) if final_date else None,
                        'rebalancing_frequency': cfg.get('rebalancing_frequency'),
                        'benchmark': cfg.get('benchmark_ticker'),
                        'use_momentum': bool(cfg.get('use_momentum', True)),
                        'momentum_strategy': cfg.get('momentum_strategy'),
                        'constraints': {
                            'use_equal_weight': cfg.get('use_equal_weight'),
                            'equal_weight_n_tickers': cfg.get('equal_weight_n_tickers'),
                            'use_limit_to_top_n': cfg.get('use_limit_to_top_n'),
                            'limit_to_top_n_tickers': cfg.get('limit_to_top_n_tickers'),
                            'use_sector_concentration_limit': cfg.get('use_sector_concentration_limit'),
                            'max_tickers_per_sector': cfg.get('max_tickers_per_sector'),
                            'use_industry_concentration_limit': cfg.get('use_industry_concentration_limit'),
                            'max_tickers_per_industry': cfg.get('max_tickers_per_industry'),
                            'unknown_counts_as_category': cfg.get('unknown_counts_as_category'),
                            'exclude_before_sp500_entry': cfg.get('exclude_before_sp500_entry'),
                            'use_min_market_cap_filter': cfg.get('use_min_market_cap_filter'),
                            'min_market_cap_billions': cfg.get('min_market_cap_billions'),
                            'use_max_allocation': cfg.get('use_max_allocation'),
                            'max_allocation_percent': cfg.get('max_allocation_percent'),
                            'use_minimal_threshold': cfg.get('use_minimal_threshold'),
                            'minimal_threshold_percent': cfg.get('minimal_threshold_percent'),
                        },
                        'selection': items,
                    }

                # Optional additional instructions/context for the AI
                extra_notes = st.text_area(
                    "Additional instructions to AI (optional)",
                    value=st.session_state.get('alloc_ai_extra_notes', ""),
                    help="Any extra guidance, caveats, or ticker clarifications you want the AI to consider.")
                st.session_state['alloc_ai_extra_notes'] = extra_notes

                payload = build_payload(sel_name)
                if extra_notes.strip():
                    payload['user_notes'] = extra_notes.strip()

                # Attach optional AI data payloads (parity with Page 5)
                st.markdown("**Attach data for AI (optional):**")
                c1, c2, c3 = st.columns(3)
                with c1:
                    include_ai_tables = st.checkbox(
                        "Comprehensive Data (5 tables)",
                        value=st.session_state.get('alloc_include_ai_tables', False),
                        key="alloc_include_ai_tables_ai"
                    )
                with c2:
                    include_ai_summary = st.checkbox(
                        "Weighted Summary Stats",
                        value=st.session_state.get('alloc_include_ai_summary', False),
                        key="alloc_include_ai_summary_ai"
                    )
                with c3:
                    include_ai_compo = st.checkbox(
                        "Composition (sectors/industries)",
                        value=st.session_state.get('alloc_include_ai_composition', False),
                        key="alloc_include_ai_composition_ai"
                    )

                # Build payloads from session data on demand
                if include_ai_tables:
                    try:
                        tables_payload = {
                            'overview': st.session_state.get('df_overview', pd.DataFrame()).to_dict(orient='records') if 'df_overview' in st.session_state else [],
                            'valuation': st.session_state.get('df_valuation', pd.DataFrame()).to_dict(orient='records') if 'df_valuation' in st.session_state else [],
                            'financial_health': st.session_state.get('df_health', pd.DataFrame()).to_dict(orient='records') if 'df_health' in st.session_state else [],
                            'growth_dividends': st.session_state.get('df_growth', pd.DataFrame()).to_dict(orient='records') if 'df_growth' in st.session_state else [],
                            'technical': st.session_state.get('df_technical', pd.DataFrame()).to_dict(orient='records') if 'df_technical' in st.session_state else [],
                        }
                        payload['comprehensive_data'] = tables_payload
                    except Exception as _e:
                        st.warning(f"AI tables unavailable: {_e}")

                if include_ai_summary:
                    try:
                        df = st.session_state.get('ai_summary_df', pd.DataFrame())
                        payload['portfolio_weighted_summary'] = df.to_dict(orient='records') if not df.empty else []
                    except Exception as _e:
                        st.warning(f"AI summary unavailable: {_e}")

                if include_ai_compo:
                    try:
                        sectors = st.session_state.get('sector_data', pd.Series(dtype=float))
                        industries = st.session_state.get('industry_data', pd.Series(dtype=float))
                        payload['portfolio_composition'] = {
                            'sectors': [{'sector': str(k), 'allocation_pct': float(v)} for k, v in (sectors.items() if hasattr(sectors, 'items') else [])],
                            'industries': [{'industry': str(k), 'allocation_pct': float(v)} for k, v in (industries.items() if hasattr(industries, 'items') else [])],
                        }
                    except Exception as _e:
                        st.warning(f"AI composition unavailable: {_e}")

                with st.expander("See payload sent to AI", expanded=False):
                    import json as _json
                    st.code(_json.dumps(payload, indent=2), language='json')

                # Provider + Model selection (with custom override)
                prov_col, sec_col = st.columns([1,1])
                with prov_col:
                    provider = st.selectbox(
                        "Provider",
                        ["Google Gemini", "OpenAI", "DeepSeek"],
                        index=0
                    )
                # Persist ultra secure checkbox state per provider (session + disk)
                import diskcache as _dc
                _state_cache = _dc.Cache('.streamlit/ai_cache')
                _ultra_key = f"ultra_secure:{provider}"
                _ultra_default = _state_cache.get(_ultra_key)
                if _ultra_default is None:
                    _ultra_default = True
                _ultra_ss_key = f"alloc_ultra_secure_{provider}"
                if _ultra_ss_key not in st.session_state:
                    st.session_state[_ultra_ss_key] = bool(_ultra_default)
                with sec_col:
                    ultra_secure = st.checkbox("Ultra secure (no cache)", key=_ultra_ss_key)
                try:
                    _state_cache.set(_ultra_key, bool(ultra_secure))
                except Exception:
                    pass

                # Suggestion: Google AI Studio API keys (free daily quota, refreshed daily)
                st.info(
                    "For quick testing, you can use Google AI Studio API keys — free with a daily quota and refreshed each day. "
                    "Create/manage at [Google AI Studio — API Keys](https://aistudio.google.com/api-keys)."
                )

                # Model presets per provider
                if provider == "Google Gemini":
                    preset_models = [
                        "gemini-2.5-pro",
                        "gemini-2.5-flash",
                        "gemini-2.5-flash-lite",
                        "gemini-2.0-flash",
                        "gemini-2.0-flash-lite",
                        "gemini-2.5-flash-tts",
                        "gemini-2.0-flash-exp",
                        "gemini-2.0-flash-preview-image-generation",
                        "gemini-2.0-flash-live",
                        "gemini-2.5-flash-live",
                        "gemini-2.5-flash-native-audio-dialog",
                        "learnlm-2.0-flash-experimental",
                        "imagen-3.0-generate",
                        "veo-2.0-generate-001",
                    ]
                    gemini_limits = {
                        "gemini-2.5-pro": {"RPM":"~2", "TPM":"~125K", "RPD":"~50", "note":"Highest reasoning quality; higher cost."},
                        "gemini-2.5-flash": {"RPM":"~10", "TPM":"~250K", "RPD":"~250", "note":"Great balance of performance and cost."},
                        "gemini-2.5-flash-lite": {"RPM":"~15", "TPM":"~250K", "RPD":"~1K", "note":"Fast and economical for volume."},
                        "gemini-2.5-flash-tts": {"RPM":"~3", "TPM":"~10K", "RPD":"~15", "note":"Text-to-speech."},
                        "gemini-2.0-flash": {"RPM":"~15", "TPM":"~1M", "RPD":"~200", "note":"Very high TPM; fast and low-cost."},
                        "gemini-2.0-flash-lite": {"RPM":"~30", "TPM":"~1M", "RPD":"~200", "note":"Maximum throughput; low cost."},
                        "gemini-2.0-flash-exp": {"RPM":"~10", "TPM":"~250K", "RPD":"~50", "note":"Experimental."},
                        "gemini-2.0-flash-preview-image-generation": {"RPM":"~10", "TPM":"~200K", "RPD":"~100", "note":"Image generation."},
                        "gemini-2.0-flash-live": {"RPM":"Live", "TPM":"~1M", "RPD":"∞", "note":"Streaming live."},
                        "gemini-2.5-flash-live": {"RPM":"Live", "TPM":"~1M", "RPD":"∞", "note":"Streaming live (2.5)."},
                        "gemini-2.5-flash-native-audio-dialog": {"RPM":"~?", "TPM":"~1M", "RPD":"∞", "note":"Native audio dialog."},
                        "learnlm-2.0-flash-experimental": {"RPM":"~15", "TPM":"N/A", "RPD":"~1.5K", "note":"Learning-oriented; experimental."},
                        "imagen-3.0-generate": {"RPM":"N/A", "TPM":"N/A", "RPD":"~25", "note":"High-quality image generation."},
                        "veo-2.0-generate-001": {"RPM":"N/A", "TPM":"N/A", "RPD":"~20", "note":"Video generation (Veo)."},
                    }
                    api_label = "GEMINI_API_KEY"
                elif provider == "OpenAI":
                    preset_models = ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-3.5-turbo"]
                    api_label = "OPENAI_API_KEY"
                else:
                    preset_models = ["deepseek-chat", "deepseek-reasoner"]
                    api_label = "DEEPSEEK_API_KEY"

                # API key handling with optional 2h cache when not ultra secure (never hide UI)
                _key_cache = _dc.Cache('.streamlit/ai_cache')
                _key_cache_key = f"api_key:{provider}"
                _cached_key = _key_cache.get(_key_cache_key)
                # If user just toggled to ultra secure, clear any cached key immediately
                _ultra_prev_key = f"{_ultra_ss_key}_prev"
                _prev_val = st.session_state.get(_ultra_prev_key, None)
                if _prev_val is not None and (not _prev_val) and ultra_secure:
                    try:
                        _key_cache.delete(_key_cache_key)
                        _cached_key = None
                        st.info("Ultra secure enabled — cached API key cleared.")
                    except Exception:
                        pass
                st.session_state[_ultra_prev_key] = bool(ultra_secure)
                key_col1, key_col2, key_col3 = st.columns([2,1,1])
                with key_col1:
                    if ultra_secure:
                        api_key_input = st.text_input(api_label, value="", type="password", help="Key not stored. No cache.")
                    else:
                        api_key_input = st.text_input(api_label, value=_cached_key or "", type="password", help="Key cached locally for 2 hours.")
                with key_col2:
                    if ultra_secure:
                        st.info("Ultra secure mode: key is not cached")
                    else:
                        st.warning("Key will be cached for 2 hours. Don't forget to clear.")
                with key_col3:
                    if not ultra_secure:
                        if st.button("Clear API key cache"):
                            try:
                                _key_cache.delete(_key_cache_key)
                            except Exception:
                                pass
                            st.session_state['alloc_ai_key_cache_cleared'] = True
                            _cached_key = None
                # Immediately cache entered key when not ultra secure
                if (not ultra_secure) and api_key_input:
                    if api_key_input != _cached_key:
                        try:
                            _key_cache.set(_key_cache_key, api_key_input, expire=7200)
                            _cached_key = api_key_input
                        except Exception:
                            pass
                # Live cache presence message after actions
                if ultra_secure:
                    st.info("Ultra secure mode active — no key is cached.")
                else:
                    if _cached_key:
                        st.success("Cached API key is active for this provider (2 hours).")
                    else:
                        st.info("No cached API key for this provider.")

                colA, colB = st.columns([1,1])
                with colA:
                    if provider == "Google Gemini":
                        _default_model = st.session_state.get('alloc_ai_last_gemini_model', 'gemini-2.5-flash')
                    elif provider == "OpenAI":
                        _default_model = st.session_state.get('alloc_ai_last_openai_model', 'gpt-4o-mini')
                    else:
                        _default_model = st.session_state.get('alloc_ai_last_deepseek_model', 'deepseek-chat')
                    _default_idx = preset_models.index(_default_model) if _default_model in preset_models else 0
                    model_choice = st.selectbox("Model", preset_models, index=_default_idx)
                with colB:
                    custom_model = st.text_input("Custom model (optional)", value="")

                if provider == "Google Gemini":
                    chosen_key = (custom_model.strip() if custom_model.strip() else model_choice)
                    info = gemini_limits.get(chosen_key, None)
                    if info:
                        st.markdown(
                            f"**Limits** — RPM: {info['RPM']} • TPM: {info['TPM']} • RPD: {info['RPD']}  ")
                        st.caption(f"Note: {info['note']}")
                    with st.expander("Which model should I choose?", expanded=False):
                        st.markdown(
                            "- **Highest quality/reasoning**: gemini-2.5-pro\n"
                            "- **Balanced perf/cost**: gemini-2.5-flash\n"
                            "- **Low cost / high throughput**: gemini-2.0-flash-lite (or 2.0-flash)\n"
                            "- **Image generation**: gemini-2.0-flash-preview-image-generation / imagen-3.0-generate\n"
                            "- **TTS**: gemini-2.5-flash-tts\n"
                            "- **Streaming live**: gemini-2.0-flash-live / gemini-2.5-flash-live\n"
                            "- **Experimental**: gemini-2.0-flash-exp / learnlm-2.0-flash-experimental"
                        )

                model_name = custom_model.strip() if custom_model.strip() else model_choice
                run_ai = st.button("Analyze", type="primary")

                if (not run_ai) and st.session_state.get('alloc_ai_last_text'):
                    st.markdown("### Last AI analysis")
                    _meta = st.session_state.get('alloc_ai_last_meta', {})
                    if _meta:
                        st.caption(f"Provider: {_meta.get('provider','?')} • Model: {_meta.get('model','?')}")
                    _ai_text = st.session_state['alloc_ai_last_text']
                    import json as _json
                    _parsed = None
                    try:
                        _s = _ai_text.find('{'); _e = _ai_text.rfind('}')
                        if _s != -1 and _e != -1 and _e > _s:
                            _parsed = _json.loads(_ai_text[_s:_e+1])
                    except Exception:
                        _parsed = None
                    if _parsed:
                        st.success(f"Overall Score: {_parsed.get('overall_score','N/A')}")
                        if _parsed.get('overall_comment'):
                            st.write(_parsed.get('overall_comment'))
                        _tlist = _parsed.get('tickers', []) or []
                        if _tlist:
                            import pandas as _pd
                            _df = _pd.DataFrame(_tlist)
                            try:
                                st.data_editor(
                                    _df,
                                    hide_index=True,
                                    use_container_width=True,
                                    disabled=True,
                                    column_config={
                                        "comment": st.column_config.TextColumn("comment", width=4000),
                                        "ticker": st.column_config.TextColumn("ticker", width=120),
                                        "score": st.column_config.NumberColumn("score", width=100),
                                    },
                                )
                            except Exception:
                                st.dataframe(_df, use_container_width=True)
                            with st.expander("Show full rows (all fields)", expanded=False):
                                for __row in _df.to_dict(orient="records"):
                                    st.markdown(f"**{__row.get('ticker','?')}** — score: {__row.get('score','?')}")
                                    _other = {k: v for k, v in __row.items() if k not in ['ticker','score']}
                                    for k, v in _other.items():
                                        st.markdown(f"- {k}: {v}")
                                    st.markdown("---")
                        _sugg = _parsed.get('suggestions', []) or []
                        if _sugg:
                            st.markdown("**Suggestions:**")
                            for s in _sugg:
                                st.markdown(f"- {s}")
                        _extra = _parsed.get('extra_insight') or _parsed.get('additional_insight') or _parsed.get('extra')
                        if _extra:
                            st.markdown("**Additional insight:**")
                            st.write(_extra)
                    else:
                        st.info("AI response (persisted, raw):")
                        st.write(_ai_text)

                if run_ai:
                    try:
                        import hashlib, os as _os
                        st.session_state['alloc_ai_last_text'] = None
                        st.session_state['alloc_ai_last_meta'] = None
                        api_key = None
                        if ultra_secure:
                            api_key = api_key_input
                        else:
                            # Prefer provided input, else cached, else env/secrets
                            api_key = api_key_input or _cached_key
                            if not api_key:
                                if provider == "Google Gemini":
                                    api_key = _os.getenv('GEMINI_API_KEY') or (st.secrets['GEMINI_API_KEY'] if 'GEMINI_API_KEY' in st.secrets else None)
                                elif provider == "OpenAI":
                                    api_key = _os.getenv('OPENAI_API_KEY') or (st.secrets['OPENAI_API_KEY'] if 'OPENAI_API_KEY' in st.secrets else None)
                                else:
                                    api_key = _os.getenv('DEEPSEEK_API_KEY') or (st.secrets['DEEPSEEK_API_KEY'] if 'DEEPSEEK_API_KEY' in st.secrets else None)
                            # If user entered a different key, cache it for 2 hours
                            try:
                                if api_key_input and api_key_input != _cached_key:
                                    _key_cache.set(_key_cache_key, api_key_input, expire=7200)
                            except Exception:
                                pass
                        if not api_key:
                            st.warning("Please configure the API key for the selected provider (env or st.secrets) or use Ultra secure mode.")
                        else:
                            prompt = (
                                "You are a portfolio analyst. Given a portfolio (target weights if rebalanced today), "
                                "provide: 1) a short qualitative assessment, 2) a per-ticker note, 3) an overall score (0-100), "
                                "4) per-ticker score (0-100) considering momentum fit, valuation, growth, sector context, risk, 5) suggested tweaks. "
                                "Focus on the given selection and constraints. If the user provides extra instructions or ticker clarifications, follow them. Return concise JSON with fields: "
                                "{overall_score:number, overall_comment:string, tickers:[{ticker, score, comment}], suggestions:[string], extra_insight:string}"
                            )
                            if extra_notes.strip():
                                prompt += f"\n\nAdditional user instructions to respect:\n{extra_notes.strip()}\n"
                            ai_text = None
                            with st.status("Analyzing with AI…", expanded=False) as __ai_status:
                                if provider == "Google Gemini":
                                    import google.generativeai as genai
                                    genai.configure(api_key=api_key)
                                    model = genai.GenerativeModel(model_name)
                                    if ultra_secure:
                                        resp = model.generate_content([
                                            {"role":"user","parts":[{"text":prompt}]},
                                            {"role":"user","parts":[{"text":str(payload)}]}
                                        ])
                                        ai_text = resp.text if hasattr(resp, 'text') else str(resp)
                                    else:
                                        import diskcache as _dc
                                        ai_cache = _dc.Cache('.streamlit/ai_cache')
                                        key_str = f"gemini:{model_name}:{payload}"
                                        cache_key = hashlib.sha256(key_str.encode('utf-8')).hexdigest()
                                        cached = ai_cache.get(cache_key)
                                        if cached:
                                            ai_text = cached
                                        else:
                                            resp = model.generate_content([
                                                {"role":"user","parts":[{"text":prompt}]},
                                                {"role":"user","parts":[{"text":str(payload)}]}
                                            ])
                                            ai_text = resp.text if hasattr(resp, 'text') else str(resp)
                                            ai_cache.set(cache_key, ai_text, expire=14400)
                                elif provider == "OpenAI":
                                    import requests
                                    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
                                    data = {
                                        "model": model_name,
                                        "response_format": {"type": "json_object"},
                                        "messages": [
                                            {"role": "system", "content": "You are a portfolio analyst."},
                                            {"role": "user", "content": prompt},
                                            {"role": "user", "content": str(payload)}
                                        ]
                                    }
                                    if ultra_secure:
                                        r = requests.post("https://api.openai.com/v1/chat/completions", headers=headers, json=data, timeout=60)
                                        r.raise_for_status()
                                        j = r.json()
                                        ai_text = (j.get("choices", [{}])[0].get("message", {}).get("content") or "")
                                    else:
                                        import diskcache as _dc
                                        ai_cache = _dc.Cache('.streamlit/ai_cache')
                                        key_str = f"openai:{model_name}:{payload}"
                                        cache_key = hashlib.sha256(key_str.encode('utf-8')).hexdigest()
                                        cached = ai_cache.get(cache_key)
                                        if cached:
                                            ai_text = cached
                                        else:
                                            r = requests.post("https://api.openai.com/v1/chat/completions", headers=headers, json=data, timeout=60)
                                            r.raise_for_status()
                                            j = r.json()
                                            ai_text = (j.get("choices", [{}])[0].get("message", {}).get("content") or "")
                                            ai_cache.set(cache_key, ai_text, expire=14400)
                                else:  # DeepSeek
                                    import requests
                                    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
                                    data = {
                                        "model": model_name,
                                        "messages": [
                                            {"role": "system", "content": "You are a portfolio analyst. Return concise JSON only."},
                                            {"role": "user", "content": prompt},
                                            {"role": "user", "content": str(payload)}
                                        ]
                                    }
                                    if ultra_secure:
                                        r = requests.post("https://api.deepseek.com/chat/completions", headers=headers, json=data, timeout=60)
                                        r.raise_for_status()
                                        j = r.json()
                                        ai_text = (j.get("choices", [{}])[0].get("message", {}).get("content") or "")
                                    else:
                                        import diskcache as _dc
                                        ai_cache = _dc.Cache('.streamlit/ai_cache')
                                        key_str = f"deepseek:{model_name}:{payload}"
                                        cache_key = hashlib.sha256(key_str.encode('utf-8')).hexdigest()
                                        cached = ai_cache.get(cache_key)
                                        if cached:
                                            ai_text = cached
                                        else:
                                            r = requests.post("https://api.deepseek.com/chat/completions", headers=headers, json=data, timeout=60)
                                            r.raise_for_status()
                                            j = r.json()
                                            ai_text = (j.get("choices", [{}])[0].get("message", {}).get("content") or "")
                                            ai_cache.set(cache_key, ai_text, expire=14400)
                                __ai_status.update(label="AI analysis complete", state="complete")

                            import json as _json
                            parsed = None
                            try:
                                start = ai_text.find('{')
                                end = ai_text.rfind('}')
                                if start != -1 and end != -1 and end > start:
                                    parsed = _json.loads(ai_text[start:end+1])
                            except Exception:
                                parsed = None

                            if parsed:
                                if provider == "Google Gemini":
                                    st.session_state['alloc_ai_last_gemini_model'] = model_name
                                elif provider == "OpenAI":
                                    st.session_state['alloc_ai_last_openai_model'] = model_name
                                else:
                                    st.session_state['alloc_ai_last_deepseek_model'] = model_name
                                st.session_state['alloc_ai_last_text'] = ai_text
                                st.session_state['alloc_ai_last_meta'] = {"provider": provider, "model": model_name}
                                st.success(f"Overall Score: {parsed.get('overall_score','N/A')}")
                                if parsed.get('overall_comment'):
                                    st.write(parsed.get('overall_comment'))
                                tlist = parsed.get('tickers', []) or []
                                if tlist:
                                    import pandas as _pd
                                    df_ai = _pd.DataFrame(tlist)
                                    try:
                                        st.data_editor(
                                            df_ai,
                                            hide_index=True,
                                            use_container_width=True,
                                            disabled=True,
                                            column_config={
                                                "comment": st.column_config.TextColumn("comment", width=4000),
                                                "ticker": st.column_config.TextColumn("ticker", width=120),
                                                "score": st.column_config.NumberColumn("score", width=100),
                                            },
                                        )
                                    except Exception:
                                        st.dataframe(df_ai, use_container_width=True)
                                    with st.expander("Show full comments", expanded=False):
                                        for _row in df_ai.to_dict(orient="records"):
                                            st.markdown(f"**{_row.get('ticker','?')}** — score: {_row.get('score','?')}")
                                            st.markdown(f"{_row.get('comment','')}\n\n---")
                                sugg = parsed.get('suggestions', []) or []
                                if sugg:
                                    st.markdown("**Suggestions:**")
                                    for s in sugg:
                                        st.markdown(f"- {s}")
                                extra = parsed.get('extra_insight') or parsed.get('additional_insight') or parsed.get('extra')
                                if extra:
                                    st.markdown("**Additional insight:**")
                                    st.write(extra)
                            else:
                                if provider == "Google Gemini":
                                    st.session_state['alloc_ai_last_gemini_model'] = model_name
                                elif provider == "OpenAI":
                                    st.session_state['alloc_ai_last_openai_model'] = model_name
                                else:
                                    st.session_state['alloc_ai_last_deepseek_model'] = model_name
                                st.session_state['alloc_ai_last_text'] = ai_text
                                st.session_state['alloc_ai_last_meta'] = {"provider": provider, "model": model_name}
                                st.info("AI response (raw):")
                                st.write(ai_text)
                    except Exception as e:
                        st.warning(f"AI error: {e}")
            else:
                st.info("No current allocation available. Please run an allocations backtest first.")
        except Exception:
            pass

    if allocs_for_portfolio:
        st.markdown("**Historical Allocations**")
        # Ensure proper DataFrame structure with explicit column names - FIXED LIKE PAGE 1
        # First, collect all tickers excluding None (EXACTLY LIKE PAGE 1)
        all_tickers = set()
        for date, alloc_dict in allocs_for_portfolio.items():
            for ticker in alloc_dict.keys():
                if ticker is not None:
                    all_tickers.add(ticker)
        
        # Create complete data structure with all tickers for all dates
        complete_data = {}
        for date, alloc_dict in allocs_for_portfolio.items():
            complete_data[date] = {ticker: alloc_dict.get(ticker, 0) for ticker in all_tickers}
        
        allocations_df_raw = pd.DataFrame(complete_data).T
        
        # Fill missing values with 0 for unavailable assets (EXACTLY LIKE PAGE 1)
        allocations_df_raw = allocations_df_raw.fillna(0)
        
        # Sort tickers with CASH always last (EXACTLY LIKE PAGE 1)
        ticker_list = sorted(list(all_tickers))
        if 'CASH' in ticker_list:
            ticker_list.remove('CASH')
            ticker_list.append('CASH')
        
        # Reorder DataFrame columns to match the desired order
        allocations_df_raw = allocations_df_raw[ticker_list]
        
        allocations_df_raw.index.name = "Date"

        def highlight_rows_by_index(s):
            is_even_row = allocations_df_raw.index.get_loc(s.name) % 2 == 0
            bg_color = 'background-color: #0e1117' if is_even_row else 'background-color: #262626'
            return [f'{bg_color}; color: white;'] * len(s)

        styler = allocations_df_raw.mul(100).style.apply(highlight_rows_by_index, axis=1)
        styler.format('{:,.0f}%', na_rep='N/A')
        
        # NUCLEAR OPTION: Inject custom CSS to override Streamlit's stubborn styling
        st.markdown("""
        <style>
        /* NUCLEAR CSS OVERRIDE - BEAT STREAMLIT INTO SUBMISSION */
        .stDataFrame [data-testid="stDataFrame"] div[data-testid="stDataFrame"] table td,
        .stDataFrame [data-testid="stDataFrame"] div[data-testid="stDataFrame"] table th,
        .stDataFrame table td,
        .stDataFrame table th {
            color: #FFFFFF !important;
            font-weight: bold !important;
            text-shadow: 1px 1px 2px black !important;
        }
        
        /* Force ALL text in dataframes to be white */
        .stDataFrame * {
            color: #FFFFFF !important;
        }
        
        /* Override any Streamlit bullshit */
        .stDataFrame [data-testid="stDataFrame"] *,
        .stDataFrame div[data-testid="stDataFrame"] * {
            color: #FFFFFF !important;
            font-weight: bold !important;
        }
        
        /* Target EVERYTHING in the dataframe */
        .stDataFrame table *,
        .stDataFrame div table *,
        .stDataFrame [data-testid="stDataFrame"] table *,
        .stDataFrame [data-testid="stDataFrame"] div table * {
            color: #FFFFFF !important;
            font-weight: bold !important;
        }
        
        /* Target all cells specifically */
        .stDataFrame td,
        .stDataFrame th,
        .stDataFrame table td,
        .stDataFrame table th {
            color: #FFFFFF !important;
            font-weight: bold !important;
        }
        
        /* Target Streamlit's specific elements */
        div[data-testid="stDataFrame"] table td,
        div[data-testid="stDataFrame"] table th,
        div[data-testid="stDataFrame"] div table td,
        div[data-testid="stDataFrame"] div table th {
            color: #FFFFFF !important;
            font-weight: bold !important;
        }
        
        /* Target everything with maximum specificity */
        div[data-testid="stDataFrame"] *,
        div[data-testid="stDataFrame"] div *,
        div[data-testid="stDataFrame"] table *,
        div[data-testid="stDataFrame"] div table * {
            color: #FFFFFF !important;
            font-weight: bold !important;
        }
        </style>
        """, unsafe_allow_html=True)
        
        st.dataframe(styler, )

    if metrics_for_portfolio:
        st.markdown("---")
        st.markdown("**Rebalancing Metrics & Calculated Weights**")
        metrics_records = []
        for date, tickers_data in metrics_for_portfolio.items():
            for ticker, data in tickers_data.items():
                # Handle None ticker as CASH
                display_ticker = 'CASH' if ticker is None else ticker
                filtered_data = {k: v for k, v in (data or {}).items() if k != 'Composite'}
                
                # Check if momentum is used for this portfolio
                use_momentum = active_portfolio.get('use_momentum', True) if active_portfolio else True
                
                # If momentum is not used, replace Calculated_Weight with target_allocation
                if not use_momentum:
                    if 'target_allocation' in filtered_data:
                        filtered_data['Calculated_Weight'] = filtered_data['target_allocation']
                    else:
                        # If target_allocation is not available, use the entered allocations from active_portfolio
                        ticker_name = display_ticker if display_ticker != 'CASH' else None
                        if ticker_name:
                            # Find the stock in active_portfolio and use its allocation
                            for stock in active_portfolio.get('stocks', []):
                                if stock.get('ticker', '').strip() == ticker_name:
                                    filtered_data['Calculated_Weight'] = stock.get('allocation', 0)
                                    break
                        else:
                            # For CASH, calculate the remaining allocation
                            total_alloc = sum(stock.get('allocation', 0) for stock in active_portfolio.get('stocks', []))
                            filtered_data['Calculated_Weight'] = max(0, 1.0 - total_alloc)
                
                record = {'Date': date, 'Ticker': display_ticker, **filtered_data}
                metrics_records.append(record)
            
            # Ensure CASH line is added if there's non-zero cash in allocations
            if allocs_for_portfolio and date in allocs_for_portfolio:
                cash_alloc = allocs_for_portfolio[date].get('CASH', 0)
                if cash_alloc > 0:
                    # Check if CASH is already in metrics_records for this date
                    cash_exists = any(record['Date'] == date and record['Ticker'] == 'CASH' for record in metrics_records)
                    if not cash_exists:
                        # Add CASH line to metrics
                        # Check if momentum is used to determine which weight to show
                        use_momentum = active_portfolio.get('use_momentum', True) if active_portfolio else True
                        if not use_momentum:
                            # When momentum is not used, calculate CASH allocation from entered allocations
                            total_alloc = sum(stock.get('allocation', 0) for stock in active_portfolio.get('stocks', []))
                            cash_weight = max(0, 1.0 - total_alloc)
                            cash_record = {'Date': date, 'Ticker': 'CASH', 'Calculated_Weight': cash_weight}
                        else:
                            cash_record = {'Date': date, 'Ticker': 'CASH', 'Calculated_Weight': cash_alloc}
                        metrics_records.append(cash_record)

        if metrics_records:
            metrics_df = pd.DataFrame(metrics_records)
            
            # Filter out CASH lines where Calculated_Weight is 0 for the last date
            if 'Calculated_Weight' in metrics_df.columns:
                # Get the last date
                last_date = metrics_df['Date'].max()
                # Remove CASH records where Calculated_Weight is 0 for the last date
                mask = ~((metrics_df['Ticker'] == 'CASH') & (metrics_df['Date'] == last_date) & (metrics_df['Calculated_Weight'] == 0))
                metrics_df = metrics_df[mask].reset_index(drop=True)
            
            if not metrics_df.empty:
                metrics_df.set_index(['Date', 'Ticker'], inplace=True)
                metrics_df_display = metrics_df.copy()
            if 'Momentum' in metrics_df_display.columns:
                metrics_df_display['Momentum'] = metrics_df_display['Momentum'].fillna(0) * 100
            if 'Calculated_Weight' in metrics_df_display.columns:
                metrics_df_display['Calculated_Weight'] = metrics_df_display['Calculated_Weight'].fillna(0) * 100
            if 'Volatility' in metrics_df_display.columns:
                metrics_df_display['Volatility'] = metrics_df_display['Volatility'].fillna(np.nan) * 100

            def color_momentum(val):
                if isinstance(val, (int, float)):
                    color = 'green' if val > 0 else 'red'
                    return f'color: {color}'
                # Force white color for None, NA, and other non-numeric values
                return 'color: #FFFFFF; font-weight: bold;'
            
            def color_all_columns(val):
                # Force white color for None, NA, and other non-numeric values in ALL columns
                if pd.isna(val) or val == 'None' or val == 'NA' or val == '':
                    return 'color: #FFFFFF; font-weight: bold;'
                if isinstance(val, (int, float)):
                    return ''  # Let default styling handle numeric values
                return 'color: #FFFFFF; font-weight: bold;'  # Force white for any other text
            
            def highlight_metrics_rows(s):
                if s.name[1] == 'CASH':
                    return ['background-color: #006400; color: white; font-weight: bold;' for _ in s]
                unique_dates = list(metrics_df_display.index.get_level_values('Date').unique())
                is_even = unique_dates.index(s.name[0]) % 2 == 0
                bg_color = 'background-color: #0e1117' if is_even else 'background-color: #262626'
                return [f'{bg_color}; color: white;'] * len(s)

            styler_metrics = metrics_df_display.style.apply(highlight_metrics_rows, axis=1)
            if 'Momentum' in metrics_df_display.columns:
                styler_metrics = styler_metrics.map(color_momentum, subset=['Momentum'])
            # Force white color for None/NA values in ALL columns
            styler_metrics = styler_metrics.map(color_all_columns)
            
            fmt_dict = {}
            if 'Momentum' in metrics_df_display.columns:
                fmt_dict['Momentum'] = '{:,.0f}%'
            if 'Beta' in metrics_df_display.columns:
                fmt_dict['Beta'] = '{:,.2f}'
            if 'Volatility' in metrics_df_display.columns:
                fmt_dict['Volatility'] = '{:,.2f}%'
            if 'Calculated_Weight' in metrics_df_display.columns:
                fmt_dict['Calculated_Weight'] = '{:,.0f}%'
            if fmt_dict:
                styler_metrics = styler_metrics.format(fmt_dict)
            
            # NUCLEAR OPTION: Inject custom CSS to override Streamlit's stubborn styling
            st.markdown("""
            <style>
            /* NUCLEAR CSS OVERRIDE - BEAT STREAMLIT INTO SUBMISSION */
            .stDataFrame [data-testid="stDataFrame"] div[data-testid="stDataFrame"] table td,
            .stDataFrame [data-testid="stDataFrame"] div[data-testid="stDataFrame"] table th,
            .stDataFrame table td,
            .stDataFrame table th {
                color: #FFFFFF !important;
                font-weight: bold !important;
                text-shadow: 1px 1px 2px black !important;
            }
            
            /* Force ALL text in dataframes to be white */
            .stDataFrame * {
                color: #FFFFFF !important;
            }
            
            /* Override any Streamlit bullshit */
            .stDataFrame [data-testid="stDataFrame"] *,
            .stDataFrame div[data-testid="stDataFrame"] * {
                color: #FFFFFF !important;
                font-weight: bold !important;
            }
            
            /* Target EVERYTHING in the dataframe */
            .stDataFrame table *,
            .stDataFrame div table *,
            .stDataFrame [data-testid="stDataFrame"] table *,
            .stDataFrame [data-testid="stDataFrame"] div table * {
                color: #FFFFFF !important;
                font-weight: bold !important;
            }
            
            /* Target all cells specifically */
            .stDataFrame td,
            .stDataFrame th,
            .stDataFrame table td,
            .stDataFrame table th {
                color: #FFFFFF !important;
                font-weight: bold !important;
            }
            
            /* Target Streamlit's specific elements */
            div[data-testid="stDataFrame"] table td,
            div[data-testid="stDataFrame"] table th,
            div[data-testid="stDataFrame"] div table td,
            div[data-testid="stDataFrame"] div table th {
                color: #FFFFFF !important;
                font-weight: bold !important;
            }
            
            /* Target everything with maximum specificity */
            div[data-testid="stDataFrame"] *,
            div[data-testid="stDataFrame"] div *,
            div[data-testid="stDataFrame"] table *,
            div[data-testid="stDataFrame"] div table * {
                color: #FFFFFF !important;
                font-weight: bold !important;
            }
            </style>
            """, unsafe_allow_html=True)
            
            st.dataframe(styler_metrics, )

    # Allocation pie charts (last rebalance vs current)
    if allocs_for_portfolio:
        try:
            alloc_dates = sorted(list(allocs_for_portfolio.keys()))
            final_date = alloc_dates[-1]
            last_rebal_date = alloc_dates[-2] if len(alloc_dates) > 1 else alloc_dates[-1]
            final_alloc = allocs_for_portfolio.get(final_date, {})
            rebal_alloc = allocs_for_portfolio.get(last_rebal_date, {})

            def prepare_bar_data(d):
                labels = []
                values = []
                for k, v in sorted(d.items(), key=lambda x: (-x[1], x[0])):
                    try:
                        val = float(v) * 100
                        if val > 0:  # Only include tickers with allocation > 0%
                            labels.append(k)
                            values.append(val)
                    except Exception:
                        pass  # Skip invalid values
                return labels, values

            labels_final, vals_final = prepare_bar_data(final_alloc)
            labels_rebal, vals_rebal = prepare_bar_data(rebal_alloc)
            # prepare helpers used by the 'Rebalance Today' UI
            # Prefer the snapshot saved when backtests were run so this UI is static until rerun
            snapshot = st.session_state.get('alloc_snapshot_data', {})
            snapshot_raw = snapshot.get('raw_data')
            snapshot_portfolios = snapshot.get('portfolio_configs')

            # select raw_data and portfolio config from snapshot if available, otherwise fall back to live state
            raw_data = snapshot_raw if snapshot_raw is not None else st.session_state.get('alloc_raw_data', {})
            # find snapshot portfolio config by name if present
            snapshot_cfg = None
            if snapshot_portfolios:
                try:
                    snapshot_cfg = next((c for c in snapshot_portfolios if c.get('name') == active_name), None)
                except Exception:
                    snapshot_cfg = None
            portfolio_cfg_for_today = snapshot_cfg if snapshot_cfg is not None else active_portfolio

            try:
                portfolio_value = float(portfolio_cfg_for_today.get('initial_value', 0) or 0)
            except Exception:
                portfolio_value = portfolio_cfg_for_today.get('initial_value', 0) or 0
            


            def _price_on_or_before(df, target_date):
                try:
                    idx = df.index[df.index <= pd.to_datetime(target_date)]
                    if len(idx) == 0:
                        return None
                    return float(df.loc[idx[-1], 'Close'])
                except Exception:
                    return None

            def build_table_from_alloc(alloc_dict, price_date, label):
                rows = []
                for tk in sorted(alloc_dict.keys()):
                    alloc_pct = float(alloc_dict.get(tk, 0))
                    if tk == 'CASH':
                        price = None
                        shares = 0
                        total_val = portfolio_value * alloc_pct
                    else:
                        # IMPORTANT: Always fetch price using original ticker (not converted)
                        # Even if raw_data contains converted ticker, get price from original to preserve currency
                        base_ticker, _ = parse_leverage_ticker(tk)
                        price = None
                        
                        # Try to get price from original ticker first (preserves currency)
                        try:
                            original_hist = get_ticker_data(base_ticker, period='1d')
                            if original_hist is not None and not original_hist.empty:
                                if price_date is None:
                                    price = float(original_hist['Close'].iloc[-1])
                                else:
                                    price = _price_on_or_before(original_hist, price_date)
                        except Exception:
                            pass
                        
                        # Fallback: Use raw_data if original ticker fetch fails
                        if price is None:
                            df = raw_data.get(tk)
                            if isinstance(df, pd.DataFrame) and 'Close' in df.columns and not df['Close'].dropna().empty:
                                if price_date is None:
                                    # use latest price
                                    try:
                                        price = float(df['Close'].iloc[-1])
                                    except Exception:
                                        price = None
                                else:
                                    price = _price_on_or_before(df, price_date)
                        try:
                            if price and price > 0:
                                # No currency conversion - use portfolio value directly with ticker's native price
                                # Portfolio value is just a number, ticker price is in its native currency
                                allocation_value = portfolio_value * alloc_pct
                                # allow fractional shares shown to 1 decimal place
                                shares = round(allocation_value / price, 1)
                                total_val = shares * price
                            else:
                                shares = 0.0
                                total_val = portfolio_value * alloc_pct
                        except Exception:
                            shares = 0
                            total_val = portfolio_value * alloc_pct

                    pct_of_port = (total_val / portfolio_value * 100) if portfolio_value > 0 else 0
                    rows.append({
                        'Ticker': tk,
                        'Allocation %': alloc_pct * 100,
                        'Price ($)': price if price is not None else float('nan'),
                        'Shares': shares,
                        'Total Value ($)': total_val,
                        '% of Portfolio': pct_of_port,
                    })

                df_table = pd.DataFrame(rows).set_index('Ticker')
                # Decide whether to show CASH row: hide if Total Value is zero or Shares zero/NaN
                df_display = df_table.copy()
                show_cash = False
                if 'CASH' in df_display.index:
                    cash_val = None
                    if 'Total Value ($)' in df_display.columns:
                        cash_val = df_display.at['CASH', 'Total Value ($)']
                    elif 'Shares' in df_display.columns:
                        cash_val = df_display.at['CASH', 'Shares']
                    try:
                        show_cash = bool(cash_val and not pd.isna(cash_val) and cash_val != 0)
                    except Exception:
                        show_cash = False
                    if not show_cash:
                        df_display = df_display.drop('CASH')
                
                # Add total row
                total_alloc_pct = df_display['Allocation %'].sum()
                total_value = df_display['Total Value ($)'].sum()
                total_port_pct = df_display['% of Portfolio'].sum()
                
                total_row = pd.DataFrame({
                    'Allocation %': [total_alloc_pct],
                    'Price ($)': [float('nan')],
                    'Shares': [float('nan')],
                    'Total Value ($)': [total_value],
                    '% of Portfolio': [total_port_pct]
                }, index=['TOTAL'])
                
                df_display = pd.concat([df_display, total_row])

                # formatting for display
                fmt = {
                    'Allocation %': '{:,.1f}%',
                    'Price ($)': '${:,.2f}',
                    'Shares': '{:,.1f}',
                    'Total Value ($)': '${:,.2f}',
                    '% of Portfolio': '{:,.2f}%'
                }
                try:
                    st.markdown(f"**{label}**")
                    sty = df_display.style.format(fmt)
                    if 'CASH' in df_table.index and show_cash:
                        def _highlight_cash_row(s):
                            if s.name == 'CASH':
                                return ['background-color: #006400; color: white; font-weight: bold;' for _ in s]
                            return [''] * len(s)
                        sty = sty.apply(_highlight_cash_row, axis=1)
                    
                    # Highlight TOTAL row
                    def _highlight_total_row(s):
                        if s.name == 'TOTAL':
                            return ['background-color: #1f4e79; color: white; font-weight: bold;' for _ in s]
                        return [''] * len(s)
                    sty = sty.apply(_highlight_total_row, axis=1)
                    
                    st.dataframe(sty, )
                except Exception:
                    st.dataframe(df_display, )
            
            # Add Returns Table BEFORE the pie charts
            st.markdown("### 📈 **Returns Summary**")
            
            def calculate_returns_table():
                """Calculate returns for different periods"""
                try:
                    # Get raw data
                    snapshot = st.session_state.get('alloc_snapshot_data', {})
                    raw_data = snapshot.get('raw_data') if snapshot and snapshot.get('raw_data') is not None else st.session_state.get('alloc_raw_data', {})
                    
                    if not raw_data:
                        return None
                    
                    today = pd.Timestamp.now().date()
                    returns_data = []
                    
                    # Get all tickers from current allocation
                    current_tickers = list(final_alloc.keys())
                    
                    for ticker in current_tickers:
                        if ticker in raw_data and not raw_data[ticker].empty:
                            df = raw_data[ticker].copy()
                            if 'Close' not in df.columns:
                                continue
                            
                            # Calculate different period returns using calendar-day lookbacks (same as Benchmark Comparison)
                            periods = {
                                '1W': 7,
                                '1M': 30,
                                '3M': 90,
                                '6M': 180,
                                '1Y': 365
                            }
                            
                            def _get_value_days_ago(series, days):
                                """Return value exactly days ago with forward fill for weekends/holidays."""
                                if series is None or len(series) == 0:
                                    return None
                                last_date = pd.to_datetime(series.index[-1])
                                target_date = last_date - pd.Timedelta(days=days)
                                # Ensure datetime index
                                series.index = pd.to_datetime(series.index)
                                
                                # Forward fill to handle weekends/holidays - create complete daily series
                                date_range = pd.date_range(start=series.index[0], end=series.index[-1], freq='D')
                                series_filled = series.reindex(date_range).fillna(method='ffill')
                                
                                # Now get exact date (should exist after ffill)
                                if target_date in series_filled.index:
                                    return series_filled.loc[target_date]
                                else:
                                    # Fallback if target_date is before series start
                                    return series_filled.iloc[0]
                            
                            current_price = df['Close'].iloc[-1]
                            ticker_returns = {'Ticker': ticker}
                            
                            # Ensure datetime index
                            df.index = pd.to_datetime(df.index)
                            for period_name, days in periods.items():
                                try:
                                    past_val = _get_value_days_ago(df['Close'], days)
                                    if past_val is not None and past_val > 0:
                                        return_pct = ((current_price - past_val) / past_val) * 100
                                        ticker_returns[period_name] = f"{return_pct:+.2f}%"
                                    else:
                                        ticker_returns[period_name] = 'N/A'
                                except Exception:
                                    ticker_returns[period_name] = 'N/A'
                            
                            returns_data.append(ticker_returns)
                    
                    if returns_data:
                        df_returns = pd.DataFrame(returns_data)
                        # Add current Momentum, Beta, Volatility from latest metrics; fallback to compute 1Y
                        try:
                            momentum_map, beta_map, vol_map = {}, {}, {}
                            try:
                                metrics_map_source = metrics_for_portfolio
                            except Exception:
                                metrics_map_source = st.session_state.get('alloc_metrics_for_portfolio') or st.session_state.get('metrics_for_portfolio')
                            if metrics_map_source:
                                last_metrics_date = max(metrics_map_source.keys())
                                last_metrics = metrics_map_source.get(last_metrics_date, {}) or {}
                                for _t, _data in (last_metrics.items() if isinstance(last_metrics, dict) else []):
                                    try:
                                        if isinstance(_data, dict) and 'Momentum' in _data and _data['Momentum'] is not None:
                                            m_val = float(_data['Momentum']) * 100.0
                                            momentum_map[_t] = f"{m_val:+.2f}%"
                                        if isinstance(_data, dict) and 'Beta' in _data and _data['Beta'] is not None:
                                            b_val = float(_data['Beta'])
                                            beta_map[_t] = f"{b_val:.2f}"
                                        if isinstance(_data, dict) and 'Volatility' in _data and _data['Volatility'] is not None:
                                            v_val = float(_data['Volatility'])
                                            v_pct = v_val * 100.0 if v_val <= 3 else v_val
                                            vol_map[_t] = f"{v_pct:.2f}%"
                                    except Exception:
                                        continue
                            if momentum_map:
                                df_returns['Momentum'] = df_returns['Ticker'].map(lambda t: momentum_map.get(t, 'N/A'))
                            if beta_map:
                                df_returns['Beta'] = df_returns['Ticker'].map(lambda t: beta_map.get(t, 'N/A'))
                            if vol_map:
                                df_returns['Volatility'] = df_returns['Ticker'].map(lambda t: vol_map.get(t, 'N/A'))
                            # Fallback compute 1Y vol/beta if missing
                            missing_beta = ('Beta' not in df_returns.columns) or df_returns['Beta'].isna().all() or (df_returns['Beta'] == 'N/A').all()
                            missing_vol = ('Volatility' not in df_returns.columns) or df_returns['Volatility'].isna().all() or (df_returns['Volatility'] == 'N/A').all()
                            if missing_beta or missing_vol:
                                bench_ticker = (active_portfolio.get('benchmark_ticker') if active_portfolio else None) or '^GSPC'
                                bench_series = None
                                if bench_ticker in raw_data:
                                    bdf = raw_data[bench_ticker].copy()
                                    if 'Close' in bdf.columns and not bdf.empty:
                                        bser = bdf['Close']; bser.index = pd.to_datetime(bser.index)
                                        date_range = pd.date_range(start=bser.index.max() - pd.Timedelta(days=365), end=bser.index.max(), freq='D')
                                        bench_series = bser.reindex(date_range).fillna(method='ffill').pct_change().dropna()
                                for _tk in df_returns['Ticker'].tolist():
                                    if _tk == 'PORTFOLIO HISTORICAL':
                                        continue
                                    tdf = raw_data.get(_tk)
                                    if tdf is None or tdf.empty or 'Close' not in tdf.columns:
                                        continue
                                    tser = tdf['Close'].copy(); tser.index = pd.to_datetime(tser.index)
                                    date_range = pd.date_range(start=tser.index.max() - pd.Timedelta(days=365), end=tser.index.max(), freq='D')
                                    tret = tser.reindex(date_range).fillna(method='ffill').pct_change().dropna()
                                    if missing_vol and not tret.empty:
                                        vol_ann = tret.std() * (252 ** 0.5) * 100.0
                                        df_returns.loc[df_returns['Ticker'] == _tk, 'Volatility'] = f"{vol_ann:.2f}%"
                                    if missing_beta and bench_series is not None and not tret.empty:
                                        try:
                                            aligned = pd.concat([tret, bench_series], axis=1, join='inner'); aligned.columns = ['t','b']
                                            if aligned['b'].var() != 0 and len(aligned) > 2:
                                                beta_val = aligned['t'].cov(aligned['b']) / aligned['b'].var()
                                                df_returns.loc[df_returns['Ticker'] == _tk, 'Beta'] = f"{beta_val:.2f}"
                                        except Exception:
                                            pass
                        except Exception:
                            pass
                        
                        # Separate stocks with allocation > 0% from those with 0% allocation
                        stocks_with_allocation = []
                        stocks_without_allocation = []
                        
                        for _, row in df_returns.iterrows():
                            ticker = row['Ticker']
                            allocation = final_alloc.get(ticker, 0)
                            if allocation > 0.0001:  # More than 0% allocation
                                stocks_with_allocation.append(row)
                            else:
                                stocks_without_allocation.append(row)
                        
                        # Sort each group by ticker name
                        stocks_with_allocation = sorted(stocks_with_allocation, key=lambda x: x['Ticker'])
                        stocks_without_allocation = sorted(stocks_without_allocation, key=lambda x: x['Ticker'])
                        
                        # Combine: stocks with allocation first, then stocks without allocation
                        combined_data = stocks_with_allocation + stocks_without_allocation
                        df_returns = pd.DataFrame(combined_data).reset_index(drop=True)
                        
                        # Add weighted portfolio return row - use same backtest data as Benchmark Comparison
                        weighted_row = {'Ticker': 'PORTFOLIO HISTORICAL'}
                        
                        # Use backtest results directly for portfolio returns (same as Benchmark Comparison)
                        try:
                            active_name = active_portfolio.get('name') if active_portfolio else None
                            all_results = st.session_state.get('alloc_all_results', {})
                            
                            if active_name in all_results:
                                portfolio_result = all_results[active_name]
                                if 'no_additions' in portfolio_result:
                                    portfolio_values = portfolio_result['no_additions']
                                    
                                    for period_name, days in periods.items():
                                        try:
                                            # Ensure we have enough data points
                                            if len(portfolio_values) < days + 1:
                                                weighted_row[period_name] = 'N/A'
                                                continue
                                            
                                            # Get current and past values safely
                                            current_value = portfolio_values.iloc[-1]
                                            past_value = portfolio_values.iloc[-(days + 1)]
                                            
                                            if past_value > 0:
                                                return_pct = ((current_value - past_value) / past_value) * 100
                                                weighted_row[period_name] = f"{return_pct:+.2f}%"
                                            else:
                                                weighted_row[period_name] = 'N/A'
                                                
                                        except (IndexError, KeyError):
                                            weighted_row[period_name] = 'N/A'
                                else:
                                    # Fallback to weighted calculation if no backtest data
                                    for period_name, days in periods.items():
                                        try:
                                            weighted_return = 0.0
                                            valid_weights = 0.0
                                            
                                            for _, row in df_returns.iterrows():
                                                ticker = row['Ticker']
                                                return_str = row[period_name]
                                                
                                                if return_str != 'N/A' and ticker in final_alloc:
                                                    try:
                                                        # Parse return percentage
                                                        return_pct = float(return_str.replace('%', '').replace('+', ''))
                                                        # Get allocation weight
                                                        weight = final_alloc[ticker]
                                                        # Add weighted return
                                                        weighted_return += return_pct * weight
                                                        valid_weights += weight
                                                    except (ValueError, KeyError):
                                                        continue
                                            
                                            if valid_weights > 0:
                                                # Normalize by actual weights used
                                                final_weighted_return = weighted_return / valid_weights
                                                weighted_row[period_name] = f"{final_weighted_return:+.2f}%"
                                            else:
                                                weighted_row[period_name] = 'N/A'
                                                
                                        except Exception:
                                            weighted_row[period_name] = 'N/A'
                            else:
                                # Fallback: all N/A if no portfolio data
                                for period_name in periods.keys():
                                    weighted_row[period_name] = 'N/A'
                        except Exception as e:
                            # Fallback to weighted calculation
                            for period_name, days in periods.items():
                                try:
                                    weighted_return = 0.0
                                    valid_weights = 0.0
                                    
                                    for _, row in df_returns.iterrows():
                                        ticker = row['Ticker']
                                        return_str = row[period_name]
                                        
                                        if return_str != 'N/A' and ticker in final_alloc:
                                            try:
                                                # Parse return percentage
                                                return_pct = float(return_str.replace('%', '').replace('+', ''))
                                                # Get allocation weight
                                                weight = final_alloc[ticker]
                                                # Add weighted return
                                                weighted_return += return_pct * weight
                                                valid_weights += weight
                                            except (ValueError, KeyError):
                                                continue
                                    
                                    if valid_weights > 0:
                                        # Normalize by actual weights used
                                        final_weighted_return = weighted_return / valid_weights
                                        weighted_row[period_name] = f"{final_weighted_return:+.2f}%"
                                    else:
                                        weighted_row[period_name] = 'N/A'
                                        
                                except Exception:
                                    weighted_row[period_name] = 'N/A'
                        
                        # Add weighted row at the end
                        df_returns = pd.concat([df_returns, pd.DataFrame([weighted_row])], ignore_index=True)
                        # Reorder columns
                        desired_order = ['Ticker', 'Momentum', 'Beta', 'Volatility', '1W', '1M', '3M', '6M', '1Y']
                        existing = [c for c in desired_order if c in df_returns.columns]
                        remaining = [c for c in df_returns.columns if c not in existing]
                        df_returns = df_returns[existing + remaining]
                        try:
                            st.session_state['returns_summary_df'] = df_returns.copy()
                        except Exception:
                            pass
                        return df_returns
                    
                except Exception as e:
                    return None
                
                return None
            
            returns_df = calculate_returns_table()
            if returns_df is not None and not returns_df.empty:
                # Style the dataframe (exclude Beta/Volatility from color semantics)
                def style_returns(val):
                    if isinstance(val, str) and val.endswith('%'):
                        try:
                            num_val = float(val.replace('%', '').replace('+', ''))
                            if num_val > 0:
                                return 'color: #00ff00; font-weight: bold'  # Green for positive
                            elif num_val < 0:
                                return 'color: #ff4444; font-weight: bold'  # Red for negative
                        except:
                            pass
                    return ''
                
                # Apply styling to returns & Momentum columns only
                percent_cols = [c for c in ['Momentum', '1W', '1M', '3M', '6M', '1Y'] if c in returns_df.columns]
                styled_returns = returns_df.style.applymap(style_returns, subset=percent_cols)
                
                # Highlight the PORTFOLIO row only
                def highlight_portfolio_row(row):
                    if 'PORTFOLIO' in row['Ticker']:
                        return ['background-color: #333333; font-weight: bold; border: 2px solid #ffff00' for _ in row]
                    return ['' for _ in row]
                
                # Apply row highlighting
                styled_returns = styled_returns.apply(highlight_portfolio_row, axis=1)
                
                # Display the table
                st.dataframe(styled_returns, )
            else:
                st.info("Returns data not available. Please run a backtest first.")
            
            st.markdown("---")
            
            # Render small pies for Last Rebalance and Current Allocation
            try:
                col1, col2 = st.columns(2)
                with col1:
                    st.markdown(f"**Target Allocation at Last Rebalance ({last_rebal_date.date()})**")
                    fig_rebal_small = go.Figure(data=[go.Pie(
                        labels=labels_rebal,
                        values=vals_rebal,
                        hole=0.35
                    )])
                    fig_rebal_small.update_traces(textinfo='percent+label')
                    fig_rebal_small.update_layout(template='plotly_dark', margin=dict(t=10))
                    st.plotly_chart(fig_rebal_small, key=f"alloc_rebal_small_{active_name}")
                with col2:
                    st.markdown(f"**Portfolio Evolution (Current Allocation)**")
                    fig_today_small = go.Figure(data=[go.Pie(
                        labels=labels_final,
                        values=vals_final,
                        hole=0.35
                    )])
                    fig_today_small.update_traces(textinfo='percent+label')
                    fig_today_small.update_layout(template='plotly_dark', margin=dict(t=10))
                    st.plotly_chart(fig_today_small, key=f"alloc_today_small_{active_name}")
            except Exception:
                # If plotting fails, continue and still render the tables below
                pass

            # Last rebalance table (use last_rebal_date)
            build_table_from_alloc(rebal_alloc, last_rebal_date, f"Target Allocation at Last Rebalance ({last_rebal_date.date()})")
            # Current / Today table (use final_date's latest available prices as of now)
            build_table_from_alloc(final_alloc, None, f"Portfolio Evolution (Current Allocation)")
        except Exception as e:
            pass

    # Add PDF generation button at the very end
    st.markdown("---")
    st.markdown("### 📄 Generate PDF Report")
    
    # Optional custom PDF report name
    custom_report_name = st.text_input(
        "📝 Custom Report Name (optional):", 
        value="",
        placeholder="e.g., Portfolio Allocation Analysis, Asset Distribution Q4, Sector Breakdown Study",
        help="Leave empty to use automatic naming: 'Allocations_Report_[timestamp].pdf'",
        key="allocations_custom_report_name"
    )
    
    if st.button("Generate PDF Report", type="primary", key="alloc_pdf_btn_2", use_container_width=True):
        try:
            success = generate_allocations_pdf(custom_report_name)
            if success:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                
                # Generate filename based on custom name or default
                if custom_report_name.strip():
                    clean_name = custom_report_name.strip().replace(' ', '_').replace('/', '_').replace('\\', '_')
                    filename = f"{clean_name}_{timestamp}.pdf"
                else:
                    filename = f"Allocations_Report_{timestamp}.pdf"
                
                st.success("✅ PDF Report Generated Successfully!")
                st.download_button(
                    label="📥 Download PDF Report",
                    data=st.session_state.get('pdf_buffer', b''),
                    file_name=filename,
                    mime="application/pdf",
                    use_container_width=True
                )
            else:
                st.error("❌ Failed to generate PDF report")
        except Exception as e:
            st.error(f"❌ Error generating PDF: {str(e)}")
            st.exception(e)
    
    # Footer - Always visible
    st.markdown("---")
    st.markdown("""
    <div style="
        text-align: center; 
        color: #666; 
        margin: 2rem 0; 
        padding: 1rem; 
        font-size: 0.9rem;
        font-weight: 500;
    ">
        Made by Nicolas Cool
    </div>
    """, unsafe_allow_html=True)