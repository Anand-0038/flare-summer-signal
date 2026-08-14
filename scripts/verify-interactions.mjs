import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import net from 'node:net'

const baseUrl = process.argv[2]
const browserBinary = process.env.BROWSER_BIN

if (!baseUrl || !browserBinary) {
  throw new Error('Usage: BROWSER_BIN=/path/to/chromium node scripts/verify-interactions.mjs <base-url>')
}

const profileDirectory = await mkdtemp(path.join(tmpdir(), 'fasset-guardian-browser-'))
const debugPort = await freePort()
const browser = spawn(browserBinary, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDirectory}`,
  baseUrl,
], { stdio: 'ignore' })

try {
  const target = await waitForTarget(debugPort, baseUrl)
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  try {
    await cdp.send('Runtime.enable')
    await waitFor(cdp, `Boolean(document.querySelector('#underlying-address') && document.querySelector('#redemption-lots'))`)
    await waitFor(cdp, `!document.querySelector('.empty-state')`)

    await setInput(cdp, 'underlying-address', 'rSHYuiEvsYsKR8uUHhBTuGP5zjRcGt4nm')
    await waitFor(cdp, `!Array.from(document.querySelectorAll('.guardian-handoff button')).find((button) => button.textContent.includes('Prepare transaction handoff')).disabled`)
    await clickHandoff(cdp)
    await waitForHandoff(cdp)
    await assertExpression(
      cdp,
      `document.querySelector('[aria-label="Transaction handoff result"]').innerText.includes('redeemAmount')`,
      'valid classic address did not produce a redeemAmount handoff',
    )

    await setInput(cdp, 'redemption-lots', '101')
    await waitFor(cdp, `!document.querySelector('[aria-label="Transaction handoff result"]')`)

    await setInput(cdp, 'underlying-address', 'rSHYuiEvsYsKR8uUHhBTuGP5zjRcGt4nn')
    await waitFor(cdp, `!Array.from(document.querySelectorAll('.guardian-handoff button')).find((button) => button.textContent.includes('Prepare transaction handoff')).disabled`)
    await clickHandoff(cdp)
    await waitFor(cdp, `Boolean(document.querySelector('.transaction-plan-error'))`)
    await assertExpression(
      cdp,
      `document.querySelector('.transaction-plan-error').innerText.includes('Transaction handoff failed')`,
      'checksum-invalid classic address did not surface a handoff error',
    )

    await setInput(cdp, 'underlying-address', 'rSHYuiEvsYsKR8uUHhBTuGP5zjRcGt4nm')
    await waitFor(cdp, `!Array.from(document.querySelectorAll('.guardian-handoff button')).find((button) => button.textContent.includes('Prepare transaction handoff')).disabled`)
    await clickHandoff(cdp)
    await waitForHandoff(cdp)
    await assertExpression(
      cdp,
      `!document.querySelector('.transaction-plan-error')`,
      'handoff did not recover after correcting the XRPL address',
    )

    await setInput(cdp, 'status-tx', '0x' + 'cd'.repeat(32))
    await switchStatusMode(cdp, 'requestId')
    await setInput(cdp, 'status-requestId', '')
    await setInput(cdp, 'status-fromBlock', '')
    await setInput(cdp, 'status-toBlock', '')
    await assertExpression(
      cdp,
      `Boolean(document.querySelector('.status-tracker button:disabled')) && document.querySelector('.status-tracker button:disabled').textContent.includes('Check request status')`,
      'status requestId mode did not disable lookup when required fields are empty',
    )

    await setInput(cdp, 'status-requestId', '111')
    await setInput(cdp, 'status-fromBlock', '1')
    await setInput(cdp, 'status-toBlock', '2')
    await assertExpression(
      cdp,
      `document.getElementById('status-requestId').value === '111' && document.getElementById('status-fromBlock').value === '1' && document.getElementById('status-toBlock').value === '2'`,
      'requestId mode setup did not retain input values for stale-state check',
    )

    await setInput(cdp, 'status-requestId', '123')
    await setInput(cdp, 'status-fromBlock', 'abc')
    await setInput(cdp, 'status-toBlock', '')
    await clickStatusLookup(cdp)
    await waitFor(cdp, `Boolean(document.querySelector('.status-error'))`)
    await assertExpression(
      cdp,
      `document.querySelector('.status-error').innerText.includes('fromBlock')\n       || document.querySelector('.status-error').innerText.includes('required')`,
      'status fromBlock non-numeric input was not rejected',
    )

    await setInput(cdp, 'status-fromBlock', '10')
    await setInput(cdp, 'status-toBlock', '11')
    await clickStatusLookup(cdp)
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.status-tracker a[href^=\"/api/redemption-status.json\"]'))`,
    )
    await assertExpression(
      cdp,
      `document.querySelector('.status-tracker a[href^=\"/api/redemption-status.json\"]')?.href.includes('requestId=123&fromBlock=10&toBlock=11')`,
      'status API path does not reflect requestId+bounds query',
    )
    await assertExpression(
      cdp,
      `document.getElementById('status-requestId').value === '123' && document.getElementById('status-fromBlock').value === '10' && document.getElementById('status-toBlock').value === '11'`,
      'requestId mode retained expected input values before switching modes',
    )

    await switchStatusMode(cdp, 'tx')
    await assertExpression(
      cdp,
      `document.getElementById('status-tx').value === '' && (document.getElementById('status-fromBlock') || {value: ''}).value === '' && (document.getElementById('status-toBlock') || {value: ''}).value === ''`,
      'switching to tx mode did not clear requestId-mode range fields',
    )
    await setInput(cdp, 'status-tx', '0x' + 'ab'.repeat(32))
    await setInput(cdp, 'status-requestIdForTx', 'abc')
    await clickStatusLookup(cdp)
    await waitFor(cdp, `Boolean(document.querySelector('.status-error'))`)
    await assertExpression(
      cdp,
      `document.querySelector('.status-error').innerText.includes('requestId')`,
      'invalid tx-mode requestId was not rejected by client validation',
    )
    await setInput(cdp, 'status-requestIdForTx', '')
    await clickStatusLookup(cdp)
    await waitFor(cdp, `Boolean(document.querySelector('.status-error') || document.querySelector('.status-result'))`)

    await setInput(cdp, 'status-tx', '0x0000000000000000000000000000000000000000000000000000000000000000')
    await clickStatusLookup(cdp)
    await waitFor(
      cdp,
      `Boolean(document.querySelector('.status-error') || document.querySelector('.status-result'))`,
    )
    await assertExpression(
      cdp,
      `Boolean(document.querySelector('.status-error') || document.querySelector('.status-result'))`,
      'status tx lookup did not produce a result or error',
    )

    await switchStatusMode(cdp, 'requestId')
    await assertExpression(
      cdp,
      `document.getElementById('status-requestId').value === '' && document.getElementById('status-fromBlock').value === '' && document.getElementById('status-toBlock').value === '' && !document.getElementById('status-tx')`,
      'switching back to requestId mode did not clear tx mode and requestId mode inputs',
    )
  } finally {
    cdp.close()
  }
} finally {
  browser.kill('SIGTERM')
  await new Promise((resolve) => browser.once('exit', resolve))
  try {
    await rm(profileDirectory, { recursive: true, force: true })
  } catch (error) {
    // Profile cleanup can race with Chromium on some CI environments.
    if (error?.code !== 'ENOTEMPTY') {
      throw error
    }
  }
}

