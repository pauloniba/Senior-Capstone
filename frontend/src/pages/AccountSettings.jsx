import { Link, useNavigate } from 'react-router-dom'
import { useState, useEffect, useCallback } from 'react'
import {
  fetchProfile,
  patchProfile,
  patchPassword,
  fetchDeviceOverview,
  deleteAccount,
  clearStoredAuth,
} from '../api'
import './Home.css'

function formatLastLogin(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

function AccountSettings({ darkMode, setDarkMode }) {
  const navigate = useNavigate()
  const [userId, setUserId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [profileMessage, setProfileMessage] = useState('')
  const [profileError, setProfileError] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [deviceCount, setDeviceCount] = useState(null)
  const [lastLoginAt, setLastLoginAt] = useState(null)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordMessage, setPasswordMessage] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async (id) => {
    setLoadError('')
    setLoading(true)
    try {
      const [profileRes, overviewRes] = await Promise.all([
        fetchProfile(id),
        fetchDeviceOverview(id).catch(() => ({ devices: [] })),
      ])
      const p = profileRes.profile
      setDisplayName(p.display_name || '')
      setEmail(p.email || '')
      setPhone(p.phone || '')
      setLastLoginAt(p.last_login_at || null)
      setDeviceCount(Array.isArray(overviewRes.devices) ? overviewRes.devices.length : 0)
      try {
        const stored = JSON.parse(localStorage.getItem('homesense_user') || '{}')
        if (stored.id === id) {
          localStorage.setItem(
            'homesense_user',
            JSON.stringify({
              ...stored,
              id: p.id,
              email: p.email,
              display_name: p.display_name ?? null,
            })
          )
        }
      } catch {
        /* ignore */
      }
    } catch (err) {
      setLoadError(err.message || 'Could not load account')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const raw = localStorage.getItem('homesense_user')
    if (!raw) {
      navigate('/', { replace: true })
      return
    }
    try {
      const u = JSON.parse(raw)
      if (!u?.id) {
        navigate('/', { replace: true })
        return
      }
      setUserId(u.id)
      load(u.id)
    } catch {
      navigate('/', { replace: true })
    }
  }, [navigate, load])

  function handleLogout() {
    clearStoredAuth()
    navigate('/', { replace: true })
  }

  async function handleProfileSave(e) {
    e.preventDefault()
    setProfileMessage('')
    setProfileError('')
    setSavingProfile(true)
    try {
      const data = await patchProfile(userId, {
        display_name: displayName.trim() || null,
        email: email.trim().toLowerCase(),
        phone,
      })
      const p = data.profile
      setEmail(p.email)
      setDisplayName(p.display_name || '')
      setPhone(p.phone || '')
      setLastLoginAt(p.last_login_at || null)
      const stored = JSON.parse(localStorage.getItem('homesense_user') || '{}')
      localStorage.setItem(
        'homesense_user',
        JSON.stringify({
          ...stored,
          id: p.id,
          email: p.email,
          display_name: p.display_name ?? null,
        })
      )
      setProfileMessage('Profile saved.')
    } catch (err) {
      setProfileError(err.message || 'Save failed')
    } finally {
      setSavingProfile(false)
    }
  }

  async function handlePasswordSave(e) {
    e.preventDefault()
    setPasswordMessage('')
    setPasswordError('')
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match')
      return
    }
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters')
      return
    }
    setSavingPassword(true)
    try {
      await patchPassword(userId, {
        current_password: currentPassword,
        new_password: newPassword,
      })
      setPasswordMessage('Password updated.')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setPasswordError(err.message || 'Update failed')
    } finally {
      setSavingPassword(false)
    }
  }

  return (
    <div className={`dashboard gf-dashboard ${darkMode ? 'dark' : 'light'}`}>
      <header className="dashboard-header d-flex justify-content-between align-items-center mb-4 flex-wrap gap-2">
        <h1 className="h4 mb-0 font-weight-bold gf-dashboard-title-alt">Account Settings</h1>
        <div className="d-flex gap-2 align-items-center">
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            onClick={() => setDarkMode(!darkMode)}
          >
            {darkMode ? 'Light Mode' : 'Dark Mode'}
          </button>
          <Link to="/home" className="btn btn-outline-secondary btn-sm">
            Back To Dashboard
          </Link>
          <button type="button" className="btn btn-outline-secondary btn-sm" onClick={handleLogout}>
            Log Out
          </button>
        </div>
      </header>

      {loadError && (
        <div className="alert alert-danger" role="alert">
          {loadError}
        </div>
      )}

      <section className="row">
        <div className="col-lg-8 mb-4">
          <div className="card shadow-sm h-100">
            <div className="card-header font-weight-medium">Profile Information</div>

            <div className="card-body">
              {loading ? (
                <p className="text-muted small mb-0">Loading…</p>
              ) : (
                <form onSubmit={handleProfileSave}>
                  {profileError && (
                    <div className="alert alert-danger small py-2" role="alert">
                      {profileError}
                    </div>
                  )}
                  {profileMessage && (
                    <div className="alert alert-success small py-2" role="alert">
                      {profileMessage}
                    </div>
                  )}

                  <div className="form-group">
                    <label htmlFor="displayName">Display name</label>
                    <input
                      type="text"
                      className="form-control"
                      id="displayName"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="How we greet you on the dashboard"
                      disabled={savingProfile}
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="emailAddress">Email Address</label>
                    <input
                      type="email"
                      className="form-control"
                      id="emailAddress"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="Email"
                      required
                      disabled={savingProfile}
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="phoneNumber">Phone Number</label>
                    <input
                      type="tel"
                      className="form-control"
                      id="phoneNumber"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="Phone (optional)"
                      disabled={savingProfile}
                    />
                  </div>

                  <button type="submit" className="btn btn-primary" disabled={savingProfile}>
                    {savingProfile ? 'Saving…' : 'Save Changes'}
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>

        <div className="col-lg-4 mb-4">
          <div className="card shadow-sm h-100">
            <div className="card-header font-weight-medium">Account Summary</div>

            <div className="card-body">
              <p className="text-muted small mb-1">Plan</p>
              <p className="font-weight-bold mb-3">Standard</p>

              <p className="text-muted small mb-1">Connected Sensors</p>
              <p className="font-weight-bold mb-3">
                {deviceCount === null ? '—' : `${deviceCount} device${deviceCount === 1 ? '' : 's'}`}
              </p>

              <p className="text-muted small mb-1">Last Login</p>
              <p className="font-weight-bold mb-0">{formatLastLogin(lastLoginAt)}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="row">
        <div className="col-md-6 mb-4">
          <div className="card shadow-sm h-100">
            <div className="card-header font-weight-medium">Change Password</div>

            <div className="card-body">
              <form onSubmit={handlePasswordSave}>
                {passwordError && (
                  <div className="alert alert-danger small py-2" role="alert">
                    {passwordError}
                  </div>
                )}
                {passwordMessage && (
                  <div className="alert alert-success small py-2" role="alert">
                    {passwordMessage}
                  </div>
                )}

                <div className="form-group">
                  <label htmlFor="currentPassword">Current Password</label>
                  <input
                    type="password"
                    className="form-control"
                    id="currentPassword"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Current password"
                    disabled={savingPassword}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="newPassword">New Password</label>
                  <input
                    type="password"
                    className="form-control"
                    id="newPassword"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    disabled={savingPassword}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="confirmNewPassword">Confirm New Password</label>
                  <input
                    type="password"
                    className="form-control"
                    id="confirmNewPassword"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm new password"
                    disabled={savingPassword}
                  />
                </div>

                <button type="submit" className="btn btn-primary" disabled={savingPassword}>
                  {savingPassword ? 'Updating…' : 'Update Password'}
                </button>
              </form>
            </div>
          </div>
        </div>

        <div className="col-md-6 mb-4">
          <div className="card shadow-sm h-100">
            <div className="card-header font-weight-medium">Preferences</div>

            <div className="card-body">
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  alert('Preferences saved (demo)')
                }}
              >
                <div className="custom-control custom-switch mb-3">
                  <input
                    type="checkbox"
                    className="custom-control-input"
                    id="emailAlerts"
                    defaultChecked
                  />
                  <label className="custom-control-label" htmlFor="emailAlerts">
                    Email Alerts
                  </label>
                </div>

                <div className="custom-control custom-switch mb-3">
                  <input type="checkbox" className="custom-control-input" id="smsAlerts" />
                  <label className="custom-control-label" htmlFor="smsAlerts">
                    SMS Notifications
                  </label>
                </div>

                <div className="custom-control custom-switch mb-4">
                  <input
                    type="checkbox"
                    className="custom-control-input"
                    id="weeklyReports"
                    defaultChecked
                  />
                  <label className="custom-control-label" htmlFor="weeklyReports">
                    Weekly Reports
                  </label>
                </div>

                <button type="submit" className="btn btn-primary">
                  Save Preferences
                </button>
              </form>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="card shadow-sm border-danger">
          <div className="card-header font-weight-medium text-danger">Danger Zone</div>

          <div className="card-body">
            <div className="d-flex flex-column flex-md-row justify-content-between align-items-md-start gap-3">
              <div>
                <p className="mb-1 font-weight-medium">Delete account</p>
                <p className="text-muted small mb-0">
                  Permanently remove your account, devices, and sensor history. This cannot be
                  undone.
                </p>
              </div>

              {!deleteOpen ? (
                <button
                  type="button"
                  className="btn btn-outline-danger flex-shrink-0"
                  onClick={() => {
                    setDeleteOpen(true)
                    setDeletePassword('')
                    setDeleteError('')
                  }}
                >
                  Delete account
                </button>
              ) : null}
            </div>

            {deleteOpen ? (
              <form
                className="mt-3 pt-3 border-top"
                onSubmit={async (e) => {
                  e.preventDefault()
                  setDeleteError('')
                  if (!deletePassword) {
                    setDeleteError('Enter your password to confirm.')
                    return
                  }
                  setDeleting(true)
                  try {
                    await deleteAccount(userId, deletePassword)
                    clearStoredAuth()
                    navigate('/', { replace: true })
                  } catch (err) {
                    setDeleteError(err.message || 'Could not delete account')
                  } finally {
                    setDeleting(false)
                  }
                }}
              >
                {deleteError ? (
                  <div className="alert alert-danger small py-2" role="alert">
                    {deleteError}
                  </div>
                ) : null}
                <div className="form-group">
                  <label htmlFor="deletePassword">Confirm with your password</label>
                  <input
                    type="password"
                    className="form-control"
                    id="deletePassword"
                    value={deletePassword}
                    onChange={(e) => setDeletePassword(e.target.value)}
                    placeholder="Current password"
                    disabled={deleting}
                    autoComplete="current-password"
                  />
                </div>
                <div className="d-flex flex-wrap gap-2">
                  <button type="submit" className="btn btn-danger" disabled={deleting}>
                    {deleting ? 'Deleting…' : 'Permanently delete my account'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline-secondary"
                    disabled={deleting}
                    onClick={() => {
                      setDeleteOpen(false)
                      setDeletePassword('')
                      setDeleteError('')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  )
}

export default AccountSettings
