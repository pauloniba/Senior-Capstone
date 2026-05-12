
import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import bcrypt from "bcryptjs"
import { pool, query } from "./db.js"
import {
  provisionDefaultDevices,
  userHasDevices
} from "./provisionDevices.js"

dotenv.config()

const app = express()
const PORT = process.env.PORT || 8080
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o"

// Origins allowed to call this API from a browser. Non-browser clients
// (Pico, fake-data Fargate task, curl, etc.) are unaffected by CORS.
// Extra origins can be added at deploy time via CORS_EXTRA_ORIGINS (comma-separated).
const DEFAULT_ALLOWED_ORIGINS = [
  "https://main.d31c4hpzddasf9.amplifyapp.com",
  "https://d1cbiu3j43blds.cloudfront.net",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:8080"
]
const extraOrigins = (process.env.CORS_EXTRA_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const ALLOWED_ORIGINS = [...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins]

app.use(
  cors({
    origin(origin, callback) {
      // Non-browser clients (Pico, curl, fake-data) send no Origin and are unaffected.
      // Browsers send Origin: if it's allowed we echo it back; otherwise we omit the
      // Access-Control-Allow-Origin header so the browser blocks the response from JS.
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true)
      }
      return callback(null, false)
    },
    credentials: true
  })
)
app.use(express.json())

/** Latest reading cache per device id (DB remains source of truth). */
const liveReadingByDeviceId = new Map()
/** Recent reading cache per device id for quick fallback only. */
const readingHistoryByDeviceId = new Map()
/** Alert history by user id for dashboard timeline. */
const alertHistoryByUserId = new Map()
/** Lightweight AI conversation memory per user+device. */
const aiConversationByDeviceKey = new Map()
const MAX_HISTORY_POINTS = 120
const MAX_ALERT_HISTORY = 200
const MAX_AI_TURNS = 8

const defaultReadingByUid = {
  "dev-attic-01": { value: 58.2, sensor_type: "humidity", unit: "% RH" },
  "dev-basement-01": { value: 41, sensor_type: "moisture", unit: "%" },
  "dev-kitchen-01": { value: 1204, sensor_type: "power", unit: "W" }
}

function unitFromSensorType(sensorType, explicitUnit) {
  if (explicitUnit) return explicitUnit
  const t = (sensorType || "").toLowerCase()
  const map = {
    humidity: "% RH",
    moisture: "%",
    temperature: "°C",
    power: "W",
    power_w: "W",
    flow: "L/min",
    liters: "L",
    custom: ""
  }
  return map[t] || ""
}

/** Human-readable device name for UI (never show raw IDs like `1-dev-kitchen-01`). */
function friendlyDeviceDisplayName(displayName, deviceUid) {
  const n = String(displayName || "").trim()
  if (n) return n
  const uid = String(deviceUid || "").trim()
  const suffixMatch = uid.match(/^\d+-(.+)$/)
  const suffix = suffixMatch ? suffixMatch[1] : uid
  const known = {
    "dev-attic-01": "Attic sensor",
    "dev-basement-01": "Basement sensor",
    "dev-kitchen-01": "Kitchen sensor"
  }
  if (known[suffix]) return known[suffix]
  const rest = suffix
    .replace(/^dev-/i, "")
    .replace(/-/g, " ")
    .replace(/\b\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!rest) return "Your device"
  const titled = rest
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
  return `${titled} device`
}

function prettifyUnitForMessage(unit) {
  const u = String(unit || "").trim()
  if (!u) return ""
  if (/^c$/i.test(u)) return "°C"
  if (/^f$/i.test(u)) return "°F"
  if (u.toLowerCase().includes("rh")) return u
  return u
}

function formatReadingForUser(value, unit) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—"
  const u = prettifyUnitForMessage(unit)
  const rounded = Math.abs(value) >= 100 ? Number(value.toFixed(1)) : Number(value.toFixed(2))
  return u ? `${rounded} ${u}` : String(rounded)
}

function friendlySensorLabel(sensorType) {
  const t = String(sensorType || "").toLowerCase()
  const map = {
    temperature: "Temperature",
    humidity: "Humidity",
    moisture: "Moisture",
    power: "Power use",
    power_w: "Power use",
    vibration: "Vibration",
    flow: "Flow",
    custom: "Sensor reading"
  }
  return map[t] || (t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}` : "Reading")
}

/** Map `12-dev-attic-01` → defaults keyed by `dev-attic-01` (legacy uids still work). */
function defaultReadingForDeviceUid(deviceUid) {
  if (defaultReadingByUid[deviceUid]) {
    return defaultReadingByUid[deviceUid]
  }
  const m = deviceUid.match(/^\d+-(.+)$/)
  const suffix = m ? m[1] : deviceUid
  return (
    defaultReadingByUid[suffix] || {
      value: null,
      sensor_type: null,
      unit: ""
    }
  )
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function defaultThresholdsFor(sensorType, unit) {
  const type = (sensorType || "").toLowerCase()
  if (type === "temperature") {
    const isF = String(unit || "").toLowerCase().includes("f")
    return {
      warning_min: null,
      warning_max: isF ? 82 : 27,
      critical_min: null,
      critical_max: isF ? 86 : 30
    }
  }
  if (type === "humidity") {
    return { warning_min: null, warning_max: 70, critical_min: null, critical_max: 80 }
  }
  if (type === "moisture") {
    return { warning_min: 28, warning_max: null, critical_min: 20, critical_max: null }
  }
  if (type === "power" || type === "power_w") {
    return { warning_min: null, warning_max: 1800, critical_min: null, critical_max: 2500 }
  }
  if (type === "vibration") {
    return { warning_min: null, warning_max: 0.5, critical_min: null, critical_max: 1 }
  }
  return { warning_min: null, warning_max: null, critical_min: null, critical_max: null }
}

function normalizeThresholdConfig(config, sensorType, unit) {
  const defaults = defaultThresholdsFor(sensorType, unit)
  return {
    warning_min:
      config?.warning_min === null || config?.warning_min === undefined
        ? defaults.warning_min
        : Number(config.warning_min),
    warning_max:
      config?.warning_max === null || config?.warning_max === undefined
        ? defaults.warning_max
        : Number(config.warning_max),
    critical_min:
      config?.critical_min === null || config?.critical_min === undefined
        ? defaults.critical_min
        : Number(config.critical_min),
    critical_max:
      config?.critical_max === null || config?.critical_max === undefined
        ? defaults.critical_max
        : Number(config.critical_max)
  }
}

function evaluateAlert(sensorType, value, unit, thresholdConfig) {
  const type = (sensorType || "").toLowerCase()
  if (typeof value !== "number" || Number.isNaN(value)) return null

  const thresholds = normalizeThresholdConfig(thresholdConfig, sensorType, unit)
  const label = friendlySensorLabel(type)
  const reading = formatReadingForUser(value, unit)

  if (
    thresholds.critical_max !== null &&
    thresholds.critical_max !== undefined &&
    value >= thresholds.critical_max
  ) {
    const thr = formatReadingForUser(thresholds.critical_max, unit)
    return {
      kind: "threshold",
      level: "critical",
      message: `${label} is critically high at ${reading} (serious level: ${thr}+). Check the sensor or what's around it soon.`
    }
  }
  if (
    thresholds.critical_min !== null &&
    thresholds.critical_min !== undefined &&
    value <= thresholds.critical_min
  ) {
    const thr = formatReadingForUser(thresholds.critical_min, unit)
    return {
      kind: "threshold",
      level: "critical",
      message: `${label} is critically low at ${reading} (serious level: ${thr} or below). Check the sensor or what's around it soon.`
    }
  }
  if (
    thresholds.warning_max !== null &&
    thresholds.warning_max !== undefined &&
    value >= thresholds.warning_max
  ) {
    const thr = formatReadingForUser(thresholds.warning_max, unit)
    return {
      kind: "threshold",
      level: "warning",
      message: `${label}: ${reading}. That's above your usual heads-up (${thr}).`
    }
  }
  if (
    thresholds.warning_min !== null &&
    thresholds.warning_min !== undefined &&
    value <= thresholds.warning_min
  ) {
    const thr = formatReadingForUser(thresholds.warning_min, unit)
    return {
      kind: "threshold",
      level: "warning",
      message: `${label}: ${reading}. That's below your usual heads-up (${thr}).`
    }
  }
  return null
}

async function loadThresholdConfig(deviceId, sensorType, unit) {
  const { rows } = await query(
    `SELECT warning_min, warning_max, critical_min, critical_max
     FROM device_thresholds
     WHERE device_id = $1 AND lower(sensor_type) = lower($2)
     LIMIT 1`,
    [deviceId, sensorType || "custom"]
  )
  return normalizeThresholdConfig(rows[0] || null, sensorType, unit)
}

function pushHistory(deviceId, reading) {
  const history = readingHistoryByDeviceId.get(deviceId) || []
  history.push(reading)
  if (history.length > MAX_HISTORY_POINTS) {
    history.splice(0, history.length - MAX_HISTORY_POINTS)
  }
  readingHistoryByDeviceId.set(deviceId, history)
}

function pushAlert(userId, alertEvent) {
  const history = alertHistoryByUserId.get(userId) || []
  const previous = history[history.length - 1]
  // Avoid flooding duplicates for the same device + same alert message.
  if (
    previous &&
    previous.device_id === alertEvent.device_id &&
    previous.message === alertEvent.message
  ) {
    return
  }
  history.push(alertEvent)
  if (history.length > MAX_ALERT_HISTORY) {
    history.splice(0, history.length - MAX_ALERT_HISTORY)
  }
  alertHistoryByUserId.set(userId, history)
}

function maybeSeedHistory(deviceId, deviceUid) {
  const existing = readingHistoryByDeviceId.get(deviceId)
  if (existing && existing.length > 0) return

  const fallback = defaultReadingForDeviceUid(deviceUid)
  if (!fallback || typeof fallback.value !== "number") return

  const now = Date.now()
  const seeded = []
  for (let i = 29; i >= 0; i -= 1) {
    const jitterPct = (Math.random() - 0.5) * 0.12
    const value = Number.parseFloat((fallback.value * (1 + jitterPct)).toFixed(2))
    seeded.push({
      value: clamp(value, 0, Number.MAX_SAFE_INTEGER),
      sensor_type: fallback.sensor_type,
      unit: unitFromSensorType(fallback.sensor_type, fallback.unit),
      recorded_at: new Date(now - i * 2 * 60 * 1000).toISOString()
    })
  }
  readingHistoryByDeviceId.set(deviceId, seeded)
}

async function ensureTimeseriesSchema() {
  if (!pool) return
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS device_thresholds (
         id SERIAL PRIMARY KEY,
         device_id INTEGER NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
         sensor_type VARCHAR(64) NOT NULL,
         warning_min DOUBLE PRECISION,
         warning_max DOUBLE PRECISION,
         critical_min DOUBLE PRECISION,
         critical_max DOUBLE PRECISION,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (device_id, sensor_type)
       )`
    )
    await query(
      "CREATE INDEX IF NOT EXISTS device_thresholds_device_idx ON device_thresholds (device_id)"
    )
    await query(
      `INSERT INTO device_thresholds (device_id, sensor_type, warning_min, warning_max, critical_min, critical_max)
       SELECT
         d.id,
         CASE
           WHEN d.device_uid LIKE '%dev-attic-01' THEN 'temperature'
           WHEN d.device_uid LIKE '%dev-basement-01' THEN 'moisture'
           WHEN d.device_uid LIKE '%dev-kitchen-01' THEN 'vibration'
           ELSE 'custom'
         END AS sensor_type,
         CASE
           WHEN d.device_uid LIKE '%dev-basement-01' THEN 28
           ELSE NULL
         END AS warning_min,
         CASE
           WHEN d.device_uid LIKE '%dev-attic-01' THEN 27
           WHEN d.device_uid LIKE '%dev-kitchen-01' THEN 0.5
           ELSE NULL
         END AS warning_max,
         CASE
           WHEN d.device_uid LIKE '%dev-basement-01' THEN 20
           ELSE NULL
         END AS critical_min,
         CASE
           WHEN d.device_uid LIKE '%dev-attic-01' THEN 30
           WHEN d.device_uid LIKE '%dev-kitchen-01' THEN 1
           ELSE NULL
         END AS critical_max
       FROM devices d
       WHERE d.device_uid LIKE '%dev-attic-01'
          OR d.device_uid LIKE '%dev-basement-01'
          OR d.device_uid LIKE '%dev-kitchen-01'
       ON CONFLICT (device_id, sensor_type) DO NOTHING`
    )
    await query(
      `CREATE TABLE IF NOT EXISTS sensor_readings (
         id BIGSERIAL PRIMARY KEY,
         device_id INTEGER NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
         sensor_type VARCHAR(64) NOT NULL,
         value DOUBLE PRECISION NOT NULL,
         unit VARCHAR(32),
         recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    )
    await query(
      "CREATE INDEX IF NOT EXISTS sensor_readings_device_time_idx ON sensor_readings (device_id, recorded_at DESC)"
    )
    await query(
      "CREATE INDEX IF NOT EXISTS sensor_readings_type_time_idx ON sensor_readings (sensor_type, recorded_at DESC)"
    )
  } catch (err) {
    console.warn("[schema] setup skipped:", err.message)
  }
}

