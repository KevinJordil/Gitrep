import { app, type BrowserWindow } from 'electron'

// Headless check used by `npm run smoke`: load the window, collect renderer errors, exit 0 (clean) or 1.
export function smoke(win: BrowserWindow): void {
  const errors: string[] = []
  win.webContents.on('console-message', (event) => {
    const { level, message } = event as unknown as { level: string; message: string }
    if (level === 'error') errors.push(message)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.log(`SMOKE FAIL renderer gone: ${details.reason}`)
    app.exit(1)
  })
  win.webContents.once('did-fail-load', (_event, code, description) => {
    console.log(`SMOKE FAIL load ${code} ${description}`)
    app.exit(1)
  })
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      console.log(errors.length ? `SMOKE FAIL\n${errors.join('\n')}` : 'SMOKE OK')
      app.exit(errors.length ? 1 : 0)
    }, 3000)
  })
}
