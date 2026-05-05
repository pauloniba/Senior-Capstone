
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

app.use(cors())
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
    await query("CREATE EXTENSION IF NOT EXISTS timescaledb")
    await query(
      `CREATE TABLE IF NOT EXISTS sensor_readings (
         id BIGSERIAL,
         device_id INTEGER NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
         sensor_type VARCHAR(64) NOT NULL,
         value DOUBLE PRECISION NOT NULL,
         unit VARCHAR(32),
         recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    )
    await query("ALTER TABLE sensor_readings DROP CONSTRAINT IF EXISTS sensor_readings_pkey")
    await query(
      "SELECT create_hypertable('sensor_readings', 'recorded_at', if_not_exists => TRUE, migrate_data => TRUE)"
    )
    await query(
      "CREATE INDEX IF NOT EXISTS sensor_readings_device_time_idx ON sensor_readings (device_id, recorded_at DESC)"
    )
    await query(
      "CREATE INDEX IF NOT EXISTS sensor_readings_type_time_idx ON sensor_readings (sensor_type, recorded_at DESC)"
    )
    await query(
      `ALTER TABLE sensor_readings
       SET (
         timescaledb.compress,
         timescaledb.compress_segmentby = 'device_id,sensor_type',
         timescaledb.compress_orderby = 'recorded_at DESC'
       )`
    )
    await query(
      "SELECT add_compression_policy('sensor_readings', INTERVAL '7 days', if_not_exists => TRUE)"
    )
    await query(
      "SELECT add_retention_policy('sensor_readings', INTERVAL '45 days', if_not_exists => TRUE)"
    )
    await query(
      `CREATE MATERIALIZED VIEW IF NOT EXISTS sensor_readings_hourly
       WITH (timescaledb.continuous) AS
       SELECT
         time_bucket(INTERVAL '1 hour', recorded_at) AS bucket,
         device_id,
         sensor_type,
         AVG(value) AS avg_value,
         MIN(value) AS min_value,
         MAX(value) AS max_value,
         COUNT(*)::BIGINT AS samples
       FROM sensor_readings
       GROUP BY bucket, device_id, sensor_type
       WITH NO DATA`
    )
    await query(
      `SELECT add_continuous_aggregate_policy(
         'sensor_readings_hourly',
         start_offset => INTERVAL '7 days',
         end_offset => INTERVAL '5 minutes',
         schedule_interval => INTERVAL '15 minutes',
         if_not_exists => TRUE
       )`
    )
    await query(
      "SELECT add_retention_policy('sensor_readings_hourly', INTERVAL '365 days', if_not_exists => TRUE)"
    )
    await query(
      `CREATE MATERIALIZED VIEW IF NOT EXISTS sensor_readings_daily
       WITH (timescaledb.continuous) AS
       SELECT
         time_bucket(INTERVAL '1 day', recorded_at) AS bucket,
         device_id,
         sensor_type,
         AVG(value) AS avg_value,
         MIN(value) AS min_value,
         MAX(value) AS max_value,
         COUNT(*)::BIGINT AS samples
       FROM sensor_readings
       GROUP BY bucket, device_id, sensor_type
       WITH NO DATA`
    )
    await query(
      `SELECT add_continuous_aggregate_policy(
         'sensor_readings_daily',
         start_offset => INTERVAL '180 days',
         end_offset => INTERVAL '1 hour',
         schedule_interval => INTERVAL '1 hour',
         if_not_exists => TRUE
       )`
    )
    await query(
      "SELECT add_retention_policy('sensor_readings_daily', INTERVAL '3 years', if_not_exists => TRUE)"
    )
  } catch (err) {
    console.warn("[timescale] setup skipped:", err.message)
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

  if (Array.isArray(safeInsight.key_points)) {
    safeInsight.key_points = safeInsight.key_points
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 4)
  } else {
    safeInsight.key_points = []
  }

  if (Array.isArray(safeInsight.recommendations)) {
    safeInsight.recommendations = safeInsight.recommendations
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 2)
  } else {
    safeInsight.recommendations = []
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

  return {
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
      latestDeltaText,
      `Estimated risk level: ${modeledRisk}.`,
      Number.isFinite(modeledScore) ? `Leak risk score: ${modeledScore}/100.` : "Leak risk score: n/a."
    ],
    recommendations: [
      "Check this device again in 24 hours and compare against alerts.",
      "If readings keep rising for 2 days, inspect nearby pipes/fittings."
    ],
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
          "You are an IoT monitoring analyst. Explain sensor behavior in plain language for non-technical customers. " +
          "Focus on trend direction, risk level, and practical next steps. If water leak/moisture is trending up, call it out clearly. " +
          "Use concrete numbers from the provided data and avoid generic repeated wording. " +
          "Tailor the response to the exact user question and avoid repeating the same sentence templates between calls. " +
          "Use prior conversation turns to maintain continuity and answer follow-up questions directly."
      },
      {
        type: "input_text",
        text: `Question: ${question || "Provide a proactive insight summary for this device."}`
      },
      {
        type: "input_text",
        text: `Context JSON:\n${JSON.stringify(context)}`
      }
    ]
  }

  const requestBody = (model) => ({
    model,
    temperature: 0.55,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Return strict JSON only with keys: summary (string), key_points (string[]), recommendations (string[]), answer (string|null), trend ({direction:'up'|'down'|'flat', percent_change:number|null}). " +
              "Be concise and user-friendly for first-time users. summary must be 1-2 short sentences. key_points must have 3-4 short bullets. recommendations must have 1-2 practical next steps. " +
              "If a question is provided, answer it directly in `answer` starting with: To answer your question. Avoid jargon, avoid long paragraphs, and keep wording simple."
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
      const countsRes = await query(
        `WITH bounds AS (
           SELECT
             time_bucket($2::interval, NOW() - ($3::interval)) AS raw_a,
             time_bucket($2::interval, NOW()) AS raw_b
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
           LATERAL generate_series(s.start_b, s.end_b, $2::interval) AS g
         ),
         cnt AS (
           SELECT
             time_bucket($2::interval, sr.recorded_at) AS bucket,
             COUNT(*)::BIGINT AS critical_count
           FROM sensor_readings sr
           LEFT JOIN device_thresholds dt
             ON dt.device_id = sr.device_id
            AND lower(dt.sensor_type) = lower(sr.sensor_type)
           WHERE sr.device_id = $1
             AND sr.recorded_at >= NOW() - ($3::interval)
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
         ORDER BY s.bucket ASC`,
        [device.id, bucketInterval, interval]
      )
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
      const viewName = resolution === "daily" ? "sensor_readings_daily" : "sensor_readings_hourly"
      const aggRes = await query(
        `SELECT bucket, avg_value, min_value, max_value, samples, sensor_type
         FROM ${viewName}
         WHERE device_id = $1
           AND bucket >= NOW() - ($2::interval)
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
  const questionIntent = classifyQuestionIntent(question)
  if (!Number.isFinite(userId) || !Number.isFinite(deviceId)) {
    return res.status(400).json({ message: "Invalid user id or device id" })
  }

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
         time_bucket(INTERVAL '1 day', recorded_at) AS day_bucket,
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

    const context = {
      device: {
        id: device.id,
        name: device.name,
        label: friendlyDeviceDisplayName(device.name, device.device_uid),
        device_uid: device.device_uid
      },
      latest_reading: latestReading,
      recent_readings_sample: recentReadings.slice(-120),
      daily_trend_14d: dailyTrendRows,
      computed_metrics: {
        samples_7d: recentReadings.length,
        avg_7d: average(recentReadings.map((r) => r.value)),
        last_24h_avg: average(
          recentReadings
            .filter((r) => r.recorded_at && Date.now() - new Date(r.recorded_at).getTime() <= 24 * 60 * 60 * 1000)
            .map((r) => r.value)
        ),
        recent_alert_count: (alertHistoryByUserId.get(userId) || []).filter(
          (a) => a.device_id === device.id
        ).length
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
        device: context.device,
        question: question || null,
        insight: {
          summary:
            "I can help interpret this device's sensor data and leak risk in plain language.",
          key_points: [
            "Ask about trend direction (up/down/stable).",
            "Ask whether leak risk is increasing this week.",
            "Ask for a 24-hour action plan based on latest readings."
          ],
          recommendations: [
            "Try: 'Is leak risk increasing this week?'",
            "Try: 'What changed in the last 24 hours and what should I do next?'"
          ],
          answer:
            "Hi! Ask me a data question about this device and I will analyze the readings, trend, risk, and next actions.",
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
      device: context.device,
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
