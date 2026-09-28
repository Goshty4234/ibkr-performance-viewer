#!/usr/bin/env python3
"""
TBILL Complete Ticker - Optimized Structure
Combines historical TBILL data with live SGOV ETF data
"""

import pandas as pd
import yfinance as yf
import warnings

# Suppress warnings
warnings.filterwarnings('ignore')

def load_historical_tbill_data():
    """Load historical TBILL data from CSV"""
    try:
        df = pd.read_csv('Complete_Tickers/Historical CSV/TBILL Historical Data Monthly.csv', 
                        sep='\t', header=None)
        
        # Parse dates
        df[0] = pd.to_datetime(df[0])
        df.set_index(0, inplace=True)
        
        # Clean price column
        df[2] = df[2].str.replace('$', '').str.replace(',', '').astype(float)
        
        # Rename columns to match expected format
        df.columns = ['Change', 'Close']
        
        return df
    except Exception as e:
        print(f"Error loading historical TBILL data: {e}")
        return None

def get_sgov_data():
    """Get recent SGOV ETF data (Short-term Treasury ETF)"""
    try:
        sgov_ticker = yf.Ticker("SGOV")
        sgov_data = sgov_ticker.history(period="max", auto_adjust=True)
        
        if not sgov_data.empty:
            # Make timezone-naive for comparison
            sgov_data.index = sgov_data.index.tz_localize(None)
            return sgov_data
        else:
            return None
    except Exception as e:
        print(f"Error fetching SGOV data: {e}")
        return None

def create_tbill_complete_ticker():
    """Create complete TBILL ticker combining historical and SGOV data"""
    try:
        # Load historical data
        historical_data = load_historical_tbill_data()
        if historical_data is None:
            print("Failed to load historical data, falling back to SGOV only")
            sgov_data = get_sgov_data()
            if sgov_data is not None:
                return sgov_data[['Close']]
            else:
                return None
        
        # Get SGOV data
        sgov_data = get_sgov_data()
        if sgov_data is None:
            print("Failed to load SGOV data, using historical data only")
            return historical_data[['Close']]
        
        # Scale SGOV to match historical data at first available date
        try:
            # Find first SGOV date in historical data
            sgov_start_date = sgov_data.index.min()
            
            # Find the closest historical price before SGOV starts
            historical_before = historical_data[historical_data.index < sgov_start_date]
            
            if len(historical_before) > 0:
                historical_price = historical_before.iloc[-1]['Close']
                sgov_price = sgov_data.iloc[0]['Close']
                
                # Calculate scaling factor
                scaling_factor = sgov_price / historical_price
                
                # Scale historical data
                historical_scaled = historical_before.copy()
                historical_scaled['Close'] = historical_scaled['Close'] * scaling_factor
                
                # Combine data
                combined_data = pd.concat([historical_scaled, sgov_data])
                combined_data = combined_data[~combined_data.index.duplicated(keep='last')]
                combined_data = combined_data.sort_index()
                
                return combined_data[['Close']]
            else:
                # No historical data before SGOV, use SGOV only
                return sgov_data[['Close']]
            
        except Exception as e:
            print(f"Error scaling SGOV data: {e}")
            # Fallback to historical data only
            return historical_data[['Close']]
            
    except Exception as e:
        print(f"Error creating TBILL complete ticker: {e}")
        return None

if __name__ == "__main__":
    data = create_tbill_complete_ticker()
    if data is not None:
        print(f"SUCCESS! Shape: {data.shape}")
        print(f"Date range: {data.index.min()} to {data.index.max()}")
