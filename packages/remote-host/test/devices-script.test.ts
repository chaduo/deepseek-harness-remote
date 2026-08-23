import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const script = fileURLToPath(new URL('../../../macos/launch-agent/devices.sh', import.meta.url))
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe.skipIf(process.platform !== 'darwin')('device allowlist manager', () => {
  it('refuses to remove the last allowed device', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-devices-test-'))
    temporaryDirectories.push(directory)
    const plist = join(directory, 'remote-host.plist')
    await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DSH_REMOTE_ALLOWED_DEVICE_IDS</key>
    <string>device_phone</string>
  </dict>
</dict>
</plist>
`)

    await expect(execFileAsync('/bin/zsh', [script, 'remove', 'device_phone'], {
      env: { ...process.env, DSH_REMOTE_LAUNCH_AGENT_PLIST: plist },
    })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('refusing to remove the last allowed device'),
    })

    expect(await readFile(plist, 'utf8')).toContain('<string>device_phone</string>')
  })
})
