#!/usr/bin/env python3
"""
Bitcoin Complete Ticker - Optimized Structure
Combines historical Bitcoin data with live BTC-USD data
"""

import pandas as pd
import yfinance as yf
import warnings

# Suppress warnings
warnings.filterwarnings('ignore')

def load_historical_bitcoin_data():
    """Load historical Bitcoin data from CSV"""
    try:
        df = pd.read_csv('Complete_Tickers/Historical CSV/BITCOIN Hisotrical Data Monthly.csv', 
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
        print(f"Error loading historical Bitcoin data: {e}")
        return None

def get_btc_data():
    """Get recent Bitcoin data from Yahoo Finance"""
    try:
        btc_ticker = yf.Ticker("BTC-USD")
        btc_data = btc_ticker.history(period="max", auto_adjust=True)
        
        if not btc_data.empty:
            # Make timezone-naive for comparison
            btc_data.index = btc_data.index.tz_localize(None)
            return btc_data
        else:
            return None
    except Exception as e:
        print(f"Error fetching Bitcoin data: {e}")
        return None

def create_bitcoin_complete_ticker():
    """Create complete Bitcoin ticker combining historical and BTC-USD data"""
    try:
        # Load historical data
        historical_data = load_historical_bitcoin_data()
        if historical_data is None:
            print("Failed to load historical data, falling back to BTC-USD only")
            btc_data = get_btc_data()
            if btc_data is not None:
                return btc_data[['Close']]
            else:
                return None
        
        # Get BTC data
        btc_data = get_btc_data()
        if btc_data is None:
            print("Failed to load BTC data, using historical data only")
            return historical_data[['Close']]
        
        # Scale Bitcoin data to match historical data at first available date
        try:
            # Find first BTC date in historical data
            btc_start_date = btc_data.index.min()
            
            # Find the closest historical price before BTC starts
            historical_before = historical_data[historical_data.index < btc_start_date]
            
            if len(historical_before) > 0:
                historical_price = historical_before.iloc[-1]['Close']
                btc_price = btc_data.iloc[0]['Close']
                
                # Calculate scaling factor
                scaling_factor = btc_price / historical_price
                
                # Scale historical data
                historical_scaled = historical_before.copy()
                historical_scaled['Close'] = historical_scaled['Close'] * scaling_factor
                
                # Combine data
                combined_data = pd.concat([historical_scaled, btc_data])
                combined_data = combined_data[~combined_data.index.duplicated(keep='last')]
                combined_data = combined_data.sort_index()
                
                return combined_data[['Close']]
            else:
                # No historical data before BTC, use BTC only
                return btc_data[['Close']]
            
        except Exception as e:
            print(f"Error scaling BTC data: {e}")
            # Fallback to historical data only
            return historical_data[['Close']]
            
    except Exception as e:
        print(f"Error creating Bitcoin complete ticker: {e}")
        return None

if __name__ == "__main__":
    data = create_bitcoin_complete_ticker()
    if data is not None:
        print(f"SUCCESS! Shape: {data.shape}")
        print(f"Date range: {data.index.min()} to {data.index.max()}")
