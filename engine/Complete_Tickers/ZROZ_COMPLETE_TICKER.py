#!/usr/bin/env python3
"""
ZROZ Complete Ticker - Optimized Structure
Combines historical ZROZ data with live ZROZ ETF data
"""

import pandas as pd
import yfinance as yf
import warnings

# Suppress warnings
warnings.filterwarnings('ignore')

def load_historical_zroz_data():
    """Load historical ZROZ data from CSV"""
    try:
        df = pd.read_csv('Complete_Tickers/Historical CSV/ZROZ Historical Data Monthly.csv', 
                        sep='\t', header=None)
        
        # Parse dates (add '-01' for day of month)
        df[0] = pd.to_datetime(df[0] + '-01')
        df.set_index(0, inplace=True)
        
        # Clean price column
        df[2] = df[2].str.replace('$', '').str.replace(',', '').astype(float)
        
        # Rename columns to match expected format
        df.columns = ['Change', 'Close']
        
        return df
    except Exception as e:
        print(f"Error loading historical ZROZ data: {e}")
        return None

def get_zroz_data():
    """Get recent ZROZ ETF data"""
    try:
        zroz_ticker = yf.Ticker("ZROZ")
        zroz_data = zroz_ticker.history(period="max", auto_adjust=True)
        
        if not zroz_data.empty:
            # Make timezone-naive for comparison
            zroz_data.index = zroz_data.index.tz_localize(None)
            return zroz_data
        else:
            return None
    except Exception as e:
        print(f"Error fetching ZROZ data: {e}")
        return None

def create_safe_zroz_ticker():
    """Create complete ZROZ ticker combining historical and ZROZ data"""
    try:
        # Load historical data
        historical_data = load_historical_zroz_data()
        if historical_data is None:
            print("Failed to load historical data, falling back to ZROZ only")
            zroz_data = get_zroz_data()
            if zroz_data is not None:
                return zroz_data[['Close']]
            else:
                return None
        
        # Get ZROZ data
        zroz_data = get_zroz_data()
        if zroz_data is None:
            print("Failed to load ZROZ data, using historical data only")
            return historical_data[['Close']]
        
        # ZROZ IPO date (November 4, 2009)
        # Scale ZROZ to match historical data at 2009
        try:
            zroz_start_date = pd.Timestamp('2009-11-04')
            
            # Find price in historical data closest to ZROZ start
            historical_2009_price = historical_data[historical_data.index <= zroz_start_date].iloc[-1]['Close']
            
            # Find first ZROZ price
            zroz_first_price = zroz_data.iloc[0]['Close']
            
            # Calculate scaling factor
            scaling_factor = historical_2009_price / zroz_first_price
            
            # Scale ZROZ data
            zroz_scaled = zroz_data.copy()
            zroz_scaled['Close'] = zroz_scaled['Close'] * scaling_factor
            zroz_scaled['Open'] = zroz_scaled['Open'] * scaling_factor
            zroz_scaled['High'] = zroz_scaled['High'] * scaling_factor
            zroz_scaled['Low'] = zroz_scaled['Low'] * scaling_factor
            
            # Get historical data before ZROZ starts
            historical_before = historical_data[historical_data.index < zroz_data.index.min()]
            
            # Combine data
            combined_data = pd.concat([historical_before, zroz_scaled])
            combined_data = combined_data[~combined_data.index.duplicated(keep='last')]
            combined_data = combined_data.sort_index()
            
            return combined_data[['Close']]
            
        except Exception as e:
            print(f"Error scaling ZROZ data: {e}")
            # Fallback to historical data only
            return historical_data[['Close']]
            
    except Exception as e:
        print(f"Error creating ZROZ complete ticker: {e}")
        return None

if __name__ == "__main__":
    data = create_safe_zroz_ticker()
    if data is not None:
        print(f"SUCCESS! Shape: {data.shape}")
        print(f"Date range: {data.index.min()} to {data.index.max()}")
