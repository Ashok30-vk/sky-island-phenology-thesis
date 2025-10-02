# Methods Protocol

## Data Processing Pipeline

### 1. Google Earth Engine Processing
- **MODIS Collections**: MOD13Q1 (Terra) + MYD13Q1 (Aqua)
- **Temporal Range**: 2000-02-18 to 2024-12-31
- **Quality Filtering**: SummaryQA ≤ 1 (Good/Marginal)
- **Spatial Resolution**: 250m resampled

### 2. Elevation Band Classification
- **Source**: SRTM 30m DEM
- **Method**: Tercile division (33rd/67th percentiles)
- **Bands**: 
  - Low: ≤ 33rd percentile
  - Mid: 33rd-67th percentile  
  - High: ≥ 67th percentile

### 3. Export Strategy
- **Points CSV**: 500 random points per region
- **Elevation Bands CSV**: Area-averaged by elevation class
- **Temporal Resolution**: ~8 days (combined Terra+Aqua)