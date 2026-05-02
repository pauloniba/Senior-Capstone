import { useParams, Link, useNavigate } from "react-router-dom"
import { useEffect, useMemo, useState } from "react"
import {
  fetchAgentInsights,
  fetchDeviceReadings,
  fetchDeviceTimeseries,
  patchDevice
} from "../api"
import "./Home.css"
import "./DayDetails.css"

const CHART_WIDTH = 860
const CHART_HEIGHT = 240
const CHART_PADDING = 16
const CHART_LEFT_GUTTER = 52
const VIEW_MODES = [
  { id: "hourly", label: "Hourly (live sensor)", range: "1h", metric: "readings", resolution: "raw", limit: 120 },
  { id: "24h", label: "24h critical counts", range: "24h", metric: "critical_counts", resolution: "raw", limit: 48 },
  { id: "monthly", label: "Monthly critical counts", range: "30d", metric: "critical_counts", resolution: "daily", limit: 40 },
  { id: "yearly", label: "Yearly critical counts", range: "365d", metric: "critical_counts", resolution: "daily", limit: 24 },
]

function formatValue(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—"
  const rounded = Math.round(value * 100) / 100
  return String(+rounded)
}

function formatTimestamp(iso) {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString()
}

function thresholdFor(sensorType, unit) {
  const t = String(sensorType || "").toLowerCase()
  if (t === "temperature") {
    return String(unit || "").toLowerCase().includes("f") ? 86 : 30
  }
  if (t === "vibration") return 1
  return null
}

function readingTimeMs(r) {
  const iso = r?.t || r?.recorded_at
  if (!iso) return null
  const ms = new Date(iso).getTime()
  return Number.isNaN(ms) ? null : ms
}

/** One calendar hour [start, end) containing `refMs`, in local time. */
function calendarHourWindow(refMs) {
  const d = new Date(refMs)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), 0, 0, 0)
  const startMs = start.getTime()
  return { windowStartMs: startMs, windowEndMs: startMs + 60 * 60 * 1000 }
}

function computeTimeWindow(viewModeId, readings) {
  const times = readings.map(readingTimeMs).filter((t) => t !== null)
  const ref = times.length > 0 ? Math.max(...times) : Date.now()

  if (viewModeId === "hourly") {
    return calendarHourWindow(ref)
  }
  if (viewModeId === "24h") {
    const endMs = ref
    const startMs = endMs - 24 * 60 * 60 * 1000
    return { windowStartMs: startMs, windowEndMs: endMs }
  }
  if (viewModeId === "monthly") {
    const endMs = ref
    const startMs = endMs - 30 * 24 * 60 * 60 * 1000
    return { windowStartMs: startMs, windowEndMs: endMs }
  }
  if (viewModeId === "yearly") {
    const endMs = ref
    const startMs = endMs - 365 * 24 * 60 * 60 * 1000
    return { windowStartMs: startMs, windowEndMs: endMs }
  }
  return calendarHourWindow(ref)
}

function buildAxisTicks(viewModeId, windowStartMs, windowEndMs) {
  const ticks = []
  const usableW = CHART_WIDTH - CHART_PADDING - CHART_LEFT_GUTTER
  const span = windowEndMs - windowStartMs || 1
  const toPct = (t) => ((CHART_LEFT_GUTTER + ((t - windowStartMs) / span) * usableW) / CHART_WIDTH) * 100
  if (viewModeId === "hourly") {
    const stepMs = 5 * 60 * 1000
    for (let t = windowStartMs; t <= windowEndMs; t += stepMs) {
      const d = new Date(t)
      const label = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })
      const pct = toPct(t)
      ticks.push({ t, label, pct })
    }
    return ticks
  }
  if (viewModeId === "24h") {
    const stepMs = 60 * 60 * 1000
    for (let i = 0; i < 24; i += 1) {
      const t = windowStartMs + i * stepMs
      const d = new Date(t)
      const label = d.toLocaleTimeString([], { hour: "numeric", hour12: true })
      const pct = toPct(t)
      ticks.push({ t, label, pct })
    }
    return ticks
  }
  if (viewModeId === "monthly" || viewModeId === "yearly") {
    const cursor = new Date(windowStartMs)
    cursor.setDate(1)
    cursor.setHours(0, 0, 0, 0)
    while (cursor.getTime() < windowStartMs) {
      cursor.setMonth(cursor.getMonth() + 1)
    }
    while (cursor.getTime() <= windowEndMs) {
      const t = cursor.getTime()
      const label = cursor.toLocaleString(undefined, { month: "short" })
      const pct = toPct(t)
      ticks.push({ t, label, pct })
      cursor.setMonth(cursor.getMonth() + 1)
    }
    if (ticks.length === 0) {
      const mid = (windowStartMs + windowEndMs) / 2
      ticks.push({
        t: mid,
        label: new Date(mid).toLocaleString(undefined, { month: "short" }),
        pct: toPct(mid)
      })
    }
    return ticks
  }
  return []
}

function niceStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1
  const pow10 = 10 ** Math.floor(Math.log10(rawStep))
  const scaled = rawStep / pow10
  if (scaled <= 1) return 1 * pow10
  if (scaled <= 2) return 2 * pow10
  if (scaled <= 5) return 5 * pow10
  return 10 * pow10
}

function buildYTicks(yMin, yMax, forced = null) {
  if (forced && Number.isFinite(forced.min) && Number.isFinite(forced.max) && forced.step > 0) {
    const ticks = []
    for (let v = forced.min; v <= forced.max + 1e-9; v += forced.step) {
      ticks.push(Number(v.toFixed(6)))
    }
    return ticks
  }
  const span = yMax - yMin || 1
  const targetCount = 6
  const step = niceStep(span / targetCount)
  const start = Math.floor(yMin / step) * step
  const end = Math.ceil(yMax / step) * step
  const ticks = []
  for (let v = start; v <= end + step * 0.5; v += step) {
    ticks.push(Number(v.toFixed(6)))
  }
  return ticks
}

function buildChartModel(readings, threshold, viewModeId, forcedYAxis = null) {
  const sorted = [...readings]
    .filter((r) => readingTimeMs(r) !== null)
    .sort((a, b) => readingTimeMs(a) - readingTimeMs(b))

  const { windowStartMs, windowEndMs } = computeTimeWindow(viewModeId, sorted)
  const span = Math.max(windowEndMs - windowStartMs, 1)

  const values = sorted.map((r) => r.value).filter((v) => typeof v === "number")
  if (!values.length) {
    return {
      linePoints: "",
      areaPath: "",
      points: [],
      thresholdLineY: null,
      yTicks: [],
      yMin: 0,
      yMax: 1,
      windowStartMs,
      windowEndMs
    }
  }
  const maxValue = Math.max(...values, threshold ?? -Infinity)
  const minValue = Math.min(...values, threshold ?? Infinity)
  const pad = (maxValue - minValue || 1) * 0.12
  const yMin = forcedYAxis && Number.isFinite(forcedYAxis.min) ? forcedYAxis.min : minValue - pad
  const yMax = forcedYAxis && Number.isFinite(forcedYAxis.max) ? forcedYAxis.max : maxValue + pad
  const range = yMax - yMin || 1
  const usableW = CHART_WIDTH - CHART_PADDING - CHART_LEFT_GUTTER
  const usableH = CHART_HEIGHT - CHART_PADDING * 2
  const points = sorted.map((r) => {
    const tMs = readingTimeMs(r)
    const ratio = (tMs - windowStartMs) / span
    const clamped = Math.min(1, Math.max(0, ratio))
    const x = CHART_LEFT_GUTTER + clamped * usableW
    const y = CHART_PADDING + (1 - (r.value - yMin) / range) * usableH
    return { x, y, value: r.value, recorded_at: r.t || r.recorded_at || null, sensor_type: r.sensor_type }
  })
  const linePoints = points.map((p) => `${p.x},${p.y}`).join(" ")
  const areaPath = `${linePoints} ${CHART_WIDTH - CHART_PADDING},${CHART_HEIGHT - CHART_PADDING} ${CHART_LEFT_GUTTER},${CHART_HEIGHT - CHART_PADDING}`
  const yTicks = buildYTicks(yMin, yMax, forcedYAxis)
  const thresholdLineY =
    typeof threshold === "number"
      ? CHART_PADDING + (1 - (threshold - yMin) / range) * usableH
      : null
  return { linePoints, areaPath, points, thresholdLineY, yTicks, yMin, yMax, windowStartMs, windowEndMs }
}

