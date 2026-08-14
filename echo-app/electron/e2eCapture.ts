import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

type E2EWindowKind = 'app' | 'recovery'

interface CaptureMetric {
  file: string
  width: number
  height: number
  sampledColors: number
  luminanceRange: number
}

const scenario = process.env.ECHO_E2E_SCENARIO ?? ''
const outputDirectory = process.env.ECHO_E2E_OUTPUT_DIR ?? ''
const enabled = process.env.ECHO_E2E === '1' && Boolean(scenario) && Boolean(outputDirectory)

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function waitForSelector(target: BrowserWindow, selector: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (target.isDestroyed()) throw new Error(`Window closed while waiting for ${selector}`)
    const found = await target.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      true,
    )
    if (found) return
    await wait(100)
  }
  throw new Error(`Timed out waiting for ${selector}`)
}

async function waitForMissing(target: BrowserWindow, selector: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await target.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      true,
    )
    if (!found) return
    await wait(100)
  }
  throw new Error(`Timed out waiting for ${selector} to disappear`)
}

async function waitForExpression(target: BrowserWindow, expression: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await target.webContents.executeJavaScript(`Boolean(${expression})`, true)) return
    await wait(100)
  }
  throw new Error(`Timed out waiting for expression: ${expression}`)
}

async function click(target: BrowserWindow, selector: string): Promise<void> {
  await waitForSelector(target, selector)
  const clicked = await target.webContents.executeJavaScript(
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) return false; element.click(); return true })()`,
    true,
  )
  if (!clicked) throw new Error(`Could not click ${selector}`)
}

async function capture(target: BrowserWindow, fileName: string): Promise<CaptureMetric> {
  let image = await target.webContents.capturePage()
  let size = image.getSize()
  for (let attempt = 0; attempt < 8 && (size.width === 0 || size.height === 0); attempt += 1) {
    target.show()
    target.webContents.invalidate()
    await wait(180)
    image = await target.webContents.capturePage()
    size = image.getSize()
  }
  const bitmap = image.toBitmap()
  const sampledColors = new Set<number>()
  let minimumLuminance = 255
  let maximumLuminance = 0
  const pixelStride = Math.max(1, Math.floor((size.width * size.height) / 24_000))
  for (let pixel = 0; pixel < size.width * size.height; pixel += pixelStride) {
    const offset = pixel * 4
    const blue = bitmap[offset] ?? 0
    const green = bitmap[offset + 1] ?? 0
    const red = bitmap[offset + 2] ?? 0
    const luminance = Math.round((red * 299 + green * 587 + blue * 114) / 1000)
    minimumLuminance = Math.min(minimumLuminance, luminance)
    maximumLuminance = Math.max(maximumLuminance, luminance)
    if (sampledColors.size < 512) sampledColors.add((red << 16) | (green << 8) | blue)
  }
  const luminanceRange = maximumLuminance - minimumLuminance
  if (size.width < 500 || size.height < 300 || sampledColors.size < 4 || luminanceRange < 8) {
    throw new Error(
      `Blank or malformed capture ${fileName}: ${size.width}x${size.height}, ${sampledColors.size} colors, luminance range ${luminanceRange}`,
    )
  }
  const filePath = path.join(outputDirectory, fileName)
  fs.writeFileSync(filePath, image.toPNG())
  return {
    file: fileName,
    width: size.width,
    height: size.height,
    sampledColors: sampledColors.size,
    luminanceRange,
  }
}

async function captureFirstRun(target: BrowserWindow): Promise<CaptureMetric[]> {
  await waitForSelector(target, '[data-testid="first-run-silent"]')
  const metrics: CaptureMetric[] = []
  for (const preset of [
    { name: 'compact', width: 1152, height: 720 },
    { name: 'standard', width: 1280, height: 800 },
    { name: 'large', width: 1440, height: 900 },
  ]) {
    target.setSize(preset.width, preset.height)
    target.center()
    metrics.push(await capture(target, `first-run-${preset.name}.png`))
  }
  target.setSize(1280, 800)
  await click(target, '[data-testid="first-run-silent"]')
  await waitForSelector(target, '[data-testid="first-run-continue"]')
  metrics.push(await capture(target, 'first-run-sequence.png'))
  await click(target, '[data-testid="first-run-continue"]')
  await waitForSelector(target, '[data-testid="onboarding-skip"]')
  metrics.push(await capture(target, 'onboarding.png'))
  await click(target, '[data-testid="onboarding-skip"]')
  await waitForMissing(target, '[data-testid="onboarding-skip"]')
  metrics.push(await capture(target, 'shell-empty.png'))
  await target.webContents.executeJavaScript(`window.echo.playback.play({
    id: 'e2e-media-track',
    title: 'Echo 媒体键测试',
    artist: 'Echo',
    album: 'D2.5',
    playUrl: './welcome/first-run-welcome.mp3',
    durationMs: 30000
  })`, true)
  await waitForExpression(target, `document.querySelector('.player-title')?.textContent?.includes('媒体键测试') && document.querySelector('.global-player audio')?.paused === false && navigator.mediaSession.metadata?.title === 'Echo 媒体键测试' && navigator.mediaSession.playbackState === 'playing'`)
  metrics.push(await capture(target, 'player-media-session.png'))
  await target.webContents.executeJavaScript('window.echo.window.close()', true)
  await waitForSelector(target, '.close-dialog')
  await waitForSelector(target, '.close-activity')
  metrics.push(await capture(target, 'close-dialog-busy.png'))
  return metrics
}

async function captureFirstRunSound(target: BrowserWindow): Promise<CaptureMetric[]> {
  await waitForSelector(target, '[data-testid="first-run-sound"]')
  await click(target, '[data-testid="first-run-sound"]')
  await waitForSelector(target, '[data-testid="first-run-continue"]')
  await waitForExpression(target, `document.querySelector('.first-run-welcome-layer audio')?.paused === false && document.querySelector('.first-run-welcome-layer audio')?.currentTime > 0.05`, 12_000)
  const metrics = [await capture(target, 'first-run-sound-playing.png')]
  await click(target, '.first-run-mute')
  await waitForExpression(target, `document.querySelector('.first-run-welcome-layer audio')?.paused === true`)
  metrics.push(await capture(target, 'first-run-sound-muted.png'))
  return metrics
}

async function captureOffline(target: BrowserWindow): Promise<CaptureMetric[]> {
  await waitForSelector(target, '[data-testid="first-run-skip"]')
  await click(target, '[data-testid="first-run-skip"]')
  await waitForSelector(target, '[data-testid="onboarding-skip"]')
  await click(target, '[data-testid="onboarding-skip"]')
  await waitForMissing(target, '[data-testid="onboarding-skip"]')
  await waitForSelector(target, '.boundary-notice')
  return [await capture(target, 'offline.png')]
}

async function captureRecovery(target: BrowserWindow): Promise<CaptureMetric[]> {
  await waitForSelector(target, 'main')
  return [await capture(target, 'startup-recovery.png')]
}

async function securitySnapshot(target: BrowserWindow): Promise<Record<string, unknown>> {
  return target.webContents.executeJavaScript(`(async () => ({
    contextIsolation: typeof window.echo === 'object' && typeof window.echo.settings?.get === 'function',
    nodeIntegrationDisabled: typeof require === 'undefined' && typeof process === 'undefined',
    notificationPermission: await navigator.permissions.query({ name: 'notifications' }).then((result) => result.state).catch(() => 'unsupported')
  }))()`, true)
}

export function configureElectronE2E(): void {
  if (!enabled) return
  const userDataDirectory = process.env.ECHO_E2E_USER_DATA
  if (!userDataDirectory) throw new Error('ECHO_E2E_USER_DATA is required')
  fs.mkdirSync(userDataDirectory, { recursive: true })
  fs.mkdirSync(outputDirectory, { recursive: true })
  app.setPath('userData', userDataDirectory)
  if (scenario !== 'first-run-sound') app.commandLine.appendSwitch('force-prefers-reduced-motion')
}

export function shouldForceStartupFailure(): boolean {
  return enabled && scenario === 'startup-failure'
}

export function isForcedOffline(): boolean {
  return enabled && scenario === 'offline'
}

export function runElectronE2E(target: BrowserWindow, kind: E2EWindowKind): void {
  if (!enabled) return
  const expectedKind: E2EWindowKind = scenario === 'startup-failure' ? 'recovery' : 'app'
  if (kind !== expectedKind) return
  void (async () => {
    try {
      const captures = scenario === 'first-run'
        ? await captureFirstRun(target)
        : scenario === 'first-run-sound'
          ? await captureFirstRunSound(target)
          : scenario === 'offline'
            ? await captureOffline(target)
            : await captureRecovery(target)
      const security = kind === 'app' ? await securitySnapshot(target) : null
      if (security && (!security.contextIsolation || !security.nodeIntegrationDisabled)) {
        throw new Error('Electron renderer security contract failed')
      }
      fs.writeFileSync(
        path.join(outputDirectory, 'result.json'),
        JSON.stringify({ ok: true, scenario, captures, security }, null, 2),
        'utf8',
      )
      app.exit(0)
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error)
      fs.writeFileSync(
        path.join(outputDirectory, 'result.json'),
        JSON.stringify({ ok: false, scenario, error: message }, null, 2),
        'utf8',
      )
      console.error('[e2e]', error)
      app.exit(1)
    }
  })()
}
