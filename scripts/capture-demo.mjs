import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB_DIR = path.join(ROOT, 'web')
const DEFAULT_OUTPUT = path.join(
  tmpdir(),
  `flare-summer-signal-demo-${new Date().toISOString().replaceAll(/[-:.TZ]/g, '')}.mp4`,
)
const VIEWPORT = { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }
const FRAME_DURATION_SECONDS = 9

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1] || fallback
}

function browserBinary() {
  const configured = process.env.CHROME_BIN
  if (configured) return configured

  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(candidate)) return candidate
  }

  const result = spawnSync('sh', ['-c', 'command -v google-chrome || command -v chromium || command -v chromium-browser'], {
    encoding: 'utf8',
  })
  const resolved = result.stdout.trim()
  if (resolved) return resolved
  throw new Error('No Chromium-compatible browser found. Set CHROME_BIN to capture the demo.')
}

async function freePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (available) return port
  }
  throw new Error(`Could not find an available port near ${start}`)
}

function startProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (chunk) => {
    logs = `${logs}${chunk}`.slice(-8_000)
  })
  child.stderr.on('data', (chunk) => {
    logs = `${logs}${chunk}`.slice(-8_000)
  })
  child.demoLogs = () => logs
  return child
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function waitForHttp(url, child, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The Vite process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`Server did not become ready at ${url}\n${child.demoLogs()}`)
}

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1
    this.pending = new Map()
    this.socket = new WebSocket(webSocketUrl)
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('Chrome DevTools connection closed'))
      this.pending.clear()
    })
  }

  async send(method, params = {}) {
    await this.ready
    const id = this.nextId++
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.socket.send(JSON.stringify({ id, method, params }))
    return result
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || 'Browser evaluation failed')
    }
    return response.result?.value
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close()
    }
  }
}

async function connectToChrome(debugPort) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      const pages = await response.json()
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) return new CdpClient(page.webSocketDebuggerUrl)
    } catch {
      // Chrome may still be opening its DevTools endpoint.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Chrome DevTools endpoint did not become ready')
}

async function waitForExpression(cdp, expression, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  let bodyText = ''
  try {
    bodyText = String(await cdp.evaluate('document.body?.innerText || ""')).slice(0, 600)
  } catch {
    bodyText = 'Browser body unavailable.'
  }
  throw new Error(`Browser condition timed out: ${expression}\n${bodyText}`)
}

async function navigateAndWait(cdp, url, expression) {
  await cdp.send('Page.navigate', { url })
  await waitForExpression(cdp, expression)
}

async function captureScreenshot(cdp, outputPath) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(outputPath, Buffer.from(result.data, 'base64'))
}

async function formatAgentJson(cdp) {
  await cdp.evaluate(`(async () => {
    const response = await fetch(location.href, { cache: 'no-store' });
    const payload = await response.json();
    document.body.innerHTML = '';
    document.body.style.margin = '0';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(payload, null, 2);
    pre.style.cssText = 'margin:0;padding:28px 34px;background:#181818;color:#f4f0e8;font:13px/1.55 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word;';
    document.body.append(pre);
    document.title = 'FAsset Guardian redemption preflight JSON';
  })()`)
}

async function setThresholdAndScroll(cdp) {
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.threshold-field input');
    input?.scrollIntoView({ block: 'center' });
    input?.focus();
    input?.select();
    return Boolean(input);
  })()`)
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    modifiers: 2,
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers: 2,
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  })
  await cdp.send('Input.insertText', { text: '1' })
  await waitForExpression(cdp, `document.querySelector('.threshold-field input')?.value === '1'`)
}

async function encodeVideo(frames, outputPath) {
  const concatFile = path.join(path.dirname(frames[0].path), 'frames.txt')
  const lines = frames.flatMap((frame) => [
    `file '${frame.path.replaceAll("'", "'\\''")}'`,
    `duration ${frame.duration}`,
  ])
  lines.push(`file '${frames.at(-1).path.replaceAll("'", "'\\''")}'`)
  await writeFile(concatFile, `${lines.join('\n')}\n`)

  await new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-n',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatFile,
      '-vf',
      'fps=30,format=yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '21',
      '-movflags',
      '+faststart',
      outputPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let errorOutput = ''
    ffmpeg.stderr.on('data', (chunk) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-4_000)
    })
    ffmpeg.once('error', reject)
    ffmpeg.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with ${code}: ${errorOutput}`))
    })
  })
}