function DayDetails({ darkMode, setDarkMode }) {
  const { day: deviceIdParam } = useParams()
  const navigate = useNavigate()
  const [device, setDevice] = useState(null)
  const [stats, setStats] = useState({ min: null, max: null, avg: null, count: 0 })
  const [readings, setReadings] = useState([])
  const [alerts, setAlerts] = useState([])
  const [viewMode, setViewMode] = useState("hourly")
  const [queryMeta, setQueryMeta] = useState(null)
  const [editingDeviceName, setEditingDeviceName] = useState(false)
  const [deviceNameDraft, setDeviceNameDraft] = useState("")
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState("")
  const [agentQuestion, setAgentQuestion] = useState("")
  const [agentInsight, setAgentInsight] = useState(null)
  const [agentAnalytics, setAgentAnalytics] = useState(null)
  const [agentSource, setAgentSource] = useState("")
  const [agentLoading, setAgentLoading] = useState(false)
  const [agentError, setAgentError] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const deviceId = Number.parseInt(deviceIdParam, 10)

  useEffect(() => {
    const raw = localStorage.getItem("homesense_user")
    if (!raw) {
      navigate("/", { replace: true })
      return
    }
    let userId = null
    try {
      const parsed = JSON.parse(raw)
      userId = parsed?.id
    } catch {
      navigate("/", { replace: true })
      return
    }
    if (!userId || !Number.isFinite(deviceId)) {
      navigate("/home", { replace: true })
      return
    }

    let mounted = true
    const load = async ({ silent = false } = {}) => {
      if (!silent) {
        setLoading(true)
        setError("")
      }
      try {
        const selected = VIEW_MODES.find((m) => m.id === viewMode) || VIEW_MODES[0]
        const [series, details] = await Promise.all([
          fetchDeviceTimeseries(userId, deviceId, {
            range: selected.range,
            resolution: selected.resolution,
            metric: selected.metric,
            limit: selected.limit,
          }),
          fetchDeviceReadings(userId, deviceId, 60),
        ])
        if (!mounted) return
        setDevice({
          ...(details.device || {}),
          sensor_type:
            selected.metric === "readings"
              ? series?.device?.sensor_type || details?.device?.sensor_type || null
              : details?.device?.sensor_type || null,
          unit:
            selected.metric === "readings"
              ? series?.device?.unit || details?.device?.unit || null
              : details?.device?.unit || null,
          latest_value: details?.device?.latest_value ?? null,
          latest_recorded_at: details?.device?.latest_recorded_at ?? null,
        })
        if (!editingDeviceName) {
          setDeviceNameDraft((details?.device?.name || "").trim())
        }
        setStats(series?.stats || { min: null, max: null, avg: null, count: 0 })
        setReadings(series?.readings || [])
        setAlerts(details?.alerts || [])
        setQueryMeta(series?.query || null)
      } catch (err) {
        if (!mounted) return
        if (!silent) {
          setError(err.message || "Could not load device details")
        }
      } finally {
        if (mounted && !silent) setLoading(false)
      }
    }
    load()
    const intervalId = window.setInterval(() => load({ silent: true }), 10000)
    return () => {
      mounted = false
      window.clearInterval(intervalId)
    }
  }, [deviceId, editingDeviceName, navigate, viewMode])

  const selectedMode = VIEW_MODES.find((m) => m.id === viewMode) || VIEW_MODES[0]
  const threshold = selectedMode.metric === "readings" ? thresholdFor(device?.sensor_type, device?.unit) : null
  const criticalYAxisMax = useMemo(() => {
    if (selectedMode.metric !== "critical_counts") return 20
    const peak = readings.reduce(
      (max, r) => (typeof r?.value === "number" && r.value > max ? r.value : max),
      0
    )
    return Math.max(20, Math.ceil(peak / 2) * 2)
  }, [selectedMode.metric, readings])
  const chartModel = useMemo(
    () =>
      buildChartModel(
        readings,
        threshold,
        viewMode,
        selectedMode.metric === "critical_counts"
          ? { min: 0, max: criticalYAxisMax, step: 2 }
          : null
      ),
    [readings, threshold, viewMode, selectedMode.metric, criticalYAxisMax]
  )
  const axisTicks = useMemo(
    () => buildAxisTicks(viewMode, chartModel.windowStartMs, chartModel.windowEndMs),
    [viewMode, chartModel.windowStartMs, chartModel.windowEndMs]
  )
  const statSuffix =
    selectedMode.metric === "readings" ? (device?.unit ? String(device.unit) : "").trim() || "" : "events"
  const criticalMarkers = useMemo(
    () =>
      selectedMode.metric === "readings" && typeof threshold === "number"
        ? chartModel.points.filter((p) => p.value >= threshold)
        : [],
    [chartModel.points, selectedMode.metric, threshold]
  )

  async function requestInsight(customQuestion = "") {
    const raw = localStorage.getItem("homesense_user")
    let userId = null
    try {
      userId = raw ? JSON.parse(raw)?.id : null
    } catch {
      userId = null
    }
    if (!userId) {
      setAgentError("Could not find signed-in user.")
      return
    }
    setAgentLoading(true)
    setAgentError("")
    try {
      const data = await fetchAgentInsights(userId, deviceId, {
        question: customQuestion || undefined
      })
      setAgentInsight(data?.insight || null)
      setAgentAnalytics(data?.analytics || null)
      setAgentSource(data?.source || "")
    } catch (err) {
      setAgentError(err.message || "Could not generate AI insight")
    } finally {
      setAgentLoading(false)
    }
  }

  return (
    <div className={`dashboard gf-dashboard ${darkMode ? "dark" : "light"}`}>
      <header className="dashboard-header d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
        <h1 className="h4 mb-0 font-weight-bold gf-dashboard-title">
          {device?.label || "Device"} details
        </h1>
        <div className="d-flex gap-2 align-items-center">
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            onClick={() => setDarkMode(!darkMode)}
          >
            {darkMode ? "Light Mode" : "Dark Mode"}
          </button>
          <Link to="/home" className="btn btn-outline-secondary btn-sm">
            ← Back to Dashboard
          </Link>
        </div>
      </header>

      {error && (
        <div className="alert alert-danger small py-2" role="alert">
          {error}
        </div>
      )}

      {loading && !error && <p className="text-muted small mb-3">Loading device details…</p>}

      {!loading && !error && (
        <div className="day-details px-0">
          <div className="card mb-3">
            <div className="card-body d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3">
              <div>
                <div className="small text-muted">Device name</div>
                <div className="h5 mb-0">{device?.name || device?.label || "Unnamed device"}</div>
              </div>
              {!editingDeviceName ? (
                <button
                  type="button"
                  className="btn btn-outline-primary btn-sm"
                  onClick={() => {
                    setEditingDeviceName(true)
                    setDeviceNameDraft((device?.name || "").trim())
                    setRenameError("")
                  }}
                >
                  Edit device name
                </button>
              ) : (
                <form
                  className="d-flex flex-column flex-sm-row gap-2 align-items-sm-start"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    const raw = localStorage.getItem("homesense_user")
                    let userId = null
                    try {
                      userId = raw ? JSON.parse(raw)?.id : null
                    } catch {
                      userId = null
                    }
                    const nextName = deviceNameDraft.trim()
                    setRenameError("")
                    if (!userId) {
                      setRenameError("Could not find signed-in user.")
                      return
                    }
                    if (!nextName) {
                      setRenameError("Device name cannot be blank.")
                      return
                    }
                    setRenaming(true)
                    try {
                      const data = await patchDevice(userId, deviceId, { name: nextName })
                      const updated = data?.device
                      if (updated) {
                        setDevice((prev) => ({
                          ...(prev || {}),
                          name: updated.name,
                          label: updated.label || updated.name || prev?.label || "Device",
                        }))
                      }
                      setEditingDeviceName(false)
                    } catch (err) {
                      setRenameError(err.message || "Could not update device name")
                    } finally {
                      setRenaming(false)
                    }
                  }}
                >
                  <input
                    type="text"
                    className="form-control form-control-sm"
                    value={deviceNameDraft}
                    onChange={(e) => setDeviceNameDraft(e.target.value)}
                    placeholder="Enter device name"
                    maxLength={255}
                    disabled={renaming}
                    style={{ minWidth: 220 }}
                  />
                  <div className="d-flex gap-2">
                    <button type="submit" className="btn btn-primary btn-sm" disabled={renaming}>
                      {renaming ? "Saving..." : "Save"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline-secondary btn-sm"
                      disabled={renaming}
                      onClick={() => {
                        setEditingDeviceName(false)
                        setDeviceNameDraft((device?.name || "").trim())
                        setRenameError("")
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
            {renameError ? (
              <div className="px-3 pb-3">
                <div className="alert alert-danger small py-2 mb-0" role="alert">
                  {renameError}
                </div>
              </div>
            ) : null}
          </div>

          {device?.alert ? (
            <div
              className={`alert mb-3 ${device.alert.level === "critical" ? "alert-danger" : "alert-warning"}`}
              role="alert"
            >
              <strong>Alert:</strong> {device.alert.message}
            </div>
          ) : null}
          <p className="dd-subtitle text-muted mb-3">
            Detailed sensor history with a graph-ready view (similar to Grafana drill-down).
          </p>

          <div className="row g-3 mb-3">
            <div className="col-6 col-md-3">
              <div className="card h-100">
                <div className="card-body py-3">
                  <div className="small text-muted">Latest</div>
                  <div className="h5 mb-0">
                    {selectedMode.metric === "readings"
                      ? `${formatValue(device?.latest_value)}${device?.unit ? ` ${device.unit}` : ""}`
                      : `${formatValue(readings[readings.length - 1]?.value)} events`}
                  </div>
                </div>
              </div>
            </div>
            <div className="col-6 col-md-3">
              <div className="card h-100">
                <div className="card-body py-3">
                  <div className="small text-muted">Min</div>
                  <div className="h5 mb-0">
                    {formatValue(stats.min)}
                    {statSuffix ? ` ${statSuffix}` : ""}
                  </div>
                </div>
              </div>
            </div>
            <div className="col-6 col-md-3">
              <div className="card h-100">
                <div className="card-body py-3">
                  <div className="small text-muted">Avg</div>
                  <div className="h5 mb-0">
                    {formatValue(stats.avg)}
                    {statSuffix ? ` ${statSuffix}` : ""}
                  </div>
                </div>
              </div>
            </div>
            <div className="col-6 col-md-3">
              <div className="card h-100">
                <div className="card-body py-3">
                  <div className="small text-muted">Max</div>
                  <div className="h5 mb-0">
                    {formatValue(stats.max)}
                    {statSuffix ? ` ${statSuffix}` : ""}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="card mb-3">
            <div className="card-header">Agentic AI Insights</div>
            <div className="card-body dd-ai-card">
              <p className="text-muted small dd-ai-help">
                Ask what this data means. The AI analyzes your sensor trend, flags possible leak patterns, and gives recommendations.
              </p>
              <form
                className="dd-ai-input-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (agentLoading) return
                  requestInsight(agentQuestion.trim())
                }}
              >
                <input
                  type="text"
                  className="form-control dd-ai-input"
                  placeholder="Example: Is this sensor showing an increasing leak risk?"
                  value={agentQuestion}
                  onChange={(e) => setAgentQuestion(e.target.value)}
                />
                <button type="submit" className="btn btn-primary dd-ai-primary-btn" disabled={agentLoading}>
                  {agentLoading ? "Analyzing..." : "Ask AI"}
                </button>
              </form>
              <div className="dd-ai-actions">
                <button
                  type="button"
                  className="btn btn-outline-secondary btn-sm"
                  disabled={agentLoading}
                  onClick={() => requestInsight("")}
                >
                  Generate proactive summary
                </button>
              </div>
              {agentError ? (
                <div className="alert alert-danger small py-2 mt-3 mb-0" role="alert">
                  {agentError}
                </div>
              ) : null}
              {agentInsight ? (
                <div className="dd-ai-result">
                  <div className="small text-muted dd-ai-source">
                    Source: {agentSource === "openai" ? "OpenAI" : "Rule-based fallback"}
                  </div>
                  <p className="mb-2">
                    <strong>Summary:</strong> {agentInsight.summary || "No summary provided."}
                  </p>
                  {agentInsight.answer ? (
                    <p className="mb-2">
                      <strong>Answer:</strong> {agentInsight.answer}
                    </p>
                  ) : null}
                  <p className="mb-1">
                    <strong>Key points</strong>
                  </p>
                  <ul className="mb-2">
                    {(agentInsight.key_points || []).map((point, idx) => (
                      <li key={`${point}-${idx}`}>{point}</li>
                    ))}
                  </ul>
                  <p className="mb-1">
                    <strong>Recommendations</strong>
                  </p>
                  <ul className="mb-0">
                    {(agentInsight.recommendations || []).map((item, idx) => (
                      <li key={`${item}-${idx}`}>{item}</li>
                    ))}
                  </ul>
                  {agentAnalytics ? (
                    <div className="dd-ai-metrics mt-3">
                      <div>
                        <strong>Leak risk score:</strong>{" "}
                        {agentAnalytics?.leak_risk?.score ?? "n/a"} / 100 (
                        {agentAnalytics?.leak_risk?.level || "n/a"})
                      </div>
                      <div>
                        <strong>Week-over-week:</strong>{" "}
                        {agentAnalytics?.week_over_week?.percent_change ?? "n/a"}% (
                        {agentAnalytics?.week_over_week?.direction || "n/a"})
                      </div>
                      <div>
                        <strong>Anomaly:</strong>{" "}
                        {agentAnalytics?.anomaly?.is_anomaly
                          ? `Yes (z-score ${agentAnalytics?.anomaly?.z_score ?? "n/a"})`
                          : "No"}
                      </div>
                      <div>
                        <strong>Forecast next reading:</strong>{" "}
                        {agentAnalytics?.forecast?.next_value ?? "n/a"}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="card mb-3">
            <div className="card-header d-flex flex-wrap justify-content-between align-items-center gap-2">
              <span>Device trend</span>
              <select
                className="form-control form-control-sm dd-range-select"
                value={viewMode}
                onChange={(e) => setViewMode(e.target.value)}
              >
                {VIEW_MODES.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="card-body">
              {readings.length === 0 && selectedMode.metric === "readings" ? (
                <p className="text-muted small mb-0">No readings yet.</p>
              ) : (
                <>
                  <p className="text-muted small mb-2">
                    {selectedMode.metric === "readings"
                      ? "Live sensor values with critical spikes highlighted."
                      : "Critical/abnormal events counted by time bucket (zeros shown when no events in a bucket)."}
                  </p>
                  <svg
                    viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                    className="dd-chart"
                    role="img"
                    aria-label="Device reading trend"
                  >
                    <defs>
                      <linearGradient id="ddAreaFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#ffbe0b" stopOpacity="0.5" />
                        <stop offset="100%" stopColor="#3ad29f" stopOpacity="0.2" />
                      </linearGradient>
                    </defs>
                    {chartModel.yTicks.map((tick) => {
                      const y =
                        CHART_PADDING +
                        (1 - (tick - chartModel.yMin) / ((chartModel.yMax - chartModel.yMin) || 1)) *
                          (CHART_HEIGHT - CHART_PADDING * 2)
                      return (
                        <g key={`y-${tick}`}>
                          <line
                            x1={CHART_LEFT_GUTTER}
                            x2={CHART_WIDTH - CHART_PADDING}
                            y1={y}
                            y2={y}
                            stroke="rgba(108, 117, 125, 0.22)"
                            strokeWidth="1"
                          />
                          <text
                            x={CHART_LEFT_GUTTER - 6}
                            y={y + 4}
                            textAnchor="end"
                            fontSize="11"
                            fill="rgba(108, 117, 125, 0.95)"
                          >
                            {Number.isInteger(tick) ? tick : tick.toFixed(1)}
                          </text>
                        </g>
                      )
                    })}
                    {chartModel.thresholdLineY !== null ? (
                      <>
                        <rect
                          x={CHART_LEFT_GUTTER}
                          y={CHART_PADDING}
                          width={CHART_WIDTH - CHART_LEFT_GUTTER - CHART_PADDING}
                          height={Math.max(chartModel.thresholdLineY - CHART_PADDING, 0)}
                          fill="rgba(220, 53, 69, 0.12)"
                        />
                        <rect
                          x={CHART_LEFT_GUTTER}
                          y={chartModel.thresholdLineY}
                          width={CHART_WIDTH - CHART_LEFT_GUTTER - CHART_PADDING}
                          height={CHART_HEIGHT - CHART_PADDING - chartModel.thresholdLineY}
                          fill="rgba(25, 135, 84, 0.12)"
                        />
                        <line
                          x1={CHART_LEFT_GUTTER}
                          x2={CHART_WIDTH - CHART_PADDING}
                          y1={chartModel.thresholdLineY}
                          y2={chartModel.thresholdLineY}
                          stroke="rgba(220, 53, 69, 0.8)"
                          strokeDasharray="4 4"
                          strokeWidth="2"
                        />
                      </>
                    ) : null}
                    <polygon points={chartModel.areaPath} fill="url(#ddAreaFill)" />
                    <polyline points={chartModel.linePoints} fill="none" stroke="#ffbe0b" strokeWidth="4" />
                    {criticalMarkers.map((p, idx) => (
                      <circle key={`${p.x}-${idx}`} cx={p.x} cy={p.y} r="4.5" fill="#dc3545" />
                    ))}
                  </svg>
                  <div className="dd-axis-ticks mt-2">
                    {axisTicks.map((tick, idx) => (
                      <span
                        key={`${tick.t}-${idx}`}
                        className="dd-axis-tick"
                        style={{ left: `${tick.pct}%` }}
                      >
                        {tick.label}
                      </span>
                    ))}
                  </div>
                  <div className="dd-point-card mt-3">
                    <div className="small text-muted">Latest sample</div>
                    <div className="h6 mb-1">
                      {selectedMode.metric === "readings"
                        ? `${formatValue(device?.latest_value)} ${device?.unit || ""}`
                        : `${formatValue(readings[readings.length - 1]?.value)} events`}
                    </div>
                    <div className="small text-muted">
                      {selectedMode.metric === "readings"
                        ? `${device?.sensor_type || "sensor"} at ${formatTimestamp(device?.latest_recorded_at)}`
                        : `${queryMeta?.resolution || "bucket"} aggregation across ${queryMeta?.range || "range"}`}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="table-responsive">
            <table className="table table-striped table-hover dd-table mt-3">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>{selectedMode.metric === "readings" ? "Sensor type" : "Metric"}</th>
                  <th>Value</th>
                  <th>Unit</th>
                  <th>Recorded at</th>
                </tr>
              </thead>
              <tbody>
                {readings
                  .slice()
                  .reverse()
                  .map((reading, idx) => (
                    <tr key={`${reading.t || reading.recorded_at}-${idx}`}>
                      <td>{device?.label || "—"}</td>
                      <td>{selectedMode.metric === "readings" ? reading.sensor_type || "—" : "critical_count"}</td>
                      <td>{formatValue(reading.value)}</td>
                      <td>{selectedMode.metric === "readings" ? reading.unit || "—" : "events"}</td>
                      <td>{formatTimestamp(reading.t || reading.recorded_at)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <div className="card mt-3">
            <div className="card-header">Alert history for this device</div>
            <div className="card-body">
              {alerts.length === 0 ? (
                <p className="text-muted small mb-0">No alerts for this device yet.</p>
              ) : (
                <div className="table-responsive">
                  <table className="table table-striped table-hover mb-0">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Level</th>
                        <th>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {alerts.map((alert, idx) => (
                        <tr key={`${alert.recorded_at}-${idx}`}>
                          <td>{formatTimestamp(alert.recorded_at)}</td>
                          <td className={alert.level === "critical" ? "text-danger fw-semibold" : "text-warning fw-semibold"}>
                            {alert.level}
                          </td>
                          <td>{alert.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default DayDetails
