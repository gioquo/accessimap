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
  distanceM: number,
  bearingDeg: number
): { lat: number; lng: number } {
  const R = 6371000
  const brng = toRad(bearingDeg)
  const latRad = toRad(lat)
  const lngRad = toRad(lng)
  const dR = distanceM / R
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

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ════════════════════════════════════════════════════
// GOOGLE STREET VIEW
// ════════════════════════════════════════════════════

interface StreetViewShot {
  url: string
  pano_id: string
  observer_lat: number
  observer_lng: number
  heading: number
  distFromTarget: number
  description: string
}

interface PanoInfo {
  lat: number
  lng: number
  pano_id: string
}

// Cerca un panorama outdoor nel raggio specificato — esclude indoor (musei, attrazioni, interni)
async function getStreetViewPano(lat: number, lng: number, radius: number): Promise<PanoInfo | null> {
  const key = process.env.GOOGLE_STREETVIEW_KEY
  const url =
    `https://maps.googleapis.com/maps/api/streetview/metadata` +
    `?location=${lat},${lng}&radius=${radius}&source=outdoor&key=${key}`
  try {
    const res = await fetch(url)
    const data = await res.json()
    if (data.status !== 'OK') return null
    return { lat: data.location.lat, lng: data.location.lng, pano_id: data.pano_id }
  } catch {
    return null
  }
}

// Usa pano_id invece di location: garantisce il panorama esatto trovato dal metadata
function buildStreetViewUrl(
  pano_id: string,
  heading: number,
  pitch: number,
  fov = 65,
  size = '640x640'
): string {
  const key = process.env.GOOGLE_STREETVIEW_KEY
  return (
    `https://maps.googleapis.com/maps/api/streetview` +
    `?size=${size}&pano=${pano_id}` +
    `&heading=${heading.toFixed(1)}&fov=${fov}&pitch=${pitch}&key=${key}`
  )
}

// Genera fino a 6 immagini Street View per un attraversamento.
//
// Caso pano ≈ target (dist < 8m): il bearing verso il target è inaffidabile (rumore su distanze
// minime), quindi si usano le 4 direzioni cardinali assolute — almeno 2 saranno perpendicolari
// alla strada e mostreranno il cordolo.
//
// Caso pano lontano: heading calcolato dal pano al target + variazioni ±35° per catturare
// entrambi i lati dell'attraversamento. Mix di pitch: un colpo inclinato in basso per il
// dettaglio del cordolo + colpi orizzontali (pitch 0°) per il contesto.
async function generateShots(targetLat: number, targetLng: number): Promise<StreetViewShot[]> {
  const shots: StreetViewShot[] = []
  const seenPanos = new Set<string>()

  // Punti di ricerca: target diretto → 4 cardinali a 15m → 4 cardinali a 30m → fallback 80m
  const searchPoints: Array<{ lat: number; lng: number; radius: number }> = [
    { lat: targetLat, lng: targetLng, radius: 25 },
  ]
  for (const angle of [0, 90, 180, 270]) {
    const p = offsetPoint(targetLat, targetLng, 15, angle)
    searchPoints.push({ lat: p.lat, lng: p.lng, radius: 20 })
  }
  for (const angle of [0, 90, 180, 270]) {
    const p = offsetPoint(targetLat, targetLng, 30, angle)
    searchPoints.push({ lat: p.lat, lng: p.lng, radius: 20 })
  }
  searchPoints.push({ lat: targetLat, lng: targetLng, radius: 80 })

  for (const sp of searchPoints) {
    if (shots.length >= 6) break

    const pano = await getStreetViewPano(sp.lat, sp.lng, sp.radius)
    if (!pano || seenPanos.has(pano.pano_id)) continue
    seenPanos.add(pano.pano_id)

    const dist = distanceMeters(pano.lat, pano.lng, targetLat, targetLng)

    // Pano quasi sul crossing: heading verso target inaffidabile → 4 cardinali assolute
    if (dist < 8) {
      const cardinals = [
        { h: 0, label: 'Nord' }, { h: 90, label: 'Est' },
        { h: 180, label: 'Sud' }, { h: 270, label: 'Ovest' },
      ]
      for (const { h, label } of cardinals) {
        if (shots.length >= 6) break
        shots.push({
          url: buildStreetViewUrl(pano.pano_id, h, -8),
          pano_id: pano.pano_id,
          observer_lat: pano.lat,
          observer_lng: pano.lng,
          heading: h,
          distFromTarget: Math.round(dist),
          description: `Vista ${label} (pano sul crossing, pitch -8°)`,
        })
      }
      continue
    }

    // Pano lontano: heading verso target + variazioni ±35°
    // Mix pitch: centro inclinato (vede cordolo) + lati orizzontali (contesto)
    const headingCenter = bearingTo(pano.lat, pano.lng, targetLat, targetLng)
    const pitchCenter = dist < 25 ? -18 : dist < 45 ? -12 : -8

    const panoCuts: Array<{ headingOffset: number; pitch: number; label: string }> =
      seenPanos.size === 1
        ? [
            { headingOffset: 0, pitch: pitchCenter, label: 'centro (inclinato)' },
            { headingOffset: -35, pitch: 0, label: 'sinistra (orizzontale)' },
            { headingOffset: 35, pitch: 0, label: 'destra (orizzontale)' },
          ]
        : shots.length < 4
        ? [
            { headingOffset: 0, pitch: pitchCenter, label: 'centro' },
            { headingOffset: -30, pitch: 0, label: 'lato' },
          ]
        : [{ headingOffset: 0, pitch: pitchCenter, label: 'centro' }]

    for (const cut of panoCuts) {
      if (shots.length >= 6) break
      const h = (headingCenter + cut.headingOffset + 360) % 360
      shots.push({
        url: buildStreetViewUrl(pano.pano_id, h, cut.pitch),
        pano_id: pano.pano_id,
        observer_lat: pano.lat,
        observer_lng: pano.lng,
        heading: h,
        distFromTarget: Math.round(dist),
        description: `Da ${Math.round(dist)}m, ${cut.label}, heading ${h.toFixed(0)}°, pitch ${cut.pitch}°`,
      })
    }
  }

  return shots
}

async function imageToBase64(url: string) {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Image fetch ${res.status}: ${body.slice(0, 120)}`)
  }
  const buf = await res.arrayBuffer()
  const base64 = Buffer.from(buf).toString('base64')
  const mimeType = res.headers.get('content-type') || 'image/jpeg'
  return { data: base64, mimeType }
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
          lastError = new Error(`${model} overloaded (${res.status})`)
          await new Promise((r) => setTimeout(r, attempt * 2000))
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
    const { crossingId, force, customImages } = await req.json()
    const extraImages: Array<{ data: string; mimeType: string }> = Array.isArray(customImages) ? customImages : []
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

    // 2. Cache (saltata se force=true)
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

    // 3. Genera shot Street View
    console.log(`[Analyze] Generating shots for (${crossing.lat}, ${crossing.lng})`)
    const shots = await generateShots(crossing.lat, crossing.lng)
    console.log(`[Analyze] ${shots.length} shots found`)

    // 4. Scarica le immagini
    const imagesData: Array<{ data: string; mimeType: string }> = []
    const imageUrls: string[] = []

    for (const shot of shots) {
      try {
        const b64 = await imageToBase64(shot.url)
        imagesData.push(b64)
        imageUrls.push(shot.url)
      } catch (e) {
        console.log('[SV] fetch err:', (e as Error).message)
      }
    }

    // 5. Aggiungi immagini personalizzate dell'utente (screenshot manuali)
    if (extraImages.length > 0) {
      imagesData.push(...extraImages)
      console.log(`[Analyze] +${extraImages.length} custom images from user`)
    }

    // 6. Costruisci prompt
    let prompt: string

    if (imagesData.length > 0) {
      const svCount = imagesData.length - extraImages.length
      const shotList = [
        ...shots.slice(0, svCount).map((s, i) => `  Immagine ${i + 1}: ${s.description}`),
        ...extraImages.map((_, i) => `  Immagine ${svCount + i + 1}: screenshot manuale dell'utente`),
      ].join('\n')

      prompt = `Sei un esperto di accessibilità urbana. Devi valutare se l'attraversamento pedonale alle coordinate ${crossing.lat.toFixed(5)}, ${crossing.lng.toFixed(5)} a Roma è accessibile a persone in carrozzina o con passeggino.

Hai ${imagesData.length} immagini Google Street View dell'area, scattate con inclinazione verso il basso per mostrare il bordo del marciapiede:
${shotList}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COSA IDENTIFICARE — RAMPE E CORDOLI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ RAMPA PRESENTE (cordolo abbassato):
  • Il bordo del marciapiede scende gradualmente fino al livello dell'asfalto
  • Superficie inclinata in calcestruzzo o asfalto, spesso con texture ruvida
  • A volte piastrelle tattili gialle/arancioni posizionate di fronte

❌ NESSUNA RAMPA (cordolo rialzato):
  • Il bordo del marciapiede forma un gradino verticale di 5-15 cm
  • Transizione netta e brusca tra marciapiede e carreggiata

⚠️ ATTENZIONE AGLI OSTACOLI TRANSITORI:
  • Auto parcheggiate o persone NON invalidano la valutazione se il cordolo è visibile ai lati
  • Valuta l'infrastruttura permanente, ignora veicoli e pedoni

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROCEDURA (2 FASI OBBLIGATORIE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FASE 1 — SCREENING
Per ogni immagine: il cordolo/bordo marciapiede è visibile anche parzialmente?
Scarta solo immagini dove è completamente invisibile (buio totale, solo cielo/muri/alberi).

FASE 2 — VALUTAZIONE (solo immagini utili)
• Il cordolo è abbassato (rampa) o verticale (scalino)?
• Condizioni del manto stradale e del marciapiede
• Pavimentazione tattile per ipovedenti presente?
• Larghezza del passaggio (sufficiente per carrozzina ≥80 cm?)
• Ostacoli permanenti: pali, fioriere, radici sporgenti (NON auto/persone)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FORMATO RISPOSTA (rispetta esattamente)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**Screening**: [immagini utili e perché le altre scartate, max 2 righe]
**Cosa vedo**: [descrizione concreta del cordolo/rampa nelle immagini utili, 1-2 frasi]
**Rampa presente**: Sì / No / Non visibile
**Qualità manto**: Buona / Deteriorata / Parziale / Non valutabile
**Ostacoli permanenti**: [elenco o "nessuno"]
**Esito**: 🟢 Accessibile / 🟡 Parzialmente accessibile / 🔴 Non accessibile / ⚪ Non determinabile

REGOLA ASSOLUTA: se meno di 2 immagini sono utilizzabili → rispondi obbligatoriamente ⚪ Non determinabile.`
    } else {
      prompt = `Attraversamento pedonale a Roma (${crossing.lat.toFixed(5)}, ${crossing.lng.toFixed(5)}).
Nessuna immagine Street View disponibile in un raggio di 80m.
Tag OSM: ${JSON.stringify(crossing.osm_tags)}

**Esito**: ⚪ Non determinabile (nessuna immagine disponibile per questo punto).`
    }

    // 6. Chiama Gemini
    const aiResponse = await callGemini(prompt, imagesData)

    // 7. Verdetto
    let verdict: 'ok' | 'bad' | 'partial' | 'unknown' = 'unknown'
    if (aiResponse.includes('🟢')) verdict = 'ok'
    else if (aiResponse.includes('🔴')) verdict = 'bad'
    else if (aiResponse.includes('🟡')) verdict = 'partial'
    else if (aiResponse.includes('⚪')) verdict = 'unknown'

    // 8. Salva in DB
    const { data: savedAnalysis } = await supabaseServer
      .from('ai_analyses')
      .insert({
        crossing_id: crossingId,
        image_url: imageUrls[0] || null,
        image_urls: imageUrls,
        ai_verdict: verdict,
        ai_full_response: aiResponse,
        model_used: 'gemini-streetview',
      })
      .select()
      .single()

    await supabaseServer.from('crossings').update({ status: verdict }).eq('id', crossingId)

    console.log(`[Analyze] ✓ crossing ${crossingId} → ${verdict} (${imagesData.length} imgs)`)
    return NextResponse.json({
      cached: false,
      analysis: savedAnalysis,
      crossing: { ...crossing, status: verdict },
      imagesUsed: imagesData.length,
      imageUrls,
    })
  } catch (err: any) {
    console.error('[Analyze] Error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// Override manuale del verdetto da parte dell'utente
export async function PATCH(req: NextRequest) {
  try {
    const { crossingId, verdict } = await req.json()
    if (!crossingId || !['ok', 'bad', 'partial', 'unknown'].includes(verdict)) {
      return NextResponse.json({ error: 'crossingId e verdict valido richiesti' }, { status: 400 })
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
    console.log(`[Analyze] Manual override crossing ${crossingId} → ${verdict}`)
    return NextResponse.json({ ok: true, verdict })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
