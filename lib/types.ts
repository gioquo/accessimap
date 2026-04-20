export type CrossingStatus = 'ok' | 'bad' | 'partial' | 'unknown'

export interface Crossing {
  id: number
  osm_id: number | null
  lat: number
  lng: number
  name: string | null
  osm_tags: Record<string, string>
  status: CrossingStatus
  distance_meters?: number
}

export interface AIAnalysis {
  id: number
  crossing_id: number
  image_url: string | null
  ai_verdict: CrossingStatus
  ai_full_response: string
  created_at: string
}