const RANGE_TO_INTERVAL = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  "365d": "365 days"
}

function normalizeRange(rangeRaw) {
  const range = String(rangeRaw || "1h").toLowerCase()
  return RANGE_TO_INTERVAL[range] ? range : "1h"
}

function chooseResolution(range, requested) {
  const normalizedRequested = String(requested || "auto").toLowerCase()
  if (normalizedRequested && normalizedRequested !== "auto") {
    if (normalizedRequested === "raw" || normalizedRequested === "hourly" || normalizedRequested === "daily") {
      return normalizedRequested
    }
    return "raw"
  }
  if (range === "1h" || range === "24h" || range === "7d") return "raw"
  if (range === "30d" || range === "90d") return "hourly"
  return "daily"
}

function maxPointsForResolution(resolution) {
  if (resolution === "daily") return 730
  if (resolution === "hourly") return 24 * 120
  return MAX_HISTORY_POINTS
}

function normalizeMetric(metricRaw) {
  const metric = String(metricRaw || "readings").toLowerCase()
  if (metric === "critical_counts") return "critical_counts"
  return "readings"
}

function criticalBucketForRange(range) {
  if (range === "24h") return "1 hour"
  if (range === "30d") return "1 day"
  if (range === "365d") return "1 month"
  if (range === "90d") return "1 day"
  return "10 minutes"
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return null
  const nums = values.filter((v) => Number.isFinite(v))
  if (nums.length === 0) return null
  return nums.reduce((acc, n) => acc + n, 0) / nums.length
}

function classifyTrend(previousAvg, currentAvg) {
  if (!Number.isFinite(previousAvg) || !Number.isFinite(currentAvg) || previousAvg === 0) {
    return { direction: "flat", percentChange: null }
  }
  const delta = currentAvg - previousAvg
  const pct = (delta / Math.abs(previousAvg)) * 100
  if (Math.abs(pct) < 3) return { direction: "flat", percentChange: pct }
  return { direction: pct > 0 ? "up" : "down", percentChange: pct }
}

function stdDev(values) {
  const nums = values.filter((v) => Number.isFinite(v))
  if (nums.length < 2) return null
  const mu = average(nums)
  const variance = nums.reduce((acc, n) => acc + (n - mu) ** 2, 0) / nums.length
  return Math.sqrt(variance)
}

function linearForecastNext(readings, points = 6) {
  const seq = readings
    .map((r) => ({ t: r.recorded_at ? new Date(r.recorded_at).getTime() : null, v: Number(r.value) }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.v))
    .slice(-points)
  if (seq.length < 3) return { next_value: null, slope_per_hour: null, confidence: "low" }

  const firstT = seq[0].t
  const xs = seq.map((p) => (p.t - firstT) / (60 * 60 * 1000))
  const ys = seq.map((p) => p.v)
  const xAvg = average(xs)
  const yAvg = average(ys)
  const numerator = xs.reduce((acc, x, i) => acc + (x - xAvg) * (ys[i] - yAvg), 0)
  const denominator = xs.reduce((acc, x) => acc + (x - xAvg) ** 2, 0)
  if (!Number.isFinite(denominator) || denominator === 0) {
    return { next_value: null, slope_per_hour: null, confidence: "low" }
  }
  const slope = numerator / denominator
  const intercept = yAvg - slope * xAvg
  const nextX = xs[xs.length - 1] + (xs[xs.length - 1] - xs[xs.length - 2] || 1)
  const nextValue = intercept + slope * nextX
  return {
    next_value: Number.isFinite(nextValue) ? Number(nextValue.toFixed(3)) : null,
    slope_per_hour: Number.isFinite(slope) ? Number(slope.toFixed(4)) : null,
    confidence: seq.length >= 5 ? "medium" : "low"
  }
}

// ============================================================================
// Agent context helpers
//
// The /agent/insights endpoint historically handed the model a wall of raw
// JSON (2000 points) and a vague "use concrete numbers" instruction. Models
// are great at quoting facts they've been given as labels, and bad at finding
// "the peak on Tuesday" inside a raw blob. So we pre-compute the interesting
// moments (peaks, streaks, jumps, week-over-week, etc.) and feed them as
// labeled facts the model is required to cite. The model also gets a small
// fleet summary so it can answer cross-device questions.
// ============================================================================

/**
 * Quick off-topic guard. The agent is only supposed to answer questions about
 * sensor data, alerts, environment, leak/water risk, and recommended actions.
 * Anything that obviously isn't (weather, news, recipes, code, plants, etc.)
 * gets caught here so we don't burn an OpenAI call or risk hallucination.
 *
 * Returns true if the question looks off-topic.
 */
function classifyOffTopic(question) {
  const q = String(question || "").trim().toLowerCase()
  if (!q) return false
  const offTopicPatterns = [
    /\bweather\b/, /\bforecast\s+for\b/, /\btemperature\s+outside\b/,
    /\bnews\b/, /\bstocks?\b/, /\bcrypto\b/, /\bbitcoin\b/,
    /\brecipes?\b/, /\bcook\b/, /\bdinner\b/,
    /\bplants?\b/, /\bgarden\b/, /\bpet\b/, /\bdog\b/, /\bcat\b/,
    /\bwrite\s+code\b/, /\bdebug\b/, /\bpython\b/, /\bjavascript\b/,
    /\bcapital\s+of\b/, /\bpresident\b/, /\bhistory\s+of\b/,
    /\bjoke\b/, /\bpoem\b/, /\bsong\b/,
    /\btell\s+me\s+about\s+yourself\b/
  ]
  return offTopicPatterns.some((re) => re.test(q))
}

/**
 * Convert a value list of {value, recorded_at} into the single peak (the
 * highest value). Returns null if no usable points.
 */
function findPeak(points) {
  let best = null
  for (const p of points) {
    const v = Number(p?.value)
    if (!Number.isFinite(v)) continue
    if (!best || v > best.value) {
      best = { value: v, recorded_at: p.recorded_at || null, sensor_type: p.sensor_type || null, unit: p.unit || null }
    }
  }
  return best
}

/**
 * Largest absolute value change between two consecutive readings inside the
 * given window (defaults to 24h before "now"). Used to call out "vibration
 * jumped from 0.2 to 1.4 at 7:18 PM" — the kind of specific fact the model
 * would otherwise miss in a raw blob.
 */
function findBiggestJump(points, windowMs = 24 * 60 * 60 * 1000) {
  const nowMs = Date.now()
  const inWindow = points
    .filter((p) => p.recorded_at && nowMs - new Date(p.recorded_at).getTime() <= windowMs)
    .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at))
  let best = null
  for (let i = 1; i < inWindow.length; i += 1) {
    const a = inWindow[i - 1]
    const b = inWindow[i]
    const av = Number(a.value)
    const bv = Number(b.value)
    if (!Number.isFinite(av) || !Number.isFinite(bv)) continue
    const delta = bv - av
    if (!best || Math.abs(delta) > Math.abs(best.delta)) {
      best = {
        delta: Number(delta.toFixed(3)),
        from_value: av,
        to_value: bv,
        from_at: a.recorded_at,
        to_at: b.recorded_at
      }
    }
  }
  return best
}

/**
 * Longest consecutive run of readings that crossed the critical threshold.
 * Threshold semantics match evaluateAlert(): a reading is "above threshold"
 * if it meets either critical_max (high-side) or critical_min (low-side).
 */
function findLongestCriticalStreak(points, thresholds) {
  if (!thresholds) return null
  const ordered = [...points].sort(
    (a, b) => new Date(a.recorded_at) - new Date(b.recorded_at)
  )
  const isCritical = (v) =>
    (thresholds.critical_max !== null && thresholds.critical_max !== undefined && v >= thresholds.critical_max) ||
    (thresholds.critical_min !== null && thresholds.critical_min !== undefined && v <= thresholds.critical_min)

  let best = null
  let runStart = null
  let runCount = 0
  let runLast = null
  for (const p of ordered) {
    const v = Number(p?.value)
    if (!Number.isFinite(v)) continue
    if (isCritical(v)) {
      if (runCount === 0) runStart = p.recorded_at
      runLast = p.recorded_at
      runCount += 1
    } else {
      if (runCount > 0 && (!best || runCount > best.count)) {
        best = { count: runCount, started_at: runStart, ended_at: runLast }
      }
      runStart = null
      runLast = null
      runCount = 0
    }
  }
  if (runCount > 0 && (!best || runCount > best.count)) {
    best = { count: runCount, started_at: runStart, ended_at: runLast }
  }
  return best
}

/**
 * Per-day count of critical readings in the last 7 days. Returns an array
 * sorted oldest -> newest with a `count` per day (zero-filled).
 */
function criticalPerDay7d(points, thresholds) {
  if (!thresholds) return []
  const nowMs = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  const buckets = new Map()
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(nowMs - i * dayMs)
    d.setHours(0, 0, 0, 0)
    buckets.set(d.toISOString(), 0)
  }
  const isCritical = (v) =>
    (thresholds.critical_max !== null && thresholds.critical_max !== undefined && v >= thresholds.critical_max) ||
    (thresholds.critical_min !== null && thresholds.critical_min !== undefined && v <= thresholds.critical_min)

  for (const p of points) {
    const v = Number(p?.value)
    if (!Number.isFinite(v) || !isCritical(v) || !p.recorded_at) continue
    const ts = new Date(p.recorded_at)
    ts.setHours(0, 0, 0, 0)
    const key = ts.toISOString()
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1)
  }
  return Array.from(buckets.entries()).map(([date, count]) => ({ date, count }))
}

/**
 * Per-sensor remediation knowledge base. The model gets the playbook for the
 * current sensor type appended to its context so its "what should I do?"
 * answers are tailored (e.g. moisture -> check pipe joints, NOT "open a
 * window"; temperature -> airflow/insulation, NOT "run a dehumidifier").
 *
 * Each playbook has:
 *   - likely_causes: hypotheses the agent can reference
 *   - environment_questions: clarifying follow-ups when context is missing
 *     (these become the `follow_ups` chips the user can click in the UI)
 *   - quick_fixes: things the user can try right now
 *   - deeper_fixes: longer-term remediation
 *   - red_flags: things that mean "stop, call a professional"
 *
 * The "high" vs "low" branches handle critical_max vs critical_min cases.
 */
