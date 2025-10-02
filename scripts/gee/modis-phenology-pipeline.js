// ================== SKY ISLAND PHENOLOGY - Combined Terra+Aqua MODIS ==================
// Optimized for phenology analysis with elevation bands

// --------------------- 0) AOI → geometry ---------------------
if (typeof CAT === 'undefined') throw 'Import CAT polygon';
var catGeom = (CAT.geometry) ? CAT.geometry() : ee.Geometry(CAT);
print('CAT area (km²):', catGeom.area().divide(1e6));

// --------------------- 1) Parameters ---------------------
var START = '2000-02-18';     // Full Terra+Aqua timeline
var END   = '2024-12-31';
var N_SAMPLES = 500;          // More points for better phenology

// Color palettes
var eviPalette = [
  '#f7fcf5','#e5f5e0','#c7e9c0','#a1d99b',
  '#74c476','#41ab5d','#238b45','#006d2c','#00441b'
];

// --------------------- 2) Elevation bands for sky island gradient ---------------------
var srtm = ee.Image('USGS/SRTMGL1_003').clip(catGeom);

// Use terciles for low/mid/high elevation bands
var qs = srtm.reduceRegion({
  reducer: ee.Reducer.percentile([33, 67]),
  geometry: catGeom, scale: 30, maxPixels: 1e10,
  bestEffort: true, tileScale: 2
});

var q1 = ee.Number(qs.get('elevation_p33'));
var q2 = ee.Number(qs.get('elevation_p67'));

var band250 = srtm
  .where(srtm.lte(q1), 1).where(srtm.gt(q1).and(srtm.lte(q2)), 2)
  .where(srtm.gt(q2), 3)
  .rename('elev_band')
  .reduceResolution({reducer: ee.Reducer.mode(), maxPixels: 1024})  // Reduced maxPixels
  .reproject({crs: 'EPSG:4326', scale: 250});

// --------------------- 3) COMBINED TERRA+AQUA for PHENOLOGY ---------------------
function preparePhenologyCollection(collectionId, satelliteName) {
  return ee.ImageCollection(collectionId)
    .filterBounds(catGeom).filterDate(START, END)
    .map(function(img){
      var qa = img.select('SummaryQA');
      var keep = qa.lte(1);  // Good + Marginal quality
      var evi = img.select('EVI').multiply(0.0001).rename('EVI');
      
      return ee.Image().addBands(evi)
               .updateMask(keep)
               .set({
                 'satellite': satelliteName,
                 'year': img.date().get('year'),
                 'doy': img.date().getRelative('day', 'year')
               })
               .copyProperties(img, ['system:time_start']);
    });
}

var terraCol = preparePhenologyCollection('MODIS/061/MOD13Q1', 'Terra');
var aquaCol = preparePhenologyCollection('MODIS/061/MYD13Q1', 'Aqua');
var modisCol = terraCol.merge(aquaCol).sort('system:time_start');

print('=== PHENOLOGY DATA SUMMARY ===');
print('Terra observations:', terraCol.size());
print('Aqua observations:', aquaCol.size());
print('Combined observations:', modisCol.size());
print('Expected temporal resolution: ~8 days');
print('Elevation bands: 1=Low(≤' + q1.getInfo() + 'm), 2=Mid, 3=High(≥' + q2.getInfo() + 'm)');

// Add elevation band to each image
var modisWithBand = modisCol.map(function(img){
  return img.addBands(band250);
});

