const CACHE_NAME = 'dsh-remote-a1-v4'
const APP_SHELL = ['/', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)),
    )),
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)

  // Never cache or emulate API/event traffic.
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then(cache => cache.put('/', copy))
          return response
        })
        .catch(async () => (await caches.match('/')) ?? Response.error()),
    )
    return
  }

  if (request.method === 'GET' && url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(cached => {
        const network = fetch(request).then(response => {
          if (response.ok) {
            const copy = response.clone()
            void caches.open(CACHE_NAME).then(cache => cache.put(request, copy))
          }
          return response
        })
        return cached ?? network
      }),
    )
  }
})

self.addEventListener('push', event => {
  let payload = {}
  try {
    payload = event.data?.json() ?? {}
  } catch {
    payload = { title: 'DSH Remote', body: 'Mac 上有新的任务状态' }
  }

  const title = typeof payload.title === 'string' ? payload.title : 'DSH Remote'
  const body = typeof payload.body === 'string' ? payload.body : '打开任务查看最新状态'
  const tag = typeof payload.tag === 'string' ? payload.tag : 'dsh-remote'
  const rawUrl = typeof payload.url === 'string' ? payload.url : '/'
  let url = '/'
  try {
    const candidate = new URL(rawUrl, self.location.origin)
    if (candidate.origin === self.location.origin) url = `${candidate.pathname}${candidate.search}${candidate.hash}`
  } catch {
    // Keep the notification on the app home page for malformed payloads.
  }

  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    data: { url },
    icon: '/icon.svg',
    badge: '/icon.svg',
    renotify: false,
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const rawUrl = event.notification.data?.url
  const target = typeof rawUrl === 'string' ? new URL(rawUrl, self.location.origin).toString() : self.location.origin
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if ('navigate' in client) await client.navigate(target)
      await client.focus()
      return
    }
    await self.clients.openWindow(target)
  })())
})
