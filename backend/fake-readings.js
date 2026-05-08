import pg from "pg"

const API_BASE = (process.env.API_BASE_URL || "http://localhost:3001").replace(/\/$/, "")
const INTERVAL_MS = Number.parseInt(process.env.FAKE_INTERVAL_MS || "10000", 10)
const REFRESH_MS = Number.parseInt(process.env.FAKE_DEVICES_REFRESH_MS || "60000", 10)

const PROFILE_BY_SUFFIX = {
  "dev-attic-01": { sensor_type: "temperature", unit: "C", min: 22, max: 37 },
  "dev-basement-01": { sensor_type: "moisture", unit: "%", min: 25, max: 60 },
  "dev-kitchen-01": { sensor_type: "vibration", unit: "", min: 0, max: 1 }
}

function uidSuffix(deviceUid) {
  const m = String(deviceUid).match(/^\d+-(.+)$/)
  return m ? m[1] : deviceUid
}

function deviceProfile(deviceUid) {
  const suffix = uidSuffix(deviceUid)
  const base = PROFILE_BY_SUFFIX[suffix]
  if (!base) {
    return {
      device_uid: deviceUid,
      sensor_type: "custom",
      unit: "",
      min: 0,
      max: 100
    }
  }
  return { device_uid: deviceUid, ...base }
}

const stateByDeviceUid = new Map()
let pool = null

function getPool() {
  const conn = process.env.DATABASE_URL
  if (!conn) return null
  if (!pool) {
    const useSsl = /\.rds\.amazonaws\.com/i.test(conn)
    pool = new pg.Pool({
      connectionString: conn,
      ssl: useSsl ? { rejectUnauthorized: false } : false
    })
  }
  return pool
}

let cachedDevices = []

async function refreshDevicesFromDb() {
  const p = getPool()
  if (!p) {
    console.warn(
      "[fake-readings] DATABASE_URL not set; using static demo UIDs (set SYNTHETIC_USER_ID=1)"
    )
    const uid = (suffix) =>
      `${process.env.SYNTHETIC_USER_ID || "1"}-${suffix}`
    cachedDevices = [
      deviceProfile(uid("dev-attic-01")),
      deviceProfile(uid("dev-basement-01")),
      deviceProfile(uid("dev-kitchen-01"))
    ]
    return
  }

  const { rows } = await p.query(
    "SELECT device_uid FROM devices ORDER BY user_id, id"
  )
  cachedDevices = rows.map((r) => deviceProfile(r.device_uid))
  console.log(`[fake-readings] loaded ${cachedDevices.length} device(s) from DB`)
}

function nextValue(device) {
  if (device.sensor_type === "vibration") {
    return Math.random() < 0.18 ? 1 : 0
  }

  const span = device.max - device.min
  const baseline = device.min + span * 0.5
  const prev = stateByDeviceUid.get(device.device_uid) ?? baseline
  const drift = (Math.random() - 0.5) * span * 0.08
  const pullToCenter = (baseline - prev) * 0.1
  const noise = (Math.random() - 0.5) * span * 0.015
  const raw = prev + drift + pullToCenter + noise
  const clamped = Math.min(device.max, Math.max(device.min, raw))
  const rounded = Number.parseFloat(clamped.toFixed(1))
  stateByDeviceUid.set(device.device_uid, rounded)
  return rounded
}

async function postReading(device) {
  const payload = {
    device_uid: device.device_uid,
    sensor_type: device.sensor_type,
    unit: device.unit,
    value: nextValue(device)
  }

  const res = await fetch(`${API_BASE}/api/readings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text || "unknown error"}`)
  }
  return { payload, responseText: text }
}

async function tick() {
  if (cachedDevices.length === 0) {
    await refreshDevicesFromDb()
  }
  for (const device of cachedDevices) {
    try {
      const { payload, responseText } = await postReading(device)
      console.log("[fake-readings] ok", payload.device_uid, payload.value, responseText)
    } catch (err) {
      console.error("[fake-readings] failed", device.device_uid, err.message)
    }
  }
}

async function main() {
  console.log(`[fake-readings] posting to ${API_BASE}/api/readings every ${INTERVAL_MS}ms`)
  await refreshDevicesFromDb()
  await tick()
  setInterval(tick, INTERVAL_MS)
  setInterval(() => {
    refreshDevicesFromDb().catch((e) => console.error("[fake-readings] refresh", e.message))
  }, REFRESH_MS)
}

main().catch((err) => {
  console.error("[fake-readings] fatal", err)
  process.exit(1)
})
