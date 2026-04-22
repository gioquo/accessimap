// Configurazione e helper Overpass API condivisi

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
]

export interface OverpassResult {
  elements?: any[]
  [key: string]: any
}

// Esegue una query Overpass provando endpoint multipli con timeout
export async function queryOverpass(
  query: string,
  options: { timeoutMs?: number; userAgent?: string } = {}
): Promise<OverpassResult> {
  const timeoutMs = options.timeoutMs ?? 25000
  const userAgent = options.userAgent ?? 'AccessiMap/1.0'

  let lastError: any = null
  for (const endpoint of OVERPASS_ENDPOINTS) {
    if (lastError) await new Promise(r => setTimeout(r, 400))

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': userAgent,
          Accept: 'application/json',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        lastError = new Error(`Overpass ${endpoint}: status ${res.status}`)
        continue
      }
      return await res.json()
    } catch (err: any) {
      lastError = err
    }
  }
  throw lastError || new Error('All Overpass endpoints failed')
}
