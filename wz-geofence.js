/**
 * Waypoint Zero — Geofence Tracker
 * ================================
 * Real-time geofencing service for GPS-based audio adventure.
 * 
 * Architecture:
 *   - Zone registry: concentric circular zones around each waypoint
 *   - Efficient distance checks via Haversine + zone sorting
 *   - Event-driven: fire 'enter'/'exit'/'cross' events at thresholds
 *   - Battery-aware: adaptive GPS accuracy, WakeLock, visibility handling
 * 
 * Design spec thresholds (from waypoint-zero-design-doc.md):
 *   200m — PERIMETER (atmospheric narrative, low tension)
 *   100m — APPROACH (elevated tension, voice: whisper→tactical transition)
 *    60m — ENGAGEMENT (high tension, heartbeat increases)
 *    30m — HOT_ZONE (very high tension, rapid breathing)
 *    25m — GO_TRIGGER (whisper→shout GO! sequence)
 *    15m — CAPTURE (waypoint auto-advance, objective secured)
 *
 * Each waypoint defines 6 concentric geofence rings.
 * The tracker fires events as the player crosses each threshold.
 */

class GeofenceManager {

  /**
   * Predefined zone threshold definitions.
   * Ordered outermost→innermost (important for crossing detection).
   */
  static THRESHOLDS = Object.freeze([
    { id: 'perimeter',   radius: 200, label: 'PERIMETER',   tension: 0.15, voice: 'whisper',  heartbeat: 52, desc: 'Atmospheric narrative zone' },
    { id: 'approach',    radius: 100, label: 'APPROACH',    tension: 0.35, voice: 'tactical', heartbeat: 58, desc: 'Elevated tension, comms active' },
    { id: 'engagement',  radius: 60,  label: 'ENGAGEMENT',  tension: 0.60, voice: 'tactical', heartbeat: 70, desc: 'High tension, rapid updates' },
    { id: 'hot_zone',    radius: 30,  label: 'HOT ZONE',    tension: 0.80, voice: 'alert',    heartbeat: 90, desc: 'Critical proximity' },
    { id: 'go_trigger',  radius: 25,  label: 'GO TRIGGER',  tension: 0.90, voice: 'shout',    heartbeat: 100,desc: 'Whisper→GO! sequence' },
    { id: 'capture',     radius: 15,  label: 'CAPTURE',     tension: 0.95, voice: 'shout',    heartbeat: 120,desc: 'Objective secured' },
  ]);

  constructor() {
    /** @type {Map<string, GeofenceZone>} zoneId → zone metadata */
    this._zoneIndex = new Map();

    /** @type {Set<string>} set of zone IDs the player is currently inside */
    this._inside = new Set();

    /** @type {Map<string, Set<string>>} eventName → Set<callback> */
    this._listeners = new Map();

    /** @type {{lat: number, lng: number, accuracy: number, timestamp: number}|null} */
    this._lastPosition = null;

    /** @type {boolean} */
    this._active = false;

    /** @type {number} minimum distance to travel before re-checking (meters) */
    this._minMovement = 3;

    /** @type {number} interval between full zone checks even when stationary (ms) */
    this._stationaryCheckMs = 5000;

    /** @type {number|null} stationary check timer */
    this._stationaryTimer = null;

    /** @type {WakeLockSentinel|null} screen wake lock */
    this._wakeLock = null;

    /** @type {number} current watchPosition ID */
    this._watchId = null;

    /** @type {boolean} high accuracy mode for GPS */
    this._highAccuracy = true;

    // Stats
    this.stats = {
      positions: 0,
      zoneEntries: 0,
      zoneExits: 0,
      eventsFired: 0,
      startTime: null,
    };
  }

  // ============================================================
  //  ZONE MANAGEMENT
  // ============================================================

  /**
   * Register a geofence zone.
   * @param {string} id - Unique zone identifier
   * @param {number} lat - Center latitude
   * @param {number} lng - Center longitude
   * @param {number} radiusM - Radius in meters
   * @param {string} name - Human-readable name
   * @param {string} type - Zone type (from THRESHOLDS keys)
   * @param {number} [parentWpIdx] - Index of parent waypoint
   * @param {Object} [meta] - Extra metadata
   * @returns {GeofenceManager} this (chainable)
   */
  addZone(id, lat, lng, radiusM, name, type, parentWpIdx, meta) {
    this._zoneIndex.set(id, {
      id,
      lat,
      lng,
      radius: radiusM,
      name,
      type,
      parentWpIdx: parentWpIdx ?? -1,
      meta: meta || {},
    });
    return this;
  }