const REMEDIATION_PLAYBOOKS = {
  temperature: {
    high: {
      likely_causes: [
        "Direct sun on the room or sensor location",
        "Poor airflow / blocked vents / closed door",
        "AC/HVAC undersized or not running",
        "Heat-producing appliances nearby (oven, dryer, server, fish tank)",
        "Insufficient insulation in walls or attic"
      ],
      environment_questions: [
        "Which room is this sensor in?",
        "Does this room get direct sunlight during the day?",
        "Is the AC or a ceiling/box fan running here?",
        "Are vents or returns blocked or closed?",
        "Are there heat-producing appliances near the sensor?"
      ],
      quick_fixes: [
        "Close blinds or curtains during peak sun hours.",
        "Open the door and run a fan to improve airflow.",
        "Verify AC vents in this room are open and unblocked.",
        "Move heat-producing electronics away from the sensor."
      ],
      deeper_fixes: [
        "Have HVAC airflow balanced if this room runs consistently warm.",
        "Add attic insulation or reflective film to sun-facing windows.",
        "Schedule a smart thermostat to pre-cool this room before peak hours."
      ],
      red_flags: ["Indoor temperature staying above 32 °C (90 °F) for hours with AC running."]
    },
    low: {
      likely_causes: ["Drafts from windows or doors", "Heater not reaching this room", "Poor insulation"],
      environment_questions: [
        "Which room is this sensor in?",
        "Is there a window or door nearby that might be drafty?",
        "Does the heater (vent / radiator) reach this room?",
        "Is the room used often, or mostly empty?"
      ],
      quick_fixes: [
        "Close any open windows and check door seals.",
        "Run a space heater on low if the room is being used.",
        "Make sure heating vents in this room are open."
      ],
      deeper_fixes: ["Weatherstrip drafty windows and doors.", "Add insulation if the room shares an exterior wall."],
      red_flags: []
    }
  },
  humidity: {
    high: {
      likely_causes: [
        "Recent showering or cooking without exhaust fan",
        "Wet laundry drying indoors",
        "Bathroom/kitchen exhaust fan broken or missing",
        "Slow leak hidden in walls or under sink",
        "Outdoor humidity is high and windows are open"
      ],
      environment_questions: [
        "Which room is this sensor in (bathroom, kitchen, basement, bedroom)?",
        "Has anything been damp recently — wet towels, laundry drying inside, or a recent shower?",
        "Is there an exhaust fan in this room, and does it work?",
        "Have you noticed any musty smell or discoloration on walls/ceiling?"
      ],
      quick_fixes: [
        "Run the exhaust fan for 20–30 minutes after showers or cooking.",
        "Move wet laundry outside or to a dryer.",
        "Run a dehumidifier; empty it daily until levels drop."
      ],
      deeper_fixes: [
        "Install or repair the bathroom/kitchen exhaust fan.",
        "Check under sinks and around appliances for slow leaks.",
        "Add a whole-home dehumidifier if multiple rooms read high."
      ],
      red_flags: [
        "Musty smell + visible discoloration → possible mold; inspect drywall/insulation soon.",
        "Humidity stays above 70% for days with no obvious source → hidden leak suspected."
      ]
    },
    low: {
      likely_causes: ["Heating system drying the air in winter"],
      environment_questions: ["Are you running the heater a lot right now?", "Is anyone in the house getting dry skin or static shocks?"],
      quick_fixes: ["Run a small humidifier in occupied rooms."],
      deeper_fixes: ["Consider a whole-home humidifier on the HVAC system."],
      red_flags: []
    }
  },
  moisture: {
    high: {
      likely_causes: [
        "Spilled water or recent cleaning nearby",
        "Slow drip from a pipe fitting or appliance hose",
        "Rain or snow melt seeping in through a wall/floor",
        "Condensation from a cold pipe or AC line",
        "Hidden leak inside a wall or under flooring"
      ],
      environment_questions: [
        "Where is this sensor placed — near a pipe, appliance, basement floor, or outside wall?",
        "Has there been any plumbing work, dishwasher/washer run, or rain recently?",
        "Do you see any visible water, staining, or warping of nearby flooring?",
        "Does the area smell musty or damp?"
      ],
      quick_fixes: [
        "Inspect the sensor's immediate area for visible water and dry it.",
        "Check the nearest pipe joints, valve, and appliance hose for slow drips.",
        "Place a dry paper towel under the sensor and check it in 24h."
      ],
      deeper_fixes: [
        "If the paper towel is wet again with no spill, call a plumber to inspect for a hidden leak.",
        "Improve drainage around the foundation if water is seeping through a basement wall.",
        "Re-caulk around tubs/showers/sinks if grout looks dark or soft."
      ],
      red_flags: [
        "Sustained moisture spikes with no obvious cause → hidden plumbing leak; investigate within days, not weeks.",
        "Moisture + musty smell + dark spots on drywall → likely mold; address quickly."
      ]
    },
    low: {
      likely_causes: ["Normal dry conditions"],
      environment_questions: [],
      quick_fixes: [],
      deeper_fixes: [],
      red_flags: []
    }
  },
  vibration: {
    high: {
      likely_causes: [
        "Appliance running on/near the sensor (washer, dryer, HVAC unit, sump pump)",
        "Unbalanced or aging appliance (loose drum, worn bearings)",
        "External source: nearby construction, road traffic, train",
        "Loose mounting of the sensor itself"
      ],
      environment_questions: [
        "What is this sensor attached to or near (appliance, foundation wall, floor joist)?",
        "Did vibration start suddenly, or has it been building over weeks?",
        "Is there a specific time of day this spikes (correlates with an appliance cycle)?",
        "Has any construction or new equipment started nearby recently?"
      ],
      quick_fixes: [
        "Check that the sensor itself is firmly mounted.",
        "Re-level the appliance closest to the sensor.",
        "Move the sensor 6–12 inches and recheck — confirms whether it's the source or a real issue."
      ],
      deeper_fixes: [
        "Service the appliance (drum, motor mounts, bearings) if vibration grows over time.",
        "Add anti-vibration pads under washers/dryers/HVAC units.",
        "Have an HVAC tech inspect the unit if vibration correlates with cycles."
      ],
      red_flags: ["Sudden new vibration on a load-bearing wall or foundation → inspect for structural cause."]
    },
    low: { likely_causes: [], environment_questions: [], quick_fixes: [], deeper_fixes: [], red_flags: [] }
  },
  power: {
    high: {
      likely_causes: [
        "New high-draw device added to the circuit",
        "Appliance malfunctioning (compressor short-cycling, heating element stuck on)",
        "Phantom loads / many devices on standby"
      ],
      environment_questions: [
        "What's plugged into this circuit?",
        "Did anything new get added recently (space heater, EV charger, server)?",
        "Does the spike happen at a regular time (suggests a cycling appliance)?"
      ],
      quick_fixes: [
        "Unplug non-essential devices and watch the meter.",
        "Identify and unplug the highest-draw item briefly to confirm the source."
      ],
      deeper_fixes: [
        "Move high-draw appliances to a dedicated circuit.",
        "Have an electrician inspect if you suspect a short or wiring fault."
      ],
      red_flags: ["Warm outlet covers, burning smell, or breaker trips → electrical hazard, address immediately."]
    },
    low: { likely_causes: [], environment_questions: [], quick_fixes: [], deeper_fixes: [], red_flags: [] }
  }
}

/**
 * Pick the right playbook branch ("high" vs "low") for the current sensor
 * based on which side of the threshold is being exceeded (or could be).
 */
function pickPlaybookFor(sensorType, thresholds) {
  const key = String(sensorType || "").toLowerCase()
  const book = REMEDIATION_PLAYBOOKS[key]
  if (!book) return null
  const hasHigh = thresholds?.critical_max !== null && thresholds?.critical_max !== undefined
  const hasLow = thresholds?.critical_min !== null && thresholds?.critical_min !== undefined
  if (hasHigh && hasLow) return { sensor_type: key, sides: { high: book.high, low: book.low } }
  if (hasHigh) return { sensor_type: key, sides: { high: book.high } }
  if (hasLow) return { sensor_type: key, sides: { low: book.low } }
  // No threshold configured yet — default to the "high" branch since that's
  // the common case (temperature/humidity/vibration/power).
  return { sensor_type: key, sides: { high: book.high } }
}

/**
 * Detect whether the user is asking "how do I fix/improve this?" rather than
 * "what's happening?". This lets the prompt switch into advisor mode and
 * proactively ask clarifying environment questions when needed.
 */
function classifyAdvisoryIntent(question) {
  const q = String(question || "").trim().toLowerCase()
  if (!q) return false
  const advisoryPatterns = [
    /\bhow\s+(?:can|do)\s+i\b/,
    /\bwhat\s+(?:can|should)\s+i\s+do\b/,
    /\bhow\s+to\s+(?:fix|reduce|lower|raise|improve|stop|prevent|address)\b/,
    /\b(?:fix|solve|reduce|lower|improve|stop|prevent|address|remediate)\b/,
    /\bcritical\s+(?:condition|event|reading)s?\b/,
    /\b(?:help|advice|recommend(?:ation)?|action)s?\b/,
    /\bwhat\s+(?:do|should)\s+i\b/,
    /\bshould\s+i\s+(?:worry|be\s+worried|call|do)\b/
  ]
  return advisoryPatterns.some((re) => re.test(q))
}

/**
 * Build the structured `facts` block the model is required to quote from.
 * This is the single biggest lever for getting specific (not generic) answers.
 *
 * Every field that survives into the prompt should be:
 *   - small (no raw point lists)
 *   - already-computed (the model just quotes it)
 *   - timestamped (so claims can be tied to a chart range)
 */
function buildAgentFacts({
  device,
  thresholds,
  recentReadings,
  dailyTrend14d,
  daily90d,
  monthly12m
}) {
  const nowMs = Date.now()
  const dayMs = 24 * 60 * 60 * 1000

  const last24h = recentReadings.filter(
    (r) => r.recorded_at && nowMs - new Date(r.recorded_at).getTime() <= dayMs
  )
  const last7d = recentReadings

  const peak24h = findPeak(last24h)
  const peak7d = findPeak(last7d)

  const criticalEvents7d = thresholds
    ? last7d.filter((r) => {
        const v = Number(r.value)
        if (!Number.isFinite(v)) return false
        return (
          (thresholds.critical_max !== null && thresholds.critical_max !== undefined && v >= thresholds.critical_max) ||
          (thresholds.critical_min !== null && thresholds.critical_min !== undefined && v <= thresholds.critical_min)
        )
      })
    : []
  const criticalEvents24h = criticalEvents7d.filter(
    (r) => r.recorded_at && nowMs - new Date(r.recorded_at).getTime() <= dayMs
  )
  const latestCriticalEvent =
    criticalEvents7d.length > 0
      ? criticalEvents7d
          .slice()
          .sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at))[0]
      : null

  // Week-over-week using the 14-day daily aggregate (7 newest vs 7 prior).
  const sortedDaily = [...dailyTrend14d].sort(
    (a, b) => new Date(a.day_bucket) - new Date(b.day_bucket)
  )
  const lastWeek = sortedDaily.slice(-7).map((d) => Number(d.avg_value)).filter(Number.isFinite)
  const priorWeek = sortedDaily.slice(-14, -7).map((d) => Number(d.avg_value)).filter(Number.isFinite)
  const lastWeekAvg = average(lastWeek)
  const priorWeekAvg = average(priorWeek)
  const wow = classifyTrend(priorWeekAvg, lastWeekAvg)

  // Year-over-year only meaningful when monthly history is long enough.
  let yoy = null
  if (monthly12m && monthly12m.length >= 13) {
    const sortedM = [...monthly12m].sort(
      (a, b) => new Date(a.month_bucket) - new Date(b.month_bucket)
    )
    const thisYear = sortedM.slice(-12).map((d) => Number(d.avg_value)).filter(Number.isFinite)
    const lastYear = sortedM.slice(-24, -12).map((d) => Number(d.avg_value)).filter(Number.isFinite)
    const thisYearAvg = average(thisYear)
    const lastYearAvg = average(lastYear)
    if (thisYearAvg !== null && lastYearAvg !== null) {
      yoy = {
        this_year_avg: Number(thisYearAvg.toFixed(3)),
        last_year_avg: Number(lastYearAvg.toFixed(3)),
        delta_pct:
          lastYearAvg !== 0 ? Number((((thisYearAvg - lastYearAvg) / Math.abs(lastYearAvg)) * 100).toFixed(2)) : null
      }
    }
  }

  return {
    device: {
      id: device?.id,
      name: device?.name,
      label: friendlyDeviceDisplayName(device?.name, device?.device_uid),
      sensor_type: device?.sensor_type || null,
      unit: device?.unit || null
    },
    thresholds: thresholds || null,
    peak_24h: peak24h,
    peak_7d: peak7d,
    latest_critical_event: latestCriticalEvent
      ? {
          value: Number(latestCriticalEvent.value),
          recorded_at: latestCriticalEvent.recorded_at
        }
      : null,
    critical_events_last_24h: criticalEvents24h.length,
    critical_events_last_7d: criticalEvents7d.length,
    critical_events_per_day_last_7d: criticalPerDay7d(last7d, thresholds),
    biggest_jump_last_24h: findBiggestJump(last7d, dayMs),
    longest_critical_streak: findLongestCriticalStreak(last7d, thresholds),
    comparison_this_week_vs_last_week: {
      this_week_avg: lastWeekAvg !== null ? Number(lastWeekAvg.toFixed(3)) : null,
      last_week_avg: priorWeekAvg !== null ? Number(priorWeekAvg.toFixed(3)) : null,
      direction: wow.direction,
      delta_pct: wow.percentChange !== null ? Number(wow.percentChange.toFixed(2)) : null
    },
    comparison_this_year_vs_last_year: yoy,
    daily_summary_last_90d: (daily90d || []).slice(-90),
    monthly_summary_last_12m: (monthly12m || []).slice(-12)
  }
}

