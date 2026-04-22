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
// 1. GOOGLE MAPS SATELLITE
// Fonte primaria: vista dall'alto, ideale per vedere la forma del cordolo,
// le strisce pedonali, le piastrelle tattili e la larghezza dei passaggi.
// Richiede "Maps Static API" abilitata nel Google Cloud Console
// (stessa chiave di Street View se il progetto ha entrambe le API attive).
// ════════════════════════════════════════════════════

function buildSatelliteUrl(lat: number, lng: number, zoom: number): string {
  const key = process.env.GOOGLE_STREETVIEW_KEY
  return (
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?center=${lat},${lng}&zoom=${zoom}&size=640x640&maptype=satellite&key=${key}`
  )
}

async function fetchSatelliteImages(lat: number, lng: number): Promise<AnalysisImage[]> {
  const images: AnalysisImage[] = []
  const configs = [
    { zoom: 20, desc: 'Satellite zoom 20 — dettaglio crossing (strisce, bordi marciapiede, piastrelle tattili)' },
    { zoom: 19, desc: 'Satellite zoom 19 — contesto area (incrocio, sensi di marcia, larghezze)' },
  ]
  for (const { zoom, desc } of configs) {
    const url = buildSatelliteUrl(lat, lng, zoom)
    try {
      const img = await imageToBase64(url)
      images.push({ ...img, url, description: desc, source: 'satellite' })
      console.log(`[Satellite] zoom ${zoom} OK`)
    } catch (e) {
      console.log(`[Satellite] zoom ${zoom} err:`, (e as Error).message)
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

// Genera shot Street View con due strategie:
// A) Pano SUL crossing (dist < 8m): 4 cardinali con pitch ripido (-50° su N/S, -10° su E/O)
//    = camera sopra le strisce che guarda lateralmente verso i bordi del marciapiede
// B) Pano sulla STRADA (dist 8-40m): frontale con pitch fisico + laterali
async function fetchStreetViewImages(targetLat: number, targetLng: number): Promise<AnalysisImage[]> {
  const images: AnalysisImage[] = []
  const seenPanos = new Set<string>()

  const searchPoints: Array<{ lat: number; lng: number; radius: number }> = [
    { lat: targetLat, lng: targetLng, radius: 20 }, // pano sul crossing — prima priorità
  ]
  for (const angle of [0, 90, 180, 270]) {
    const p = offsetPoint(targetLat, targetLng, 15, angle)
    searchPoints.push({ lat: p.lat, lng: p.lng, radius: 15 })
  }
  for (const angle of [0, 90, 180, 270]) {
    const p = offsetPoint(targetLat, targetLng, 28, angle)
    searchPoints.push({ lat: p.lat, lng: p.lng, radius: 18 })
  }
  searchPoints.push({ lat: targetLat, lng: targetLng, radius: 80 })

  for (const sp of searchPoints) {
    if (images.length >= 4) break

    const pano = await getStreetViewPano(sp.lat, sp.lng, sp.radius)
    if (!pano || seenPanos.has(pano.pano_id)) continue
    seenPanos.add(pano.pano_id)

    const dist = distanceMeters(pano.lat, pano.lng, targetLat, targetLng)

    if (dist < 8) {
      // Pano SUL crossing: pitch ripido verso i bordi laterali
      const shots = [
        { h: 0,   pitch: -50, label: 'N (sopra strisce → bordo marciapiede, pitch -50°)' },
        { h: 180, pitch: -50, label: 'S (sopra strisce → bordo marciapiede, pitch -50°)' },
        { h: 90,  pitch: -10, label: 'E (sopra strisce → contesto, pitch -10°)' },
        { h: 270, pitch: -10, label: 'O (sopra strisce → contesto, pitch -10°)' },
      ]
      for (const { h, pitch, label } of shots) {
        if (images.length >= 4) break
        const url = buildStreetViewUrl(pano.pano_id, h, pitch, 80)
        try {
          const img = await imageToBase64(url)
          images.push({ ...img, url, description: `Street View ${label}`, source: 'streetview' })
        } catch (e) { console.log('[SV]', (e as Error).message) }
      }
      continue
    }

    // Pano sulla strada: frontale con pitch fisico + laterali ±40°
    const heading = bearingTo(pano.lat, pano.lng, targetLat, targetLng)
    const pitch = pitchForDist(dist)
    const cuts = images.length === 0
      ? [
          { ho: 0,   p: pitch, fov: 80, label: `frontale da ${Math.round(dist)}m, pitch ${pitch}°` },
          { ho: -40, p: -4,    fov: 65, label: `lato sinistro da ${Math.round(dist)}m` },
          { ho: 40,  p: -4,    fov: 65, label: `lato destro da ${Math.round(dist)}m` },
        ]
      : [{ ho: 0, p: pitch, fov: 80, label: `frontale da ${Math.round(dist)}m` }]

    for (const { ho, p, fov, label } of cuts) {
      if (images.length >= 4) break
      const h = (heading + ho + 360) % 360
      const url = buildStreetViewUrl(pano.pano_id, h, p, fov)
      try {
        const img = await imageToBase64(url)
        images.push({ ...img, url, description: `Street View ${label}`, source: 'streetview' })
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
${satCount > 0 ? `🛰️ IMMAGINI SATELLITARI (prime ${satCount}):
  • Le strisce bianche = strisce pedonali dell'attraversamento
  • Cerca discontinuità nel bordo del marciapiede: una "tacca" o cambio di texture = possibile rampa
  • Piastrelle gialle/arancioni a terra = pavimentazione tattile (indica rampa)
  • Bordo rettilineo senza interruzioni = nessuna rampa
  • Larghezza del passaggio misurabile dalla proporzione con le strisce (striscia tipica = 50cm)

` : ''}🏙️ IMMAGINI STREET VIEW (livello strada):
  • Le shot dal crossing (pitch ripido) mostrano il bordo del marciapiede lateralmente
  • Le shot dalla strada mostrano il punto di arrivo sul marciapiede
  • Cerca: gradino verticale (NO rampa) vs superficie inclinata (SÌ rampa)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DEFINIZIONI PRECISE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ RAMPA CONFERMATA — TUTTI questi elementi visibili:
  1. Superficie inclinata che connette marciapiede a strada (non un gradino)
  2. Larghezza ≥ 80 cm praticabile (non un semplice angolo smussato)
  3. Accessibile da entrambi i lati del crossing

❌ NON È UNA RAMPA:
  • Gradino verticale, anche piccolo (3-15 cm)
  • Abbassamento solo parziale o su un lato
  • Accesso privato (cancello, garage, parcheggio) — non vale

🚫 ERRORI DA EVITARE:
  • NON confondere muri bassi, muretti o bordure con rampe
  • NON concludere "rampa" solo per un'inclinazione prospettica nell'immagine
  • NON dire "Accessibile" se non vedi chiaramente almeno UNA rampa praticabile

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROCEDURA OBBLIGATORIA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. IDENTIFICA: in quale immagine vedi chiaramente le strisce pedonali?
2. ESAMINA: descrive ESATTAMENTE il bordo marciapiede — "vedo un gradino verticale di ~X cm" oppure "vedo una superficie inclinata larga ~Y cm"
3. VERDETTO CAUTELATIVO: dubbio tra 🟢 e 🟡 → scegli 🟡. Dubbio tra 🟡 e 🔴 → scegli 🟡. MAI 🟢 se non sei certo al 90%.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FORMATO RISPOSTA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**Crossing identificato**: [immagine/i dove si vedono le strisce]
**Screening**: [immagini utili vs scartate]
**Cosa vedo**: [descrizione PRECISA bordo marciapiede con misure stimate]
**Rampa presente**: Sì (chiaramente) / Parziale (un lato o scarsa qualità) / No / Non visibile
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
