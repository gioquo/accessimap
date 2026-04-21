import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase-server'

// ════════════════════════════════════════════════════
// UTILITIES GEOGRAFICHE
// ════════════════════════════════════════════════════

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}
function toDeg(rad: number): number {
  return (rad * 180) / Math.PI
}

function offsetPoint(
  lat: number,
  lng: number,
  distanceMeters: number,
  bearingDeg: number
): { lat: number; lng: number } {
  const R = 6371000
  const brng = toRad(bearingDeg)
  const latRad = toRad(lat)
  const lngRad = toRad(lng)
  const dR = distanceMeters / R
  const newLat = Math.asin(
    Math.sin(latRad) * Math.cos(dR) + Math.cos(latRad) * Math.sin(dR) * Math.cos(brng)
  )
  const newLng =
    lngRad +
    Math.atan2(
      Math.sin(brng) * Math.sin(dR) * Math.cos(latRad),
      Math.cos(dR) - Math.sin(latRad) * Math.sin(newLat)
    )
  return { lat: toDeg(newLat), lng: toDeg(newLng) }
}

function bearingTo(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLng = toRad(lng2 - lng1)
  const lat1Rad = toRad(lat1)
  const lat2Rad = toRad(lat2)
  const y = Math.sin(dLng) * Math.cos(lat2Rad)
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

// ════════════════════════════════════════════════════
// GOOGLE STREET VIEW
// ════════════════════════════════════════════════════

interface StreetViewShot {
  url: string
  observer_lat: number
  observer_lng: number
  heading: number
  distance: number
  description: string
}

interface PanoInfo {
  lat: number
  lng: number
  pano_id: string
}

// Ritorna la posizione REALE del panorama Street View più vicino (non quella teorica dell'osservatore)
async function getStreetViewPano(lat: number, lng: number, radius = 50): Promise<PanoInfo | null> {
  const key = process.env.GOOGLE_STREETVIEW_KEY
  const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&radius=${radius}&key=${key}`
  try {
    const res = await fetch(url)
    const data = await res.json()
    if (data.status !== 'OK') return null
    return { lat: data.location.lat, lng: data.location.lng, pano_id: data.pano_id }
  } catch {
    return null
  }
}

function buildStreetViewUrl(
  lat: number,
  lng: number,
  heading: number,
  fov = 65,
  size = '640x640',
  pitch = -15
): string {
  const key = process.env.GOOGLE_STREETVIEW_KEY
  return (
    `https://maps.googleapis.com/maps/api/streetview?` +
    `size=${size}&location=${lat},${lng}&heading=${heading.toFixed(1)}&fov=${fov}&pitch=${pitch}&key=${key}`
  )
}

// Genera shot con una prospettiva per angolazione, massimizzando la varietà di punti di vista.
// Heading ricalcolato dalla posizione REALE del pano verso il target (non dalla posizione teorica).
// Deduplica per pano_id: se 12m e 20m convergono allo stesso panorama, conta una volta sola.
async function generateShots(targetLat: number, targetLng: number): Promise<StreetViewShot[]> {
  const angles = [0, 60, 120, 180, 240, 300]
  const angleNames = ['Nord', 'Nord-Est', 'Sud-Est', 'Sud', 'Sud-Ovest', 'Nord-Ovest']
  const distances = [12, 20]

  const primary: StreetViewShot[] = []   // primo disponibile per angolazione (preferibilmente 12m)
  const secondary: StreetViewShot[] = [] // secondo per angolazione (20m dove esiste anche 12m)
  const seenPanos = new Set<string>()

  for (let ai = 0; ai < angles.length; ai++) {
    const angle = angles[ai]
    const angleName = angleNames[ai]
    let foundForAngle = false

    for (const distance of distances) {
      const observer = offsetPoint(targetLat, targetLng, distance, angle)
      const pano = await getStreetViewPano(observer.lat, observer.lng)
      if (!pano) continue
      if (seenPanos.has(pano.pano_id)) continue

      seenPanos.add(pano.pano_id)

      // Heading dalla posizione REALE del pano verso il target — corregge errori da snap
      const heading = bearingTo(pano.lat, pano.lng, targetLat, targetLng)
      // Pitch più inclinato verso il basso a distanza ravvicinata per mostrare il cordolo
      const pitch = distance === 12 ? -15 : -10

      const shot: StreetViewShot = {
        url: buildStreetViewUrl(pano.lat, pano.lng, heading, 65, '640x640', pitch),
        observer_lat: pano.lat,
        observer_lng: pano.lng,
        heading,
        distance,
        description: `Vista da ${distance}m ${angleName}`,
      }

      if (!foundForAngle) {
        primary.push(shot)
        foundForAngle = true
      } else {
        secondary.push(shot)
      }
    }
  }

  // Prima i primari (una per angolazione = massima varietà), poi i secondari come rinforzo
  return [...primary, ...secondary].slice(0, 6)
}

