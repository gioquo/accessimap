// Rate limiter in-memory per route API
// Limita N richieste per IP in una finestra temporale.
// Nota: in serverless ogni instance ha il suo Map → limite per-instance, non globale.
// Per limite globale serve Redis/Upstash. Per ora basta a fermare attacchi banali.

import { NextRequest } from 'next/server'

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

function getClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const realIp = req.headers.get('x-real-ip')
  if (realIp) return realIp
  return 'unknown'
}

export interface RateLimitResult {
  ok: boolean
  remaining: number
  resetAt: number
}

// Pulisce bucket scaduti ogni tanto per non riempire la memoria
let lastCleanup = Date.now()
function maybeCleanup(now: number) {
  if (now - lastCleanup < 60_000) return
  lastCleanup = now
  for (const [key, b] of buckets.entries()) {
    if (b.resetAt < now) buckets.delete(key)
  }
}

export function rateLimit(
  req: NextRequest,
  key: string,
  maxRequests: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now()
  maybeCleanup(now)

  const ip = getClientIp(req)
  const bucketKey = `${key}:${ip}`
  const bucket = buckets.get(bucketKey)

  if (!bucket || bucket.resetAt < now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + windowMs })
    return { ok: true, remaining: maxRequests - 1, resetAt: now + windowMs }
  }

  if (bucket.count >= maxRequests) {
    return { ok: false, remaining: 0, resetAt: bucket.resetAt }
  }

  bucket.count++
  return { ok: true, remaining: maxRequests - bucket.count, resetAt: bucket.resetAt }
}