// --------------------- 4) CSV Export for PhenoFit ---------------------
function exportPhenologyData() {
  // Option A: Per-pixel time series (ideal for phenofit)
  var pts = ee.Image.random(42).addBands(ee.Image.pixelLonLat())
    .sample({
      region: catGeom, 
      scale: 250, 
      numPixels: 2000,  // Reduced from 5000
      geometries: true,
      tileScale: 2
    })
    .sort('random').limit(N_SAMPLES);
  
  function sampleForPhenology(img) {
    var dateStr = img.date().format('YYYY-MM-dd');
    return img.select(['EVI','elev_band']).sampleRegions({
      collection: pts, 
      scale: 250, 
      geometries: false,
      tileScale: 2
    }).map(function(f){
      return f.set({
        'date': dateStr,
        'satellite': img.get('satellite'),
        'year': img.date().get('year'),
        'doy': img.date().getRelative('day', 'year')
      });
    });
  }
  
  var phenoPts = ee.FeatureCollection(modisWithBand.map(sampleForPhenology)).flatten();
  
  Export.table.toDrive({
    collection: phenoPts,
    description: 'CAT_Phenology_Points_Combined',
    fileFormat: 'CSV',
    selectors: ['date', 'year', 'doy', 'EVI', 'elev_band', 'satellite', 'longitude', 'latitude']
  });
  
  // Option B: Elevation-band aggregated time series
  function bandPhenologyStats(img) {
    var dateStr = img.date().format('YYYY-MM-dd');
    var im = img.select('EVI').addBands(band250);
    
    var grouped = im.reduceRegion({
      reducer: ee.Reducer.mean().combine(ee.Reducer.stdDev(), '', true)
                 .combine(ee.Reducer.count(), '', true)
                 .group(1, 'elev_band'),
      geometry: catGeom, 
      scale: 250, 
      maxPixels: 1e9,
      bestEffort: true,
      tileScale: 4
    });
    
    var groups = ee.List(grouped.get('groups'));
    return ee.FeatureCollection(groups.map(function(d){
      d = ee.Dictionary(d);
      return ee.Feature(null, {
        date: dateStr, 
        year: img.date().get('year'), 
        doy: img.date().getRelative('day', 'year'),
        satellite: img.get('satellite'), 
        elev_band: d.get('elev_band'),
        EVI_mean: d.get('mean'), 
        EVI_std: d.get('stdDev'), 
        n_pixels: d.get('count')
      });
    }));
  }
  
  var bandPheno = ee.FeatureCollection(modisWithBand.map(bandPhenologyStats)).flatten();
  
  Export.table.toDrive({
    collection: bandPheno,
    description: 'CAT_Phenology_ElevBands_Combined',
    fileFormat: 'CSV'
  });
}

exportPhenologyData();

// --------------------- 5) FIXED Map Visualization ---------------------
// Use a smaller time period for median calculation to avoid memory issues
var recentPeriod = modisCol.filterDate('2020-01-01', '2023-12-31');
var eviMedian = recentPeriod.select('EVI').median().clip(catGeom);

// Get stats for visualization bounds
var eviStats = eviMedian.reduceRegion({
  reducer: ee.Reducer.percentile([2, 98]),  // Use 2nd and 98th percentiles for robust min/max
  geometry: catGeom,
  scale: 250,
  bestEffort: true,
  tileScale: 2,
  maxPixels: 1e8
});

var vmin = ee.Number(eviStats.get('EVI_p2')).getInfo();
var vmax = ee.Number(eviStats.get('EVI_p98')).getInfo();

print('EVI visualization range:', {min: vmin, max: vmax});

Map.centerObject(catGeom, 9);
Map.addLayer(eviMedian, {min: vmin, max: vmax, palette: eviPalette}, 'Median EVI - Combined (2020-2023)');
Map.addLayer(band250, {min: 1, max: 3, palette: ['#9ecae1','#6baed6','#2171b5']}, 'Elevation Bands');

// --------------------- 6) Data Quality Check ---------------------
// Check data distribution by year and satellite
var years = ee.List.sequence(2003, 2023);
var dataSummary = years.map(function(year) {
  var yearData = modisCol.filter(ee.Filter.calendarRange(year, year, 'year'));
  var terraCount = terraCol.filter(ee.Filter.calendarRange(year, year, 'year')).size();
  var aquaCount = aquaCol.filter(ee.Filter.calendarRange(year, year, 'year')).size();
  
  return ee.Feature(null, {
    year: year,
    total_obs: yearData.size(),
    terra_obs: terraCount,
    aqua_obs: aquaCount,
    data_density: yearData.size().divide(23)  // Approx observations per 16-day period
  });
});

print('Annual data summary:', ee.FeatureCollection(dataSummary));

print('=== PHENOLOGY ANALYSIS READY ===');
print('1. Use CAT_Phenology_Points_Combined.csv for pixel-level phenofit analysis');
print('2. Use CAT_Phenology_ElevBands_Combined.csv for elevation-band trends');
print('3. Using 2020-2023 period for visualization to avoid memory issues');
print('4. Full 2000-2024 data is available for export and analysis');

// ================== End ==================