async function imageToBase64(url: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Image fetch ${res.status}`)
  const buf = await res.arrayBuffer()
  const base64 = Buffer.from(buf).toString('base64')
  const mimeType = res.headers.get('content-type') || 'image/jpeg'
  return { data: base64, mimeType }
}

// ════════════════════════════════════════════════════
// MAPILLARY FALLBACK
// ════════════════════════════════════════════════════

async function fetchMapillaryFallback(
  targetLat: number,
  targetLng: number
): Promise<string[]> {
  const token = process.env.MAPILLARY_TOKEN
  if (!token) return []
  try {
    const bbox = `${targetLng - 0.002},${targetLat - 0.002},${targetLng + 0.002},${targetLat + 0.002}`
    const url = `https://graph.mapillary.com/images?access_token=${token}&fields=id,thumb_1024_url&bbox=${bbox}&limit=3`
    const res = await fetch(url)
    const data = await res.json()
    return (data.data || [])
      .filter((img: any) => img.thumb_1024_url)
      .map((img: any) => img.thumb_1024_url)
  } catch {
    return []
  }
}

// ════════════════════════════════════════════════════
// GEMINI API
// ════════════════════════════════════════════════════

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']

async function callGemini(
  prompt: string,
  images: Array<{ data: string; mimeType: string }>
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured')

  const parts: any[] = [{ text: prompt }]
  for (const img of images) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } })
  }
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2000 },
  })

  let lastError: any = null
  for (const model of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[Gemini] ${model} attempt ${attempt}, ${images.length} images`)
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
        if (res.status === 503 || res.status === 429) {
          const waitMs = attempt * 2000
          lastError = new Error(`${model} overloaded (${res.status})`)
          await new Promise((r) => setTimeout(r, waitMs))
          continue
        }
        if (!res.ok) {
          const errText = await res.text()
          lastError = new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`)
          break
        }
        const data = await res.json()
        const text =
          data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || ''
        if (text) {
          console.log(`[Gemini] ✓ ${model}`)
          return text
        }
        lastError = new Error('Empty response')
      } catch (err: any) {
        lastError = err
      }
    }
  }
  throw lastError || new Error('All Gemini models failed')
}

