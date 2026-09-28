#!/usr/bin/env python3
"""
IEF Complete Ticker - Optimized Structure
Combines historical IEF data with live IEF ETF data
"""

import pandas as pd
import yfinance as yf
import warnings

# Suppress warnings
warnings.filterwarnings('ignore')

def load_historical_ief_data():
    """Load historical IEF data from CSV"""
    try:
        df = pd.read_csv('Complete_Tickers/Historical CSV/IEF Historical Data Monthly.csv', 
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
        print(f"Error loading historical IEF data: {e}")
        return None

def get_ief_data():
    """Get recent IEF ETF data"""
    try:
        ief_ticker = yf.Ticker("IEF")
        ief_data = ief_ticker.history(period="max", auto_adjust=True)
        
        if not ief_data.empty:
            # Make timezone-naive for comparison
            ief_data.index = ief_data.index.tz_localize(None)
            return ief_data
        else:
            return None
    except Exception as e:
        print(f"Error fetching IEF data: {e}")
        return None

def create_ief_complete_ticker():
    """Create complete IEF ticker combining historical and IEF data"""
    try:
        # Load historical data
        historical_data = load_historical_ief_data()
        if historical_data is None:
            print("Failed to load historical data, falling back to IEF only")
            ief_data = get_ief_data()
            if ief_data is not None:
                return ief_data[['Close']]
            else:
                return None
        
        # Get IEF data
        ief_data = get_ief_data()
        if ief_data is None:
            print("Failed to load IEF data, using historical data only")
            return historical_data[['Close']]
        
        # IEF IPO date (July 22, 2002)
        # Scale IEF to match historical data at first available date
        try:
            # Find first IEF date in historical data
            ief_start_date = ief_data.index.min()
            
            # Find the closest historical price before IEF starts
            historical_before = historical_data[historical_data.index < ief_start_date]
            
            if len(historical_before) > 0:
                historical_price = historical_before.iloc[-1]['Close']
                ief_price = ief_data.iloc[0]['Close']
                
                # Calculate scaling factor
                scaling_factor = ief_price / historical_price
                
                # Scale historical data
                historical_scaled = historical_before.copy()
                historical_scaled['Close'] = historical_scaled['Close'] * scaling_factor
                
                # Combine data
                combined_data = pd.concat([historical_scaled, ief_data])
                combined_data = combined_data[~combined_data.index.duplicated(keep='last')]
                combined_data = combined_data.sort_index()
                
                return combined_data[['Close']]
            else:
                # No historical data before IEF, use IEF only
                return ief_data[['Close']]
            
        except Exception as e:
            print(f"Error scaling IEF data: {e}")
            # Fallback to historical data only
            return historical_data[['Close']]
            
    except Exception as e:
        print(f"Error creating IEF complete ticker: {e}")
        return None

if __name__ == "__main__":
    data = create_ief_complete_ticker()
    if data is not None:
        print(f"SUCCESS! Shape: {data.shape}")
        print(f"Date range: {data.index.min()} to {data.index.max()}")
