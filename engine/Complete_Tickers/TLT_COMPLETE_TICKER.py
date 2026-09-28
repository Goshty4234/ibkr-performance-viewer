#!/usr/bin/env python3
"""
TLT Complete Ticker - Optimized Structure
Combines historical TLT data with live TLT ETF data
"""

import pandas as pd
import yfinance as yf
import warnings

# Suppress warnings
warnings.filterwarnings('ignore')

def load_historical_tlt_data():
    """Load historical TLT data from CSV"""
    try:
        df = pd.read_csv('Complete_Tickers/Historical CSV/TLT Historical Data Monthly.csv', 
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
        print(f"Error loading historical TLT data: {e}")
        return None

def get_tlt_data():
    """Get recent TLT ETF data"""
    try:
        tlt_ticker = yf.Ticker("TLT")
        tlt_data = tlt_ticker.history(period="max", auto_adjust=True)
        
        if not tlt_data.empty:
            # Make timezone-naive for comparison
            tlt_data.index = tlt_data.index.tz_localize(None)
            return tlt_data
        else:
            return None
    except Exception as e:
        print(f"Error fetching TLT data: {e}")
        return None

def create_safe_tlt_ticker():
    """Create complete TLT ticker combining historical and TLT data"""
    try:
        # Load historical data
        historical_data = load_historical_tlt_data()
        if historical_data is None:
            print("Failed to load historical data, falling back to TLT only")
            tlt_data = get_tlt_data()
            if tlt_data is not None:
                return tlt_data[['Close']]
            else:
                return None
        
        # Get TLT data
        tlt_data = get_tlt_data()
        if tlt_data is None:
            print("Failed to load TLT data, using historical data only")
            return historical_data[['Close']]
        
        # TLT IPO date (July 22, 2002)
        # Scale TLT to match historical data at 2002
        try:
            tlt_start_date = pd.Timestamp('2002-07-22')
            
            # Find price in historical data closest to TLT start
            historical_2002_price = historical_data[historical_data.index <= tlt_start_date].iloc[-1]['Close']
            
            # Find first TLT price
            tlt_first_price = tlt_data.iloc[0]['Close']
            
            # Calculate scaling factor
            scaling_factor = historical_2002_price / tlt_first_price
            
            # Scale TLT data
            tlt_scaled = tlt_data.copy()
            tlt_scaled['Close'] = tlt_scaled['Close'] * scaling_factor
            tlt_scaled['Open'] = tlt_scaled['Open'] * scaling_factor
            tlt_scaled['High'] = tlt_scaled['High'] * scaling_factor
            tlt_scaled['Low'] = tlt_scaled['Low'] * scaling_factor
            
            # Get historical data before TLT starts
            historical_before = historical_data[historical_data.index < tlt_data.index.min()]
            
            # Combine data
            combined_data = pd.concat([historical_before, tlt_scaled])
            combined_data = combined_data[~combined_data.index.duplicated(keep='last')]
            combined_data = combined_data.sort_index()
            
            return combined_data[['Close']]
            
        except Exception as e:
            print(f"Error scaling TLT data: {e}")
            # Fallback to historical data only
            return historical_data[['Close']]
            
    except Exception as e:
        print(f"Error creating TLT complete ticker: {e}")
        return None

if __name__ == "__main__":
    data = create_safe_tlt_ticker()
    if data is not None:
        print(f"SUCCESS! Shape: {data.shape}")
        print(f"Date range: {data.index.min()} to {data.index.max()}")