function computeAdvancedAnalytics(recentReadings, dailyTrendRows, sensorType) {
  const nowMs = Date.now()
  const weekMs = 7 * 24 * 60 * 60 * 1000
  const currentWeek = recentReadings
    .filter((r) => r.recorded_at && nowMs - new Date(r.recorded_at).getTime() <= weekMs)
    .map((r) => Number(r.value))
    .filter((v) => Number.isFinite(v))
  const previousWeek = dailyTrendRows
    .slice(0, Math.max(0, dailyTrendRows.length - 7))
    .map((d) => Number(d.avg_value))
    .filter((v) => Number.isFinite(v))
  const currentWeekAvg = average(currentWeek)
  const previousWeekAvg = average(previousWeek.slice(-7))
  const woW = classifyTrend(previousWeekAvg, currentWeekAvg)

  const baseline = average(currentWeek)
  const sigma = stdDev(currentWeek)
  const latest = recentReadings[recentReadings.length - 1]
  const latestValue = Number(latest?.value)
  const zScore =
    Number.isFinite(latestValue) && Number.isFinite(baseline) && Number.isFinite(sigma) && sigma > 0
      ? (latestValue - baseline) / sigma
      : null
  const isAnomaly = Number.isFinite(zScore) ? Math.abs(zScore) >= 2 : false
  const forecast = linearForecastNext(recentReadings, 8)

  const t = String(sensorType || "").toLowerCase()
  const leakSensitive = t === "moisture" || t === "humidity" || t === "temperature"
  const trendFactor = woW.percentChange === null ? 0 : Math.max(0, woW.percentChange)
  const anomalyFactor = isAnomaly ? 20 : 0
  const forecastFactor =
    Number.isFinite(forecast.slope_per_hour) && forecast.slope_per_hour > 0
      ? Math.min(20, forecast.slope_per_hour * 20)
      : 0
  const leakRiskScoreRaw = (leakSensitive ? 35 : 20) + trendFactor + anomalyFactor + forecastFactor
  const leakRiskScore = Math.max(0, Math.min(100, Number(leakRiskScoreRaw.toFixed(1))))
  const leakRiskLevel = leakRiskScore >= 75 ? "high" : leakRiskScore >= 45 ? "medium" : "low"

  return {
    week_over_week: {
      previous_avg: previousWeekAvg !== null ? Number(previousWeekAvg.toFixed(3)) : null,
      current_avg: currentWeekAvg !== null ? Number(currentWeekAvg.toFixed(3)) : null,
      direction: woW.direction,
      percent_change: woW.percentChange !== null ? Number(woW.percentChange.toFixed(2)) : null
    },
    anomaly: {
      is_anomaly: isAnomaly,
      z_score: zScore !== null ? Number(zScore.toFixed(3)) : null
    },
    forecast,
    leak_risk: {
      score: leakRiskScore,
      level: leakRiskLevel
    }
  }
}

function extractJsonObject(text) {
  const raw = String(text || "").trim()
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : raw
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return null
  return candidate.slice(start, end + 1)
}

function classifyQuestionIntent(question) {
  const q = String(question || "").trim().toLowerCase()
  if (!q) return "summary"
  if (["hi", "hello", "hey", "yo", "sup"].includes(q)) return "greeting"
  if (q.length < 6) return "greeting"
  const analyticalSignals = [
    "trend",
    "risk",
    "leak",
    "water",
    "moisture",
    "humidity",
    "temperature",
    "sensor",
    "why",
    "how",
    "what does",
    "recommend",
    "action",
    "next",
    "increase",
    "decrease"
  ]
  return analyticalSignals.some((k) => q.includes(k)) ? "analysis" : "analysis"
}

function aiConversationKey(userId, deviceId) {
  return `${userId}:${deviceId}`
}

function getAiConversation(userId, deviceId) {
  return aiConversationByDeviceKey.get(aiConversationKey(userId, deviceId)) || []
}

function pushAiConversationTurn(userId, deviceId, turn) {
  const key = aiConversationKey(userId, deviceId)
  const turns = aiConversationByDeviceKey.get(key) || []
  turns.push(turn)
  if (turns.length > MAX_AI_TURNS) {
    turns.splice(0, turns.length - MAX_AI_TURNS)
  }
  aiConversationByDeviceKey.set(key, turns)
}

function enforceQuestionAwareInsight(insight, question, fallbackSummary) {
  const safeInsight = insight && typeof insight === "object" ? { ...insight } : {}
  const q = String(question || "").trim()

  // is_on_topic defaults to true unless the model explicitly flagged it false.
  safeInsight.is_on_topic = safeInsight.is_on_topic === false ? false : true

  if (Array.isArray(safeInsight.key_points)) {
    safeInsight.key_points = safeInsight.key_points
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 4)
  } else {
    safeInsight.key_points = []
  }

  // New: structured actions with severity. Keep `recommendations` as a flat
  // string array for backward compatibility with older UI builds.
  const allowedSeverities = new Set(["critical", "warning", "info"])
  if (Array.isArray(safeInsight.actions)) {
    safeInsight.actions = safeInsight.actions
      .map((a) => {
        if (!a) return null
        if (typeof a === "string") {
          return { severity: "info", text: a.trim() }
        }
        const text = String(a.text || "").trim()
        if (!text) return null
        const severity = allowedSeverities.has(String(a.severity || "").toLowerCase())
          ? String(a.severity).toLowerCase()
          : "info"
        return { severity, text }
      })
      .filter(Boolean)
      .slice(0, 3)
  } else {
    safeInsight.actions = []
  }

  if (Array.isArray(safeInsight.recommendations)) {
    safeInsight.recommendations = safeInsight.recommendations
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 3)
  } else {
    safeInsight.recommendations = []
  }
  // Mirror actions -> recommendations so older clients keep working.
  if (safeInsight.recommendations.length === 0 && safeInsight.actions.length > 0) {
    safeInsight.recommendations = safeInsight.actions.map((a) => a.text)
  }
  // And the other way around if the model only returned recommendations.
  if (safeInsight.actions.length === 0 && safeInsight.recommendations.length > 0) {
    safeInsight.actions = safeInsight.recommendations.map((text) => ({ severity: "info", text }))
  }

  // follow_ups: short clarifying questions the agent wants the user to answer
  // next. Rendered as clickable suggestion chips in the UI; clicking a chip
  // re-asks the agent with that question.
  if (Array.isArray(safeInsight.follow_ups)) {
    safeInsight.follow_ups = safeInsight.follow_ups
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 4)
  } else {
    safeInsight.follow_ups = []
  }

  // Highlight: { device_id, start_iso, end_iso, reason } — used by the chart
  // to draw a tinted band over the time range the AI is talking about.
  if (safeInsight.highlight && typeof safeInsight.highlight === "object") {
    const h = safeInsight.highlight
    const start = h.start_iso || h.start || null
    const end = h.end_iso || h.end || null
    const reason = String(h.reason || "").trim() || null
    const deviceId = Number.isFinite(Number(h.device_id)) ? Number(h.device_id) : null
    const startMs = start ? new Date(start).getTime() : NaN
    const endMs = end ? new Date(end).getTime() : NaN
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      safeInsight.highlight = {
        device_id: deviceId,
        start_iso: new Date(startMs).toISOString(),
        end_iso: new Date(endMs).toISOString(),
        reason
      }
    } else {
      safeInsight.highlight = null
    }
  } else {
    safeInsight.highlight = null
  }

  if (q) {
    const answerText = String(safeInsight.answer || "").trim()
    const looksQuestionAware =
      answerText.toLowerCase().includes("your question") ||
      answerText.toLowerCase().includes(q.toLowerCase().slice(0, 20))
    if (!answerText || !looksQuestionAware) {
      safeInsight.answer = `To answer your question "${q}": ${String(
        safeInsight.summary || fallbackSummary || "Based on current readings, risk appears stable."
      )}`
    }
  }

  if (!String(safeInsight.summary || "").trim()) {
    safeInsight.summary = String(fallbackSummary || "No summary available yet.")
  }

  return safeInsight
}

/**
 * Canned refusal payload for clearly off-topic questions. We short-circuit to
 * this so we don't burn an OpenAI call and so users see a consistent message
 * instead of the model trying its best to invent an answer.
 */
function buildRefusalInsight(question, deviceLabel) {
  const q = String(question || "").trim()
  return {
    is_on_topic: false,
    summary:
      "I can only analyze sensor data and recommend actions for your HomeSense devices.",
    answer:
      `That's outside what I can help with. I'm built to look at this device's readings, alerts, and trends — ` +
      `try asking about ${deviceLabel || "your device"} instead (for example: "What was the peak in the last 24 hours?" ` +
      `or "Should I be worried about the recent trend?").`,
    key_points: [],
    actions: [],
    recommendations: [],
    highlight: null,
    trend: { direction: "flat", percent_change: null }
  }
}

