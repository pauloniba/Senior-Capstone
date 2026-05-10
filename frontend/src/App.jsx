import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'

import Login from './pages/Login'
import CreateAccount from './pages/CreateAccount'
import AccountSettings from './pages/AccountSettings'
import ForgotPassword from './pages/ForgotPassword'
import Home from './pages/Home'
import DayDetails from './pages/DayDetails'

import './index.css'

function AppLayout() {
  const location = useLocation()

  // Dark by default; honor stored preference if user has toggled before.
  const [darkMode, setDarkMode] = useState(() => {
    const stored = localStorage.getItem("theme")
    if (stored === "light") return false
    if (stored === "dark") return true
    return true
  })

  // 🌙 Apply theme globally
  useEffect(() => {
    const theme = darkMode ? "dark" : "light"

    // prevent overwriting other classes
    document.body.classList.remove("light", "dark")
    document.body.classList.add(theme)

    localStorage.setItem("theme", theme)
  }, [darkMode])

  // detect dashboard pages
  const dashboardRoutes = ['/home', '/account-settings', '/day/']
  const isDashboard = dashboardRoutes.some(route =>
    location.pathname.startsWith(route)
  )

  return (
    <div
      className={`theme-shell d-flex w-100 ${
        isDashboard
          ? 'align-items-start'
          : 'justify-content-center align-items-center'
      }`}
      style={{ minHeight: '100vh', padding: 16 }}
    >
      <div
        className="w-100 app-shell__inner"
        style={{ maxWidth: isDashboard ? 'none' : 400 }}
      >
        <Routes>
          <Route path="/" element={<Login />} />
          <Route
            path="/create-account"
            element={<CreateAccount darkMode={darkMode} setDarkMode={setDarkMode} />}
          />
          <Route
            path="/forgot-password"
            element={<ForgotPassword darkMode={darkMode} setDarkMode={setDarkMode} />}
          />
          <Route
            path="/account-settings"
            element={<AccountSettings darkMode={darkMode} setDarkMode={setDarkMode} />}
          />
          <Route
            path="/home"
            element={<Home darkMode={darkMode} setDarkMode={setDarkMode} />}
          />
          <Route
            path="/day/:day"
            element={<DayDetails darkMode={darkMode} setDarkMode={setDarkMode} />}
          />
        </Routes>
      </div>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  )
}

export default App