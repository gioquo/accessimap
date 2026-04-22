import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase-server'
import { toRad, offsetPoint, bearingTo, distanceMeters, pitchForDist } from '@/lib/geo'
import { queryOverpass } from '@/lib/overpass'
import { rateLimit } from '@/lib/rate-limit'

// ════════════════════════════════════════════════════
// DIREZIONE STRADALE DA OSM
// Restituisce il bearing della strada che contiene il nodo del crossing.
// ════════════════════════════════════════════════════

async function getRoadBearing(osmId: number | null, lat: number, lng: number): Promise<number | null> {
  if (!osmId) return null
  const query = `[out:json][timeout:8];node(${osmId});way(bn)["highway"];out geom;`
  try {
    const data = await queryOverpass(query, { timeoutMs: 7000 })
    const ways = (data.elements || []).filter(
      (el: any) => el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2
    )
    if (ways.length === 0) return null

    const geom: Array<{ lat: number; lon: number }> = ways[0].geometry

    // Trova il segmento del way più vicino al crossing
    let minDist = Infinity, closestIdx = 0
    for (let i = 0; i < geom.length; i++) {
      const d = distanceMeters(geom[i].lat, geom[i].lon, lat, lng)
      if (d < minDist) { minDist = d; closestIdx = i }
    }
    const i1 = Math.max(0, closestIdx - 1)
    const i2 = Math.min(geom.length - 1, closestIdx + 1)
    if (i1 === i2) return null

    const b = bearingTo(geom[i1].lat, geom[i1].lon, geom[i2].lat, geom[i2].lon)
    console.log(`[Road] osm_id=${osmId} bearing=${b.toFixed(0)}°`)
    return b
  } catch {
    console.log(`[Road] osm_id=${osmId} — bearing non trovato`)
    return null
  }
}

// ════════════════════════════════════════════════════
// TIPO IMMAGINE UNIFICATO
// ════════════════════════════════════════════════════

interface AnalysisImage {
  data: string
  mimeType: string
  url: string
  description: string
  source: 'satellite' | 'streetview' | 'mapillary' | 'custom'
}

// ════════════════════════════════════════════════════
// 1. IMMAGINI SATELLITARI
//
// Strategia a cascata:
//   A) Google Maps Static API (zoom 20+19) — qualità massima, richiede
//      "Maps Static API" abilitata su Google Cloud Console (stessa chiave)
//   B) Esri World Imagery export — fallback automatico, GRATUITO, no API key,
//      stesso servizio già usato per i tile della mappa in MapClient.tsx.
//      URL export: /MapServer/export?bbox=lng1,lat1,lng2,lat2&...&f=image
//
// Con Esri specifichiamo una bbox in metri attorno al crossing:
//   - dettaglio: raggio 25m → 50×50m → ~12px/m a 640px (vede rampe da 80cm)
//   - contesto:  raggio 55m → 110×110m → mostra l'incrocio completo
// ════════════════════════════════════════════════════

function buildGoogleSatelliteUrl(lat: number, lng: number, zoom: number): string {
  const key = process.env.GOOGLE_STREETVIEW_KEY
  return (
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?center=${lat},${lng}&zoom=${zoom}&size=640x640&maptype=satellite&key=${key}`
  )
}

function buildEsriSatelliteUrl(lat: number, lng: number, radiusMeters: number): string {
  // Converte metri in gradi alla latitudine corrente
  const dLat = radiusMeters / 111320
  const dLng = radiusMeters / (111320 * Math.cos(toRad(lat)))
  const bbox = `${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat}`
  return (
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export` +
    `?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=640,640&format=jpg&f=image`
  )
}

