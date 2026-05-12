import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createAccount, setStoredToken } from '../api'

function CreateAccount({ darkMode, setDarkMode }) {
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)


    const form = e.target
    const email = form.createEmail.value.trim()
    const password = form.createPassword.value
    const confirmPassword = form.confirmPassword.value


    if (password !== confirmPassword) {
      setError('Passwords do not match')
      setLoading(false)
      return
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      setLoading(false)
      return
    }

    try {
      const data = await createAccount(email, password)
      if (data.success) {
        // The register endpoint also issues a session token. Persisting it
        // means the user is effectively signed in already — but we still
        // route them through the login page to keep the existing flow.
        if (data.token) {
          setStoredToken(data.token)
        }
        navigate('/')
        return
      }
      setError(data.message || 'Could not create account')
    } catch (err) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-100" style={{ maxWidth: 400 }}>
      <div className="d-flex justify-content-end mb-2">
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => setDarkMode(!darkMode)}
        >
          {darkMode ? 'Light mode' : 'Dark mode'}
        </button>
      </div>
    <div className="card shadow-sm gf-auth-card">
      <div className="card-body">
        <h3 className="card-title mb-4 text-center">Create account</h3>

        <form onSubmit={handleSubmit}>
          {error && (
            <div className="alert alert-danger small py-2" role="alert">
              {error}
            </div>
          )}

          <div className="form-group">
            <label htmlFor="createEmail">Email address</label>
            <input
              type="email"
              className="form-control"
              id="createEmail"
              name="createEmail"
              placeholder="Enter email"
              required
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="createPassword">Password</label>
            <input
              type="password"
              className="form-control"
              id="createPassword"
              name="createPassword"
              placeholder="At least 8 characters"
              required
              minLength={8}
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="confirmPassword">Confirm password</label>
            <input
              type="password"
              className="form-control"
              id="confirmPassword"
              name="confirmPassword"
              placeholder="Confirm password"
              required
              disabled={loading}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={loading}
          >
            {loading ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="mt-3 text-center text-muted small mb-0">
          Already have an account? <Link to="/">Log in</Link>
        </p>
      </div>
    </div>
    </div>
  )
}

export default CreateAccount
