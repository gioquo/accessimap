import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase-server'

// ════════════════════════════════════════════════════
// UTILITIES GEOGRAFICHE
// ════════════════════════════════════════════════════

function toRad(deg: number) { return (deg * Math.PI) / 180 }
function toDeg(rad: number) { return (rad * 180) / Math.PI }

function offsetPoint(lat: number, lng: number, distM: number, bearingDeg: number) {
  const R = 6371000
  const brng = toRad(bearingDeg)
  const latR = toRad(lat); const lngR = toRad(lng)
  const dR = distM / R
  const newLat = Math.asin(Math.sin(latR) * Math.cos(dR) + Math.cos(latR) * Math.sin(dR) * Math.cos(brng))
  const newLng = lngR + Math.atan2(Math.sin(brng) * Math.sin(dR) * Math.cos(latR), Math.cos(dR) - Math.sin(latR) * Math.sin(newLat))
  return { lat: toDeg(newLat), lng: toDeg(newLng) }
}

function bearingTo(lat1: number, lng1: number, lat2: number, lng2: number) {
  const dLng = toRad(lng2 - lng1)
  const y = Math.sin(dLng) * Math.cos(toRad(lat2))
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000
  const dLat = toRad(lat2 - lat1); const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Pitch fisico: arctan(altezza camera / distanza) = angolo per puntare al suolo alla distanza target
function pitchForDist(dist: number) {
  return -Math.round(Math.atan2(1.4, Math.max(dist, 3)) * 180 / Math.PI)
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

// Recupera immagini Street View ottimizzate per vedere il PROFILO del cordolo.
//
// Principio chiave: per distinguere gradino (no rampa) da rampa inclinata
// bisogna vedere il LATO del cordolo, non la superficie dall'alto.
// → Pitch quasi orizzontale (0°) da road level mostra chiaramente il profilo.
// → Pitch -50° dal crossing mostra solo sanpietrini/asfalto = AI si confonde.
//
// Ordine ricerca: 8 direzioni a 12m → 4 cardinali a 22m → fallback raggio largo.
// Panorami sul crossing (dist<5m) usati SOLO se non si trova nient'altro, con pitch -10°.
async function fetchStreetViewImages(targetLat: number, targetLng: number): Promise<AnalysisImage[]> {
  const images: AnalysisImage[] = []
  const seenPanos = new Set<string>()

  // Cerca pani SULLA STRADA (offset dal crossing) — dà la vista "pedone che si avvicina"
  // 8 direzioni a 12m (ogni 45°) + 4 cardinali a 22m + fallback sul crossing
  const searchPoints: Array<{ lat: number; lng: number; radius: number }> = []
  for (const angle of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const p = offsetPoint(targetLat, targetLng, 12, angle)
    searchPoints.push({ lat: p.lat, lng: p.lng, radius: 12 })
  }
  for (const angle of [0, 90, 180, 270]) {
    const p = offsetPoint(targetLat, targetLng, 22, angle)
    searchPoints.push({ lat: p.lat, lng: p.lng, radius: 15 })
  }
  searchPoints.push({ lat: targetLat, lng: targetLng, radius: 80 }) // fallback

  for (const sp of searchPoints) {
    if (images.length >= 4) break

    const pano = await getStreetViewPano(sp.lat, sp.lng, sp.radius)
    if (!pano || seenPanos.has(pano.pano_id)) continue
    seenPanos.add(pano.pano_id)

    const dist = distanceMeters(pano.lat, pano.lng, targetLat, targetLng)
    const heading = bearingTo(pano.lat, pano.lng, targetLat, targetLng)

    // Pitch orizzontale o leggermente negativo: mostra il PROFILO del cordolo
    // (gradino verticale vs superficie inclinata) invece della superficie dall'alto
    const pitch = dist < 5 ? -10 : 0

    // Dal primo pano: 3 shot (frontale wide + lato sx + lato dx)
    // Dai pani successivi: 1 shot frontale per avere un secondo punto di vista
    const cuts = images.length === 0
      ? [
          { ho: 0,   fov: 80, label: `frontale da ${Math.round(dist)}m (vede profilo cordolo)` },
          { ho: -35, fov: 65, label: `lato sx da ${Math.round(dist)}m` },
          { ho: 35,  fov: 65, label: `lato dx da ${Math.round(dist)}m` },
        ]
      : [{ ho: 0, fov: 80, label: `frontale da ${Math.round(dist)}m (secondo angolo)` }]

    for (const { ho, fov, label } of cuts) {
      if (images.length >= 4) break
      const h = (heading + ho + 360) % 360
      const url = buildStreetViewUrl(pano.pano_id, h, pitch, fov)
      try {
        const img = await imageToBase64(url)
        images.push({ ...img, url, description: `Street View ${label}, pitch ${pitch}°`, source: 'streetview' })
      } catch (e) { console.log('[SV]', (e as Error).message) }
    }
  }

  return images
}

// ════════════════════════════════════════════════════
// 3. MAPILLARY (immagini pedoni/ciclisti)
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
    generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
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

export async function POST(req: NextRequest) {
  try {
    const { crossingId, force, customImages } = await req.json()
    if (!crossingId) return NextResponse.json({ error: 'crossingId required' }, { status: 400 })

    const extraImages: Array<{ data: string; mimeType: string }> = Array.isArray(customImages) ? customImages : []

    // 1. Crossing
    const { data: crossing, error: crossErr } = await supabaseServer
      .from('crossings').select('*').eq('id', crossingId).single()
    if (crossErr || !crossing) return NextResponse.json({ error: 'crossing not found' }, { status: 404 })

    // 2. Cache
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

    // 3. Raccolta immagini — tre fonti in parallelo
    const [satImages, svImages] = await Promise.all([
      fetchSatelliteImages(lat, lng),
      fetchStreetViewImages(lat, lng),
    ])

    // Mapillary solo se le prime due fonti danno meno di 3 immagini utili
    const mlyImages = (satImages.length + svImages.length < 3)
      ? await fetchMapillaryImages(lat, lng)
      : []

    // 4. Immagini custom dell'utente (screenshot manuali)
    const customAnalysisImages: AnalysisImage[] = extraImages.map((img, i) => ({
      ...img,
      url: '',
      description: `Screenshot manuale utente #${i + 1}`,
      source: 'custom' as const,
    }))

    // Ordine finale: satellite → street view → mapillary → custom
    const allImages: AnalysisImage[] = [
      ...satImages,
      ...svImages,
      ...mlyImages,
      ...customAnalysisImages,
    ]

    console.log(`[Analyze] images: ${satImages.length} sat + ${svImages.length} sv + ${mlyImages.length} mly + ${extraImages.length} custom = ${allImages.length}`)

    const imageUrls = allImages.map(img => img.url).filter(Boolean)

    // 5. Prompt
    let prompt: string

    if (allImages.length > 0) {
      const imgList = allImages
        .map((img, i) => `  Immagine ${i + 1} [${img.source.toUpperCase()}]: ${img.description}`)
        .join('\n')

      const satCount = satImages.length
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

` : ''}🏙️ STREET VIEW (pitch ≈ 0°, vista quasi orizzontale da road level):
  • Le immagini sono scattate dalla STRADA guardando verso il marciapiede
  • Con pitch quasi orizzontale vedi il PROFILO LATERALE del cordolo:
    - Gradino verticale (5-20 cm) = nessuna rampa → 🔴
    - Superficie che sale gradualmente dal piano strada = rampa → 🟢
    - Superficie parzialmente abbassata o un solo lato = parziale → 🟡
  • NON confondere: curve del selciato, bordure, angoli smussati con rampe praticabili
  • NON confondere: accessi a garage/cancelli privati con rampe pedonali pubbliche

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

// Override manuale del verdetto
export async function PATCH(req: NextRequest) {
  try {
    const { crossingId, verdict } = await req.json()
    if (!crossingId || !['ok', 'bad', 'partial', 'unknown'].includes(verdict)) {
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
