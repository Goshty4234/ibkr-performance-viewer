#!/usr/bin/env python3
"""
KMLM Complete Ticker - Optimized Structure
Combines historical KMLM data with live KMLM ETF data
"""

import pandas as pd
import yfinance as yf
import warnings

# Suppress warnings
warnings.filterwarnings('ignore')

def load_historical_kmlm_data():
    """Load historical KMLM data from CSV"""
    try:
        df = pd.read_csv('Complete_Tickers/Historical CSV/KMLM Historical Data Monthly.csv', 
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
        print(f"Error loading historical KMLM data: {e}")
        return None

def get_kmlm_data():
    """Get recent KMLM ETF data"""
    try:
        kmlm_ticker = yf.Ticker("KMLM")
        kmlm_data = kmlm_ticker.history(period="max", auto_adjust=True)
        
        if not kmlm_data.empty:
            # Make timezone-naive for comparison
            kmlm_data.index = kmlm_data.index.tz_localize(None)
            return kmlm_data
        else:
            return None
    except Exception as e:
        print(f"Error fetching KMLM data: {e}")
        return None

def create_kmlm_complete_ticker():
    """Create complete KMLM ticker combining historical and KMLM data"""
    try:
        # Load historical data
        historical_data = load_historical_kmlm_data()
        if historical_data is None:
            print("Failed to load historical data, falling back to KMLM only")
            kmlm_data = get_kmlm_data()
            if kmlm_data is not None:
                return kmlm_data[['Close']]
            else:
                return None
        
        # Get KMLM data
        kmlm_data = get_kmlm_data()
        if kmlm_data is None:
            print("Failed to load KMLM data, using historical data only")
            return historical_data[['Close']]
        
        # Scale KMLM to match historical data at first available date
        try:
            # Find first KMLM date in historical data
            kmlm_start_date = kmlm_data.index.min()
            
            # Find the closest historical price before KMLM starts
            historical_before = historical_data[historical_data.index < kmlm_start_date]
            
            if len(historical_before) > 0:
                historical_price = historical_before.iloc[-1]['Close']
                kmlm_price = kmlm_data.iloc[0]['Close']
                
                # Calculate scaling factor
                scaling_factor = kmlm_price / historical_price
                
                # Scale historical data
                historical_scaled = historical_before.copy()
                historical_scaled['Close'] = historical_scaled['Close'] * scaling_factor
                
                # Combine data
                combined_data = pd.concat([historical_scaled, kmlm_data])
                combined_data = combined_data[~combined_data.index.duplicated(keep='last')]
                combined_data = combined_data.sort_index()
                
                return combined_data[['Close']]
            else:
                # No historical data before KMLM, use KMLM only
                return kmlm_data[['Close']]
            
        except Exception as e:
            print(f"Error scaling KMLM data: {e}")
            # Fallback to historical data only
            return historical_data[['Close']]
            
    except Exception as e:
        print(f"Error creating KMLM complete ticker: {e}")
        return None

if __name__ == "__main__":
    data = create_kmlm_complete_ticker()
    if data is not None:
        print(f"SUCCESS! Shape: {data.shape}")
        print(f"Date range: {data.index.min()} to {data.index.max()}")