async function fetchSatelliteImages(lat: number, lng: number): Promise<AnalysisImage[]> {
  // Tenta Google Maps Static API (massima qualità)
  try {
    const [img20, img19] = await Promise.all([
      imageToBase64(buildGoogleSatelliteUrl(lat, lng, 20)),
      imageToBase64(buildGoogleSatelliteUrl(lat, lng, 19)),
    ])
    console.log('[Satellite] Google OK')
    return [
      { ...img20, url: buildGoogleSatelliteUrl(lat, lng, 20), description: 'Satellite Google zoom 20 — dettaglio crossing', source: 'satellite' as const },
      { ...img19, url: buildGoogleSatelliteUrl(lat, lng, 19), description: 'Satellite Google zoom 19 — contesto area',      source: 'satellite' as const },
    ]
  } catch (e) {
    console.log('[Satellite] Google fallisce (Maps Static API non abilitata?), uso Esri:', (e as Error).message)
  }

  // Fallback Esri World Imagery — gratuito, no API key richiesta
  const esriConfigs = [
    { radius: 25, desc: 'Satellite Esri dettaglio (~50m area, ~12px/m — vede rampe e piastrelle tattili)' },
    { radius: 55, desc: 'Satellite Esri contesto (~110m area — incrocio completo e sensi di marcia)' },
  ]
  const images: AnalysisImage[] = []
  for (const { radius, desc } of esriConfigs) {
    const url = buildEsriSatelliteUrl(lat, lng, radius)
    try {
      const img = await imageToBase64(url)
      images.push({ ...img, url, description: desc, source: 'satellite' as const })
      console.log(`[Satellite] Esri r${radius}m OK`)
    } catch (e) {
      console.log(`[Satellite] Esri r${radius}m err:`, (e as Error).message)
    }
  }
  return images
}

// ════════════════════════════════════════════════════
// 2. GOOGLE STREET VIEW
// ════════════════════════════════════════════════════

interface PanoInfo { lat: number; lng: number; pano_id: string }

async function getStreetViewPano(lat: number, lng: number, radius: number): Promise<PanoInfo | null> {
  const key = process.env.GOOGLE_STREETVIEW_KEY
  const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&radius=${radius}&source=outdoor&key=${key}`
  try {
    const res = await fetch(url)
    const data = await res.json()
    if (data.status !== 'OK') return null
    return { lat: data.location.lat, lng: data.location.lng, pano_id: data.pano_id }
  } catch { return null }
}

function buildStreetViewUrl(pano_id: string, heading: number, pitch: number, fov = 75): string {
  const key = process.env.GOOGLE_STREETVIEW_KEY
  return (
    `https://maps.googleapis.com/maps/api/streetview` +
    `?size=640x640&pano=${pano_id}&heading=${heading.toFixed(1)}&fov=${fov}&pitch=${pitch}&key=${key}`
  )
}