function buildDeterministicInsight(
  device,
  latestReading,
  recentReadings,
  dailyTrendRows,
  question,
  analytics = null
) {
  const deviceName = friendlyDeviceDisplayName(device?.name, device?.device_uid || "device")
  const sensorType = latestReading?.sensor_type || recentReadings[recentReadings.length - 1]?.sensor_type || "sensor"
  const unit = unitFromSensorType(sensorType, latestReading?.unit || "")
  const values = recentReadings.map((r) => r.value).filter((v) => Number.isFinite(v))
  const latestValue = Number.isFinite(latestReading?.value) ? latestReading.value : null
  const stats =
    values.length > 0
      ? {
          min: Math.min(...values),
          max: Math.max(...values),
          avg: average(values)
        }
      : { min: null, max: null, avg: null }

  const half = Math.floor(dailyTrendRows.length / 2)
  const firstHalf = dailyTrendRows.slice(0, half).map((r) => Number(r.avg_value))
  const secondHalf = dailyTrendRows.slice(half).map((r) => Number(r.avg_value))
  const trend = classifyTrend(average(firstHalf), average(secondHalf))
  const trendText =
    trend.percentChange === null
      ? "Not enough historical trend data yet."
      : trend.direction === "flat"
        ? `Trend is stable (about ${Math.abs(trend.percentChange).toFixed(1)}% change).`
        : `Trend is ${trend.direction === "up" ? "increasing" : "decreasing"} by about ${Math.abs(
            trend.percentChange
          ).toFixed(1)}% versus the prior period.`
  const latestDelta =
    Number.isFinite(latestValue) && Number.isFinite(stats.avg) && stats.avg !== 0
      ? ((latestValue - stats.avg) / Math.abs(stats.avg)) * 100
      : null
  const latestDeltaText =
    latestDelta === null
      ? "Deviation from baseline cannot be computed yet."
      : latestDelta >= 0
        ? `Latest reading is ${latestDelta.toFixed(1)}% above the recent baseline.`
        : `Latest reading is ${Math.abs(latestDelta).toFixed(1)}% below the recent baseline.`
  const riskLevel =
    trend.direction === "up" && (trend.percentChange || 0) >= 8
      ? "high"
      : trend.direction === "up"
        ? "medium"
        : "low"
  const modeledRisk = analytics?.leak_risk?.level || riskLevel
  const modeledScore = analytics?.leak_risk?.score
  const answerText = question
    ? `To answer your question "${question}": ${trendText} Current risk is ${modeledRisk}${
        Number.isFinite(modeledScore) ? ` (score ${modeledScore}/100)` : ""
      }.`
    : null

  const actions = [
    {
      severity: modeledRisk === "high" ? "critical" : modeledRisk === "medium" ? "warning" : "info",
      text: "Check this device again in 24 hours and compare against alert history."
    },
    {
      severity: "info",
      text:
        trend.direction === "up"
          ? "If readings keep rising for 2 more days, inspect nearby pipes/fittings or move the sensor to confirm."
          : "Trend looks stable — keep monitoring weekly."
    }
  ]
  return {
    is_on_topic: true,
    summary: `For ${deviceName}, the ${sensorType} sensor currently reads ${
      latestValue !== null ? `${latestValue}${unit ? ` ${unit}` : ""}` : "no recent value"
    }. ${trendText} Risk is ${modeledRisk}${
      Number.isFinite(modeledScore) ? ` (score ${modeledScore}/100)` : ""
    }.`,
    key_points: [
      `Recent average: ${
        Number.isFinite(stats.avg) ? `${Number(stats.avg).toFixed(2)}${unit ? ` ${unit}` : ""}` : "n/a"
      }`,
      `Recent range: ${
        Number.isFinite(stats.min) && Number.isFinite(stats.max)
          ? `${Number(stats.min).toFixed(2)} to ${Number(stats.max).toFixed(2)}${unit ? ` ${unit}` : ""}`
          : "n/a"
      }`,
      trendText,
      latestDeltaText
    ],
    actions,
    recommendations: actions.map((a) => a.text),
    follow_ups: [],
    highlight: null,
    answer: answerText,
    trend: {
      direction: trend.direction,
      percent_change: trend.percentChange !== null ? Number(trend.percentChange.toFixed(2)) : null
    }
  }
}

async function generateOpenAIInsight(context, question) {
  if (!OPENAI_API_KEY) return null
  const prompt = {
    role: "user",
    content: [
      {
        type: "input_text",
        text:
          "You are the HomeSense Agent — a household conditions advisor. You help the user understand their sensor " +
          "readings AND fix problems in their home. You speak like a knowledgeable handy friend: specific, calm, and " +
          "useful. You only answer questions about: sensor readings, alerts, leak/moisture/temperature/vibration/" +
          "humidity/power risk, device behavior, environmental trends, and concrete remediation. Anything else " +
          "(weather forecasts, news, general knowledge, plants, pets, code help, recipes, jokes) is out of scope."
      },
      {
        type: "input_text",
        text: `User question: ${question || "(no question — give a proactive summary of this device's state and the single most important action right now)"}`
      },
      {
        type: "input_text",
        text:
          "GROUNDING RULES — you MUST follow these:\n" +
          "1. Use only the facts inside `facts.*` and `fleet.*`. Do not invent values, timestamps, or events that are not in the JSON.\n" +
          "2. When you make a claim about a number, you MUST quote the exact value AND its timestamp from facts (e.g. \"vibration peaked at 1.42 at 2026-05-11T19:18:00Z\").\n" +
          "3. When you reference a time window (a peak, an event, a streak), you MUST also set `highlight` so the chart can mark that range. Pick the tightest window that supports your claim (e.g. ±15 minutes around an event, or the streak's started_at..ended_at).\n" +
          "4. Format timestamps in `answer` for humans (\"7:18 PM\" or \"Tuesday at 7:18 PM\") — but `highlight.start_iso` and `highlight.end_iso` MUST be raw ISO strings copied from facts.\n" +
          "5. If `facts.critical_events_last_24h` is 0 AND no other concerning fact is present, say so plainly — do NOT manufacture risk.\n" +
          "6. If the question is out of scope (anything not about this device's sensor data, alerts, or recommended action), set `is_on_topic` to false and put a brief refusal in `answer`. Leave `key_points`, `actions`, and `follow_ups` empty in that case.\n" +
          "\n" +
          "ADVISOR RULES — when the user asks how to fix/improve, OR when critical events exist:\n" +
          "A. Tailor recommendations to the sensor type using `playbook.sides.*` (likely_causes, quick_fixes, deeper_fixes, red_flags). Do not give moisture advice for a temperature sensor or vice versa.\n" +
          "B. Convert the playbook items into specific, prioritized actions for the user's situation — don't just paste them verbatim. Reference the actual readings when you do (e.g. 'Since humidity is sitting at 78% (peak 82% at 6:14 PM), run the bathroom exhaust fan after showers for 30 min.').\n" +
          "C. Severity guide: 'critical' = do today (risk of damage, mold, or hazard), 'warning' = do this week, 'info' = good practice / preventative.\n" +
          "D. If a playbook `red_flags` entry applies based on facts (e.g. sustained high readings, no obvious cause, musty conditions implied), surface it as a critical action.\n" +
          "E. Always return 1–3 actions. More than 3 is overwhelming.\n" +
          "\n" +
          "FOLLOW-UP QUESTIONS — `follow_ups` field:\n" +
          "F. If you don't have enough context about the home environment to give a strong recommendation (room type, ventilation, recent activity, what's near the sensor, what's plugged in, etc.), ASK 2–3 short follow-up questions in `follow_ups`. Pull them from `playbook.sides.*.environment_questions` but rephrase them naturally and keep each under 80 characters.\n" +
          "G. Do not ask follow-ups when the user only wants observation/analysis (e.g. 'what was the peak?', 'is it trending up?'). Use follow-ups only when remediation depends on missing context.\n" +
          "H. If the user already answered an environment question in a prior conversation turn (see `conversation_memory`), don't ask it again."
      },
      {
        type: "input_text",
        text: `Context JSON:\n${JSON.stringify(context)}`
      }
    ]
  }

  const requestBody = (model) => ({
    model,
    temperature: 0.35,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Return STRICT JSON only (no prose, no markdown fences) with exactly these keys:\n" +
              "  is_on_topic: boolean — true if the question is about this device's sensor data, alerts, environment, or recommended actions.\n" +
              "  summary: string — 1-2 short sentences citing at least one specific value+timestamp from facts.\n" +
              "  answer: string — direct response to the user's question, starting with 'To answer your question'. MUST quote exact numbers and human-readable times from facts.\n" +
              "  key_points: string[] — 2-4 short bullets, each anchored on a specific fact (e.g. 'Peak last 24h: 30.9 °C at 7:18 PM').\n" +
              "  actions: { severity: 'critical'|'warning'|'info', text: string }[] — 1-3 prioritized next steps tailored to the sensor type from `playbook`.\n" +
              "  recommendations: string[] — same texts as actions (for backward compatibility).\n" +
              "  follow_ups: string[] — 0-3 short clarifying questions about the user's environment (room type, airflow, what's nearby, recent activity). Empty array unless remediation depends on missing context.\n" +
              "  highlight: { device_id: number, start_iso: string, end_iso: string, reason: string } | null — the chart will mark this time window. Set null only if your answer truly does not reference a specific time range.\n" +
              "  trend: { direction: 'up'|'down'|'flat', percent_change: number|null } — based on facts.comparison_this_week_vs_last_week.\n" +
              "Never invent timestamps. Never invent values. Never repeat the same sentence template across responses."
          }
        ]
      },
      prompt
    ]
  })
  const modelsToTry = [OPENAI_MODEL, "gpt-4.1", "gpt-4o", "gpt-4o-mini"].filter(
    (m, i, arr) => Boolean(m) && arr.indexOf(m) === i
  )

  let payload = null
  let lastError = null
  for (const model of modelsToTry) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(requestBody(model))
    })
    if (response.ok) {
      payload = await response.json()
      break
    }
    const text = await response.text()
    lastError = `model=${model}: ${response.status} ${text}`
    // Retry with a safer fallback model when model id is invalid/unavailable.
    if (response.status === 400 || response.status === 404) continue
    throw new Error(`OpenAI request failed: ${lastError}`)
  }
  if (!payload) {
    throw new Error(`OpenAI request failed: ${lastError || "unknown error"}`)
  }

  const raw =
    payload?.output_text ||
    payload?.output?.flatMap((item) => item.content || []).map((c) => c.text).join("") ||
    ""
  if (!raw) return null

  try {
    return JSON.parse(raw)
  } catch {
    const extracted = extractJsonObject(raw)
    if (!extracted) return null
    try {
      return JSON.parse(extracted)
    } catch {
      return null
    }
  }
}

app.get("/api/health", async (req, res) => {
  if (!pool) {
    return res.json({ status: "ok", db: false })
  }
  try {
    await query("SELECT 1")
    return res.json({ status: "ok", db: true })
  } catch (err) {
    console.error(err)
    return res.status(503).json({ status: "degraded", db: false })
  }
})

app.get("/api/sensors", (req, res) => {
  res.json({
    sensors: [
      { id: 1, name: "Living room", type: "temperature", value: 72 },
      { id: 2, name: "Front door", type: "motion", value: 0 }
    ]
  })
})

app.post("/api/register", async (req, res) => {
  const { email, password, display_name: displayNameRaw } = req.body || {}

  if (!email || !password) {
    return res.status(400).json({ message: "Missing fields" })
  }

  if (password.length < 8) {
    return res.status(400).json({ message: "Password too short" })
  }

  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const displayName =
    displayNameRaw === undefined || displayNameRaw === null
      ? null
      : String(displayNameRaw).trim() || null

  try {
    const hash = await bcrypt.hash(password, 10)
    const { rows } = await query(
      `INSERT INTO users (email, password, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name`,
      [email.trim().toLowerCase(), hash, displayName]
    )
    const newUser = rows[0]
    await provisionDefaultDevices(query, newUser.id)
    return res.status(201).json({
    success: true,
      user: {
        id: newUser.id,
        email: newUser.email,
        display_name: newUser.display_name
      }
    })
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ message: "Email already registered" })
    }
    console.error(err)
    return res.status(500).json({ message: "Registration failed" })
  }
})

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {}

  if (!email || !password) {
    return res.status(400).json({ message: "Missing fields" })
  }

  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  try {
    const { rows } = await query(
      "SELECT id, email, password, display_name FROM users WHERE lower(email) = lower($1)",
      [email.trim()]
    )

    if (rows.length === 0) {
      return res.status(401).json({
        message: "This account doesn't exist. Try creating one or check your email."
      })
    }

    const user = rows[0]
    const ok = await bcrypt.compare(password, user.password)
    if (!ok) {
      return res.status(401).json({ message: "Invalid email or password" })
    }

    query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]).catch(
      () => {}
    )

    const hasDevices = await userHasDevices(query, user.id)
    if (!hasDevices) {
      await provisionDefaultDevices(query, user.id)
    }

    return res.json({
    success: true,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: "Login failed" })
  }
})

