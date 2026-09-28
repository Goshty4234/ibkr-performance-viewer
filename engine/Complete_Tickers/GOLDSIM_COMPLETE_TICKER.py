#!/usr/bin/env python3
"""
GOLDSIM Complete Ticker - Ultra Optimized
Combines historical GOLD data with live GLD ETF data
"""

import pandas as pd
import yfinance as yf
import warnings

# Suppress warnings
warnings.filterwarnings('ignore')

def load_historical_goldsim_data():
    """Load historical GOLDSIM data from CSV"""
    try:
        df = pd.read_csv('Complete_Tickers/Historical CSV/GOLD Historical Data Monthly.csv', 
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
        print(f"Error loading historical GOLDSIM data: {e}")
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

def create_goldsim_complete_ticker():
    """Create complete GOLDSIM ticker combining historical and GLD data"""
    try:
        # Load historical data
        historical_data = load_historical_goldsim_data()
        if historical_data is None:
            gld_data = get_gld_data()
            if gld_data is not None:
                return gld_data[['Close']]
            else:
                return None
        
        # Get GLD data
        gld_data = get_gld_data()
        if gld_data is None:
            return historical_data[['Close']]
        
        # GLD IPO date (November 18, 2004)
        # Scale GLD to match historical data at 2004
        try:
            gld_start_date = pd.Timestamp('2004-11-18')
            
            # Find price in historical data closest to GLD start
            historical_2004_price = historical_data[historical_data.index <= gld_start_date].iloc[-1]['Close']
            
            # Find first GLD price
            gld_first_price = gld_data.iloc[0]['Close']
            
            # Calculate scaling factor
            scaling_factor = historical_2004_price / gld_first_price
            
            # Scale GLD data
            gld_scaled = gld_data.copy()
            gld_scaled['Close'] = gld_scaled['Close'] * scaling_factor
            gld_scaled['Open'] = gld_scaled['Open'] * scaling_factor
            gld_scaled['High'] = gld_scaled['High'] * scaling_factor
            gld_scaled['Low'] = gld_scaled['Low'] * scaling_factor
            
            # Get historical data before GLD starts
            historical_before = historical_data[historical_data.index < gld_data.index.min()]
            
            # Combine data
            combined_data = pd.concat([historical_before, gld_scaled])
            combined_data = combined_data[~combined_data.index.duplicated(keep='last')]
            combined_data = combined_data.sort_index()
            
            return combined_data[['Close']]
            
        except Exception as e:
            print(f"Error scaling GLD data: {e}")
            return historical_data[['Close']]
            
    except Exception as e:
        print(f"Error creating GOLDSIM complete ticker: {e}")
        return None

if __name__ == "__main__":
    data = create_goldsim_complete_ticker()
    if data is not None:
        print(f"SUCCESS! Shape: {data.shape}")
        print(f"Date range: {data.index.min()} to {data.index.max()}")
