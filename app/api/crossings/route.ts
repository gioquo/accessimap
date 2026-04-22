import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase-server'

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
]

async function queryOverpass(query: string): Promise<any> {
  let lastError: any = null

  for (const endpoint of OVERPASS_ENDPOINTS) {
    // Piccola pausa tra tentativi per evitare rate limit a catena
    if (lastError) await new Promise((r) => setTimeout(r, 500))

    try {
      console.log(`[Overpass] Trying ${endpoint}`)

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 30000)

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'AccessiMap/1.0 (accessibility-mapping-project)',
          Accept: 'application/json',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!res.ok) {
        console.log(`[Overpass] ${endpoint} returned status ${res.status}`)
        lastError = new Error(`Status ${res.status}`)
        continue
      }

      const data = await res.json()
      console.log(
        `[Overpass] Success from ${endpoint}, got ${data.elements?.length || 0} elements`
      )
      return data
    } catch (err: any) {
      console.log(`[Overpass] ${endpoint} failed:`, err.message)
      lastError = err
    }
  }

  throw lastError || new Error('All Overpass endpoints failed')
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const lat = parseFloat(searchParams.get('lat') || '')
  const lng = parseFloat(searchParams.get('lng') || '')
  const radius = parseInt(searchParams.get('radius') || '500')

  if (isNaN(lat) || isNaN(lng)) {
    return NextResponse.json({ error: 'lat/lng required' }, { status: 400 })
  }

  const { data: cached, error: cacheErr } = await supabaseServer.rpc(
    'crossings_within_radius',
    {
      center_lat: lat,
      center_lng: lng,
      radius_meters: radius,
    }
  )

  if (cacheErr) {
    console.error('[DB] Cache error:', cacheErr)
    return NextResponse.json({ error: cacheErr.message }, { status: 500 })
  }

  console.log(`[DB] Cached crossings in radius: ${cached?.length || 0}`)

  // Se abbiamo già dati in cache, usiamo quelli e tentiamo refresh solo in background
  if (cached && cached.length > 0) {
    return NextResponse.json({ crossings: cached, source: 'cache' })
  }

  // Nessuna cache → forziamo fetch da Overpass
  const query = `[out:json][timeout:25];(
    node["highway"="crossing"](around:${radius},${lat},${lng});
    node["crossing"="uncontrolled"](around:${radius},${lat},${lng});
    node["crossing"="traffic_signals"](around:${radius},${lat},${lng});
  );out body;`

  try {
    const osmData = await queryOverpass(query)
    const elements = osmData.elements || []

    if (elements.length > 0) {
      const toInsert = elements.slice(0, 100).map((el: any) => {
        const tags = el.tags || {}

        return {
          osm_id: el.id,
          lat: el.lat,
          lng: el.lon,
          name: tags.name || tags['addr:street'] || null,
          osm_tags: tags,
          status: 'unknown', // tutti i punti richiedono verifica visiva AI
        }
      })

      const { error: upsertErr } = await supabaseServer
        .from('crossings')
        .upsert(toInsert, { onConflict: 'osm_id', ignoreDuplicates: true })

      if (upsertErr) console.error('[DB] Upsert error:', upsertErr)
      else console.log(`[DB] Upserted ${toInsert.length} crossings`)
    }

    const { data: final } = await supabaseServer.rpc('crossings_within_radius', {
      center_lat: lat,
      center_lng: lng,
      radius_meters: radius,
    })

    console.log(`[DB] Returning ${final?.length || 0} crossings`)
    return NextResponse.json({ crossings: final || [], source: 'fresh' })
  } catch (err: any) {
    console.error('[Overpass] All endpoints failed:', err.message)
    return NextResponse.json({
      crossings: [],
      warning: 'OSM temporarily unavailable. Retry in 1 minute.',
      details: err.message,
    })
  }
}