async function main() {
  const outputPath = path.resolve(option('--output', DEFAULT_OUTPUT))
  if (existsSync(outputPath)) throw new Error(`Refusing to overwrite existing output: ${outputPath}`)

  const livePort = await freePort(Number(option('--live-port', '5191')))
  const failPort = await freePort(Number(option('--fail-port', '5192')))
  const debugPort = await freePort(Number(option('--debug-port', '9223')))
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'flare-summer-signal-demo-'))
  const liveBaseUrl = `http://127.0.0.1:${livePort}`
  const failBaseUrl = `http://127.0.0.1:${failPort}`
  const viteEntry = path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
  const liveServer = startProcess(process.execPath, [viteEntry, '--host', '127.0.0.1', '--port', String(livePort), '--strictPort'], {
    cwd: WEB_DIR,
  })
  const failServer = startProcess(process.execPath, [viteEntry, '--host', '127.0.0.1', '--port', String(failPort), '--strictPort'], {
    cwd: WEB_DIR,
    env: { FLARE_RPC_URL: 'http://127.0.0.1:1' },
  })

  let cdp
  let browser
  try {
    await Promise.all([waitForHttp(`${liveBaseUrl}/`, liveServer), waitForHttp(`${failBaseUrl}/`, failServer)])

    browser = startProcess(browserBinary(), [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${temporaryDirectory}/chrome-profile`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      'about:blank',
    ])
    cdp = await connectToChrome(debugPort)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.setDeviceMetricsOverride', VIEWPORT)

    const frames = []
    const framePath = (name) => path.join(temporaryDirectory, `${frames.length + 1}-${name}.png`)
    await navigateAndWait(cdp, `${liveBaseUrl}/`, `document.querySelector('.connection--live') !== null`)
    const liveFrame = framePath('live-overview')
    await captureScreenshot(cdp, liveFrame)
    frames.push({ path: liveFrame, duration: FRAME_DURATION_SECONDS })

    await cdp.evaluate(`document.querySelector('#agents-title')?.scrollIntoView({ block: 'center' })`)
    const agentsFrame = framePath('agent-health')
    await captureScreenshot(cdp, agentsFrame)
    frames.push({ path: agentsFrame, duration: FRAME_DURATION_SECONDS })

    await setThresholdAndScroll(cdp)
    const thresholdFrame = framePath('operator-threshold')
    await captureScreenshot(cdp, thresholdFrame)
    frames.push({ path: thresholdFrame, duration: FRAME_DURATION_SECONDS })

    await navigateAndWait(cdp, `${liveBaseUrl}/api/redemption.json?lots=100`, `document.body?.textContent?.includes('redemptionPreview')`)
    await formatAgentJson(cdp)
    const apiFrame = framePath('redemption-preflight-json')
    await captureScreenshot(cdp, apiFrame)
    frames.push({ path: apiFrame, duration: FRAME_DURATION_SECONDS })

    await navigateAndWait(cdp, `${liveBaseUrl}/api/redemption-plan.json?lots=100&underlying=rSHYuiEvsYsKR8uUHhBTuGP5zjRcGt4nm`, `document.body?.textContent?.includes('redemptionPlan')`)
    await formatAgentJson(cdp)
    const transactionPlanFrame = framePath('transaction-plan-json')
    await captureScreenshot(cdp, transactionPlanFrame)
    frames.push({ path: transactionPlanFrame, duration: FRAME_DURATION_SECONDS })

    await navigateAndWait(cdp, `${failBaseUrl}/`, `document.querySelector('.empty-state--error') !== null`)
    const failClosedFrame = framePath('fail-closed')
    await captureScreenshot(cdp, failClosedFrame)
    frames.push({ path: failClosedFrame, duration: FRAME_DURATION_SECONDS })

    await encodeVideo(frames, outputPath)
    const outputStats = await stat(outputPath)
    if (outputStats.size === 0) throw new Error('ffmpeg produced an empty video')
    console.log(`capture-demo OK: ${outputPath}`)
    console.log(`duration: ${frames.length * FRAME_DURATION_SECONDS}s`)
    console.log(`size: ${Math.ceil(outputStats.size / 1024)}K`)
  } finally {
    cdp?.close()
    await stopProcess(browser)
    await stopProcess(liveServer)
    await stopProcess(failServer)
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`capture-demo failed: ${error.message}`)
  process.exitCode = 1
})