// Genera immagini Street View ottimizzate per vedere le rampe.
//
// Geometria corretta:
//   roadBearing = direzione della strada (es. 90° = E-O)
//   crossing direction = roadBearing ± 90° = direzione perpendicolare alla strada
//   Le strisce corrono nella crossing direction
//
//   SHOT PRIMARI (crossing direction, rb+90° e rb+270°):
//   = "dal centro delle strisce, prima da una parte poi dall'altra"
//   = zona garantita car-free (auto non possono stare sulle strisce)
//   = cordolo lontano visibile in prospettiva: salita graduale = rampa, muro = gradino
//
//   SHOT SECONDARI (road direction, rb e rb+180°):
//   = contesto della strada, visuale simile a quella del conducente
//
// STEP 1: Trova il pano più vicino al crossing (è il pano "sul crossing")
//         e genera 4 shot da esso.
// STEP 2: Cerca pano sulla strada (lungo road direction) per secondo angolo.
// STEP 3: Fallback raggio largo se tutto fallisce.
async function fetchStreetViewImages(
  targetLat: number,
  targetLng: number,
  roadBearing: number | null
): Promise<AnalysisImage[]> {
  const images: AnalysisImage[] = []
  const seenPanos = new Set<string>()
  const rb = ((roadBearing ?? 0) + 360) % 360  // normalizza, default 0° se non noto

  // ── STEP 1: pano principale (sul / vicino al crossing) ──
  const mainPano = await getStreetViewPano(targetLat, targetLng, 22)
  if (mainPano) {
    seenPanos.add(mainPano.pano_id)
    const dist = distanceMeters(mainPano.lat, mainPano.lng, targetLat, targetLng)
    console.log(`[SV] main pano dist=${Math.round(dist)}m, pano=${mainPano.pano_id}`)

    // Solo crossing direction: "da una parte e dall'altra delle strisce"
    // Road direction shots rimossi — erano inutili (mostravano la strada, non il cordolo)
    const shots = [
      { h: (rb + 90) % 360,  pitch: -10, fov: 85, label: `crossing dir. A (verso cordolo A), dist=${Math.round(dist)}m` },
      { h: (rb + 270) % 360, pitch: -10, fov: 85, label: `crossing dir. B (verso cordolo B), dist=${Math.round(dist)}m` },
    ]
    for (const { h, pitch, fov, label } of shots) {
      if (images.length >= 4) break
      const url = buildStreetViewUrl(mainPano.pano_id, h, pitch, fov)
      try {
        const img = await imageToBase64(url)
        images.push({ ...img, url, description: `Street View ${label}`, source: 'streetview' })
      } catch (e) { console.log('[SV] fetch err:', (e as Error).message) }
    }
  }

  // ── STEP 2: pano secondario sulla strada (se disponibile) ──
  // Cerca lungo la road direction per avere un secondo punto di vista
  if (images.length < 4) {
    for (const dist of [10, 18]) {
      for (const b of [rb, (rb + 180) % 360]) {
        if (images.length >= 4) break
        const p = offsetPoint(targetLat, targetLng, dist, b)
        const pano2 = await getStreetViewPano(p.lat, p.lng, 9)
        if (!pano2 || seenPanos.has(pano2.pano_id)) continue
        seenPanos.add(pano2.pano_id)
        const d2 = distanceMeters(pano2.lat, pano2.lng, targetLat, targetLng)
        const heading = bearingTo(pano2.lat, pano2.lng, targetLat, targetLng)
        const url = buildStreetViewUrl(pano2.pano_id, heading, 0, 85)
        try {
          const img = await imageToBase64(url)
          images.push({ ...img, url, description: `Street View da strada dist=${Math.round(d2)}m`, source: 'streetview' })
        } catch (e) { console.log('[SV]', (e as Error).message) }
      }
    }
  }

  // ── STEP 3: fallback raggio largo ──
  if (images.length === 0) {
    const fallback = await getStreetViewPano(targetLat, targetLng, 80)
    if (fallback && !seenPanos.has(fallback.pano_id)) {
      const heading = bearingTo(fallback.lat, fallback.lng, targetLat, targetLng)
      const url = buildStreetViewUrl(fallback.pano_id, heading, 0, 90)
      try {
        const img = await imageToBase64(url)
        images.push({ ...img, url, description: 'Street View fallback raggio largo', source: 'streetview' })
      } catch (e) { console.log('[SV fallback]', (e as Error).message) }
    }
  }

  console.log(`[SV] total: ${images.length} images`)
  return images
}

// ════════════════════════════════════════════════════
// 3. KARTAVIEW (ex OpenStreetCam) — GRATUITO, nessun token
// Community open source, spesso scattato a piedi o in bici.
// API pubblica, nessuna API key richiesta.
// ════════════════════════════════════════════════════

async function fetchKartaViewImages(lat: number, lng: number): Promise<AnalysisImage[]> {
  try {
    const url = `https://api.kartaview.org/2.0/photo/list/?lat=${lat}&lng=${lng}&radius=60&ipp=5`
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } })
    if (!res.ok) return []
    const data = await res.json()
    const photos = (data.result?.data || [])
      .filter((p: any) => p.thumb_name || p.name)
      .slice(0, 2)
    const images: AnalysisImage[] = []
    for (const photo of photos) {
      const imgUrl = photo.thumb_name
        ? `https://kartaview.org${photo.thumb_name}`
        : `https://kartaview.org${photo.name}`
      try {
        const img = await imageToBase64(imgUrl)
        images.push({ ...img, url: imgUrl, description: 'KartaView (community, a piedi/bici)', source: 'mapillary' as const })
      } catch {}
    }
    if (images.length > 0) console.log(`[KartaView] ${images.length} images`)
    return images
  } catch (e) {
    console.log('[KartaView] err:', (e as Error).message)
    return []
  }
}

