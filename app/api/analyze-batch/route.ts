import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase-server'

// POST /api/analyze-batch  body: { crossingIds: number[] }
// Avvia analisi multiple in modo sequenziale con pause per rispettare rate limit
export async function POST(req: NextRequest) {
  try {
    const { crossingIds } = await req.json()
    if (!Array.isArray(crossingIds) || crossingIds.length === 0) {
      return NextResponse.json({ error: 'crossingIds array required' }, { status: 400 })
    }

    // Limita a max 10 per evitare timeout Vercel
    const limited = crossingIds.slice(0, 10)
    const results: any[] = []

    // Trova l'URL base per chiamare /api/analyze
    const baseUrl = new URL(req.url).origin

    for (let i = 0; i < limited.length; i++) {
      const id = limited[i]
      try {
        const res = await fetch(`${baseUrl}/api/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ crossingId: id }),
        })
        const data = await res.json()
        results.push({ id, success: !data.error, ...data })
      } catch (err: any) {
        results.push({ id, success: false, error: err.message })
      }

      // Pausa di 2 secondi tra richieste (rispetta rate limit Gemini)
      if (i < limited.length - 1) {
        await new Promise((r) => setTimeout(r, 2000))
      }
    }

    return NextResponse.json({ results, total: limited.length })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}