  /**
   * Build concentric zones around a waypoint.
   * Creates 6 nested zones (one per THRESHOLD).
   * @param {number} wpIdx - Waypoint index
   * @param {number} lat - Waypoint latitude
   * @param {number} lng - Waypoint longitude
   * @param {string} wpName - Waypoint display name
   * @returns {string[]} array of created zone IDs (outermost→innermost)
   */
  createWaypointZones(wpIdx, lat, lng, wpName) {
    const ids = [];
    for (const t of GeofenceManager.THRESHOLDS) {
      const zoneId = `wp${wpIdx}_${t.id}`;
      this.addZone(
        zoneId, lat, lng, t.radius,
        `${wpName} · ${t.label}`,
        t.id,
        wpIdx,
        { threshold: t }
      );
      ids.push(zoneId);
    }
    return ids;
  }

  /**
   * Build zones for all waypoints in a mission.
   * @param {Array<{lat:number, lng:number, name:string}>} waypoints
   * @returns {string[][]} nested array of zone IDs per waypoint
   */
  buildMissionZones(waypoints) {
    this.clearZones();
    return waypoints.map((wp, i) =>
      this.createWaypointZones(i, wp.lat, wp.lng, wp.name)
    );
  }

  /** Remove all registered zones. */
  clearZones() {
    this._zoneIndex.clear();
    this._inside.clear();
  }

  /** @returns {number} total number of registered zones */
  get zoneCount() {
    return this._zoneIndex.size;
  }

  /** @returns {Set<string>} IDs of zones currently occupied */
  get occupiedZones() {
    return new Set(this._inside);
  }

  /**
   * Check if player is inside a specific zone.
   * @param {string} zoneId
   * @returns {boolean}
   */
  isInside(zoneId) {
    return this._inside.has(zoneId);
  }

  /**
   * Get the innermost zone the player occupies for a given waypoint.
   * @param {number} wpIdx
   * @returns {{zone: GeofenceZone, threshold: Object}|null}
   */
  getInnermostZone(wpIdx) {
    const thresholds = GeofenceManager.THRESHOLDS;
    // Check from innermost → outermost; stop at first occupied
    for (let i = thresholds.length - 1; i >= 0; i--) {
      const zoneId = `wp${wpIdx}_${thresholds[i].id}`;
      if (this._inside.has(zoneId)) {
        return {
          zone: this._zoneIndex.get(zoneId),
          threshold: thresholds[i],
        };
      }
    }
    return null;
  }

  // ============================================================
  //  POSITION UPDATES & ZONE DETECTION
  // ============================================================

  /**
   * Feed a new GPS position to the geofence tracker.
   * Checks all zones for enter/exit events.
   * @param {number} lat
   * @param {number} lng
   * @param {number} [accuracy] - GPS accuracy in meters
   * @param {number} [timestamp] - epoch ms
   */
  updatePosition(lat, lng, accuracy, timestamp) {
    const now = timestamp || Date.now();
    const pos = { lat, lng, accuracy: accuracy || 0, timestamp: now };

    // Skip if position hasn't changed meaningfully and we're in a fast-update loop
    if (this._lastPosition) {
      const moved = GeofenceManager._haversineDist(
        this._lastPosition.lat, this._lastPosition.lng, lat, lng
      );
      if (moved < this._minMovement) {
        // Still record position but skip full zone check for performance
        this._lastPosition = pos;
        return;
      }
    }

    this._lastPosition = pos;
    this.stats.positions++;

    // Check all registered zones
    const newlyInside = new Set();
    const newlyOutside = new Set();

    for (const [zoneId, zone] of this._zoneIndex) {
      const d = GeofenceManager._haversineDist(lat, lng, zone.lat, zone.lng);
      const wasInside = this._inside.has(zoneId);
      const isInside = d <= zone.radius;

      if (isInside && !wasInside) {
        newlyInside.add(zoneId);
      } else if (!isInside && wasInside) {
        newlyOutside.add(zoneId);
      }
    }

    // Update state
    for (const id of newlyInside) this._inside.add(id);
    for (const id of newlyOutside) this._inside.delete(id);

    // Fire events
    this._fireEnterEvents(newlyInside);
    this._fireExitEvents(newlyOutside);

    // Restart stationary check timer
    this._resetStationaryTimer();
  }

