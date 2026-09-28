#!/usr/bin/env python3
"""
SPYSIM Complete Ticker - Ultra Optimized
Combines historical SPY data with Yahoo Finance SP500TR data
"""

import pandas as pd
import yfinance as yf
import warnings

# Suppress warnings
warnings.filterwarnings('ignore')

def load_historical_spysim_data():
    """Load historical SPYSIM data from CSV"""
    try:
        df = pd.read_csv('Complete_Tickers/Historical CSV/SPY Historical Data Monthly.csv', 
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
        print(f"Error loading historical SPYSIM data: {e}")
        return None

def get_sp500tr_data():
    """Get recent SP500TR data"""
    try:
        sp500tr_ticker = yf.Ticker("^SP500TR")
        sp500tr_data = sp500tr_ticker.history(period="max", auto_adjust=True)
        
        if not sp500tr_data.empty:
            # Make timezone-naive for comparison
            sp500tr_data.index = sp500tr_data.index.tz_localize(None)
            return sp500tr_data
        else:
            return None
    except Exception as e:
        print(f"Error fetching SP500TR data: {e}")
        return None

def create_spysim_complete_ticker():
    """Create complete SPYSIM ticker combining historical and SP500TR data"""
    try:
        # Load historical data
        historical_data = load_historical_spysim_data()
        if historical_data is None:
            sp500tr_data = get_sp500tr_data()
            if sp500tr_data is not None:
                return sp500tr_data[['Close']]
            else:
                return None
        
        # Get SP500TR data
        sp500tr_data = get_sp500tr_data()
        if sp500tr_data is None:
            return historical_data[['Close']]
        
        # SP500TR data starts around 1988
        # Scale SP500TR to match historical data at transition
        try:
            sp500tr_start_date = sp500tr_data.index.min()
            
            # Find price in historical data closest to SP500TR start
            historical_before = historical_data[historical_data.index < sp500tr_start_date]
            
            if len(historical_before) > 0:
                historical_price = historical_before.iloc[-1]['Close']
                
                # Find first SP500TR price
                sp500tr_first_price = sp500tr_data.iloc[0]['Close']
                
                # Calculate scaling factor
                scaling_factor = historical_price / sp500tr_first_price
                
                # Scale SP500TR data
                sp500tr_scaled = sp500tr_data.copy()
                sp500tr_scaled['Close'] = sp500tr_scaled['Close'] * scaling_factor
                sp500tr_scaled['Open'] = sp500tr_scaled['Open'] * scaling_factor
                sp500tr_scaled['High'] = sp500tr_scaled['High'] * scaling_factor
                sp500tr_scaled['Low'] = sp500tr_scaled['Low'] * scaling_factor
                
                # Combine data
                combined_data = pd.concat([historical_before, sp500tr_scaled])
                combined_data = combined_data[~combined_data.index.duplicated(keep='last')]
                combined_data = combined_data.sort_index()
                
                return combined_data[['Close']]
            else:
                # No historical data before SP500TR, use SP500TR only
                return sp500tr_data[['Close']]
            
        except Exception as e:
            print(f"Error scaling SP500TR data: {e}")
            return historical_data[['Close']]
            
    except Exception as e:
        print(f"Error creating SPYSIM complete ticker: {e}")
        return None

if __name__ == "__main__":
    data = create_spysim_complete_ticker()
    if data is not None:
        print(f"SUCCESS! Shape: {data.shape}")
        print(f"Date range: {data.index.min()} to {data.index.max()}")