// ════════════════════════════════════════════════════
// PIPELINE PRINCIPALE
// ════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const { crossingId, force } = await req.json()
    if (!crossingId) {
      return NextResponse.json({ error: 'crossingId required' }, { status: 400 })
    }

    // 1. Recupera il crossing
    const { data: crossing, error: crossErr } = await supabaseServer
      .from('crossings')
      .select('*')
      .eq('id', crossingId)
      .single()
    if (crossErr || !crossing) {
      return NextResponse.json({ error: 'crossing not found' }, { status: 404 })
    }

    // 2. Cache
    if (!force) {
      const { data: existing } = await supabaseServer
        .from('ai_analyses')
        .select('*')
        .eq('crossing_id', crossingId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (existing) {
        console.log(`[Analyze] Cached for ${crossingId}`)
        const cachedUrls: string[] =
          existing.image_urls || (existing.image_url ? [existing.image_url] : [])
        return NextResponse.json({ cached: true, analysis: existing, crossing, imageUrls: cachedUrls })
      }
    }

    // 3. Prova Street View
    console.log(`[Analyze] Generating Street View shots for (${crossing.lat}, ${crossing.lng})`)
    const shots = await generateShots(crossing.lat, crossing.lng)
    console.log(`[Analyze] Got ${shots.length} valid Street View shots`)

    let imagesData: Array<{ data: string; mimeType: string }> = []
    let imageUrls: string[] = []
    let source = 'streetview'

    if (shots.length > 0) {
      for (const shot of shots) {
        try {
          const b64 = await imageToBase64(shot.url)
          imagesData.push(b64)
          imageUrls.push(shot.url)
        } catch (e) {
          console.log('[SV] fetch err:', e)
        }
      }
    }

    // 4. Fallback Mapillary
    if (imagesData.length === 0) {
      console.log('[Analyze] No Street View, trying Mapillary fallback')
      const mlyUrls = await fetchMapillaryFallback(crossing.lat, crossing.lng)
      for (const url of mlyUrls) {
        try {
          const b64 = await imageToBase64(url)
          imagesData.push(b64)
          imageUrls.push(url)
        } catch (e) {}
      }
      source = 'mapillary'
    }

    // 5. Costruisci il prompt
    let prompt: string
    if (imagesData.length > 0) {
      const shotDescriptions =
        source === 'streetview'
          ? shots
              .slice(0, imagesData.length)
              .map(
                (s, i) =>
                  `Immagine ${i + 1}: ${s.description}, heading ${s.heading.toFixed(0)}°, pitch ${s.distance === 12 ? '-15' : '-10'}°`
              )
              .join('\n')
          : imagesData.map((_, i) => `Immagine ${i + 1}: vista Mapillary`).join('\n')

      prompt = `Sei un esperto di accessibilità urbana. Analizzi un attraversamento pedonale a Roma (${crossing.lat.toFixed(5)}, ${crossing.lng.toFixed(5)}).

Ti fornisco ${imagesData.length} immagini da Google Street View scattate da angolazioni diverse attorno al punto, con inclinazione verso il basso per mostrare il cordolo:
${shotDescriptions}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COSA CERCARE — RAMPE E CORDOLI:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Una rampa/scivolo è un abbassamento del cordolo che porta dal marciapiede alla strada:
• Il bordo del marciapiede scende gradualmente fino all'asfalto (non è verticale)
• Superficie in calcestruzzo grigio o asfalto, spesso con texture ruvida
• A volte piastrelle tattili gialle/arancioni di fronte alla rampa
• Larghezza tipica 80-150 cm

Un cordolo SENZA rampa appare come un gradino verticale alto 5-15 cm tra marciapiede e strada.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROCEDURA A DUE FASI — SEGUILA RIGOROSAMENTE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**FASE 1 — SCREENING QUALITÀ (OBBLIGATORIA)**
Per OGNI immagine valuta se il cordolo/bordo marciapiede è visibile:
- Un'auto parcheggiata davanti al cordolo NON scarta l'immagine se si vede il cordolo ai suoi lati o sotto
- Scarta SOLO immagini dove il cordolo è totalmente invisibile (buio, solo cielo/muri/alberi, copertura totale)

**FASE 2 — VALUTAZIONE ACCESSIBILITÀ**
Sulle immagini utili, valuta:
- Il cordolo è abbassato (rampa) o verticale (nessuna rampa)?
- Qualità del manto (crepe, buche, dislivelli significativi)
- Presenza di pavimentazione tattile per ipovedenti
- Larghezza del passaggio per carrozzina/passeggino (≥80 cm)
- Ostacoli PERMANENTI (pali, fioriere, radici sporgenti) — ignora veicoli e persone

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FORMATO RISPOSTA OBBLIGATORIO:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**Screening immagini**: quante e quali (per numero) sono utilizzabili, e perché le altre sono scartate (max 2 righe)
**Cosa vedo**: descrizione concreta del cordolo/rampa nelle immagini utili (1-2 frasi)
**Rampa presente**: Sì / No / Non visibile
**Qualità**: Buona / Deteriorata / Parziale / Non valutabile
**Ostacoli permanenti**: elenca o "nessuno"
**Esito**: 🟢 Accessibile / 🟡 Parzialmente accessibile / 🔴 Non accessibile / ⚪ Non determinabile

REGOLA: se meno di 2 immagini sono utilizzabili, rispondi sempre ⚪ Non determinabile.`
    } else {
      prompt = `Attraversamento pedonale a Roma (${crossing.lat.toFixed(5)}, ${crossing.lng.toFixed(5)}).
Nessuna immagine disponibile (né Street View né Mapillary).
Tag OSM: ${JSON.stringify(crossing.osm_tags)}

Rispondi: ⚪ Non determinabile (senza immagini non posso verificare visualmente).`
    }

    // 6. Chiama Gemini
    const aiResponse = await callGemini(prompt, imagesData)

    // 7. Interpreta il verdetto
    let verdict: 'ok' | 'bad' | 'partial' | 'unknown' = 'unknown'
    if (aiResponse.includes('🟢')) verdict = 'ok'
    else if (aiResponse.includes('🔴')) verdict = 'bad'
    else if (aiResponse.includes('🟡')) verdict = 'partial'
    else if (aiResponse.includes('⚪')) verdict = 'unknown'

    // 8. Salva in DB (image_urls richiede la colonna aggiunta via migrazione SQL)
    const { data: savedAnalysis } = await supabaseServer
      .from('ai_analyses')
      .insert({
        crossing_id: crossingId,
        image_url: imageUrls[0] || null,
        image_urls: imageUrls,
        ai_verdict: verdict,
        ai_full_response: aiResponse,
        model_used: `gemini-${source}`,
      })
      .select()
      .single()

    await supabaseServer.from('crossings').update({ status: verdict }).eq('id', crossingId)

    console.log(`[Analyze] ✓ ${crossingId} → ${verdict} (${source}, ${imagesData.length} imgs)`)
    return NextResponse.json({
      cached: false,
      analysis: savedAnalysis,
      crossing: { ...crossing, status: verdict },
      source,
      imagesUsed: imagesData.length,
      imageUrls,
    })
  } catch (err: any) {
    console.error('[Analyze] Error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