app.get("/api/users/:userId/profile", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const userId = Number.parseInt(req.params.userId, 10)
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ message: "Invalid user id" })
  }

  try {
    const { rows } = await query(
      `SELECT id, email, display_name, first_name, last_name, phone, last_login_at
       FROM users WHERE id = $1`,
      [userId]
    )
    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" })
    }
    return res.json({ profile: rows[0] })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: "Could not load profile" })
  }
})

app.patch("/api/users/:userId/profile", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const userId = Number.parseInt(req.params.userId, 10)
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ message: "Invalid user id" })
  }

  const { display_name: displayNameRaw, email, phone } = req.body || {}
  const newEmail = typeof email === "string" ? email.trim().toLowerCase() : ""
  if (!newEmail || !newEmail.includes("@")) {
    return res.status(400).json({ message: "A valid email address is required" })
  }

  const displayName =
    displayNameRaw === undefined || displayNameRaw === null
      ? null
      : String(displayNameRaw).trim() || null
  const ph =
    phone === undefined || phone === null ? null : String(phone).trim() || null

  try {
    const taken = await query(
      `SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2`,
      [newEmail, userId]
    )
    if (taken.rows.length > 0) {
      return res.status(409).json({ message: "That email is already in use" })
    }

    const { rows } = await query(
      `UPDATE users
       SET email = $1, display_name = $2, phone = $3
       WHERE id = $4
       RETURNING id, email, display_name, first_name, last_name, phone, last_login_at`,
      [newEmail, displayName, ph, userId]
    )
    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" })
    }
    return res.json({ success: true, profile: rows[0] })
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ message: "That email is already in use" })
    }
    console.error(err)
    return res.status(500).json({ message: "Could not update profile" })
  }
})

app.patch("/api/users/:userId/password", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const userId = Number.parseInt(req.params.userId, 10)
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ message: "Invalid user id" })
  }

  const { current_password: currentPassword, new_password: newPassword } =
    req.body || {}
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: "Current and new passwords are required" })
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ message: "New password must be at least 8 characters" })
  }

  try {
    const { rows } = await query("SELECT password FROM users WHERE id = $1", [userId])
    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" })
    }
    const ok = await bcrypt.compare(currentPassword, rows[0].password)
    if (!ok) {
      return res.status(401).json({ message: "Current password is incorrect" })
    }
    const hash = await bcrypt.hash(String(newPassword), 10)
    await query("UPDATE users SET password = $1 WHERE id = $2", [hash, userId])
    return res.json({ success: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: "Could not update password" })
  }
})

app.delete("/api/users/:userId", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const userId = Number.parseInt(req.params.userId, 10)
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ message: "Invalid user id" })
  }

  const { password } = req.body || {}
  if (!password) {
    return res.status(400).json({ message: "Password is required to delete your account" })
  }

  try {
    const { rows } = await query("SELECT password FROM users WHERE id = $1", [userId])
    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" })
    }
    const ok = await bcrypt.compare(String(password), rows[0].password)
    if (!ok) {
      return res.status(401).json({ message: "Invalid password" })
    }
    await query("DELETE FROM users WHERE id = $1", [userId])
    return res.json({ success: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: "Could not delete account" })
  }
})

app.get("/api/users/:userId/devices", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const userId = Number.parseInt(req.params.userId, 10)
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ message: "Invalid user id" })
  }

  try {
    const { rows } = await query(
      `SELECT id, user_id, name, device_uid, created_at
       FROM devices WHERE user_id = $1 ORDER BY id`,
      [userId]
    )
    return res.json({ devices: rows })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: "Could not load devices" })
  }
})

app.patch("/api/users/:userId/devices/:deviceId", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const userId = Number.parseInt(req.params.userId, 10)
  const deviceId = Number.parseInt(req.params.deviceId, 10)
  if (!Number.isFinite(userId) || !Number.isFinite(deviceId)) {
    return res.status(400).json({ message: "Invalid user id or device id" })
  }

  const rawName = req.body?.name
  const newName = typeof rawName === "string" ? rawName.trim() : ""
  if (!newName) {
    return res.status(400).json({ message: "Device name is required" })
  }
  if (newName.length > 255) {
    return res.status(400).json({ message: "Device name must be 255 characters or fewer" })
  }

  try {
    const { rows } = await query(
      `UPDATE devices
       SET name = $1
       WHERE id = $2 AND user_id = $3
       RETURNING id, user_id, name, device_uid, created_at`,
      [newName, deviceId, userId]
    )
    if (rows.length === 0) {
      return res.status(404).json({ message: "Device not found for user" })
    }
    const device = rows[0]
    return res.json({
      success: true,
      device: {
        ...device,
        label: friendlyDeviceDisplayName(device.name, device.device_uid)
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: "Could not update device name" })
  }
})

app.get("/api/users/:userId/devices/:deviceId/thresholds", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const userId = Number.parseInt(req.params.userId, 10)
  const deviceId = Number.parseInt(req.params.deviceId, 10)
  const sensorType = String(req.query.sensor_type || "temperature")
  if (!Number.isFinite(userId) || !Number.isFinite(deviceId)) {
    return res.status(400).json({ message: "Invalid user id or device id" })
  }

  try {
    const deviceRes = await query(
      "SELECT id FROM devices WHERE id = $1 AND user_id = $2 LIMIT 1",
      [deviceId, userId]
    )
    if (deviceRes.rows.length === 0) {
      return res.status(404).json({ message: "Device not found for user" })
    }
    const thresholds = await loadThresholdConfig(deviceId, sensorType, "")
    return res.json({
      device_id: deviceId,
      sensor_type: sensorType,
      thresholds
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: "Could not load thresholds" })
  }
})

app.patch("/api/users/:userId/devices/:deviceId/thresholds", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const userId = Number.parseInt(req.params.userId, 10)
  const deviceId = Number.parseInt(req.params.deviceId, 10)
  const sensorType = String(req.body?.sensor_type || req.query.sensor_type || "").trim().toLowerCase()
  if (!Number.isFinite(userId) || !Number.isFinite(deviceId)) {
    return res.status(400).json({ message: "Invalid user id or device id" })
  }
  if (!sensorType) {
    return res.status(400).json({ message: "sensor_type is required" })
  }

  const toNumOrNull = (value) =>
    value === undefined || value === null || value === "" ? null : Number(value)
  const warningMin = toNumOrNull(req.body?.warning_min)
  const warningMax = toNumOrNull(req.body?.warning_max)
  const criticalMin = toNumOrNull(req.body?.critical_min)
  const criticalMax = toNumOrNull(req.body?.critical_max)
  if ([warningMin, warningMax, criticalMin, criticalMax].some((v) => v !== null && !Number.isFinite(v))) {
    return res.status(400).json({ message: "Threshold values must be numeric or null" })
  }

  try {
    const deviceRes = await query(
      "SELECT id FROM devices WHERE id = $1 AND user_id = $2 LIMIT 1",
      [deviceId, userId]
    )
    if (deviceRes.rows.length === 0) {
      return res.status(404).json({ message: "Device not found for user" })
    }
    const { rows } = await query(
      `INSERT INTO device_thresholds (device_id, sensor_type, warning_min, warning_max, critical_min, critical_max, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (device_id, sensor_type)
       DO UPDATE SET
         warning_min = EXCLUDED.warning_min,
         warning_max = EXCLUDED.warning_max,
         critical_min = EXCLUDED.critical_min,
         critical_max = EXCLUDED.critical_max,
         updated_at = NOW()
       RETURNING device_id, sensor_type, warning_min, warning_max, critical_min, critical_max, updated_at`,
      [deviceId, sensorType, warningMin, warningMax, criticalMin, criticalMax]
    )
    return res.json({ success: true, thresholds: rows[0] })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: "Could not update thresholds" })
  }
})

/**
 * Devices for this user with a single raw reading each (live in-memory or seeded default).
 */
app.get("/api/users/:userId/devices/overview", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const userId = Number.parseInt(req.params.userId, 10)
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ message: "Invalid user id" })
  }

  try {
    const { rows } = await query(
      `SELECT
         d.id,
         d.name,
         d.device_uid,
         r.value,
         r.sensor_type,
         r.unit,
         r.recorded_at
       FROM devices d
       LEFT JOIN LATERAL (
         SELECT value, sensor_type, unit, recorded_at
         FROM sensor_readings
         WHERE device_id = d.id
         ORDER BY recorded_at DESC
         LIMIT 1
       ) r ON TRUE
       WHERE d.user_id = $1
       ORDER BY d.id`,
      [userId]
    )

    const devices = rows.map((row) => {
      const fallback = defaultReadingForDeviceUid(row.device_uid)
      const source = {
        value: row.value ?? fallback.value,
        sensor_type: row.sensor_type ?? fallback.sensor_type,
        unit: row.unit ?? fallback.unit,
        recorded_at: row.recorded_at ? new Date(row.recorded_at).toISOString() : null
      }
      const unit = unitFromSensorType(source.sensor_type, source.unit)
      const alert = evaluateAlert(source.sensor_type, source.value, unit)
      return {
        id: row.id,
        name: row.name,
        device_uid: row.device_uid,
        label: friendlyDeviceDisplayName(row.name, row.device_uid),
        reading: source.value,
        sensor_type: source.sensor_type,
        unit,
        recorded_at: source.recorded_at || null,
        alert
      }
    })

    return res.json({ devices })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: "Could not load device overview" })
  }
})

/**
 * Alert history for this user (most recent first).
 */
app.get("/api/users/:userId/alerts", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const userId = Number.parseInt(req.params.userId, 10)
  const limitRaw = Number.parseInt(req.query.limit, 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 25
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ message: "Invalid user id" })
  }

  try {
    const alerts = (alertHistoryByUserId.get(userId) || []).slice(-limit).reverse()
    return res.json({ alerts })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: "Could not load alert history" })
  }
})

/**
 * Push a synthetic reading (HTTP). Same payload can later be sent from MQTT → shared handler.
 */
