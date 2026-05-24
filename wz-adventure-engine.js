/**
 * Waypoint Zero — Adventure Engine
 * =================================
 * Core engine for audio playback + trigger orchestration.
 * Sits between GeofenceManager and audio systems, implementing
 * a deterministic state machine with priority-based audio queueing.
 *
 * Architecture:
 *   AdventureEngine (state machine) → AudioManager (priority queue)
 *     ├── Tone.js synthesis (ambient pad, heartbeat, static)
 *     ├── Pre-rendered MP3 playback (fixed sequences)
 *     └── TTS fallback (backend /tts endpoint)
 *
 * Usage:
 *   const engine = new AdventureEngine({
 *     audioCtx: window.audioCtx,
 *     ttsEndpoint: '/tts',
 *     audioBaseUrl: '/audio_fixed/',
 *     onStateChange: (state) => {},
 *     debug: true,
 *   });
 *   engine.start();
 *   engine.onGeofenceEvent(event); // feed from GeofenceManager
 *   engine.simulateSequence([...]);  // test mode
 */

// ═══════════════════════════════════════════════════════
// STATE MACHINE
// ═══════════════════════════════════════════════════════

const ENGINE_STATES = Object.freeze({
  OFF:        'off',
  IDLE:       'idle',
  ENTERING:   'entering',   // just crossed into a zone
  IN_ZONE:    'in_zone',    // steady state inside a zone
  EXITING:    'exiting',    // just left a zone
  GO_SEQ:     'go_sequence',// GO! trigger active
  CAPTURING:  'capturing',  // auto-capture in progress
  COMPLETE:   'complete',   // mission finished
});

const STATE_TRANSITIONS = {
  [ENGINE_STATES.OFF]:       [ENGINE_STATES.IDLE, ENGINE_STATES.COMPLETE],
  [ENGINE_STATES.IDLE]:      [ENGINE_STATES.ENTERING, ENGINE_STATES.COMPLETE],
  [ENGINE_STATES.ENTERING]:  [ENGINE_STATES.IN_ZONE, ENGINE_STATES.EXITING, ENGINE_STATES.COMPLETE],
  [ENGINE_STATES.IN_ZONE]:   [ENGINE_STATES.ENTERING, ENGINE_STATES.EXITING, ENGINE_STATES.GO_SEQ, ENGINE_STATES.CAPTURING, ENGINE_STATES.COMPLETE],
  [ENGINE_STATES.EXITING]:   [ENGINE_STATES.IDLE, ENGINE_STATES.ENTERING, ENGINE_STATES.COMPLETE],
  [ENGINE_STATES.GO_SEQ]:    [ENGINE_STATES.IN_ZONE, ENGINE_STATES.COMPLETE],
  [ENGINE_STATES.CAPTURING]: [ENGINE_STATES.IDLE, ENGINE_STATES.COMPLETE],
  [ENGINE_STATES.COMPLETE]:  [],
};

// Zone types from geofence (outermost → innermost)
const ZONE_TYPES = [
  'perimeter', 'approach', 'engagement', 'hot_zone', 'go_trigger', 'capture'
];

// Zone tension/voice/heartbeat mapping (from GeofenceManager.THRESHOLDS)
const ZONE_PROFILES = {
  perimeter:   { tension: 0.15, voice: 'whisper',  heartbeat: 52,  label: 'PERIMETER' },
  approach:    { tension: 0.35, voice: 'tactical', heartbeat: 58,  label: 'APPROACH' },
  engagement:  { tension: 0.60, voice: 'tactical', heartbeat: 70,  label: 'ENGAGEMENT' },
  hot_zone:    { tension: 0.80, voice: 'alert',    heartbeat: 90,  label: 'HOT ZONE' },
  go_trigger:  { tension: 0.90, voice: 'shout',    heartbeat: 100, label: 'GO TRIGGER' },
  capture:     { tension: 0.95, voice: 'shout',    heartbeat: 120, label: 'CAPTURE' },
};

// Audio priority (higher = plays first, from manifest playback_rules)
const AUDIO_PRIORITY = {
  shout_voice:       100,  // jumps to front
  nav_call:           90,
  time_warning:       80,
  go_sequence:        70,
  narrative_beat:     50,  // suppressed <40m from turn
  weather_dialogue:   40,
  waypoint_captured:  30,
  ambient:             0,  // background, never queued
  heartbeat:           0,
};