  /**
   * Force a full re-check of all zones against the last known position.
   * Useful after zone definitions change mid-mission.
   */
  forceRecheck() {
    if (!this._lastPosition) return;
    const { lat, lng, accuracy, timestamp } = this._lastPosition;
    // Temporarily zero minMovement to force check
    const saved = this._minMovement;
    this._minMovement = 0;
    this.updatePosition(lat, lng, accuracy, timestamp);
    this._minMovement = saved;
  }

  /** @returns {{lat, lng, accuracy, timestamp}|null} */
  get lastPosition() {
    return this._lastPosition ? { ...this._lastPosition } : null;
  }

  // ============================================================
  //  EVENT SYSTEM
  // ============================================================

  /**
   * Subscribe to geofence events.
   * @param {'enter'|'exit'|'cross'} eventName
   * @param {(event: GeofenceEvent) => void} callback
   * @returns {() => void} unsubscribe function
   */
  on(eventName, callback) {
    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, new Set());
    }
    this._listeners.get(eventName).add(callback);
    return () => this._listeners.get(eventName)?.delete(callback);
  }

  /**
   * Subscribe to a specific zone type crossing.
   * @param {string} type - Zone type (e.g. 'go_trigger', 'capture')
   * @param {'enter'|'exit'} direction
   * @param {(event: GeofenceEvent) => void} callback
   * @returns {() => void} unsubscribe
   */
  onZoneType(type, direction, callback) {
    return this.on(direction, (event) => {
      if (event.zoneType === type) callback(event);
    });
  }

  /**
   * Subscribe to waypoint proximity changes (entering ANY zone of a WP).
   * @param {number} wpIdx
   * @param {(event: GeofenceEvent) => void} callback
   * @returns {() => void} unsubscribe
   */
  onWaypointProximity(wpIdx, callback) {
    return this.on('enter', (event) => {
      if (event.parentWpIdx === wpIdx) callback(event);
    });
  }

  /** @private */
  _fireEnterEvents(zoneIds) {
    for (const id of zoneIds) {
      const zone = this._zoneIndex.get(id);
      if (!zone) continue;
      const event = this._makeEvent('enter', zone);
      this.stats.eventsFired++;
      this.stats.zoneEntries++;
      this._emit('enter', event);
      this._emit('cross', { ...event, direction: 'enter' });
    }
  }

  /** @private */
  _fireExitEvents(zoneIds) {
    for (const id of zoneIds) {
      const zone = this._zoneIndex.get(id);
      if (!zone) continue;
      const event = this._makeEvent('exit', zone);
      this.stats.eventsFired++;
      this.stats.zoneExits++;
      this._emit('exit', event);
      // Only fire 'cross' for meaningful exits (leaving capture zone, etc.)
      if (zone.radius <= 30) {
        this._emit('cross', { ...event, direction: 'exit' });
      }
    }
  }

  /** @private */
  _makeEvent(dir, zone) {
    const dist = this._lastPosition
      ? GeofenceManager._haversineDist(
          this._lastPosition.lat, this._lastPosition.lng, zone.lat, zone.lng
        )
      : zone.radius;

    return {
      direction: dir,
      zoneId: zone.id,
      zoneType: zone.type,
      zoneName: zone.name,
      zoneRadius: zone.radius,
      parentWpIdx: zone.parentWpIdx,
      lat: zone.lat,
      lng: zone.lng,
      distanceToCenter: Math.round(dist),
      playerPosition: this._lastPosition
        ? { lat: this._lastPosition.lat, lng: this._lastPosition.lng }
        : null,
      timestamp: Date.now(),
      meta: zone.meta || {},
    };
  }

  /** @private */
  _emit(eventName, event) {
    const cbs = this._listeners.get(eventName);
    if (cbs) {
      for (const cb of cbs) {
        try { cb(event); } catch (e) {
          console.warn('[Geofence] listener error:', e.message);
        }
      }
    }
  }

  /** @private */
  _resetStationaryTimer() {
    if (this._stationaryTimer) clearTimeout(this._stationaryTimer);
    this._stationaryTimer = setTimeout(() => {
      if (this._active && this._lastPosition) {
        this.forceRecheck();
      }
    }, this._stationaryCheckMs);
  }

  // ============================================================
  //  GPS TRACKING (watchPosition wrapper)
  // ============================================================

  /**
   * Start continuous GPS tracking via watchPosition.
   * Feeds all positions into the geofence update pipeline.
   * @param {Object} [opts]
   * @param {boolean} [opts.highAccuracy=true]
   * @param {number} [opts.maximumAge=1500] - ms, max cached position age
   * @param {number} [opts.timeout=10000] - ms, max wait for position
   * @returns {boolean} whether tracking started successfully
   */
  startTracking(opts = {}) {
    if (this._active) return true;
    if (!navigator.geolocation) {
      console.warn('[Geofence] Geolocation not available');
      return false;
    }

    this._highAccuracy = opts.highAccuracy !== false;
    this._active = true;
    this.stats.startTime = Date.now();

    const options = {
      enableHighAccuracy: this._highAccuracy,
      maximumAge: opts.maximumAge ?? 1500,
      timeout: opts.timeout ?? 10000,
    };

    let prevLat = null, prevLng = null;

    this._watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const acc = pos.coords.accuracy;

        // Feed to geofence pipeline
        this.updatePosition(lat, lng, acc, pos.timestamp);

        // GPS-derived heading (fallback when compass unavailable)
        if (prevLat !== null && prevLng !== null) {
          const d = GeofenceManager._haversineDist(prevLat, prevLng, lat, lng);
          if (d > 5) {
            const h = GeofenceManager._bearing(prevLat, prevLng, lat, lng);
            this._emit('heading_update', { heading: h, speed: d, timestamp: Date.now() });
          }
        }
        prevLat = lat;
        prevLng = lng;
      },
      (err) => {
        this._emit('gps_error', { code: err.code, message: err.message });
        // Degrade to lower accuracy after repeated failures
        if (this._highAccuracy && this.stats.positions < 3) {
          console.warn('[Geofence] High accuracy failed, falling back to coarse');
          this._highAccuracy = false;
          // Re-register with lower accuracy by stopping and restarting
          this.stopTracking();
          setTimeout(() => this.startTracking({ highAccuracy: false }), 500);
        }
      },
      options
    );

    // Acquire screen wake lock to prevent device sleep during mission
    this._acquireWakeLock();

    // Listen for visibility changes (app going to background)
    this._bindVisibilityHandler();

    this._emit('tracking_started', { highAccuracy: this._highAccuracy });

    return true;
  }

  /**
   * Stop GPS tracking.
   */
  stopTracking() {
    this._active = false;
    if (this._watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this._watchId);
      this._watchId = null;
    }
    if (this._stationaryTimer) {
      clearTimeout(this._stationaryTimer);
      this._stationaryTimer = null;
    }
    this._releaseWakeLock();
    this._unbindVisibilityHandler();
    this._emit('tracking_stopped', { stats: { ...this.stats } });
  }

  /**
   * Adapt GPS accuracy for battery saving.
   * Call this when tension is low (far from waypoints).
   * @param {boolean} high - true = high accuracy, false = battery save
   */
  setAccuracy(high) {
    if (high === this._highAccuracy) return;
    this._highAccuracy = high;
    // Re-register watchPosition with new settings
    if (this._active) {
      const lastPos = this._lastPosition;
      this.stopTracking();
      this.startTracking({ highAccuracy: this._highAccuracy });
      // Restore last position so we don't lose state
      if (lastPos) {
        this._lastPosition = lastPos;
      }
    }
  }

  /** @returns {boolean} */
  get isTracking() {
    return this._active;
  }

  // ============================================================
  //  BATTERY & BACKGROUND OPTIMIZATION
  // ============================================================

  /** @private */
  async _acquireWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this._wakeLock = await navigator.wakeLock.request('screen');
        this._wakeLock.addEventListener('release', () => {
          // Attempt to re-acquire if mission still active
          if (this._active) {
            setTimeout(() => this._acquireWakeLock(), 2000);
          }
        });
      } catch (e) {
        // WakeLock may not be available (e.g., battery saver mode)
        // This is non-critical — GPS still works without it
      }
    }
  }

  /** @private */
  async _releaseWakeLock() {
    if (this._wakeLock) {
      try { await this._wakeLock.release(); } catch (e) { /* ignore */ }
      this._wakeLock = null;
    }
  }

  _visibilityHandler = null;

  /** @private */
  _bindVisibilityHandler() {
    this._visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        // App came back to foreground — re-acquire wake lock and recheck
        if (this._active) {
          this._acquireWakeLock();
          // Force a position re-check after returning
          setTimeout(() => this.forceRecheck(), 1500);
          this._emit('app_foreground', { timestamp: Date.now() });
        }
      } else {
        // App going to background — release wake lock to save battery
        this._releaseWakeLock();
        this._emit('app_background', { timestamp: Date.now() });
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  /** @private */
  _unbindVisibilityHandler() {
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
  }

  // ============================================================
  //  STATIC UTILITY: HAVERSINE DISTANCE (optimized, no Math.pow)
  // ============================================================

  /**
   * Haversine distance between two lat/lng points in meters.
   */
  static _haversineDist(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const φ1 = lat1 * 0.017453292519943295; // * π/180
    const φ2 = lat2 * 0.017453292519943295;
    const Δφ = (lat2 - lat1) * 0.017453292519943295;
    const Δλ = (lng2 - lng1) * 0.017453292519943295;
    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) *
      Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Bearing between two points (0–360°, 0 = north).
   */
  static _bearing(lat1, lng1, lat2, lng2) {
    const φ1 = lat1 * 0.017453292519943295;
    const φ2 = lat2 * 0.017453292519943295;
    const Δλ = (lng2 - lng1) * 0.017453292519943295;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x =
      Math.cos(φ1) * Math.sin(φ2) -
      Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 57.29577951308232) + 360) % 360;
  }

  /**
   * Destination point from origin given distance and bearing.
   */
  static destinationPoint(lat, lng, distanceM, bearingDeg) {
    const R = 6371000;
    const δ = distanceM / R;
    const θ = bearingDeg * 0.017453292519943295;
    const φ1 = lat * 0.017453292519943295;
    const λ1 = lng * 0.017453292519943295;
    const φ2 = Math.asin(
      Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
    );
    const λ2 =
      λ1 +
      Math.atan2(
        Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
        Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
      );
    return {
      lat: φ2 * 57.29577951308232,
      lng: λ2 * 57.29577951308232,
    };
  }
}

