import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const lat = parseFloat(searchParams.get('lat') || '41.888439')
  const lng = parseFloat(searchParams.get('lng') || '12.494099')
  const key = process.env.GOOGLE_STREETVIEW_KEY

  if (!key) return NextResponse.json({ error: 'GOOGLE_STREETVIEW_KEY not set' }, { status: 500 })

  const radii = [25, 50, 80, 150]
  const sources = ['outdoor', 'default'] as const
  const results: Record<string, any> = {}

  for (const source of sources) {
    results[source] = {}
    for (const radius of radii) {
      const url =
        `https://maps.googleapis.com/maps/api/streetview/metadata` +
        `?location=${lat},${lng}&radius=${radius}&source=${source}&key=${key}`
      try {
        const res = await fetch(url)
        const data = await res.json()
        results[source][`r${radius}`] = {
          status: data.status,
          pano_id: data.pano_id || null,
          location: data.location || null,
          copyright: data.copyright || null,
          date: data.date || null,
        }
      } catch (e: any) {
        results[source][`r${radius}`] = { error: e.message }
      }
    }
  }

  return NextResponse.json({ lat, lng, results })
}