// ════════════════════════════════════════════════════
// 4. MAPILLARY (immagini pedoni/ciclisti)
// Spesso scattate a livello del marciapiede — angolazione ideale per vedere
// le rampe. Usato come integratore quando satellite o SV non bastano.
// Richiede MAPILLARY_TOKEN in .env.local e su Vercel Dashboard.
// ════════════════════════════════════════════════════

async function fetchMapillaryImages(lat: number, lng: number): Promise<AnalysisImage[]> {
  const token = process.env.MAPILLARY_TOKEN
  if (!token) return []
  try {
    const delta = 0.0008
    const bbox = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`
    const url = `https://graph.mapillary.com/images?access_token=${token}&fields=id,thumb_1024_url&bbox=${bbox}&limit=4`
    const res = await fetch(url)
    const data = await res.json()
    const items = (data.data || []).filter((img: any) => img.thumb_1024_url).slice(0, 2)
    const images: AnalysisImage[] = []
    for (const item of items) {
      try {
        const img = await imageToBase64(item.thumb_1024_url)
        images.push({ ...img, url: item.thumb_1024_url, description: 'Mapillary (vista pedone/ciclista)', source: 'mapillary' })
      } catch {}
    }
    if (images.length > 0) console.log(`[Mapillary] ${images.length} images`)
    return images
  } catch (e) {
    console.log('[Mapillary] err:', (e as Error).message)
    return []
  }
}

// ════════════════════════════════════════════════════
// UTILITY
// ════════════════════════════════════════════════════

async function imageToBase64(url: string) {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`fetch ${res.status}: ${body.slice(0, 100)}`)
  }
  const buf = await res.arrayBuffer()
  return {
    data: Buffer.from(buf).toString('base64'),
    mimeType: res.headers.get('content-type') || 'image/jpeg',
  }
}

// ════════════════════════════════════════════════════
// GEMINI API
// ════════════════════════════════════════════════════

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']

async function callGemini(prompt: string, images: Array<{ data: string; mimeType: string }>): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured')

  const parts: any[] = [{ text: prompt }]
  for (const img of images) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } })
  }
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4000 },
  })

  let lastError: any = null
  for (const model of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[Gemini] ${model} attempt ${attempt}, ${images.length} imgs`)
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        if (res.status === 503 || res.status === 429) {
          lastError = new Error(`${model} overloaded`)
          await new Promise(r => setTimeout(r, attempt * 2000))
          continue
        }
        if (!res.ok) {
          lastError = new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`)
          break
        }
        const data = await res.json()
        const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || ''
        if (text) { console.log(`[Gemini] ✓ ${model}`); return text }
        lastError = new Error('Empty response')
      } catch (err: any) { lastError = err }
    }
  }
  throw lastError || new Error('All Gemini models failed')
}

// ════════════════════════════════════════════════════
// PIPELINE PRINCIPALE
// ════════════════════════════════════════════════════

