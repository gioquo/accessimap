import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase-server'

interface MapillaryImg {
  url: string
  compass_angle?: number
  distance_to_point?: number
}

async function fetchMapillaryImages(
  lat: number,
  lng: number,
  limit = 3
): Promise<MapillaryImg[]> {
  const token = process.env.MAPILLARY_TOKEN
  if (!token) return []

  try {
    const bbox = `${lng - 0.002},${lat - 0.002},${lng + 0.002},${lat + 0.002}`
    const url = `https://graph.mapillary.com/images?access_token=${token}&fields=id,thumb_1024_url,compass_angle,computed_geometry&bbox=${bbox}&limit=${limit}`
    const res = await fetch(url)
    const data = await res.json()
    if (!data.data) return []
    return data.data
      .filter((img: any) => img.thumb_1024_url)
      .map((img: any) => ({
        url: img.thumb_1024_url,
        compass_angle: img.compass_angle,
      }))
  } catch {
    return []
  }
}

async function imageToBase64(url: string) {
  const res = await fetch(url)
  const buf = await res.arrayBuffer()
  const base64 = Buffer.from(buf).toString('base64')
  const mimeType = res.headers.get('content-type') || 'image/jpeg'
  return { data: base64, mimeType }
}

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
    generationConfig: { temperature: 0.3, maxOutputTokens: 1500 },
  })

  let lastError: any = null

  for (const model of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[Gemini] Trying ${model} (attempt ${attempt}) with ${images.length} images`)
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })

        if (res.status === 503 || res.status === 429) {
          const waitMs = attempt * 2000
          console.log(`[Gemini] ${model} overloaded (${res.status}), waiting ${waitMs}ms`)
          lastError = new Error(`${model} overloaded (${res.status})`)
          await new Promise((r) => setTimeout(r, waitMs))
          continue
        }

        if (!res.ok) {
          const errText = await res.text()
          console.log(`[Gemini] ${model} error ${res.status}: ${errText.slice(0, 200)}`)
          lastError = new Error(`Gemini ${res.status}: ${errText}`)
          break
        }

        const data = await res.json()
        const text =
          data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || ''

        if (text) {
          console.log(`[Gemini] Success with ${model}`)
          return text
        }
        lastError = new Error('Empty response')
      } catch (err: any) {
        console.log(`[Gemini] ${model} threw:`, err.message)
        lastError = err
      }
    }
  }

  throw lastError || new Error('All Gemini models failed')
}

export async function POST(req: NextRequest) {
  try {
    const { crossingId, force } = await req.json()
    if (!crossingId) {
      return NextResponse.json({ error: 'crossingId required' }, { status: 400 })
    }

    const { data: crossing, error: crossErr } = await supabaseServer
      .from('crossings')
      .select('*')
      .eq('id', crossingId)
      .single()

    if (crossErr || !crossing) {
      return NextResponse.json({ error: 'crossing not found' }, { status: 404 })
    }

    if (!force) {
      const { data: existingAnalysis } = await supabaseServer
        .from('ai_analyses')
        .select('*')
        .eq('crossing_id', crossingId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (existingAnalysis) {
        console.log(`[Analyze] Returning cached analysis for crossing ${crossingId}`)
        return NextResponse.json({
          cached: true,
          analysis: existingAnalysis,
          crossing,
        })
      }
    }

    const mlyImages = await fetchMapillaryImages(crossing.lat, crossing.lng, 3)
    console.log(`[Analyze] Found ${mlyImages.length} Mapillary images`)

    const imagesData: Array<{ data: string; mimeType: string }> = []
    const firstImageUrl = mlyImages[0]?.url || null

    for (const img of mlyImages) {
      try {
        imagesData.push(await imageToBase64(img.url))
      } catch (e) {
        console.log('[Analyze] Image fetch failed:', e)
      }
    }

    let prompt: string
    if (imagesData.length > 0) {
      prompt = `Sei un esperto di accessibilità urbana per persone disabili, passeggini e carrozzine.

Analizza queste ${imagesData.length} immagini di un attraversamento pedonale a Roma, prese da angolazioni diverse alle coordinate (${crossing.lat.toFixed(5)}, ${crossing.lng.toFixed(5)}).

Obiettivo: determinare se le persone che usano una carrozzina o spingono un passeggino possono attraversare agevolmente.

Criteri di valutazione:
- Rampe/scivoli sul marciapiede (cordolo abbassato, scivolo inclinato)
- Continuità del percorso (no scalini improvvisi)
- Ostacoli (pali, auto parcheggiate, dislivelli)
- Presenza di pavimentazione tattile

IMPORTANTE: le immagini potrebbero non inquadrare precisamente il punto di attraversamento. In tal caso dichiaralo esplicitamente.

Rispondi in italiano con questo formato esatto:
**Rampa presente**: Sì / No / Non visibile nelle immagini
**Qualità**: Buona / Deteriorata / Parziale / Non valutabile
**Ostacoli**: (elenca eventuali problemi visibili, o "nessuno visibile")
**Note**: descrizione concisa di cosa vedi (1-2 frasi complete)
**Esito**: 🟢 Accessibile / 🟡 Parzialmente accessibile / 🔴 Non accessibile / ⚪ Non determinabile`
    } else {
      prompt = `Sei un esperto di accessibilità urbana a Roma.
Attraversamento pedonale: lat=${crossing.lat.toFixed(5)}, lon=${crossing.lng.toFixed(5)}
Tag OpenStreetMap: ${JSON.stringify(crossing.osm_tags)}

Non ci sono immagini disponibili per quest'area. Basandoti esclusivamente sui tag OSM:
**Valutazione**: cosa indicano i tag sulle rampe?
**Tag mancanti**: quali info sarebbero utili aggiungere?
**Esito**: 🟢 Accessibile / 🟡 Incerto / 🔴 Problematico / ⚪ Non determinabile`
    }

    const aiResponse = await callGemini(prompt, imagesData)

    let verdict: 'ok' | 'bad' | 'partial' | 'unknown' = 'unknown'
    if (aiResponse.includes('🟢')) verdict = 'ok'
    else if (aiResponse.includes('🔴')) verdict = 'bad'
    else if (aiResponse.includes('🟡')) verdict = 'partial'
    else if (aiResponse.includes('⚪')) verdict = 'unknown'

    const { data: savedAnalysis } = await supabaseServer
      .from('ai_analyses')
      .insert({
        crossing_id: crossingId,
        image_url: firstImageUrl,
        ai_verdict: verdict,
        ai_full_response: aiResponse,
        model_used: 'gemini-auto',
      })
      .select()
      .single()

    await supabaseServer
      .from('crossings')
      .update({ status: verdict })
      .eq('id', crossingId)

    console.log(`[Analyze] New analysis for crossing ${crossingId}: ${verdict}`)
    return NextResponse.json({
      cached: false,
      analysis: savedAnalysis,
      crossing: { ...crossing, status: verdict },
      imagesUsed: imagesData.length,
    })
  } catch (err: any) {
    console.error('[Analyze] Error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}