/**
 * Waypoint Zero — Mock GPS Engine
 * ================================
 * Simulates GPS movement through waypoints for offline testing.
 * Fires real geofence events by updating GeofenceManager with
 * fake positions, so the adventure plays out exactly as if walking.
 * 
 * Usage:
 *   const mock = new MockGPSEngine(geofenceManager, {
 *     waypoints: S.waypoints,
 *     speed: 1.4,        // m/s (walking pace)
 *     debug: true,
 *   });
 *   mock.start();
 *   mock.stop();
 */

class MockGPSEngine {
  /**
   * @param {GeofenceManager} geofence
   * @param {Object} opts
   * @param {Array} opts.waypoints - mission waypoints [{lat, lng, name}]
   * @param {number} [opts.speed=1.4] - meters per second
   * @param {number} [opts.pauseAtWaypoint=2000] - ms to pause at each capture
   * @param {number} [opts.startLat] - starting lat (default: first waypoint - 300m)
   * @param {number} [opts.startLng] - starting lng
   * @param {boolean} [opts.debug=false]
   * @param {function} [opts.onTick] - called with {lat, lng, wpIdx, distToWP}
   * @param {function} [opts.onComplete] - called when all waypoints visited
   */
  constructor(geofence, opts = {}) {
    this.gf = geofence;
    this.waypoints = opts.waypoints || [];
    this.speed = opts.speed || 1.4;
    this.pauseAtWaypoint = opts.pauseAtWaypoint || 2000;
    this.debug = opts.debug || false;
    this.onTick = opts.onTick || (() => {});
    this.onComplete = opts.onComplete || (() => {});

    this._active = false;
    this._currentWp = 0;
    this._interval = null;
    this._paused = false;
    this._pausedUntil = 0;

    // Calculate start position (300m north-west of first waypoint)
    if (this.waypoints.length > 0) {
      const wp0 = this.waypoints[0];
      if (opts.startLat != null && opts.startLng != null) {
        this._lat = opts.startLat;
        this._lng = opts.startLng;
      } else {
        // ~300m NW of first waypoint
        const pt = this._destinationPoint(wp0.lat, wp0.lng, 300, 315);
        this._lat = pt.lat;
        this._lng = pt.lng;
      }
    } else {
      this._lat = 47.33;
      this._lng = 9.41;
    }

    this._tickInterval = 500; // ms between position updates
    this._log('MockGPS created');
  }

  start() {
    if (this._active) return;
    this._active = true;
    this._currentWp = 0;

    // Feed initial position
    this._feedPosition();

    // Start walking
    this._interval = setInterval(() => this._tick(), this._tickInterval);
    this._log('MockGPS started — walking waypoints');
  }

  stop() {
    this._active = false;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._log('MockGPS stopped');
  }

  pause(ms) {
    this._paused = true;
    this._pausedUntil = Date.now() + ms;
  }

  /** @returns {boolean} */
  get isActive() { return this._active; }

  /** @returns {number} current waypoint index */
  get currentWaypoint() { return this._currentWp; }

  // ═══ PRIVATE ═══

  _tick() {
    if (!this._active) return;
    if (this._paused) {
      if (Date.now() < this._pausedUntil) return;
      this._paused = false;
    }

    if (this._currentWp >= this.waypoints.length) {
      this._log('All waypoints visited');
      this.onComplete();
      this.stop();
      return;
    }

    const target = this.waypoints[this._currentWp];
    const d = this._dist(this._lat, this._lng, target.lat, target.lng);

    if (d < 10) {
      // Arrived — pause briefly, then advance
      this._log(`Arrived at WP${this._currentWp}: ${target.name}`);
      this.pause(this.pauseAtWaypoint);
      this._currentWp++;
      return;
    }

    // Move toward target
    const step = this.speed * (this._tickInterval / 1000); // meters per tick
    const bear = this._bearing(this._lat, this._lng, target.lat, target.lng);
    const newPt = this._destinationPoint(this._lat, this._lng, Math.min(step, d), bear);

    this._lat = newPt.lat;
    this._lng = newPt.lng;

    this._feedPosition();
  }

  _feedPosition() {
    // Feed fake position to geofence manager
    const pos = {
      coords: {
        latitude: this._lat,
        longitude: this._lng,
        accuracy: 5,
        heading: this._currentWp < this.waypoints.length
          ? this._bearing(this._lat, this._lng, this.waypoints[this._currentWp].lat, this.waypoints[this._currentWp].lng)
          : 0,
        speed: this.speed,
      },
      timestamp: Date.now(),
    };

    // Directly invoke the geofence position handler
    if (this.gf._onPosition) {
      this.gf._onPosition(pos);
    }

    const target = this._currentWp < this.waypoints.length ? this.waypoints[this._currentWp] : null;
    const distToWP = target ? this._dist(this._lat, this._lng, target.lat, target.lng) : -1;

    this.onTick({
      lat: this._lat,
      lng: this._lng,
      wpIdx: this._currentWp,
      distToWP,
    });
  }

  // ═══ GEO MATH ═══

  _dist(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180, Δλ = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  _bearing(lat1, lng1, lat2, lng2) {
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }

  _destinationPoint(lat, lng, distM, bearingDeg) {
    const R = 6371000;
    const δ = distM / R;
    const θ = bearingDeg * Math.PI / 180;
    const φ1 = lat * Math.PI / 180;
    const λ1 = lng * Math.PI / 180;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
    return { lat: φ2 * 180 / Math.PI, lng: λ2 * 180 / Math.PI };
  }

  _log(msg) {
    if (this.debug) console.log(`[MockGPS] ${msg}`);
  }
}

// Export globally
if (typeof window !== 'undefined') {
  window.MockGPSEngine = MockGPSEngine;
}