app.post("/api/readings", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const {
    device_uid: deviceUid,
    value,
    sensor_type: sensorType,
    unit: unitOverride
  } = req.body || {}
  if (!deviceUid || typeof value !== "number" || Number.isNaN(value)) {
    return res.status(400).json({ message: "device_uid and numeric value are required" })
  }

  try {
    const { rows } = await query(
      "SELECT id, user_id, name FROM devices WHERE device_uid = $1 LIMIT 1",
      [deviceUid]
    )
    if (rows.length === 0) {
      return res.status(404).json({ message: "Unknown device_uid" })
    }

    const deviceId = rows[0].id
    const userId = rows[0].user_id
    const deviceDisplayName = rows[0].name
    const st = sensorType || "custom"
    const resolvedUnit =
      typeof unitOverride === "string" ? unitOverride : unitFromSensorType(st, "")
    const thresholdConfig = await loadThresholdConfig(deviceId, st, resolvedUnit)
    const recordedAt = new Date().toISOString()
    liveReadingByDeviceId.set(deviceId, {
      value,
      sensor_type: st,
      unit: resolvedUnit,
      recorded_at: recordedAt
    })
    pushHistory(deviceId, {
      value,
      sensor_type: st,
      unit: resolvedUnit,
      recorded_at: recordedAt
    })
    await query(
      `INSERT INTO sensor_readings (device_id, sensor_type, value, unit, recorded_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [deviceId, st, value, resolvedUnit, recordedAt]
    )
    const alert = evaluateAlert(st, value, resolvedUnit, thresholdConfig)
    if (alert) {
      pushAlert(userId, {
        device_id: deviceId,
        device_uid: deviceUid,
        label: friendlyDeviceDisplayName(deviceDisplayName, deviceUid),
        sensor_type: st,
        value,
        unit: resolvedUnit,
        level: alert.level,
        kind: alert.kind,
        message: alert.message,
        recorded_at: recordedAt
      })
    }

    return res.json({ ok: true, device_id: deviceId, alert })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: "Could not record reading" })
  }
})

/**
 * Detailed device readings for charts/table drill-down.
 */
app.get("/api/users/:userId/devices/:deviceId/readings", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const userId = Number.parseInt(req.params.userId, 10)
  const deviceId = Number.parseInt(req.params.deviceId, 10)
  const limitRaw = Number.parseInt(req.query.limit, 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 10), MAX_HISTORY_POINTS) : 60
  if (!Number.isFinite(userId) || !Number.isFinite(deviceId)) {
    return res.status(400).json({ message: "Invalid user id or device id" })
  }

  try {
    const { rows } = await query(
      `SELECT id, name, device_uid
       FROM devices
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [deviceId, userId]
    )
    if (rows.length === 0) {
      return res.status(404).json({ message: "Device not found for user" })
    }

    const device = rows[0]
    const historyRes = await query(
      `SELECT value, sensor_type, unit, recorded_at
       FROM sensor_readings
       WHERE device_id = $1
       ORDER BY recorded_at DESC
       LIMIT $2`,
      [device.id, limit]
    )
    let readings = historyRes.rows
      .map((r) => ({
        value: r.value,
        sensor_type: r.sensor_type,
        unit: r.unit,
        recorded_at: r.recorded_at ? new Date(r.recorded_at).toISOString() : null
      }))
      .reverse()

    if (readings.length === 0) {
      maybeSeedHistory(device.id, device.device_uid)
      const cached = readingHistoryByDeviceId.get(device.id) || []
      readings = cached.slice(-limit)
    }
    const values = readings.map((r) => r.value).filter((v) => typeof v === "number")
    const latest = readings[readings.length - 1] || null
    const latestUnit = latest?.unit || unitFromSensorType(latest?.sensor_type, "") || ""
    const thresholdConfig = latest
      ? await loadThresholdConfig(device.id, latest.sensor_type, latestUnit)
      : null
    const alert = latest
      ? evaluateAlert(latest.sensor_type, latest.value, latestUnit, thresholdConfig)
      : null
    const recentAlerts = (alertHistoryByUserId.get(userId) || [])
      .filter((entry) => entry.device_id === device.id)
      .slice(-10)
      .reverse()

    const stats =
      values.length > 0
        ? {
            min: Number.parseFloat(Math.min(...values).toFixed(2)),
            max: Number.parseFloat(Math.max(...values).toFixed(2)),
            avg: Number.parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)),
            count: values.length
          }
        : { min: null, max: null, avg: null, count: 0 }

    return res.json({
      device: {
        id: device.id,
        name: device.name,
        device_uid: device.device_uid,
        label: friendlyDeviceDisplayName(device.name, device.device_uid),
        sensor_type: latest?.sensor_type || null,
        unit: latestUnit,
        latest_value: latest?.value ?? null,
        latest_recorded_at: latest?.recorded_at || null,
        alert
      },
      stats,
      readings,
      alerts: recentAlerts
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: "Could not load device readings" })
  }
})

/**
 * Timeseries endpoint for graphing with selectable range + resolution.
 * - range: 1h | 24h | 7d | 30d | 90d | 365d
 * - resolution: auto | raw | hourly | daily
 */
