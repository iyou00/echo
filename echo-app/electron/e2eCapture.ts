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
    if (target.isDestroyed()) throw new Error(`Window closed while waiting for ${selector} to disappear`)
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
    if (target.isDestroyed()) throw new Error(`Window closed while waiting for expression: ${expression}`)
    let matched = false
    try {
      matched = await target.webContents.executeJavaScript(`Boolean(${expression})`, true)
    } catch {
      matched = false
    }
    if (matched) return
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
  target.webContents.invalidate()
  await wait(50)
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
  await wait(1400)
  metrics.push(await capture(target, 'first-run-sequence.png'))
  await waitForMissing(target, '.first-run-welcome-layer', 20_000)
  await waitForSelector(target, '[data-testid="onboarding-skip"]')
  metrics.push(await capture(target, 'onboarding.png'))
  await click(target, '[data-testid="onboarding-skip"]')
  await waitForMissing(target, '[data-testid="onboarding-skip"]')
  metrics.push(await capture(target, 'shell-empty.png'))
  await click(target, '.d2-icon-button[aria-label="设置"]')
  await waitForSelector(target, '.d2-drawer-layer.open .settings-page')
  await wait(360)
  metrics.push(await capture(target, 'settings-overview.png'))
  await click(target, '[data-testid="settings-connections"]')
  await waitForSelector(target, '[data-testid="settings-connections-view"]')
  await wait(120)
  metrics.push(await capture(target, 'settings-connections.png'))
  await click(target, '[data-testid="settings-ai-edit"]')
  await waitForSelector(target, '[data-testid="settings-overview-back"]')
  await wait(120)
  metrics.push(await capture(target, 'settings-ai-model.png'))
  await click(target, '[data-testid="settings-overview-back"]')
  await waitForSelector(target, '[data-testid="settings-connections-view"]')
  await click(target, '[data-testid="settings-connections-back"]')
  await waitForSelector(target, '[data-testid="settings-connections"]')
  await click(target, '[data-testid="settings-tasks"]')
  await waitForSelector(target, '[data-testid="settings-tasks-view"]')
  await wait(120)
  metrics.push(await capture(target, 'settings-tasks.png'))
  await click(target, '[data-testid="settings-tasks-view"] .d2-settings-back')
  await waitForSelector(target, '[data-testid="settings-yinyi"]')
  await click(target, '[data-testid="settings-yinyi"]')
  await waitForSelector(target, '.d2-settings-form.detail-yinyi .target-yinyi')
  await wait(120)
  metrics.push(await capture(target, 'settings-yinyi.png'))
  await click(target, '[data-testid="settings-overview-back"]')
  await waitForSelector(target, '[data-testid="settings-connections"]')
  await wait(120)
  await click(target, '.d2-icon-button[aria-label="品味"]')
  await waitForSelector(target, '.d2-profile')
  await wait(360)
  metrics.push(await capture(target, 'profile-drawer.png'))
  await click(target, '.d2-brand')
  await waitForMissing(target, '.d2-drawer-layer.open')
  await click(target, '[aria-label="打开队列"]')
  await waitForSelector(target, '.d2-queue')
  await wait(360)
  metrics.push(await capture(target, 'queue-drawer.png'))
  await click(target, '.d2-brand')
  await waitForMissing(target, '.d2-drawer-layer.open')
  await click(target, '.d2-icon-button[aria-label="设置"]')
  await waitForSelector(target, '.d2-drawer-layer.open .settings-page')
  await wait(200)
  const aboutButton = await target.webContents.executeJavaScript(
    `(() => { const buttons = [...document.querySelectorAll('.d2-settings-links button')]; const hit = buttons.find((b) => b.textContent?.includes('关于 Echo')); if (hit instanceof HTMLElement) { hit.click(); return true } return false })()`,
    true,
  )
  if (!aboutButton) throw new Error('Could not find about entry in settings overview')
  await waitForSelector(target, '.d2-about')
  await wait(300)
  metrics.push(await capture(target, 'about-drawer.png'))
  await click(target, '.d2-brand')
  await waitForMissing(target, '.d2-drawer-layer.open')
  await click(target, '.voice-entry-button')
  await waitForSelector(target, '.field-voice')
  metrics.push(await capture(target, 'voice-idle-stage.png'))
  await click(target, '.d2-brand')
  await waitForSelector(target, '.chat-page')
  await target.webContents.executeJavaScript(`window.echo.playback.play({
    id: 'e2e-media-track',
    title: 'Echo 媒体键测试',
    artist: 'Echo',
    album: 'D2.5',
    playUrl: './welcome/first-run-welcome.mp3',
    durationMs: 30000
  })`, true)
  await waitForExpression(target, `document.querySelector('.player-title')?.textContent?.includes('媒体键测试') && document.querySelector('.global-player audio')?.paused === false && navigator.mediaSession.metadata?.title === 'Echo 媒体键测试' && navigator.mediaSession.playbackState === 'playing'`)
  await waitForSelector(target, '.field-listening')
  await waitForSelector(target, '.wave-bars.measured')
  try {
    await waitForExpression(target, `Array.from(document.querySelectorAll('.wave-bars.measured span')).some((bar) => Number.parseFloat(bar.style.height) > 5)`, 5_000)
  } catch (error) {
    const diagnostics = await target.webContents.executeJavaScript(`(() => {
      const audio = document.querySelector('.global-player audio')
      return {
        captureStream: typeof audio?.captureStream,
        audioContext: typeof AudioContext,
        paused: audio?.paused,
        currentTime: audio?.currentTime,
        heights: Array.from(document.querySelectorAll('.wave-bars.measured span')).slice(0, 8).map((bar) => bar.style.height),
      }
    })()`, true)
    throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(diagnostics)}`)
  }
  await click(target, '.d2-sound-art')
  await waitForExpression(target, `document.querySelector('.global-player audio')?.paused === true`)
  await click(target, '.d2-sound-art')
  await waitForExpression(target, `document.querySelector('.global-player audio')?.paused === false`)
  await target.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.d2-volume-control input')
    if (!(input instanceof HTMLInputElement)) return false
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    valueSetter?.call(input, '37')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`, true)
  await waitForExpression(target, `document.querySelector('.d2-volume-control input')?.value === '37'`)
  const persistedVolume = await target.webContents.executeJavaScript('window.echo.playback.getVolume()', true)
  if (persistedVolume !== 37) throw new Error(`Volume control did not persist: ${persistedVolume}`)
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

async function captureBoundaryModelInvalid(target: BrowserWindow): Promise<CaptureMetric[]> {
  await waitForSelector(target, '[data-testid="first-run-skip"]')
  await click(target, '[data-testid="first-run-skip"]')
  await waitForSelector(target, '[data-testid="onboarding-skip"]')
  await click(target, '[data-testid="onboarding-skip"]')
  await waitForMissing(target, '[data-testid="onboarding-skip"]')
  await waitForSelector(target, '.chat-page .d2-empty')
  await wait(300)
  return [await capture(target, 'boundary-model-invalid.png')]
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
            : scenario === 'boundary-model-invalid'
              ? await captureBoundaryModelInvalid(target)
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