console.log('verify-interactions OK: handoff, stale-plan invalidation, checksum rejection, status checks, and recovery verified')

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
  })
}

async function waitForTarget(port, expectedUrl) {
  const endpoint = `http://127.0.0.1:${port}/json/list`
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(endpoint)
      const targets = await response.json()
      const target = targets.find((item) => item.type === 'page' && item.url.startsWith(expectedUrl))
      if (target?.webSocketDebuggerUrl) return target
    } catch {
      // Chromium may not have opened its debugger socket yet.
    }
    await delay(250)
  }
  throw new Error(`Chromium did not expose the Guardian page at ${endpoint}`)
}

async function connectCdp(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  })

  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId
        nextId += 1
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close() {
      socket.close()
    },
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Browser evaluation failed')
  }
  return result.result.value
}

async function waitFor(cdp, expression) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await evaluate(cdp, expression)) return
    await delay(250)
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`)
}

async function waitForHandoff(cdp) {
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[aria-label="Transaction handoff result"]') || document.querySelector('.transaction-plan-error'))`,
  )
  const error = await evaluate(
    cdp,
    `document.querySelector('.transaction-plan-error')?.innerText || ''`,
  )
  if (error) throw new Error(`Live transaction handoff failed: ${error}`)
}

async function setInput(cdp, id, value) {
  await evaluate(cdp, `(() => {
    const input = document.getElementById(${JSON.stringify(id)})
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
}

async function clickHandoff(cdp) {
  const clicked = await evaluate(cdp, `(() => {
    const button = Array.from(document.querySelectorAll('.guardian-handoff button'))
      .find((candidate) => candidate.textContent.includes('Prepare transaction handoff'))
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error('Transaction handoff button was not ready')
}

async function switchStatusMode(cdp, mode) {
  const switched = await evaluate(cdp, `(() => {
    const input = document.querySelector('.status-mode input[name="status-mode"][value="${mode}"]')
    if (!input) return false
    if (!input.checked) input.click()
    return true
  })()`)
  if (!switched) throw new Error(`Status lookup mode not found: ${mode}`)
  const expected = mode === 'tx'
    ? `Boolean(document.getElementById("status-tx"))`
    : `Boolean(document.getElementById("status-requestId"))`
  await waitFor(cdp, expected)
}

async function clickStatusLookup(cdp) {
  await waitFor(
    cdp,
    `Boolean(Array.from(document.querySelectorAll('.status-tracker button')).find((candidate) => candidate.textContent.includes('Check request status') && !candidate.disabled))`,
  )
  const clicked = await evaluate(cdp, `(() => {
    const button = Array.from(document.querySelectorAll('.status-tracker button'))
      .find((candidate) => candidate.textContent.includes('Check request status'))
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error('Status lookup button was not ready')
}

async function assertExpression(cdp, expression, message) {
  if (!await evaluate(cdp, expression)) throw new Error(message)
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
