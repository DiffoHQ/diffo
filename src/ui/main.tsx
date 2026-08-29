import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { TooltipLayer } from './components/Tooltip.js'
import { applyTheme, loadTheme } from './theme.js'
import './styles.css'

// Before the first render, or a stored light/dark choice flashes the system palette
// for a frame on every load.
applyTheme(loadTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <TooltipLayer />
  </StrictMode>,
)
