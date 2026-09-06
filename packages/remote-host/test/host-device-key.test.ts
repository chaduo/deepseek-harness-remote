import { describe, expect, it, vi } from 'vitest'
import { MacKeychainSecretStore } from '../src/keychain.js'
import type { SecretStore } from '../src/keychain.js'
import { ensureHostDeviceKey, fingerprint } from '../src/host-device-key.js'

class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>()

  async setSecret(account: string, secret: string): Promise<void> {
    this.values.set(account, secret)
  }

  async getSecret(account: string): Promise<string | undefined> {
    return this.values.get(account)
  }

  async deleteSecret(account: string): Promise<void> {
    this.values.delete(account)
  }
}

describe('ensureHostDeviceKey', () => {
  it('creates a key pair, stores only the private key, and is idempotent', async () => {
    const store = new MemorySecretStore()
    const first = await ensureHostDeviceKey(store, 'host_1')
    expect(first.created).toBe(true)
    expect(first.publicKeyPem).toContain('BEGIN PUBLIC KEY')
    expect(first.fingerprint).toBe(fingerprint(first.publicKeyPem))

    const storedPrivateKey = store.values.get('host-device-key:host_1')
    expect(storedPrivateKey).toContain('BEGIN PRIVATE KEY')
    expect(storedPrivateKey).not.toContain('BEGIN PUBLIC KEY')

    const second = await ensureHostDeviceKey(store, 'host_1')
    expect(second.created).toBe(false)
    expect(second.publicKeyPem).toBe(first.publicKeyPem)
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  it('uses a distinct keychain account per host', async () => {
    const store = new MemorySecretStore()
    await ensureHostDeviceKey(store, 'host_a')
    await ensureHostDeviceKey(store, 'host_b')
    expect(store.values.has('host-device-key:host_a')).toBe(true)
    expect(store.values.has('host-device-key:host_b')).toBe(true)
  })

  it.each(['', 'invalid-private-key'])('preserves an invalid existing key: %j', async value => {
    const store = new MemorySecretStore()
    store.values.set('host-device-key:host_1', value)
    const write = vi.spyOn(store, 'setSecret')
    await expect(ensureHostDeviceKey(store, 'host_1')).rejects.toThrow('refusing to replace')
    expect(write).not.toHaveBeenCalled()
    expect(store.values.get('host-device-key:host_1')).toBe(value)
  })

  it('does not write a replacement when Keychain cannot be read', async () => {
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error('read denied'), { code: 36 })
    })
    const store = new MacKeychainSecretStore({ execFile: execFile as never })
    await expect(ensureHostDeviceKey(store, 'host_1')).rejects.toThrow('macOS Keychain read failed')
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile.mock.calls[0]).toEqual([
      '/usr/bin/security',
      ['find-generic-password', '-a', 'host-device-key:host_1', '-s', 'com.dshbox.remote-host', '-w'],
      expect.anything(),
    ])
  })
})