app.get("/api/users/:userId/devices/:deviceId/readings/timeseries", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const userId = Number.parseInt(req.params.userId, 10)
  const deviceId = Number.parseInt(req.params.deviceId, 10)
  if (!Number.isFinite(userId) || !Number.isFinite(deviceId)) {
    return res.status(400).json({ message: "Invalid user id or device id" })
  }

  const range = normalizeRange(req.query.range)
  const resolution = chooseResolution(range, req.query.resolution)
  const metric = normalizeMetric(req.query.metric)
  const interval = RANGE_TO_INTERVAL[range]
  const maxPoints = maxPointsForResolution(resolution)
  const requestedLimitRaw = Number.parseInt(req.query.limit, 10)
  const limit = Number.isFinite(requestedLimitRaw)
    ? Math.min(Math.max(requestedLimitRaw, 10), maxPoints)
    : maxPoints

  try {
    const deviceRes = await query(
      `SELECT id, name, device_uid
       FROM devices
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [deviceId, userId]
    )
    if (deviceRes.rows.length === 0) {
      return res.status(404).json({ message: "Device not found for user" })
    }
    const device = deviceRes.rows[0]

    let rows = []
    if (metric === "critical_counts") {
      const bucketInterval = criticalBucketForRange(range)
      // Whitelist guard — bucketInterval is interpolated as a literal below.
      const ALLOWED_BUCKETS = ["10 minutes", "1 hour", "1 day", "1 month"]
      const safeBucket = ALLOWED_BUCKETS.includes(bucketInterval) ? bucketInterval : "10 minutes"
      // Postgres date_bin doesn't support month/year intervals → use date_trunc for month buckets.
      const isMonthly = safeBucket === "1 month"
      const bucketExpr = isMonthly
        ? "date_trunc('month', $TS$)"
        : `date_bin(INTERVAL '${safeBucket}', $TS$, TIMESTAMPTZ '2000-01-01')`
      const seriesStep = `INTERVAL '${safeBucket}'`
      const sql = `WITH bounds AS (
           SELECT
             ${bucketExpr.replace("$TS$", "NOW() - ($2::interval)")} AS raw_a,
             ${bucketExpr.replace("$TS$", "NOW()")} AS raw_b
         ),
         span AS (
           SELECT
             LEAST(raw_a, raw_b) AS start_b,
             GREATEST(raw_a, raw_b) AS end_b
           FROM bounds
         ),
         series AS (
           SELECT g AS bucket
           FROM span s,
           LATERAL generate_series(s.start_b, s.end_b, ${seriesStep}) AS g
         ),
         cnt AS (
           SELECT
             ${bucketExpr.replace("$TS$", "sr.recorded_at")} AS bucket,
             COUNT(*)::BIGINT AS critical_count
           FROM sensor_readings sr
           LEFT JOIN device_thresholds dt
             ON dt.device_id = sr.device_id
            AND lower(dt.sensor_type) = lower(sr.sensor_type)
           WHERE sr.device_id = $1
             AND sr.recorded_at >= NOW() - ($2::interval)
             AND (
               (
                 COALESCE(dt.critical_max,
                   CASE
                     WHEN lower(sr.sensor_type) = 'temperature' THEN
                       CASE
                         WHEN lower(COALESCE(sr.unit, '')) LIKE '%f%' THEN 86
                         ELSE 30
                       END
                     WHEN lower(sr.sensor_type) = 'humidity' THEN 80
                     WHEN lower(sr.sensor_type) IN ('power', 'power_w') THEN 2500
                     WHEN lower(sr.sensor_type) = 'vibration' THEN 1
                     ELSE NULL
                   END
                 ) IS NOT NULL
                 AND sr.value >= COALESCE(dt.critical_max,
                   CASE
                     WHEN lower(sr.sensor_type) = 'temperature' THEN
                       CASE
                         WHEN lower(COALESCE(sr.unit, '')) LIKE '%f%' THEN 86
                         ELSE 30
                       END
                     WHEN lower(sr.sensor_type) = 'humidity' THEN 80
                     WHEN lower(sr.sensor_type) IN ('power', 'power_w') THEN 2500
                     WHEN lower(sr.sensor_type) = 'vibration' THEN 1
                     ELSE NULL
                   END
                 )
               )
               OR (
                 COALESCE(dt.critical_min,
                   CASE
                     WHEN lower(sr.sensor_type) = 'moisture' THEN 20
                     ELSE NULL
                   END
                 ) IS NOT NULL
                 AND sr.value <= COALESCE(dt.critical_min,
                   CASE
                     WHEN lower(sr.sensor_type) = 'moisture' THEN 20
                     ELSE NULL
                   END
                 )
               )
             )
           GROUP BY bucket
         )
         SELECT s.bucket, COALESCE(c.critical_count, 0)::BIGINT AS critical_count
         FROM series s
         LEFT JOIN cnt c ON s.bucket = c.bucket
         ORDER BY s.bucket ASC`
      const countsRes = await query(sql, [device.id, interval])
      rows = countsRes.rows.map((r) => ({
        t: r.bucket ? new Date(r.bucket).toISOString() : null,
        value: Number.parseInt(r.critical_count, 10) || 0,
        min_value: null,
        max_value: null,
        samples: Number.parseInt(r.critical_count, 10) || 0,
        sensor_type: "critical_count",
        unit: "events"
      }))
      if (rows.length === 0) {
        rows = [
          {
            t: new Date().toISOString(),
            value: 0,
            min_value: null,
            max_value: null,
            samples: 0,
            sensor_type: "critical_count",
            unit: "events"
          }
        ]
      }
    } else if (resolution === "raw") {
      const rawRes = await query(
        `SELECT value, sensor_type, unit, recorded_at
         FROM sensor_readings
         WHERE device_id = $1
           AND recorded_at >= NOW() - ($2::interval)
         ORDER BY recorded_at DESC
         LIMIT $3`,
        [device.id, interval, limit]
      )
      rows = rawRes.rows
        .map((r) => ({
          t: r.recorded_at ? new Date(r.recorded_at).toISOString() : null,
          value: r.value,
          min_value: r.value,
          max_value: r.value,
          samples: 1,
          sensor_type: r.sensor_type,
          unit: r.unit
        }))
        .reverse()
    } else {
      const truncUnit = resolution === "daily" ? "day" : "hour"
      const aggRes = await query(
        `SELECT
           date_trunc('${truncUnit}', recorded_at) AS bucket,
           AVG(value) AS avg_value,
           MIN(value) AS min_value,
           MAX(value) AS max_value,
           COUNT(*)::BIGINT AS samples,
           MIN(sensor_type) AS sensor_type
         FROM sensor_readings
         WHERE device_id = $1
           AND recorded_at >= NOW() - ($2::interval)
         GROUP BY bucket
         ORDER BY bucket DESC
         LIMIT $3`,
        [device.id, interval, limit]
      )
      rows = aggRes.rows
        .map((r) => ({
          t: r.bucket ? new Date(r.bucket).toISOString() : null,
          value: r.avg_value !== null ? Number.parseFloat(Number(r.avg_value).toFixed(3)) : null,
          min_value: r.min_value !== null ? Number.parseFloat(Number(r.min_value).toFixed(3)) : null,
          max_value: r.max_value !== null ? Number.parseFloat(Number(r.max_value).toFixed(3)) : null,
          samples: Number.parseInt(r.samples, 10) || 0,
          sensor_type: r.sensor_type,
          unit: null
        }))
        .reverse()
    }

    const values = rows.map((r) => r.value).filter((v) => typeof v === "number")
    const latest = rows[rows.length - 1] || null
    const latestUnit = unitFromSensorType(latest?.sensor_type, latest?.unit || "")

    return res.json({
      device: {
        id: device.id,
        name: device.name,
        device_uid: device.device_uid,
        label: friendlyDeviceDisplayName(device.name, device.device_uid),
        sensor_type: metric === "critical_counts" ? "critical_count" : latest?.sensor_type || null,
        unit: metric === "critical_counts" ? "events" : latestUnit || null
      },
      query: {
        range,
        interval,
        metric,
        resolution,
        points: rows.length
      },
      stats:
        values.length > 0
          ? {
              min: Number.parseFloat(Math.min(...values).toFixed(3)),
              max: Number.parseFloat(Math.max(...values).toFixed(3)),
              avg: Number.parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)),
              count: values.length
            }
          : { min: null, max: null, avg: null, count: 0 },
      readings: rows
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: "Could not load timeseries readings" })
  }
})

/**
 * Agentic AI: explains trends and answers device data questions.
 */
app.post("/api/users/:userId/devices/:deviceId/agent/insights", async (req, res) => {
  if (!pool) {
    return res.status(500).json({ message: "Database not configured" })
  }

  const userId = Number.parseInt(req.params.userId, 10)
  const deviceId = Number.parseInt(req.params.deviceId, 10)
  const question = String(req.body?.question || "").trim()
  // The client passes the current chart range so the model can prefer to
  // highlight inside what the user is already looking at.
  const viewMode = String(req.body?.view_mode || "").trim() || null
  const rangeStartIso = String(req.body?.range_start_iso || "").trim() || null
  const rangeEndIso = String(req.body?.range_end_iso || "").trim() || null
  const questionIntent = classifyQuestionIntent(question)
  if (!Number.isFinite(userId) || !Number.isFinite(deviceId)) {
    return res.status(400).json({ message: "Invalid user id or device id" })
  }

  try {
    const deviceRes = await query(
      `SELECT id, name, device_uid, sensor_type, unit
       FROM devices
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [deviceId, userId]
    )
    if (deviceRes.rows.length === 0) {
      return res.status(404).json({ message: "Device not found for user" })
    }
    const device = deviceRes.rows[0]

    // Hard refuse clearly off-topic prompts before doing any DB or AI work.
    if (classifyOffTopic(question)) {
      const refusal = buildRefusalInsight(question, friendlyDeviceDisplayName(device.name, device.device_uid))
      return res.json({
        device: {
          id: device.id,
          name: device.name,
          label: friendlyDeviceDisplayName(device.name, device.device_uid),
          device_uid: device.device_uid
        },
        question: question || null,
        insight: refusal,
        source: "refusal"
      })
    }

    const latestRes = await query(
      `SELECT value, sensor_type, unit, recorded_at
       FROM sensor_readings
       WHERE device_id = $1
       ORDER BY recorded_at DESC
       LIMIT 1`,
      [device.id]
    )
    const recentRes = await query(
      `SELECT value, sensor_type, unit, recorded_at
       FROM sensor_readings
       WHERE device_id = $1
         AND recorded_at >= NOW() - INTERVAL '7 days'
       ORDER BY recorded_at ASC
       LIMIT 2000`,
      [device.id]
    )
    const dailyTrendRes = await query(
      `SELECT
         date_trunc('day', recorded_at) AS day_bucket,
         AVG(value) AS avg_value,
         MIN(value) AS min_value,
         MAX(value) AS max_value,
         COUNT(*)::BIGINT AS samples
       FROM sensor_readings
       WHERE device_id = $1
         AND recorded_at >= NOW() - INTERVAL '14 days'
       GROUP BY day_bucket
       ORDER BY day_bucket ASC`,
      [device.id]
    )
    // 90-day daily history powers "how does this week compare" claims; cheap
    // because it's already a daily aggregate, not raw points.
    const daily90Res = await query(
      `SELECT
         date_trunc('day', recorded_at) AS day_bucket,
         AVG(value) AS avg_value,
         MIN(value) AS min_value,
         MAX(value) AS max_value,
         COUNT(*)::BIGINT AS samples
       FROM sensor_readings
       WHERE device_id = $1
         AND recorded_at >= NOW() - INTERVAL '90 days'
       GROUP BY day_bucket
       ORDER BY day_bucket ASC`,
      [device.id]
    )
    // 12-month monthly history powers year-over-year comparisons (only useful
    // once the device has >= 13 months of data; we still send it so the model
    // can answer "we don't have a year of data yet" honestly when needed).
    const monthly12Res = await query(
      `SELECT
         date_trunc('month', recorded_at) AS month_bucket,
         AVG(value) AS avg_value,
         MIN(value) AS min_value,
         MAX(value) AS max_value,
         COUNT(*)::BIGINT AS samples
       FROM sensor_readings
       WHERE device_id = $1
         AND recorded_at >= NOW() - INTERVAL '24 months'
       GROUP BY month_bucket
       ORDER BY month_bucket ASC`,
      [device.id]
    )
    // Fleet snapshot for cross-device questions ("are my basement readings
    // worse than my attic?"). One row per device with cheap aggregates.
    const fleetRes = await query(
      `WITH latest AS (
         SELECT DISTINCT ON (device_id)
                device_id, value, sensor_type, unit, recorded_at
         FROM sensor_readings
         ORDER BY device_id, recorded_at DESC
       )
       SELECT
         d.id,
         d.name,
         d.device_uid,
         d.sensor_type,
         d.unit,
         l.value AS latest_value,
         l.recorded_at AS latest_recorded_at
       FROM devices d
       LEFT JOIN latest l ON l.device_id = d.id
       WHERE d.user_id = $1
       ORDER BY d.id ASC`,
      [userId]
    )

    const latestReading = latestRes.rows[0]
      ? {
          ...latestRes.rows[0],
          recorded_at: latestRes.rows[0].recorded_at
            ? new Date(latestRes.rows[0].recorded_at).toISOString()
            : null
        }
      : null
    const recentReadings = recentRes.rows.map((r) => ({
      ...r,
      recorded_at: r.recorded_at ? new Date(r.recorded_at).toISOString() : null
    }))
    const dailyTrendRows = dailyTrendRes.rows.map((r) => ({
      day_bucket: r.day_bucket ? new Date(r.day_bucket).toISOString() : null,
      avg_value: r.avg_value !== null ? Number(r.avg_value) : null,
      min_value: r.min_value !== null ? Number(r.min_value) : null,
      max_value: r.max_value !== null ? Number(r.max_value) : null,
      samples: Number.parseInt(r.samples, 10) || 0
    }))
    const daily90Rows = daily90Res.rows.map((r) => ({
      day_bucket: r.day_bucket ? new Date(r.day_bucket).toISOString() : null,
      avg_value: r.avg_value !== null ? Number(r.avg_value) : null,
      min_value: r.min_value !== null ? Number(r.min_value) : null,
      max_value: r.max_value !== null ? Number(r.max_value) : null,
      samples: Number.parseInt(r.samples, 10) || 0
    }))
    const monthly12Rows = monthly12Res.rows.map((r) => ({
      month_bucket: r.month_bucket ? new Date(r.month_bucket).toISOString() : null,
      avg_value: r.avg_value !== null ? Number(r.avg_value) : null,
      min_value: r.min_value !== null ? Number(r.min_value) : null,
      max_value: r.max_value !== null ? Number(r.max_value) : null,
      samples: Number.parseInt(r.samples, 10) || 0
    }))

    // Threshold config drives "critical" classification used in facts.
    const thresholds = await loadThresholdConfig(
      device.id,
      device.sensor_type || latestReading?.sensor_type,
      device.unit || latestReading?.unit
    )

    // Pre-computed facts the model is required to quote from. Compared to
    // dumping raw points, this is ~5-10x smaller and ~10x more reliable when
    // the user asks for specific moments.
    const facts = buildAgentFacts({
      device: { ...device, unit: device.unit || latestReading?.unit },
      thresholds,
      recentReadings,
      dailyTrend14d: dailyTrendRows,
      daily90d: daily90Rows,
      monthly12m: monthly12Rows
    })

    // Per-device fleet summary: just enough for cross-device questions.
    const recentAlerts = alertHistoryByUserId.get(userId) || []
    const dayMs = 24 * 60 * 60 * 1000
    const nowMs = Date.now()
    const fleet = fleetRes.rows.map((row) => {
      const alerts24h = recentAlerts.filter(
        (a) =>
          a.device_id === row.id &&
          a.recorded_at &&
          nowMs - new Date(a.recorded_at).getTime() <= dayMs
      ).length
      return {
        device_id: row.id,
        name: row.name,
        label: friendlyDeviceDisplayName(row.name, row.device_uid),
        sensor_type: row.sensor_type || null,
        unit: row.unit || null,
        latest_value: row.latest_value !== null ? Number(row.latest_value) : null,
        latest_recorded_at: row.latest_recorded_at
          ? new Date(row.latest_recorded_at).toISOString()
          : null,
        critical_events_24h: alerts24h,
        is_current_device: row.id === device.id
      }
    })

    // Remediation playbook for THIS sensor type (so the model gives moisture
    // advice for moisture sensors, temperature advice for temperature sensors,
    // etc.) plus an advisory-intent flag so the model knows when to switch
    // into "how do I fix this?" mode.
    const sensorTypeForPlaybook =
      device.sensor_type || latestReading?.sensor_type || recentReadings[recentReadings.length - 1]?.sensor_type
    const playbook = pickPlaybookFor(sensorTypeForPlaybook, thresholds)
    const isAdvisory = classifyAdvisoryIntent(question)

    const context = {
      // What chart the user is currently looking at — helps the model pick a
      // sensible highlight window.
      ui_context: {
        view_mode: viewMode,
        chart_range_start_iso: rangeStartIso,
        chart_range_end_iso: rangeEndIso
      },
      facts,
      fleet,
      playbook,
      intent: {
        is_advisory: isAdvisory,
        has_active_critical: facts.critical_events_last_24h > 0
      },
      computed_metrics: {
        samples_7d: recentReadings.length,
        avg_7d: average(recentReadings.map((r) => r.value)),
        last_24h_avg: average(
          recentReadings
            .filter((r) => r.recorded_at && nowMs - new Date(r.recorded_at).getTime() <= dayMs)
            .map((r) => r.value)
        ),
        recent_alert_count: recentAlerts.filter((a) => a.device_id === device.id).length
      },
      conversation_memory: getAiConversation(userId, deviceId)
    }
    const analytics = computeAdvancedAnalytics(
      recentReadings,
      dailyTrendRows,
      latestReading?.sensor_type || recentReadings[recentReadings.length - 1]?.sensor_type || null
    )
    context.analytics = analytics

    if (questionIntent === "greeting") {
      return res.json({
        device: {
          id: device.id,
          name: device.name,
          label: facts.device.label,
          device_uid: device.device_uid
        },
        question: question || null,
        insight: {
          is_on_topic: true,
          summary:
            "I can interpret this device's sensor data, peaks, alerts, and tell you what to do about them.",
          key_points: [
            "Ask about a specific time window (\"What was the peak last night?\").",
            "Ask about trend (\"Is moisture trending up this week?\").",
            "Ask for fixes (\"What can I do to improve the critical readings?\")."
          ],
          actions: [
            { severity: "info", text: "Try: 'What was the highest reading in the last 24 hours and when?'" },
            { severity: "info", text: "Try: 'What can I do to improve the critical conditions on this sensor?'" }
          ],
          recommendations: [
            "Try: 'What was the highest reading in the last 24 hours and when?'",
            "Try: 'What can I do to improve the critical conditions on this sensor?'"
          ],
          follow_ups: [
            "What was the highest reading in the last 24 hours and when?",
            "What can I do to improve the critical conditions on this sensor?",
            "Should I be worried about the recent trend?"
          ],
          highlight: null,
          answer:
            "Hi! Ask me about this device's readings, or ask how to improve conditions — I'll cite specific values, mark the relevant time range on the chart, and walk you through what to check.",
          trend: { direction: "flat", percent_change: null }
        },
        source: "openai"
      })
    }

    const deterministic = buildDeterministicInsight(
      device,
      latestReading,
      recentReadings,
      dailyTrendRows,
      question,
      analytics
    )

    let aiInsight = null
    try {
      aiInsight = await generateOpenAIInsight(context, question)
    } catch (err) {
      console.warn("[ai] fallback to deterministic insight:", err.message)
    }

    const insight = {
      ...deterministic,
      ...(aiInsight && typeof aiInsight === "object" ? aiInsight : {})
    }
    const normalizedInsight = enforceQuestionAwareInsight(insight, question, deterministic.summary)
    pushAiConversationTurn(userId, deviceId, {
      question: question || "(proactive summary)",
      answer: normalizedInsight?.answer || normalizedInsight?.summary || null,
      trend: normalizedInsight?.trend || null,
      at: new Date().toISOString()
    })

    return res.json({
      device: {
        id: device.id,
        name: device.name,
        label: facts.device.label,
        device_uid: device.device_uid
      },
      question: question || null,
      insight: normalizedInsight,
      analytics,
      source: aiInsight ? "openai" : "rule_based"
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ message: "Could not generate AI insight" })
  }
})

// 404
app.use((req, res) => {
  res.status(404).json({ message: "Not found" })
})


ensureTimeseriesSchema().finally(() => {
app.listen(PORT, "0.0.0.0", () => {
  console.log(`API running on http://localhost:${PORT}`)
})
})
