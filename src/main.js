import './styles.css'
import { App } from './app.js'

// Build identifier — check this in the browser console (F12) to confirm
// which version is actually running. If you just pushed a fix and this
// timestamp doesn't match what you expect, the browser is serving a
// cached old build: hard-refresh with Ctrl+Shift+R (Windows/Linux) or
// Cmd+Shift+R (Mac), or open in a private/incognito window to test.
console.log('%cEDH Commander Online — build ' + __BUILD_TIME__, 'color:#e8aa38;font-weight:bold;font-size:14px')

document.getElementById('app').appendChild(App())