// ═══════════════════════════════════════════════════════
// AUDIO MANAGER
// ═══════════════════════════════════════════════════════

class AudioManager {
  /**
   * @param {Object} opts
   * @param {AudioContext} opts.audioCtx
   * @param {string} opts.audioBaseUrl - base URL for pre-rendered MP3s
   * @param {string} opts.ttsEndpoint - TTS API endpoint
   * @param {function} opts.log - debug logger
   */
  constructor(opts) {
    this.ctx = opts.audioCtx;
    this.audioBaseUrl = opts.audioBaseUrl || '/audio_fixed/';
    this.ttsEndpoint = opts.ttsEndpoint || '/tts';
    this.log = opts.log || (() => {});

    /** @type {AudioQueueItem[]} */
    this._queue = [];
    this._playing = false;
    this._currentSource = null;

    // Pre-loaded MP3 buffer cache (URL → AudioBuffer)
    this._mp3Cache = new Map();

    // Active Tone.js components (set externally)
    this._toneScore = null;
  }

  // ── Queue management ──

  /**
   * Enqueue an audio item. Higher priority items interrupt lower ones.
   * @param {Object} item
   * @param {string} item.type - 'tts'|'mp3'|'tone'
   * @param {number} item.priority - from AUDIO_PRIORITY
   * @param {string} [item.text] - TTS text
   * @param {string} [item.voice] - voice mode
   * @param {string} [item.url] - MP3 URL
   * @param {function} [item.action] - Tone.js action
   * @param {boolean} [item.interrupt=false] - can this item be interrupted?
   * @param {string} [item.id] - unique identifier for logging
   */
  enqueue(item) {
    item.id = item.id || `audio_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

    // Check if we should interrupt current playback
    if (this._playing && this._currentItem) {
      const currentPrio = this._currentItem.priority || 0;
      if (item.priority > currentPrio) {
        // Check interrupt rules from manifest
        const currentType = this._currentItem.type || '';
        const newType = item.type || '';

        // nav_call interrupted by shout
        // narrative_beat interrupted by nav_call, go_sequence
        // all interrupted by user_skip
        // all interrupted by shout_voice
        const shouldInterrupt =
          item.priority >= AUDIO_PRIORITY.shout_voice ||  // shout beats everything
          (currentType === 'narrative_beat' && newType === 'nav_call') ||
          (currentType === 'narrative_beat' && newType === 'go_sequence');

        if (shouldInterrupt) {
          this.log(`Audio: interrupting ${this._currentItem.id} (prio ${currentPrio}) for ${item.id} (prio ${item.priority})`);
          this._stopCurrent();
        }
      }
    }

    // Insert by priority (highest first)
    let inserted = false;
    for (let i = 0; i < this._queue.length; i++) {
      if (item.priority > (this._queue[i].priority || 0)) {
        this._queue.splice(i, 0, item);
        inserted = true;
        break;
      }
    }
    if (!inserted) this._queue.push(item);

    this.log(`Audio: enqueued ${item.id} (${item.type || '?'}, prio ${item.priority}, queue len ${this._queue.length})`);

    if (!this._playing) this._drain();
  }

  /** Clear the queue */
  clear() {
    this._stopCurrent();
    this._queue = [];
    this._playing = false;
    this.log('Audio: queue cleared');
  }

  /** Skip current item */
  skip() {
    this.log('Audio: user skip');
    this._stopCurrent();
    this._drain();
  }

  // ── Internal playback ──

  /** @private */
  async _drain() {
    if (this._queue.length === 0) {
      this._playing = false;
      this._currentItem = null;
      return;
    }
    this._playing = true;
    const item = this._queue.shift();
    this._currentItem = item;

    this.log(`Audio: playing ${item.id} (type=${item.type})`);

    try {
      await this._playItem(item);
    } catch (e) {
      this.log(`Audio: error playing ${item.id}: ${e.message}`);
    }

    this._currentItem = null;
    this._drain();
  }

  /** @private */
  async _playItem(item) {
    switch (item.type) {
      case 'tts':
        return this._playTTS(item);
      case 'mp3':
        return this._playMP3(item);
      case 'tone':
        return this._playTone(item);
      default:
        this.log(`Audio: unknown type ${item.type}`);
    }
  }

  /** @private */
  async _playTTS(item) {
    const { text, voice } = item;
    if (!text) return;

    const modes = {
      whisper:  { voice: 'operator', speed: '-25%', pitch: '-3Hz' },
      tactical: { voice: 'commander', speed: '+0%', pitch: '+0Hz' },
      alert:    { voice: 'tactical', speed: '+15%', pitch: '+2Hz' },
      shout:    { voice: 'operator', speed: '+25%', pitch: '+5Hz' },
    };
    const m = modes[voice] || modes.tactical;

    const r = await fetch(this.ttsEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: m.voice, speed: m.speed, pitch: m.pitch }),
    });

    if (!r.ok) throw new Error(`TTS HTTP ${r.status}`);

    const arrayBuf = await r.arrayBuffer();
    const audioBuf = await this.ctx.decodeAudioData(arrayBuf);

    return new Promise((resolve) => {
      const src = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();
      gain.gain.value = voice === 'shout' ? 1.0 : voice === 'whisper' ? 0.6 : 0.85;
      src.buffer = audioBuf;
      src.connect(gain);
      gain.connect(this.ctx.destination);
      src.onended = () => resolve();
      src.start();
      this._currentSource = src;
    });
  }

  /** @private */
  async _playMP3(item) {
    const url = this.audioBaseUrl + item.url;

    // Use cache
    let buffer = this._mp3Cache.get(url);
    if (!buffer) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`MP3 HTTP ${r.status}: ${url}`);
      const arrayBuf = await r.arrayBuffer();
      buffer = await this.ctx.decodeAudioData(arrayBuf);
      this._mp3Cache.set(url, buffer);
    }

    return new Promise((resolve) => {
      const src = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();
      gain.gain.value = item.volume != null ? item.volume : 1.0;
      src.buffer = buffer;
      src.connect(gain);
      gain.connect(this.ctx.destination);
      src.onended = () => resolve();
      src.start();
      this._currentSource = src;
    });
  }

  /** @private */
  async _playTone(item) {
    if (item.action) {
      await item.action();
    }
    if (item.durationMs) {
      await new Promise(r => setTimeout(r, item.durationMs));
    }
  }

  /** @private */
  _stopCurrent() {
    if (this._currentSource) {
      try { this._currentSource.stop(); } catch (e) { /* already stopped */ }
      this._currentSource = null;
    }
  }

  /** @returns {number} queue length */
  get queueLength() { return this._queue.length; }

  /** @returns {boolean} */
  get isPlaying() { return this._playing; }
}

// ═══════════════════════════════════════════════════════
// ADVENTURE ENGINE
// ═══════════════════════════════════════════════════════

class AdventureEngine {
  /**
   * @param {Object} opts
   * @param {AudioContext} opts.audioCtx
   * @param {Object} [opts.toneScore] - Tone.js score components {pad, rv, bs, bp}
   * @param {string} [opts.ttsEndpoint='/tts']
   * @param {string} [opts.audioBaseUrl='/audio_fixed/']
   * @param {(state:string, prev:string, data?:Object) => void} [opts.onStateChange]
   * @param {(event:Object) => void} [opts.onAudioEvent]
   * @param {boolean} [opts.debug=false]
   */
  constructor(opts = {}) {
    this.audioCtx = opts.audioCtx;
    this._toneScore = opts.toneScore || null;
    this._onStateChange = opts.onStateChange || (() => {});
    this._onAudioEvent = opts.onAudioEvent || (() => {});
    this._debug = opts.debug || false;

    // State
    this._state = ENGINE_STATES.OFF;
    this._prevState = null;
    this._currentZone = null;      // current active zone type
    this._currentWpIdx = -1;       // current waypoint index
    this._tension = 0.03;
    this._voiceMode = 'whisper';
    this._heartbeatBpm = 50;
    this._goTriggered = false;

    // Mission context
    this._missionStartTime = null;
    this._missionTimeLimit = null;
    this._waypoints = [];

    // Narrative beat tracking
    this._narrativeCount = 0;
    this._narrativeHistory = [];
    this._lastNarrativeTime = 0;
    this._narrativeBeatCap = 20;

    // Audio manager
    this.audio = new AudioManager({
      audioCtx: this.audioCtx,
      audioBaseUrl: opts.audioBaseUrl || '/audio_fixed/',
      ttsEndpoint: opts.ttsEndpoint || '/tts',
      log: (msg) => this._log(msg),
    });

    // Simulation
    this._simLog = [];

    // Heartbeat timer
    this._heartbeatTimer = null;
  }

  // ═══ PUBLIC API ═══

  /**
   * Start the engine. Transitions from OFF → IDLE.
   * @param {Object} [mission]
   * @param {Array} [mission.waypoints]
   * @param {number} [mission.timeLimit] - seconds
   */
  start(mission = {}) {
    if (this._state !== ENGINE_STATES.OFF) {
      this._log('Engine already started');
      return;
    }
    this._missionStartTime = Date.now();
    this._missionTimeLimit = mission.timeLimit || 1200;
    this._waypoints = mission.waypoints || [];
    this._currentWpIdx = 0;
    this._narrativeCount = 0;
    this._lastNarrativeTime = Date.now();

    this._transition(ENGINE_STATES.IDLE, { reason: 'start' });
    this._setToneScore(this._tension);

    this._log(`Engine started. ${this._waypoints.length} waypoints, ${this._missionTimeLimit}s limit`);
  }

  /**
   * Stop the engine. Transitions to OFF.
   */
  stop() {
    this.audio.clear();
    this._stopHeartbeat();
    this._transition(ENGINE_STATES.OFF, { reason: 'stop' });
  }

  /**
   * Feed a geofence event into the engine.
   * This is the main entry point from GeofenceManager.
   * @param {GeofenceEvent} event
   */
  onGeofenceEvent(event) {
    if (this._state === ENGINE_STATES.OFF || this._state === ENGINE_STATES.COMPLETE) return;

    const { direction, zoneType, parentWpIdx, distanceToCenter } = event;

    this._log(`Event: ${direction} ${zoneType} wp${parentWpIdx} @ ${distanceToCenter}m`);

    if (direction === 'enter') {
      this._handleZoneEnter(zoneType, parentWpIdx, event);
    } else if (direction === 'exit') {
      this._handleZoneExit(zoneType, parentWpIdx, event);
    }
  }

  /**
   * Advance to the next waypoint manually (photo capture, etc.).
   */
  advanceWaypoint() {
    if (this._currentWpIdx >= this._waypoints.length) return;
    this._currentWpIdx++;
    this._goTriggered = false;

    if (this._currentWpIdx >= this._waypoints.length) {
      this._transition(ENGINE_STATES.COMPLETE, { reason: 'all_waypoints_captured' });
      return;
    }

    const next = this._waypoints[this._currentWpIdx];
    this._transition(ENGINE_STATES.IDLE, { reason: 'waypoint_advanced', wpIdx: this._currentWpIdx });
    this._setToneScore(0.08);

    // Play capture confirmation
    const files = [
      'trail1_wp_confirmed.mp3',
      'cipher_target_acquired.mp3',
      'eagle6_good_capture.mp3',
      'trail1_clean_acquisition.mp3',
    ];
    const file = files[Math.floor(Math.random() * files.length)];
    this.audio.enqueue({
      type: 'mp3', url: file, priority: AUDIO_PRIORITY.waypoint_captured,
      id: 'capture_confirm',
    });

    // Nav to next
    if (next && next.nav_text) {
      this.audio.enqueue({
        type: 'tts', text: next.nav_text, voice: 'tactical',
        priority: AUDIO_PRIORITY.nav_call, id: 'nav_next_wp',
      });
    }

    setTimeout(() => this._setToneScore(0.15), 2000);
  }

  /**
   * Handle mission timer tick.
   * @param {number} elapsed - seconds elapsed
   * @param {number} remaining - seconds remaining
   */
  onTimerTick(elapsed, remaining) {
    if (this._state === ENGINE_STATES.OFF || this._state === ENGINE_STATES.COMPLETE) return;

    // Time warnings at thresholds
    const warnings = [
      { at: 300, mp3: 'eagle6_5min_warning.mp3' },
      { at: 120, mp3: 'eagle6_2min_warning.mp3' },
      { at: 60,  mp3: 'eagle6_60sec_warning.mp3' },
      { at: 30,  mp3: 'eagle6_30sec_warning.mp3' },
    ];

    for (const w of warnings) {
      if (remaining === w.at) {
        this.audio.enqueue({
          type: 'mp3', url: w.mp3, priority: AUDIO_PRIORITY.time_warning,
          id: `time_${w.at}s`,
        });
      }
    }

    if (remaining <= 0) {
      this._transition(ENGINE_STATES.COMPLETE, { reason: 'time_expired' });
    }
  }

  /**
   * Check if a narrative beat should fire.
   * Call this periodically (e.g., every few seconds).
   * @param {number} [distanceToWaypoint] - suppresses beats <40m from turn
   */
  checkNarrativeBeat(distanceToWaypoint) {
    if (this._state === ENGINE_STATES.OFF || this._state === ENGINE_STATES.COMPLETE) return;
    if (this._narrativeCount >= this._narrativeBeatCap) return;

    // Don't interrupt when close to a turn
    if (distanceToWaypoint != null && distanceToWaypoint < 40) return;
    // Don't fire during GO sequence
    if (this._state === ENGINE_STATES.GO_SEQ) return;

    const now = Date.now();
    const elapsed = (now - this._missionStartTime) / 1000;
    const total = this._missionTimeLimit;
    const progress = Math.min(1, elapsed / total);

    // Interval depends on tension
    const iv = this._tension > 0.6 ? 90000 : 150000;
    if (now - this._lastNarrativeTime < iv) return;

    this._lastNarrativeTime = now;
    this._narrativeCount++;

    // Pick a narrative beat from the pool (client-side fallback)
    const beat = this._pickNarrativeBeat(progress);
    if (!beat) return;

    this._narrativeHistory.push(beat);
    const mode = progress > 0.8 ? 'alert' : progress > 0.5 ? 'tactical' : 'whisper';

    this.audio.enqueue({
      type: 'tts', text: beat, voice: mode,
      priority: AUDIO_PRIORITY.narrative_beat,
      id: `narrative_${this._narrativeCount}`,
    });
  }

  /**
   * Get current engine state for UI.
   */
  getState() {
    return {
      state: this._state,
      prevState: this._prevState,
      tension: this._tension,
      voiceMode: this._voiceMode,
      heartbeatBpm: this._heartbeatBpm,
      currentZone: this._currentZone,
      currentWpIdx: this._currentWpIdx,
      narrativeCount: this._narrativeCount,
      audioQueueLen: this.audio.queueLength,
    };
  }

  // ═══ SIMULATION ═══

  /**
   * Simulate a sequence of geofence events for testing.
   * Produces deterministic audio output logging.
   * @param {Object[]} events - array of simulated geofence events
   * @returns {Object[]} simulation log
   */
  simulateSequence(events) {
    this._log('=== SIMULATION START ===');
    this._simLog = [];
    this._state = ENGINE_STATES.IDLE;
    this._currentWpIdx = 0;
    this._tension = 0.03;
    this._voiceMode = 'whisper';

    for (const evt of events) {
      this._simLog.push({
        event: evt,
        state_before: this._state,
      });

      this.onGeofenceEvent(evt);

      this._simLog[this._simLog.length - 1].state_after = this._state;
      this._simLog[this._simLog.length - 1].tension = this._tension;
      this._simLog[this._simLog.length - 1].voice = this._voiceMode;
    }

    this._log('=== SIMULATION END ===');
    return this._simLog;
  }

  /** Get simulation results. */
  getSimLog() { return this._simLog; }

  // ═══ PRIVATE: ZONE HANDLING ═══

  /** @private */
  _handleZoneEnter(zoneType, wpIdx, event) {
    const profile = ZONE_PROFILES[zoneType];
    if (!profile) return;

    const prevZone = this._currentZone;

    // Update zone tracking
    this._currentZone = zoneType;
    this._currentWpIdx = wpIdx;

    // Update tension/voice
    this._tension = profile.tension;
    this._voiceMode = profile.voice;
    this._heartbeatBpm = profile.heartbeat;

    // State transition
    if (zoneType === 'go_trigger') {
      if (!this._goTriggered) {
        this._transition(ENGINE_STATES.GO_SEQ, { reason: 'go_trigger_enter', wpIdx });
        this._executeGoSequence();
      }
    } else if (zoneType === 'capture') {
      this._transition(ENGINE_STATES.CAPTURING, { reason: 'capture_enter', wpIdx });
      this._executeCapture(wpIdx, event);
    } else {
      this._transition(ENGINE_STATES.ENTERING, { reason: `${zoneType}_enter`, wpIdx });

      // Atmosphere on engagement/hot_zone
      if (zoneType === 'engagement') {
        this._playStaticBurst(0.15, 0.03);
      } else if (zoneType === 'hot_zone') {
        this._playStaticBurst(0.25, 0.05);
      }

      // Settle into in_zone after a brief moment
      setTimeout(() => {
        if (this._state === ENGINE_STATES.ENTERING && this._currentZone === zoneType) {
          this._transition(ENGINE_STATES.IN_ZONE, { reason: 'settled' });
        }
      }, 1500);
    }

    // Update Tone.js score
    this._setToneScore(this._tension);
    this._setHeartbeat(profile.heartbeat, profile.tension * 0.8);
  }

  /** @private */
  _handleZoneExit(zoneType, wpIdx, event) {
    // Only transition if we're leaving the current active zone
    if (zoneType === 'go_trigger') {
      this._goTriggered = false;
    }

    // Check if we left the innermost zone for this waypoint
    // (Simplified: if we're exiting and not entering something deeper)
    if (this._currentZone === zoneType) {
      // Find the next outermost zone we're still in
      const currentIdx = ZONE_TYPES.indexOf(zoneType);
      let stillIn = null;
      for (let i = currentIdx - 1; i >= 0; i--) {
        // In a full implementation we'd check geofence.occupiedZones
        // For now, fall back to the previous zone profile
        stillIn = ZONE_TYPES[i];
        break;
      }

      this._currentZone = stillIn;
      if (stillIn) {
        const profile = ZONE_PROFILES[stillIn];
        this._tension = profile.tension;
        this._voiceMode = profile.voice;
        this._heartbeatBpm = profile.heartbeat;
        this._setToneScore(this._tension);
        this._setHeartbeat(profile.heartbeat, profile.tension * 0.8);
        this._transition(ENGINE_STATES.IN_ZONE, { reason: `receded_to_${stillIn}` });
      } else {
        this._tension = 0.03;
        this._voiceMode = 'whisper';
        this._heartbeatBpm = 50;
        this._setToneScore(this._tension);
        this._setHeartbeat(50, 0.03);
        this._transition(ENGINE_STATES.IDLE, { reason: 'left_all_zones' });
      }
    }
  }

  // ═══ PRIVATE: AUDIO ACTIONS ═══

  /** @private */
  _executeGoSequence() {
    this._goTriggered = true;

    // 1. Kill music
    if (this._toneScore) {
      this._toneScore.pad.volume.rampTo(-50, 0.8);
      this._toneScore.rv.wet.rampTo(0.05, 0.8);
      // Tone.Transport.bpm.rampTo(30, 0.8);
    }
    this._setHeartbeat(80, 0.6);

    // 2. GO sequence audio (pre-rendered MP3s)
    this.audio.enqueue({
      type: 'mp3', url: 'eagle6_go_wait.mp3', priority: AUDIO_PRIORITY.go_sequence,
      id: 'go_wait', volume: 0.9,
    });

    // Wait between "Wait..." and "NOW!"
    this.audio.enqueue({
      type: 'tone', priority: AUDIO_PRIORITY.go_sequence,
      id: 'go_pause', durationMs: 1200,
      action: () => { this._setHeartbeat(100, 0.8); },
    });

    this.audio.enqueue({
      type: 'mp3', url: 'eagle6_go_now.mp3', priority: AUDIO_PRIORITY.go_sequence,
      id: 'go_now', volume: 1.0,
    });

    this.audio.enqueue({
      type: 'mp3', url: 'eagle6_go_gogogo.mp3', priority: AUDIO_PRIORITY.go_sequence,
      id: 'go_gogogo', volume: 1.0,
    });

    // 3. Music explodes back after sequence
    this.audio.enqueue({
      type: 'tone', priority: AUDIO_PRIORITY.go_sequence,
      id: 'go_music_explode',
      action: () => {
        if (this._toneScore) {
          this._toneScore.pad.volume.rampTo(-18, 0.3);
          this._toneScore.rv.wet.rampTo(0.7, 0.3);
          // Tone.Transport.bpm.rampTo(100, 0.3);
        }
        this._setHeartbeat(120, 0.9);
        // After GO sequence, stay at high tension in_zone
        if (this._state === ENGINE_STATES.GO_SEQ) {
          this._transition(ENGINE_STATES.IN_ZONE, { reason: 'go_sequence_complete' });
        }
      },
    });

    // Notify UI
    this._onAudioEvent({ type: 'go_sequence_started' });
  }

  /** @private */
  _executeCapture(wpIdx, event) {
    if (wpIdx !== this._currentWpIdx || wpIdx >= this._waypoints.length) return;

    // Play capture sound
    this._playStaticBurst(0.1, 0.04);

    // Advance waypoint
    this.advanceWaypoint();
  }

  /** @private */
  _playStaticBurst(duration, vol) {
    this.audio.enqueue({
      type: 'tone', priority: AUDIO_PRIORITY.ambient,
      id: `static_${Date.now()}`,
      action: () => {
        if (!this.audioCtx || this.audioCtx.state !== 'running') return;
        const sr = this.audioCtx.sampleRate;
        const len = Math.floor(sr * duration);
        const buf = this.audioCtx.createBuffer(1, len, sr);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.8;
        const src = this.audioCtx.createBufferSource();
        src.buffer = buf;
        const filt = this.audioCtx.createBiquadFilter();
        filt.type = 'bandpass';
        filt.frequency.value = 1500;
        filt.Q.value = 0.4;
        const gain = this.audioCtx.createGain();
        gain.gain.setValueAtTime(vol, this.audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + duration);
        src.connect(filt); filt.connect(gain); gain.connect(this.audioCtx.destination);
        src.start(); src.stop(this.audioCtx.currentTime + duration);
      },
    });
  }

  // ═══ PRIVATE: SYNTHESIS ═══

  /** @private */
  _setToneScore(tension) {
    if (!this._toneScore) return;
    const { pad, rv, bs, bp } = this._toneScore;
    pad.volume.rampTo(-30 + tension * 14, 1.5);
    rv.wet.rampTo(0.3 + tension * 0.45, 1.5);
    // Tone.Transport.bpm.rampTo(45 + tension * 55, 1.5);
    if (bs) bs.volume.rampTo(-24 + tension * 16, 1.5);
    if (bp) bp.interval = tension > 0.6 ? '4n' : tension > 0.3 ? '2n' : '4n';
  }

  /** @private */
  _setHeartbeat(bpm, vol) {
    if (!this.audioCtx || this.audioCtx.state !== 'running') return;
    this._heartbeatBpm = bpm;
    this._stopHeartbeat();
    if (bpm <= 0) return;

    const interval = 60000 / bpm;
    let beat = false;
    this._heartbeatTimer = setInterval(() => {
      if (!this.audioCtx) return;
      // Simple click-style heartbeat — in production this uses the existing
      // MembraneSynth from Tone.js. For standalone we use a minimal oscillator.
      const t = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.frequency.setValueAtTime(beat ? 45 : 35, t);
      osc.type = 'sine';
      gain.gain.setValueAtTime(beat ? vol * 0.25 : 0, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.15);
      beat = !beat;
    }, interval / 2);
  }

  /** @private */
  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ═══ PRIVATE: NARRATIVE ═══

  /** @private */
  _pickNarrativeBeat(progress) {
    // Client-side narrative pool (simplified; full pool is in narrative_beats.py)
    const pool = NARRATIVE_BEAT_POOL;
    const poolIdx = Math.floor(progress * pool.length);
    const phase = pool[Math.min(poolIdx, pool.length - 1)];
    if (!phase || phase.length === 0) return null;

    const recent = this._narrativeHistory.slice(-5);
    const available = phase.filter(b => !recent.includes(b));
    if (available.length === 0) return phase[Math.floor(Math.random() * phase.length)];
    return available[Math.floor(Math.random() * available.length)];
  }

  // ═══ PRIVATE: STATE ═══

  /** @private */
  _transition(newState, data = {}) {
    const allowed = STATE_TRANSITIONS[this._state] || [];
    if (!allowed.includes(newState)) {
      this._log(`WARN: invalid transition ${this._state} → ${newState} (allowed: ${allowed.join(',')})`);
      // Allow the transition anyway for robustness
    }
    this._prevState = this._state;
    this._state = newState;
    this._log(`State: ${this._prevState} → ${this._state} (${data.reason || '?'})`);
    this._onStateChange(newState, this._prevState, data);
  }

  /** @private */
  _log(msg) {
    if (this._debug) console.log(`[AdventureEngine] ${msg}`);
  }

  // ═══ PUBLIC: TONE SCORE SETTER ═══

  setToneScore(score) {
    this._toneScore = score;
  }

  /** @returns {boolean} */
  get isActive() {
    return this._state !== ENGINE_STATES.OFF && this._state !== ENGINE_STATES.COMPLETE;
  }
}

// ═══════════════════════════════════════════════════════
// CLIENT-SIDE NARRATIVE BEAT POOL
// ═══════════════════════════════════════════════════════
// (subset of the full 280-beat pool in narrative_beats.py)

const NARRATIVE_BEAT_POOL = [
  // Phase 0: START (0-20%)
  [
    "Satellite's picking up heat signatures three blocks ahead. Could be nothing. Could be not nothing.",
    "I've been watching this sector for two weeks. Something changed tonight.",
    "The radio just crackled. Encrypted. Short burst. Someone's close.",
    "Intel update: a civilian reported strange lights near the old quarter an hour ago.",
    "There's a CCTV blind spot coming up on your left. If you need to disappear, that's where.",
    "The last operative who ran this route found something. Never told us what.",
  ],
  // Phase 1: EARLY (20-40%)
  [
    "You're passing the old district now. Most of these buildings predate the war.",
    "CIPHER just picked up an encrypted signal. Local. Military-grade.",
    "Keep your pace steady. Nothing draws attention like someone who looks lost.",
    "PATCH-3 here. Your vitals are elevated. Everything alright down there?",
    "The streetlights flickered twice just now. That's not random.",
    "I'm running background on the building to your right. Records are... incomplete.",
  ],
  // Phase 2: MID (40-60%)
  [
    "EAGLE-6: I'm seeing movement on thermal. Three blocks north. Stay sharp.",
    "You're getting close. The tension in your voice is audible.",
    "CIPHER: I've got a partial ID on the signal. It's not friendly.",
    "Whatever you do, don't stop now. You're in the kill zone.",
    "PATCH-3: Adrenaline's spiking. Breathe. Four-count in, four-count out.",
  ],
  // Phase 3: LATE (60-80%)
  [
    "Thirty seconds out. Weapons hot. Stay low.",
    "I've got eyes on the target building. Lights are on. Someone's home.",
    "This is it. Everything we've worked for comes down to the next two minutes.",
    "EAGLE-6: Dropping to 200 feet. Can't stay here long. Make it fast.",
    "Your heart rate is 140. That's either fear or readiness. Make it readiness.",
  ],
  // Phase 4: FINAL (80-100%)
  [
    "GO! GO! GO! Move like your life depends on it!",
    "TARGET ACQUIRED! Extract! Extract! Extract!",
    "CIPHER: Signal is spiking! They know you're there!",
    "EAGLE-6: I'm coming in hot! Be ready for extraction in 30 seconds!",
    "This is TRAIL-1. Mission complete. Outstanding work, operative.",
  ],
];

// ═══════════════════════════════════════════════════════
// STATIC PRE-RENDERED MP3 INVENTORY
// ═══════════════════════════════════════════════════════

const PRE_RENDERED_MP3S = [
  // Prologue
  'trail1_awaken_operative.mp3',
  'eagle6_identify_yourself.mp3',
  // Deploy
  'eagle6_wheels_up.mp3',
  'trail1_operation_live.mp3',
  'trail1_good_hunting.mp3',
  // GO sequence
  'eagle6_go_wait.mp3',
  'eagle6_go_now.mp3',
  'eagle6_go_gogogo.mp3',
  // Time warnings
  'eagle6_5min_warning.mp3',
  'eagle6_2min_warning.mp3',
  'eagle6_60sec_warning.mp3',
  'eagle6_30sec_warning.mp3',
  // Weather
  'cipher_weather_thunderstorm.mp3',
  'cipher_weather_rain.mp3',
  'cipher_weather_snow.mp3',
  'cipher_weather_fog.mp3',
  'cipher_weather_clear.mp3',
  'cipher_weather_clouds.mp3',
  // Waypoint captured
  'trail1_wp_confirmed.mp3',
  'cipher_target_acquired.mp3',
  'eagle6_good_capture.mp3',
  'trail1_clean_acquisition.mp3',
  // Mission end
  'trail1_mission_complete.mp3',
  'trail1_mission_failed.mp3',
];

// ═══════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════

// Make available globally (single-file HTML pattern)
if (typeof window !== 'undefined') {
  window.AdventureEngine = AdventureEngine;
  window.AudioManager = AudioManager;
  window.ENGINE_STATES = ENGINE_STATES;
  window.ZONE_PROFILES = ZONE_PROFILES;
  window.AUDIO_PRIORITY = AUDIO_PRIORITY;
  window.PRE_RENDERED_MP3S = PRE_RENDERED_MP3S;
  window.NARRATIVE_BEAT_POOL = NARRATIVE_BEAT_POOL;
}

// CommonJS/ESM export for test harness
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AdventureEngine, AudioManager, ENGINE_STATES, ZONE_PROFILES, AUDIO_PRIORITY };
}
