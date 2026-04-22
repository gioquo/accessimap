import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase-server'
import { queryOverpass } from '@/lib/overpass'
import { isValidLatLng } from '@/lib/geo'
import { rateLimit } from '@/lib/rate-limit'

export async function GET(req: NextRequest) {
  // Rate limit: 60 req/min per IP — protegge Overpass + DB da abuso
  const rl = rateLimit(req, 'crossings', 60, 60_000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Troppe richieste, riprova tra poco.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } }
    )
  }

  const { searchParams } = new URL(req.url)
  const lat = parseFloat(searchParams.get('lat') || '')
  const lng = parseFloat(searchParams.get('lng') || '')
  const radiusRaw = parseInt(searchParams.get('radius') || '500')
  const radius = Math.min(Math.max(radiusRaw, 50), 5000) // clamp 50-5000m

  if (!isValidLatLng(lat, lng)) {
    return NextResponse.json({ error: 'lat/lng non validi' }, { status: 400 })
  }

  const { data: cached, error: cacheErr } = await supabaseServer.rpc('crossings_within_radius', {
    center_lat: lat,
    center_lng: lng,
    radius_meters: radius,
  })

  if (cacheErr) {
    console.error('[DB] Cache error:', cacheErr)
    return NextResponse.json({ error: cacheErr.message }, { status: 500 })
  }

  if (cached && cached.length > 0) {
    return NextResponse.json({ crossings: cached, source: 'cache' })
  }

  // Nessuna cache → fetch da Overpass
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
          status: 'unknown', // tutti richiedono verifica visiva AI
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

    return NextResponse.json({ crossings: final || [], source: 'fresh' })
  } catch (err: any) {
    console.error('[Overpass] All endpoints failed:', err.message)
    return NextResponse.json({
      crossings: [],
      warning: 'OSM temporaneamente non disponibile. Riprova tra un minuto.',
      details: err.message,
    })
  }
}
