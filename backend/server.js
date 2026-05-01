
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

app.use(cors())
app.use(express.json())

/** Latest reading cache per device id (DB remains source of truth). */
const liveReadingByDeviceId = new Map()
/** Recent reading cache per device id for quick fallback only. */
const readingHistoryByDeviceId = new Map()
/** Alert history by user id for dashboard timeline. */
const alertHistoryByUserId = new Map()
const MAX_HISTORY_POINTS = 120
const MAX_ALERT_HISTORY = 200

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

function uidLabel(deviceUid) {
  return deviceUid.replaceAll("-", " ")
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
  const formatted = `${value}${unit ? ` ${unit}` : ""}`

  if (
    thresholds.critical_max !== null &&
    thresholds.critical_max !== undefined &&
    value >= thresholds.critical_max
  ) {
    return {
      kind: "threshold",
      level: "critical",
      message: `${type || "sensor"} critically high (${formatted} >= ${thresholds.critical_max})`
    }
  }
  if (
    thresholds.critical_min !== null &&
    thresholds.critical_min !== undefined &&
    value <= thresholds.critical_min
  ) {
    return {
      kind: "threshold",
      level: "critical",
      message: `${type || "sensor"} critically low (${formatted} <= ${thresholds.critical_min})`
    }
  }
  if (
    thresholds.warning_max !== null &&
    thresholds.warning_max !== undefined &&
    value >= thresholds.warning_max
  ) {
    return {
      kind: "threshold",
      level: "warning",
      message: `${type || "sensor"} high (${formatted} >= ${thresholds.warning_max})`
    }
  }
  if (
    thresholds.warning_min !== null &&
    thresholds.warning_min !== undefined &&
    value <= thresholds.warning_min
  ) {
    return {
      kind: "threshold",
      level: "warning",
      message: `${type || "sensor"} low (${formatted} <= ${thresholds.warning_min})`
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
        label: device.name || uidLabel(device.device_uid)
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
        label: row.name || uidLabel(row.device_uid),
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
      "SELECT id, user_id FROM devices WHERE device_uid = $1 LIMIT 1",
      [deviceUid]
    )
    if (rows.length === 0) {
      return res.status(404).json({ message: "Unknown device_uid" })
    }

    const deviceId = rows[0].id
    const userId = rows[0].user_id
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
        label: uidLabel(deviceUid),
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
        label: device.name || uidLabel(device.device_uid),
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
        label: device.name || uidLabel(device.device_uid),
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

// 404
app.use((req, res) => {
  res.status(404).json({ message: "Not found" })
})


ensureTimeseriesSchema().finally(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`API running on http://localhost:${PORT}`)
  })
})
