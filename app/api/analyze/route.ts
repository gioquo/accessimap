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

// Usa pano_id: garantisce il panorama esatto trovato dal metadata, senza re-snap
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

// Pitch fisicamente corretto: punta esattamente al livello del suolo alla distanza del target.
// Street View camera è a ~1.4m d'altezza: arctan(1.4 / dist) gradi verso il basso.
// Esempio: dist=10m → -8°, dist=20m → -4°, dist=5m → -16°.
// Valori precedenti (-15° a 20m) puntavano al suolo a 5m → vedevano l'asfalto, non il cordolo.
function pitchForDistance(dist: number): number {
  return -Math.round(Math.atan2(1.4, Math.max(dist, 3)) * 180 / Math.PI)
}

// Genera 6 immagini Street View ottimizzate per vedere rampe e cordoli.
//
// Logica di acquisizione:
// 1. Target diretto → trova il pano SUL crossing (visuale dall'alto delle strisce)
// 2. Poi 4 cardinali a 15m e 25m → trova pani sulla STRADA che guardano verso il marciapiede
//
// Pano sul crossing (dist < 8m):
//   Genera 2 shot a pitch=-22° nelle direzioni N/S oppure E/O (parallele al marciapiede)
//   = visuale "macchina sopra le strisce che guarda lateralmente verso il cordolo"
//   + 2 shot a pitch=-8° nelle direzioni perpendicolari per il contesto
//
// Pano sulla strada (dist ≥ 8m):
//   Shot principale con pitch fisico (punta esattamente al suolo dove si trova il cordolo)
//   + shot laterali ±40° per vedere i dettagli di ciascun lato della rampa
async function generateShots(targetLat: number, targetLng: number): Promise<StreetViewShot[]> {
  const shots: StreetViewShot[] = []
  const seenPanos = new Set<string>()

  // Target prima (pano sul crossing), poi cardinali a 15m/25m (pani sulla strada)
  const searchPoints: Array<{ lat: number; lng: number; radius: number }> = [
    { lat: targetLat, lng: targetLng, radius: 20 },
  ]
  for (const angle of [0, 90, 180, 270]) {
    const p15 = offsetPoint(targetLat, targetLng, 15, angle)
    const p25 = offsetPoint(targetLat, targetLng, 25, angle)
    searchPoints.push({ lat: p15.lat, lng: p15.lng, radius: 15 })
    searchPoints.push({ lat: p25.lat, lng: p25.lng, radius: 18 })
  }
  searchPoints.push({ lat: targetLat, lng: targetLng, radius: 80 })

  for (const sp of searchPoints) {
    if (shots.length >= 6) break

    const pano = await getStreetViewPano(sp.lat, sp.lng, sp.radius)
    if (!pano || seenPanos.has(pano.pano_id)) continue
    seenPanos.add(pano.pano_id)

    const dist = distanceMeters(pano.lat, pano.lng, targetLat, targetLng)
    const pitch = pitchForDistance(dist)

    if (dist < 8) {
      // Pano SUL crossing: genera 4 shot cardinali con pitch ripido (-22°)
      // = camera sopra le strisce che guarda verso il marciapiede lateralmente
      // Almeno 2 delle 4 direzioni saranno parallele alle strisce pedonali
      const cardinals = [
        { h: 0,   label: 'Nord',  pitchVal: -22 },
        { h: 180, label: 'Sud',   pitchVal: -22 },
        { h: 90,  label: 'Est',   pitchVal: -8  },
        { h: 270, label: 'Ovest', pitchVal: -8  },
      ]
      for (const { h, label, pitchVal } of cardinals) {
        if (shots.length >= 6) break
        shots.push({
          url: buildStreetViewUrl(pano.pano_id, h, pitchVal, 80),
          pano_id: pano.pano_id,
          observer_lat: pano.lat,
          observer_lng: pano.lng,
          heading: h,
          distFromTarget: Math.round(dist),
          description: `Sul crossing verso ${label}, pitch ${pitchVal}°, FOV 80°`,
        })
      }
      continue
    }

    // Pano sulla strada: pitch fisico verso il cordolo + shot laterali per dettaglio rampe
    const headingCenter = bearingTo(pano.lat, pano.lng, targetLat, targetLng)

    const panoCuts: Array<{ headingOffset: number; pitch: number; fov: number; label: string }> =
      seenPanos.size === 1
        ? [
            { headingOffset: 0,   pitch,          fov: 80, label: 'frontale FOV largo' },
            { headingOffset: -40, pitch: -4,       fov: 65, label: 'lato sinistro' },
            { headingOffset: 40,  pitch: -4,       fov: 65, label: 'lato destro' },
          ]
        : shots.length < 4
        ? [
            { headingOffset: 0,   pitch,          fov: 80, label: 'frontale' },
            { headingOffset: -35, pitch: -4,       fov: 65, label: 'lato' },
          ]
        : [{ headingOffset: 0, pitch, fov: 75, label: 'frontale' }]

    for (const cut of panoCuts) {
      if (shots.length >= 6) break
      const h = (headingCenter + cut.headingOffset + 360) % 360
      shots.push({
        url: buildStreetViewUrl(pano.pano_id, h, cut.pitch, cut.fov),
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

      // Contesto OSM: aiuta l'AI a capire cosa aspettarsi
      const osmHint = (() => {
        const t = crossing.osm_tags || {}
        if (t.kerb === 'lowered' || t.kerb === 'flush') return '⚠️ Tag OSM: kerb=lowered/flush — i dati OSM suggeriscono rampa presente, ma VERIFICA visivamente.'
        if (t.kerb === 'raised' || t.kerb === 'no') return '⚠️ Tag OSM: kerb=raised/no — i dati OSM suggeriscono NESSUNA rampa. Sii molto scettico verso "Accessibile".'
        if (t.tactile_paving === 'yes') return '⚠️ Tag OSM: tactile_paving=yes — potrebbe esserci una rampa, ma verifica.'
        return `Tag OSM disponibili: ${JSON.stringify(t)}`
      })()

      prompt = `Sei un esperto di accessibilità urbana con un compito critico: valutare se l'attraversamento pedonale a Roma (${crossing.lat.toFixed(5)}, ${crossing.lng.toFixed(5)}) è DAVVERO accessibile a persone in carrozzina o con passeggino.

${osmHint}

Hai ${imagesData.length} immagini Street View. Le prime ${Math.min(4, svCount)} sono scattate con la camera SUL crossing (sopra le strisce) che guarda lateralmente verso i marciapiedi. Le successive sono scattate dalla strada guardando verso l'attraversamento:
${shotList}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DEFINIZIONI PRECISE — LEGGI CON ATTENZIONE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ RAMPA CONFERMATA — devi vedere TUTTI questi elementi:
  1. Il bordo del marciapiede scende GRADUALMENTE (non bruscamente) fino al livello dell'asfalto
  2. La superficie di transizione è inclinata e ha una larghezza ≥ 80 cm
  3. Non basta vedere un bordo basso o un angolo — deve essere una SUPERFICIE PRATICABILE

❌ NON È UNA RAMPA se vedi:
  • Un gradino verticale (anche piccolo, 3-15 cm)
  • Un bordo del marciapiede che termina bruscamente
  • Un'area di accesso privato (cancello, garage, parcheggio) — non vale come rampa pedonale
  • Un abbassamento solo parziale o su un lato solo

🚫 ERRORI COMUNI DA EVITARE:
  • NON confondere muri bassi, muretti, o bordure con rampe
  • NON concludere "rampa presente" solo perché l'angolo di ripresa sembra mostrare un'inclinazione — potrebbe essere prospettiva
  • NON concludere "Accessibile" se la rampa non è chiaramente visibile almeno in UNA immagine

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROCEDURA OBBLIGATORIA (3 FASI)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FASE 1 — IDENTIFICA IL CROSSING
In quale/i immagine/i vedi chiaramente le strisce pedonali bianche e i due bordi del marciapiede ai lati? Se non le trovi, le altre immagini potrebbero non mostrare il punto corretto.

FASE 2 — ESAMINA I BORDI DEL MARCIAPIEDE
Per ogni lato dell'attraversamento visibile: il bordo è abbassato (rampa) o è un gradino verticale?
Descrivi ESATTAMENTE cosa vedi: "vedo un gradino verticale alto circa X cm" oppure "vedo una superficie inclinata larga Y cm".

FASE 3 — VERDETTO CONSERVATIVO
Regola: in caso di dubbio, scegli sempre il verdetto PIÙ CAUTELATIVO:
• Se vedi chiaramente rampa su entrambi i lati → 🟢 Accessibile
• Se vedi rampa su un lato solo, o rampa di qualità scarsa → 🟡 Parzialmente accessibile
• Se vedi gradini o nessuna rampa → 🔴 Non accessibile
• Se le immagini non mostrano chiaramente i bordi → ⚪ Non determinabile
• REGOLA CRITICA: se hai dubbi tra 🟢 e 🟡, scegli sempre 🟡. Se hai dubbi tra 🟡 e 🔴, scegli 🟡. MAI esagerare verso il verde se non sei certo.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FORMATO RISPOSTA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**Crossing identificato**: [in quale/i immagine/i sono visibili le strisce e i bordi]
**Screening**: [quali immagini utili e perché le altre scartate]
**Cosa vedo**: [descrizione PRECISA del bordo marciapiede — gradino o rampa, con dimensioni stimate]
**Rampa presente**: Sì (chiaramente visibile) / Parziale (un lato o qualità scarsa) / No / Non visibile
**Qualità manto**: Buona / Deteriorata / Parziale / Non valutabile
**Ostacoli permanenti**: [elenco o "nessuno"]
**Esito**: 🟢 Accessibile / 🟡 Parzialmente accessibile / 🔴 Non accessibile / ⚪ Non determinabile

REGOLA ASSOLUTA: meno di 2 immagini utili → ⚪ Non determinabile. Dubbio tra due esiti → scegli il più cautelativo.`
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