// ============================================================
//  ADVENTURE ENGINE INTEGRATION
// ============================================================
// Wire geofence events into the existing game systems:
// tension, voice mode, heartbeat, Tone.js score, narrative beats.

/**
 * Create an adventure engine integration that connects
 * GeofenceManager events to the game's existing systems.
 *
 * @param {GeofenceManager} geofence
 * @param {Object} gameSystems - hooks into the game
 * @param {Object} gameSystems.S - game state object (with tensionLevel, voiceMode, etc.)
 * @param {(text:string, mode:string, urgent?:boolean) => void} gameSystems.speak
 * @param {(level:number) => void} gameSystems.setTension
 * @param {(bpm:number, volume:number) => void} gameSystems.setHeartbeat
 * @param {(staticDur:number, vol:number) => void} gameSystems.playStatic
 * @returns {{ start: () => void, stop: () => void }}
 */
function wireGeofenceToAdventure(geofence, gameSystems) {
  const { S } = gameSystems;
  let unsubs = [];

  // ── TENSION & VOICE MODE on zone enter ──
  unsubs.push(geofence.on('enter', (event) => {
    const t = event.meta?.threshold;
    if (!t) return;

    // Update tension
    S.tensionLevel = t.tension;
    if (gameSystems.setTension) {
      gameSystems.setTension(t.tension);
    }

    // Update voice mode
    S.voiceMode = t.voice;

    // Update heartbeat
    if (gameSystems.setHeartbeat) {
      gameSystems.setHeartbeat(t.heartbeat, t.tension * 0.8);
    }
  }));

  // ── NARRATIVE BEAT on entering APPROACH zone ──
  unsubs.push(geofence.onZoneType('approach', 'enter', (event) => {
    // Already handled by the separate narrative engine (checkNarrativeBeat)
    // This is a secondary trigger for extra atmosphere
  }));

  // ── GO! SEQUENCE on GO_TRIGGER zone entry ──
  unsubs.push(geofence.onZoneType('go_trigger', 'enter', (event) => {
    if (!S.goTriggered) {
      S.goTriggered = true;
      // The existing triggerGoSequence() handles the full whisper→GO! arc
      if (typeof triggerGoSequence === 'function') {
        triggerGoSequence();
      }
    }
  }));

  // ── Reset goTriggered when leaving GO zone ──
  unsubs.push(geofence.onZoneType('go_trigger', 'exit', (event) => {
    S.goTriggered = false;
  }));

  // ── WAYPOINT CAPTURE on CAPTURE zone entry ──
  unsubs.push(geofence.onZoneType('capture', 'enter', (event) => {
    const wpIdx = event.parentWpIdx;
    if (wpIdx === S.currentWP && wpIdx < S.waypoints.length) {
      S.currentWP++;

      // Reset state
      S.goTriggered = false;

      // Clear alert banner
      const banner = document.getElementById('alert-banner');
      if (banner) banner.classList.remove('active');

      // Reset compass ring
      const ring = document.getElementById('compass-ring');
      if (ring) ring.className = 'compass-ring';

      if (S.currentWP >= S.waypoints.length) {
        // Mission complete!
        if (typeof endMission === 'function') {
          endMission(true);
        }
        return;
      }

      // Advance to next waypoint
      const next = S.waypoints[S.currentWP];
      if (gameSystems.setTension) {
        gameSystems.setTension(0.08);
      }
      if (gameSystems.speak && next.nav_text) {
        gameSystems.speak(next.nav_text, 'tactical');
      }
      setTimeout(() => {
        if (gameSystems.setTension) {
          gameSystems.setTension(0.15);
        }
      }, 2000);
    }
  }));

  // ── STATIC BURST on zone transitions for atmosphere ──
  unsubs.push(geofence.onZoneType('engagement', 'enter', (event) => {
    if (gameSystems.playStatic) {
      gameSystems.playStatic(0.15, 0.03);
    }
  }));

  unsubs.push(geofence.onZoneType('hot_zone', 'enter', (event) => {
    if (gameSystems.playStatic) {
      gameSystems.playStatic(0.25, 0.05);
    }
  }));

  // ── GPS DEGRADATION: lower accuracy when far from all waypoints ──
  let farFromAllTimer = null;
  unsubs.push(geofence.on('exit', (event) => {
    // When player leaves APPROACH zone of all waypoints,
    // consider dropping to lower GPS accuracy to save battery.
    // Check if ANY approach zone is still occupied
    const hasAnyApproach = Array.from(geofence.occupiedZones)
      .some(id => id.includes('_approach') || id.includes('_engagement') ||
                  id.includes('_hot_zone') || id.includes('_go_trigger') ||
                  id.includes('_capture'));

    if (!hasAnyApproach) {
      // Debounce: wait 30 seconds before lowering accuracy
      if (farFromAllTimer) clearTimeout(farFromAllTimer);
      farFromAllTimer = setTimeout(() => {
        if (!geofence.isTracking) return;
        const stillFar = !Array.from(geofence.occupiedZones)
          .some(id => id.includes('_engagement') || id.includes('_hot_zone') ||
                      id.includes('_go_trigger') || id.includes('_capture'));
        if (stillFar) geofence.setAccuracy(false);
      }, 30000);
    }
  }));

  // Restore high accuracy when approaching any waypoint
  unsubs.push(geofence.onZoneType('approach', 'enter', () => {
    if (farFromAllTimer) clearTimeout(farFromAllTimer);
    geofence.setAccuracy(true);
  }));

  return {
    /** Start the integration (called at mission deploy) */
    start() { /* listeners already active */ },
    /** Stop the integration (called at mission end) */
    stop() {
      unsubs.forEach(fn => { try { fn(); } catch(e) {} });
      unsubs = [];
      if (farFromAllTimer) clearTimeout(farFromAllTimer);
    },
    /** Get number of active listeners */
    get listenerCount() { return unsubs.length; },
  };
}

// Make available globally (single-file HTML pattern)
window.GeofenceManager = GeofenceManager;
window.wireGeofenceToAdventure = wireGeofenceToAdventure;
