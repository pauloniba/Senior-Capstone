import { Link, useNavigate } from "react-router-dom";
import { useState, useEffect, useCallback } from "react";
import { fetchAlertHistory, fetchDeviceOverview } from "../api";
import "./Home.css";

function displayNameFromEmail(email) {
  if (!email || typeof email !== "string") return "there";
  const local = email.split("@")[0] || "";
  if (!local) return "there";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function formatReading(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "number" || Number.isNaN(value)) return String(value);
  const rounded = Math.round(value * 100) / 100;
  return String(+rounded);
}

function formatLastUpdated(isoString) {
  if (!isoString) return "Not synced yet";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "Not synced yet";
  return `Updated ${d.toLocaleTimeString()}`;
}

function formatAlertLevel(level) {
  const s = String(level || "").toLowerCase();
  if (s === "critical") return "Critical";
  if (s === "warning") return "Warning";
  if (!s) return "—";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Home({ darkMode, setDarkMode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [user, setUser] = useState(null);
  const [devices, setDevices] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [lastSyncAt, setLastSyncAt] = useState("");
  const navigate = useNavigate();

  const loadDevices = useCallback(async (userId, opts = {}) => {
    const { silent } = opts;
    if (!silent) {
      setLoadError("");
      setLoading(true);
    }
    try {
      const [deviceData, alertData] = await Promise.all([
        fetchDeviceOverview(userId),
        fetchAlertHistory(userId, 12)
      ]);
      setDevices(deviceData.devices || []);
      setAlerts(alertData.alerts || []);
      setLastSyncAt(new Date().toISOString());
    } catch (err) {
      if (!silent) {
        setLoadError(err.message || "Could not load devices");
        setDevices([]);
        setAlerts([]);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem("homesense_user");
    if (!raw) {
      navigate("/", { replace: true });
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed?.id) {
        navigate("/", { replace: true });
        return;
      }
      setUser(parsed);
      loadDevices(parsed.id);
    } catch {
      navigate("/", { replace: true });
    }
  }, [navigate, loadDevices]);

  useEffect(() => {
    if (!user?.id) return undefined;
    const id = user.id;
    const intervalMs = 10000;
    const idInterval = window.setInterval(() => {
      loadDevices(id, { silent: true });
    }, intervalMs);
    return () => window.clearInterval(idInterval);
  }, [user?.id, loadDevices]);

  function handleLogout() {
    localStorage.removeItem("homesense_user");
    navigate("/", { replace: true });
  }

  const welcomeName =
    (user?.display_name && String(user.display_name).trim()) ||
    displayNameFromEmail(user?.email);
  const activeDeviceCount = devices.filter((d) => typeof d.reading === "number").length;
  const sensorTypeCount = new Set(
    devices.map((d) => d.sensor_type).filter((sensorType) => Boolean(sensorType))
  ).size;
  const activeAlertCount = devices.filter((d) => Boolean(d.alert)).length;

  return (
    <div className={`dashboard gf-dashboard ${darkMode ? "dark" : "light"}`}>
      <p className="mb-3 h5 font-weight-normal" style={{ fontWeight: 500 }}>
        Welcome Back, {welcomeName}!
      </p>

      <header className="dashboard-header d-flex justify-content-between align-items-center mb-4">
        <h1 className="h4 mb-0 font-weight-bold gf-dashboard-title">Analytics Dashboard</h1>

        <div className="position-relative" style={{ zIndex: 9999 }}>
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            ☰
          </button>

          {menuOpen && (
            <div
              className="card shadow-sm position-absolute"
              style={{
                top: "calc(100% + 8px)",
                right: 0,
                minWidth: 200,
                zIndex: 9999,
              }}
            >
              <div className="list-group list-group-flush">
                <button
                  type="button"
                  className="list-group-item list-group-item-action"
                  onClick={() => setDarkMode(!darkMode)}
                >
                  {darkMode ? "Light Mode" : "Dark Mode"}
                </button>

                <Link to="/account-settings" className="list-group-item list-group-item-action">
                  Account Settings
                </Link>

                <button
                  type="button"
                  className="list-group-item list-group-item-action text-danger"
                  onClick={handleLogout}
                >
                  Log Out
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      <section className="mb-3">
        <div className="row g-3">
          <div className="col-6 col-md-3">
            <div className="card h-100 gf-summary-card">
              <div className="card-body py-3">
                <div className="small text-muted">Total devices</div>
                <div className="h4 mb-0">{devices.length}</div>
              </div>
            </div>
          </div>
          <div className="col-6 col-md-3">
            <div className="card h-100 gf-summary-card">
              <div className="card-body py-3">
                <div className="small text-muted">Reporting now</div>
                <div className="h4 mb-0">{activeDeviceCount}</div>
              </div>
            </div>
          </div>
          <div className="col-6 col-md-3">
            <div className="card h-100 gf-summary-card">
              <div className="card-body py-3">
                <div className="small text-muted">Sensor types</div>
                <div className="h4 mb-0">{sensorTypeCount}</div>
              </div>
            </div>
          </div>
          <div className="col-6 col-md-3">
            <div className="card h-100 gf-summary-card">
              <div className="card-body py-3">
                <div className="small text-muted">Active alerts</div>
                <div className="h4 mb-0">{activeAlertCount}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="card shadow-sm">
          <div className="card-header d-flex justify-content-between align-items-center">
            <span>Device List</span>
            <small className="text-muted">{formatLastUpdated(lastSyncAt)}</small>
          </div>
          <div className="card-body">
            {loadError && (
              <div className="alert alert-danger small py-2" role="alert">
                {loadError}
              </div>
            )}
            {loading && !loadError && <p className="text-muted small mb-0">Loading devices…</p>}
            {!loading && !loadError && devices.length === 0 && (
              <p className="text-muted small mb-0">No devices for this account.</p>
            )}
            {!loading &&
              devices.map((d) => (
                <Link
                  key={d.id}
                  to={`/day/${d.id}`}
                  className="d-flex justify-content-between align-items-center border-bottom py-2 text-decoration-none text-reset gf-device-row"
                >
                  <span>
                    {d.label}
                    {d.alert ? (
                      <small className="d-block text-danger fw-semibold">
                        Alert: {d.alert.message}
                      </small>
                    ) : null}
                  </span>
                  <span className="text-right" style={{ fontFamily: "ui-monospace, monospace" }}>
                    <span className="font-weight-bold">{formatReading(d.reading)}</span>
                    {d.unit ? (
                      <span className="text-muted small ml-2" style={{ fontFamily: "inherit" }}>
                        {d.unit}
                      </span>
                    ) : null}
                    {!d.unit ? <span className="text-muted small ml-2">event</span> : null}
                  </span>
                </Link>
              ))}
          </div>
        </div>
      </section>

      <section className="mt-3">
        <div className="card shadow-sm">
          <div className="card-header">Alert History</div>
          <div className="card-body">
            {alerts.length === 0 ? (
              <p className="text-muted small mb-0">No alerts yet.</p>
            ) : (
              <div className="table-responsive">
                <table className="table table-striped table-hover mb-0">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Device</th>
                      <th>Level</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alerts.map((alert, idx) => (
                      <tr key={`${alert.recorded_at}-${alert.device_id}-${idx}`}>
                        <td>{new Date(alert.recorded_at).toLocaleString()}</td>
                        <td>{alert.label || alert.device_uid}</td>
                        <td className={alert.level === "critical" ? "text-danger fw-semibold" : "text-warning fw-semibold"}>
                          {formatAlertLevel(alert.level)}
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
      </section>
    </div>
  );
}

export default Home;
