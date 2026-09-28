#!/usr/bin/env python3
"""
DBMF Complete Ticker - Optimized Structure
Combines historical DBMF data with live DBMF ETF data
"""

import pandas as pd
import yfinance as yf
import warnings

# Suppress warnings
warnings.filterwarnings('ignore')

def load_historical_dbmf_data():
    """Load historical DBMF data from CSV"""
    try:
        df = pd.read_csv('Complete_Tickers/Historical CSV/DBMF Historical Data Monthly.csv', 
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
        print(f"Error loading historical DBMF data: {e}")
        return None

def get_dbmf_data():
    """Get recent DBMF ETF data"""
    try:
        dbmf_ticker = yf.Ticker("DBMF")
        dbmf_data = dbmf_ticker.history(period="max", auto_adjust=True)
        
        if not dbmf_data.empty:
            # Make timezone-naive for comparison
            dbmf_data.index = dbmf_data.index.tz_localize(None)
            return dbmf_data
        else:
            return None
    except Exception as e:
        print(f"Error fetching DBMF data: {e}")
        return None

def create_dbmf_complete_ticker():
    """Create complete DBMF ticker combining historical and DBMF data"""
    try:
        # Load historical data
        historical_data = load_historical_dbmf_data()
        if historical_data is None:
            print("Failed to load historical data, falling back to DBMF only")
            dbmf_data = get_dbmf_data()
            if dbmf_data is not None:
                return dbmf_data[['Close']]
            else:
                return None
        
        # Get DBMF data
        dbmf_data = get_dbmf_data()
        if dbmf_data is None:
            print("Failed to load DBMF data, using historical data only")
            return historical_data[['Close']]
        
        # Scale DBMF to match historical data at first available date
        try:
            # Find first DBMF date in historical data
            dbmf_start_date = dbmf_data.index.min()
            
            # Find the closest historical price before DBMF starts
            historical_before = historical_data[historical_data.index < dbmf_start_date]
            
            if len(historical_before) > 0:
                historical_price = historical_before.iloc[-1]['Close']
                dbmf_price = dbmf_data.iloc[0]['Close']
                
                # Calculate scaling factor
                scaling_factor = dbmf_price / historical_price
                
                # Scale historical data
                historical_scaled = historical_before.copy()
                historical_scaled['Close'] = historical_scaled['Close'] * scaling_factor
                
                # Combine data
                combined_data = pd.concat([historical_scaled, dbmf_data])
                combined_data = combined_data[~combined_data.index.duplicated(keep='last')]
                combined_data = combined_data.sort_index()
                
                return combined_data[['Close']]
            else:
                # No historical data before DBMF, use DBMF only
                return dbmf_data[['Close']]
            
        except Exception as e:
            print(f"Error scaling DBMF data: {e}")
            # Fallback to historical data only
            return historical_data[['Close']]
            
    except Exception as e:
        print(f"Error creating DBMF complete ticker: {e}")
        return None

if __name__ == "__main__":
    data = create_dbmf_complete_ticker()
    if data is not None:
        print(f"SUCCESS! Shape: {data.shape}")
        print(f"Date range: {data.index.min()} to {data.index.max()}")