// Helper: valida e parsea un crossingId da request body o query
function parseCrossingId(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

// GET /api/analyze?crossingId=X — lettura SOLO della cache, NON triggera analisi.
// Usato dal frontend al click su un punto: niente spreco API se l'analisi
// esiste già in DB. Ritorna 404 se non c'è cache.
export async function GET(req: NextRequest) {
  const rl = rateLimit(req, 'analyze-get', 120, 60_000)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Troppe richieste' }, { status: 429 })
  }

  const { searchParams } = new URL(req.url)
  const crossingId = parseCrossingId(searchParams.get('crossingId'))
  if (!crossingId) return NextResponse.json({ error: 'crossingId non valido' }, { status: 400 })

  const [{ data: crossing }, { data: existing }] = await Promise.all([
    supabaseServer.from('crossings').select('*').eq('id', crossingId).single(),
    supabaseServer.from('ai_analyses').select('*').eq('crossing_id', crossingId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  if (!crossing) return NextResponse.json({ error: 'crossing not found' }, { status: 404 })
  if (!existing) return NextResponse.json({ cached: false, crossing, imageUrls: [] }, { status: 200 })

  const cachedUrls: string[] = existing.image_urls || (existing.image_url ? [existing.image_url] : [])
  return NextResponse.json({ cached: true, analysis: existing, crossing, imageUrls: cachedUrls })
}

export async function POST(req: NextRequest) {
  // Rate limit aggressivo: ogni POST consuma Gemini + Google + Esri/Overpass
  const rl = rateLimit(req, 'analyze-post', 20, 60_000)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Troppe analisi, riprova tra poco' }, { status: 429 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const crossingId = parseCrossingId(body.crossingId)
    if (!crossingId) return NextResponse.json({ error: 'crossingId non valido' }, { status: 400 })

    const force = !!body.force
    const customImages = body.customImages
    const extraImages: Array<{ data: string; mimeType: string }> = Array.isArray(customImages)
      ? customImages.filter((i: any) => typeof i?.data === 'string' && typeof i?.mimeType === 'string').slice(0, 5)
      : []

    // 1. Crossing
    const { data: crossing, error: crossErr } = await supabaseServer
      .from('crossings').select('*').eq('id', crossingId).single()
    if (crossErr || !crossing) return NextResponse.json({ error: 'crossing not found' }, { status: 404 })

    // 2. Cache (saltata se force=true)
    if (!force) {
      const { data: existing } = await supabaseServer
        .from('ai_analyses').select('*').eq('crossing_id', crossingId)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (existing) {
        const cachedUrls: string[] = existing.image_urls || (existing.image_url ? [existing.image_url] : [])
        return NextResponse.json({ cached: true, analysis: existing, crossing, imageUrls: cachedUrls })
      }
    }

    const { lat, lng } = crossing
    console.log(`[Analyze] crossing ${crossingId} at (${lat}, ${lng})`)

    // 3. Satellite + direzione stradale OSM in parallelo (nessuna dipendenza tra loro)
    const [satImages, roadBearing] = await Promise.all([
      fetchSatelliteImages(lat, lng),
      getRoadBearing(crossing.osm_id, lat, lng),
    ])

    // Street View posizionato con direzione stradale precisa (o fallback 8-dir)
    const svImages = await fetchStreetViewImages(lat, lng, roadBearing)

    // Fallback community: Mapillary + KartaView in parallelo se le prime due fonti
    // danno meno di 3 immagini (spesso scattate da pedoni/ciclisti = angolazione utile)
    const fallbackImages: AnalysisImage[] = (satImages.length + svImages.length < 3)
      ? await Promise.all([fetchMapillaryImages(lat, lng), fetchKartaViewImages(lat, lng)])
          .then(([m, k]) => [...m, ...k].slice(0, 2))
      : []

    // 4. Immagini custom dell'utente (screenshot manuali)
    const customAnalysisImages: AnalysisImage[] = extraImages.map((img, i) => ({
      ...img,
      url: '',
      description: `Screenshot manuale utente #${i + 1}`,
      source: 'custom' as const,
    }))

    // Ordine finale: satellite → street view → community fallback → custom
    const allImages: AnalysisImage[] = [
      ...satImages,
      ...svImages,
      ...fallbackImages,
      ...customAnalysisImages,
    ]

    console.log(`[Analyze] images: ${satImages.length} sat + ${svImages.length} sv + ${fallbackImages.length} community + ${extraImages.length} custom = ${allImages.length}`)

    const imageUrls = allImages.map(img => img.url).filter(Boolean)

    // 5. Prompt
    let prompt: string

    if (allImages.length > 0) {
      const imgList = allImages
        .map((img, i) => `  Immagine ${i + 1} [${img.source.toUpperCase()}]: ${img.description}`)
        .join('\n')

      const satCount = satImages.length
      const roadInfo = roadBearing !== null
        ? `Direzione strada: ${roadBearing.toFixed(0)}° — le immagini Street View guardano perpendicolarmente verso le rampe.`
        : `Direzione strada: non determinata — immagini da direzioni multiple.`
      const osmTags = crossing.osm_tags || {}
      const osmNote = (() => {
        if (osmTags.kerb === 'lowered' || osmTags.kerb === 'flush')
          return '⚠️ OSM segnala kerb=lowered: possibile rampa, ma VERIFICA visivamente — i dati OSM possono essere obsoleti.'
        if (osmTags.kerb === 'raised' || osmTags.kerb === 'no')
          return '⚠️ OSM segnala kerb=raised: probabilmente NESSUNA rampa. Sii molto scettico verso "Accessibile".'
        if (osmTags.tactile_paving === 'yes')
          return '⚠️ OSM segnala tactile_paving=yes: probabilmente presente accessibilità.'
        return `Dati OSM: ${JSON.stringify(osmTags)}`
      })()

      prompt = `Sei un esperto di accessibilità urbana. Valuta se l'attraversamento pedonale a Roma (${lat.toFixed(5)}, ${lng.toFixed(5)}) è accessibile a persone in carrozzina o con passeggino.

${osmNote}
${roadInfo}

Hai ${allImages.length} immagini da fonti diverse:
${imgList}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COME LEGGERE LE IMMAGINI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${satCount > 0 ? `🛰️ SATELLITARI (prime ${satCount} immagini) — vista dall'alto:
  • Strisce bianche orizzontali = le strisce pedonali del crossing
  • Cerca una "tacca" o discontinuità nel bordo del marciapiede dove finiscono le strisce
  • Piastrelle gialle/arancioni = pavimentazione tattile (forte indicatore di rampa)
  • Bordo rettilineo continuo senza interruzioni = nessuna rampa (gradino verticale)
  • Attenzione: angoli arrotondati del selciato NON sono rampe accessibili

` : ''}🏙️ STREET VIEW — come leggere la prospettiva:
  • Alcune immagini sono scattate SUL crossing guardando LUNGO la strada
    (le strisce corrono ai lati, il cordolo lontano è in fondo all'inquadratura)
  • In questa prospettiva: se c'è una RAMPA vedi il piano stradale che sale
    gradualmente verso il livello del marciapiede nel punto lontano.
    Se c'è un GRADINO vedi una transizione brusca verticale in fondo.
  • Altre immagini guardano di LATO al cordolo: vedi direttamente la faccia
    verticale (gradino) o la superficie inclinata (rampa).
  • Auto sulla strada NON invalidano la valutazione se il cordolo è visibile
    oltre o tra di esse. Le auto NON possono essere sulle strisce pedonali.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DEFINIZIONI — COSA COSTITUISCE UNA RAMPA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ RAMPA VALIDA: superficie inclinata, larga ≥ 80 cm, che porta il piano stradale
   al livello del marciapiede senza gradini. Deve essere chiaramente percorribile
   da una carrozzina.

❌ NON SONO RAMPE:
  • Angoli smussati del selciato o bordure arrotondate
  • Abbassamento del cordolo solo su un angolo (< 50 cm larghezza)
  • Accessi privati (garage, cancelli, negozi)
  • Qualsiasi gradino, anche piccolo

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROCEDURA OBBLIGATORIA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. IDENTIFICA il crossing: in quale/i immagine/i vedi le strisce pedonali bianche?
2. ESAMINA i bordi: per ogni lato dell'attraversamento visibile, descrivi ESATTAMENTE
   cosa vedi — "gradino verticale di ~X cm" oppure "superficie inclinata larga ~Y cm"
3. VERDETTO CAUTELATIVO: dubbio tra 🟢 e 🟡 → scegli 🟡.
   Dubbio tra 🟡 e 🔴 → scegli 🟡. MAI 🟢 se hai meno del 90% di certezza.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FORMATO RISPOSTA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**Crossing identificato**: [immagine/i dove sono visibili le strisce]
**Screening**: [immagini utili vs scartate e perché]
**Cosa vedo**: [descrizione PRECISA del profilo del cordolo con misure stimate]
**Rampa presente**: Sì (chiaramente, ≥80cm, praticabile) / Parziale / No / Non visibile
**Qualità manto**: Buona / Deteriorata / Parziale / Non valutabile
**Ostacoli permanenti**: [lista o "nessuno"]
**Esito**: 🟢 Accessibile / 🟡 Parzialmente accessibile / 🔴 Non accessibile / ⚪ Non determinabile

REGOLA ASSOLUTA: < 2 immagini utili → ⚪. Dubbio → esito più cautelativo.`
    } else {
      prompt = `Attraversamento pedonale a Roma (${lat.toFixed(5)}, ${lng.toFixed(5)}).
Nessuna immagine disponibile da nessuna fonte (satellite, Street View, Mapillary).
Dati OSM: ${JSON.stringify(crossing.osm_tags)}
**Esito**: ⚪ Non determinabile`
    }

    // 6. Gemini
    const geminiInputs = allImages.map(({ data, mimeType }) => ({ data, mimeType }))
    const aiResponse = await callGemini(prompt, geminiInputs)

    // 7. Verdetto
    let verdict: 'ok' | 'bad' | 'partial' | 'unknown' = 'unknown'
    if (aiResponse.includes('🟢')) verdict = 'ok'
    else if (aiResponse.includes('🔴')) verdict = 'bad'
    else if (aiResponse.includes('🟡')) verdict = 'partial'
    else if (aiResponse.includes('⚪')) verdict = 'unknown'

    // 8. Salva
    const { data: savedAnalysis } = await supabaseServer
      .from('ai_analyses')
      .insert({
        crossing_id: crossingId,
        image_url: imageUrls[0] || null,
        image_urls: imageUrls,
        ai_verdict: verdict,
        ai_full_response: aiResponse,
        model_used: 'gemini-multimodal',
      })
      .select().single()

    await supabaseServer.from('crossings').update({ status: verdict }).eq('id', crossingId)

    console.log(`[Analyze] ✓ ${crossingId} → ${verdict} (${allImages.length} imgs total)`)
    return NextResponse.json({
      cached: false,
      analysis: savedAnalysis,
      crossing: { ...crossing, status: verdict },
      imagesUsed: allImages.length,
      imageUrls,
    })
  } catch (err: any) {
    console.error('[Analyze] Error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// Override manuale del verdetto da parte dell'utente
export async function PATCH(req: NextRequest) {
  const rl = rateLimit(req, 'analyze-patch', 60, 60_000)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Troppe richieste' }, { status: 429 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const crossingId = parseCrossingId(body.crossingId)
    const verdict = body.verdict
    const VALID = ['ok', 'bad', 'partial', 'unknown'] as const
    if (!crossingId || typeof verdict !== 'string' || !VALID.includes(verdict as any)) {
      return NextResponse.json({ error: 'params invalidi' }, { status: 400 })
    }
    await supabaseServer.from('crossings').update({ status: verdict }).eq('id', crossingId)
    await supabaseServer.from('ai_analyses').insert({
      crossing_id: crossingId,
      image_url: null,
      image_urls: [],
      ai_verdict: verdict,
      ai_full_response: `Verdetto impostato manualmente: ${verdict}`,
      model_used: 'manual',
    })
    console.log(`[Analyze] Manual override ${crossingId} → ${verdict}`)
    return NextResponse.json({ ok: true, verdict })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
