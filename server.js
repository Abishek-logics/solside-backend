const express = require('express');
const cors = require('cors');
const axios = require('axios');
const SunCalc = require('suncalc');

const app = express();

app.use(cors());
app.use(express.json());

// Helper 1: Calculate initial bearing between two GPS coordinates (in degrees 0-360)
function calculateBearing(startLat, startLng, destLat, destLng) {
  const startLatRad = (startLat * Math.PI) / 180;
  const destLatRad = (destLat * Math.PI) / 180;
  const dLngRad = ((destLng - startLng) * Math.PI) / 180;

  const y = Math.sin(dLngRad) * Math.cos(destLatRad);
  const x =
    Math.cos(startLatRad) * Math.sin(destLatRad) -
    Math.sin(startLatRad) * Math.cos(destLatRad) * Math.cos(dLngRad);

  const bearingRad = Math.atan2(y, x);
  return ((bearingRad * 180) / Math.PI + 360) % 360;
}

// Helper 2: Calculate distance between two GPS points in meters (Haversine Formula)
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

app.post('/api/v1/predict-shade', async (req, res) => {
  try {
    const { origin_lat, origin_lng, dest_lat, dest_lng, departure_time, via_lat, via_lng } = req.body;

    if (!origin_lat || !origin_lng || !dest_lat || !dest_lng || !departure_time) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: origin_lat, origin_lng, dest_lat, dest_lng, departure_time'
      });
    }

    // 1. Build OSRM route URL
    let coordinatesPath = `${origin_lng},${origin_lat}`;
    if (via_lat && via_lng) {
      coordinatesPath += `;${via_lng},${via_lat}`;
    }
    coordinatesPath += `;${dest_lng},${dest_lat}`;

    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coordinatesPath}?overview=full&geometries=geojson`;
    const routeResponse = await axios.get(osrmUrl);

    if (!routeResponse.data.routes || routeResponse.data.routes.length === 0) {
      return res.status(404).json({ status: 'error', message: 'No route found between coordinates.' });
    }

    const routeData = routeResponse.data.routes[0];
    const carDurationSeconds = routeData.duration;
    const coordinates = routeData.geometry.coordinates; // Array of [lng, lat]

    // Bus speed correction factor (1.55x for intercity transit)
    const BUS_SPEED_FACTOR = 1.55;
    const busDurationSeconds = carDurationSeconds * BUS_SPEED_FACTOR;
    const totalDistanceMeters = routeData.distance;

    const startTime = new Date(departure_time);

    let rightShadeTimeSeconds = 0;
    let leftShadeTimeSeconds = 0;
    let totalSampledTimeSeconds = 0;

    const segmentCount = coordinates.length - 1;

    // First pass: calculate total geometry distance across segments
    let totalGeometryMeters = 0;
    const segmentDistances = [];
    for (let i = 0; i < segmentCount; i++) {
      const [startLng, startLat] = coordinates[i];
      const [endLng, endLat] = coordinates[i + 1];
      const dist = calculateDistanceMeters(startLat, startLng, endLat, endLng);
      segmentDistances.push(dist);
      totalGeometryMeters += dist;
    }

    let accumulatedTimeSeconds = 0;

    // 2. Evaluate each road segment mathematically weighted by time
    for (let i = 0; i < segmentCount; i++) {
      const [startLng, startLat] = coordinates[i];
      const [endLng, endLat] = coordinates[i + 1];

      const segmentDist = segmentDistances[i];
      if (segmentDist === 0) continue;

      // Fraction of total journey time spent on this segment
      const segmentTimeFraction = totalGeometryMeters > 0 ? segmentDist / totalGeometryMeters : 1 / segmentCount;
      const segmentDurationSeconds = busDurationSeconds * segmentTimeFraction;

      // Time at the midpoint of this segment
      const segmentMidpointTime = new Date(startTime.getTime() + (accumulatedTimeSeconds + segmentDurationSeconds / 2) * 1000);
      accumulatedTimeSeconds += segmentDurationSeconds;

      // Bus heading direction (0° = North, 90° = East, 180° = South, 270° = West)
      const busHeading = calculateBearing(startLat, startLng, endLat, endLng);

      // Get accurate solar coordinates using SunCalc
      const sunPos = SunCalc.getPosition(segmentMidpointTime, startLat, startLng);
      
      // SunCalc returns azimuth in radians measured from South (-pi to +pi).
      // Standard geographic azimuth: 0° = North, 90° = East, 180° = South, 270° = West.
      const sunAzimuthDeg = ((sunPos.azimuth * (180 / Math.PI)) + 180) % 360;
      const sunElevationDeg = sunPos.altitude * (180 / Math.PI);

      // If the sun is below the horizon (night travel), no direct sun hits either side
      if (sunElevationDeg <= 0) {
        leftShadeTimeSeconds += segmentDurationSeconds / 2;
        rightShadeTimeSeconds += segmentDurationSeconds / 2;
        totalSampledTimeSeconds += segmentDurationSeconds;
        continue;
      }

      // Mathematical Relative Azimuth (Sun angle relative to Bus Heading)
      // 0° = Sun directly in front
      // 90° = Sun directly on the RIGHT side of bus (Right gets sun -> LEFT gets shade)
      // 180° = Sun directly behind
      // 270° = Sun directly on the LEFT side of bus (Left gets sun -> RIGHT gets shade)
      const relativeSunAngle = (sunAzimuthDeg - busHeading + 360) % 360;

      if (relativeSunAngle > 0 && relativeSunAngle < 180) {
        // Sun is on the RIGHT side of the bus -> LEFT side is shaded
        leftShadeTimeSeconds += segmentDurationSeconds;
      } else if (relativeSunAngle > 180 && relativeSunAngle < 360) {
        // Sun is on the LEFT side of the bus -> RIGHT side is shaded
        rightShadeTimeSeconds += segmentDurationSeconds;
      } else {
        // Sun directly ahead or behind -> split evenly
        leftShadeTimeSeconds += segmentDurationSeconds / 2;
        rightShadeTimeSeconds += segmentDurationSeconds / 2;
      }

      totalSampledTimeSeconds += segmentDurationSeconds;
    }

    const avgLeftShade = Math.round((leftShadeTimeSeconds / totalSampledTimeSeconds) * 100);
    const avgRightShade = 100 - avgLeftShade;
    const recommendedSide = avgLeftShade >= avgRightShade ? 'LEFT' : 'RIGHT';

    return res.json({
      status: 'success',
      engine: 'SolSide-v3-Universal-Vector',
      route_details: {
        distance_km: (totalDistanceMeters / 1000).toFixed(2),
        estimated_bus_duration_minutes: Math.round(busDurationSeconds / 60),
        estimated_bus_duration_hours: (busDurationSeconds / 3600).toFixed(1)
      },
      recommended_side: recommendedSide,
      left_side_shade_percentage: avgLeftShade,
      right_side_shade_percentage: avgRightShade,
      badge_label: `${recommendedSide === 'LEFT' ? avgLeftShade : avgRightShade}% Shaded Route`
    });

  } catch (error) {
    console.error('Shade Calculation Error:', error.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error processing route.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SolSide backend listening on port ${PORT}`);
});