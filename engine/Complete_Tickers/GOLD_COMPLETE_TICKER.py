#!/usr/bin/env python3
"""
Gold Complete Ticker - Simple and Clean
Combines historical gold futures data with live GLD ETF data
"""

import pandas as pd
import yfinance as yf
import warnings

# Suppress warnings
warnings.filterwarnings('ignore')

def load_historical_gold_data():
    """Load historical gold data from CSV"""
    try:
        df = pd.read_csv('Complete_Tickers/Historical CSV/Gold_Futures_Complete.csv')
        
        # Parse dates
        df['Date'] = pd.to_datetime(df['Date'], format='%m/%d/%Y')
        df.set_index('Date', inplace=True)
        
        # Rename columns to match expected format
        df.columns = ['Close', 'Open', 'High', 'Low', 'Volume', 'Change_Percent']
        
        return df
    except Exception as e:
        print(f"Error loading historical gold data: {e}")
        return None

def get_gld_data():
    """Get recent GLD ETF data"""
    try:
        gld_ticker = yf.Ticker("GLD")
        gld_data = gld_ticker.history(period="max", auto_adjust=True)
        
        if not gld_data.empty:
            # Make timezone-naive for comparison
            gld_data.index = gld_data.index.tz_localize(None)
            return gld_data
        else:
            return None
    except Exception as e:
        print(f"Error fetching GLD data: {e}")
        return None

def create_gold_complete_ticker():
    """Create complete gold ticker combining historical and GLD data"""
    try:
        # Load historical data
        historical_data = load_historical_gold_data()
        if historical_data is None:
            print("Failed to load historical data, falling back to GLD only")
            gld_data = get_gld_data()
            if gld_data is not None:
                return gld_data[['Close']]
            else:
                return None
        
        # Get GLD data
        gld_data = get_gld_data()
        if gld_data is None:
            print("Failed to load GLD data, using historical data only")
            return historical_data[['Close']]
        
        # Scale GLD to match historical data at GLD IPO and stitch like GOLDSIM
        try:
            gld_start_date = pd.Timestamp('2004-11-18')

            # Historical price on or before GLD start
            hist_before_start = historical_data[historical_data.index <= gld_start_date]
            if hist_before_start.empty:
                # Fallback: use earliest available historical
                historical_anchor_price = float(historical_data.iloc[0]['Close'])
            else:
                historical_anchor_price = float(hist_before_start.iloc[-1]['Close'])

            # First GLD price
            gld_first_price = float(gld_data.iloc[0]['Close'])

            # Scaling factor
            scaling_factor = historical_anchor_price / gld_first_price if gld_first_price != 0 else 1.0

            # Scale GLD
            gld_scaled = gld_data.copy()
            gld_scaled['Close'] = gld_scaled['Close'] * scaling_factor
            gld_scaled['Open'] = gld_scaled['Open'] * scaling_factor
            gld_scaled['High'] = gld_scaled['High'] * scaling_factor
            gld_scaled['Low'] = gld_scaled['Low'] * scaling_factor

            # Use only historical data strictly before GLD begins
            historical_before = historical_data[historical_data.index < gld_data.index.min()]

            # Build Close and Dividends exactly from sources
            hist_close = historical_before[['Close']].copy()
            hist_close['Dividends'] = 0.0

            gld_close = gld_scaled[['Close']].copy()
            # Scale dividends with the same factor to preserve continuity
            gld_div = gld_data[['Dividends']].copy() if 'Dividends' in gld_data.columns else pd.DataFrame(index=gld_data.index, data={'Dividends': 0.0})
            gld_div_scaled = gld_div * scaling_factor
            gld_close['Dividends'] = gld_div_scaled['Dividends']

            # Concatenate strictly before GLD start + GLD segment dates only
            combined = pd.concat([hist_close, gld_close])
            combined = combined[~combined.index.duplicated(keep='last')]
            combined = combined.sort_index()

            return combined[['Close', 'Dividends']]
            
        except Exception as e:
            print(f"Error scaling GLD data: {e}")
            # Fallback to historical data only
            return historical_data[['Close']]
            
    except Exception as e:
        print(f"Error creating gold complete ticker: {e}")
        return None

def test_gold_ticker():
    """Test the gold ticker"""
    print("Testing Gold Complete Ticker")
    print("=" * 50)
    
    data = create_gold_complete_ticker()
    
    if data is not None:
        print(f"SUCCESS! Shape: {data.shape}")
        print(f"Date range: {data.index.min()} to {data.index.max()}")
        print(f"Price range: ${data['Close'].min():.2f} to ${data['Close'].max():.2f}")
        
        # Check specific years
        for year in [1975, 1980, 1990, 2000, 2010, 2020]:
            year_data = data[data.index.year == year]
            print(f"{year}: {len(year_data)} rows")
        
        # Check before/after 2004
        before_2004 = data[data.index.year < 2004]
        from_2004 = data[data.index.year >= 2004]
        print(f"Before 2004: {len(before_2004)} rows")
        print(f"From 2004: {len(from_2004)} rows")
        
        return True
    else:
        print("FAILED to create gold ticker")
        return False

if __name__ == "__main__":
    test_gold_ticker()
