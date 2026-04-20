'use client'

import { useEffect, useRef, useState } from 'react'
import type { Crossing, CrossingStatus } from '../lib/types'

const COLORS: Record<CrossingStatus, string> = {
  ok: '#00e5a0',
  bad: '#ff4a6b',
  partial: '#f5c842',
  unknown: '#7a7f8e',
}

export default function MapClient() {
  const mapRef = useRef<any>(null)
  const markersRef = useRef<any[]>([])
  const circleRef = useRef<any>(null)
  const [L, setL] = useState<any>(null)
  const [crossings, setCrossings] = useState<Crossing[]>([])
  const [selected, setSelected] = useState<Crossing | null>(null)
  const [analysis, setAnalysis] = useState<string>('')
  const [imageUrl, setImageUrl] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [radius, setRadius] = useState(500)
  const [center, setCenter] = useState<[number, number]>([41.8902, 12.4922])
  const [locationLabel, setLocationLabel] = useState('📍 Colosseo, Roma')
  const [zone, setZone] = useState('')
  const [isSatellite, setIsSatellite] = useState(true)
  const satLayerRef = useRef<any>(null)
  const streetLayerRef = useRef<any>(null)

  useEffect(() => {
    import('leaflet').then((leaflet) => {
      setL(leaflet.default || leaflet)
    })
  }, [])

  useEffect(() => {
    if (!L || mapRef.current) return

    const map = L.map('map', { zoomControl: true }).setView(center, 16)

    streetLayerRef.current = L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      { attribution: '© OpenStreetMap', maxZoom: 19 }
    )
    satLayerRef.current = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: '© Esri, Maxar', maxZoom: 19 }
    )

    satLayerRef.current.addTo(map)

    circleRef.current = L.circle(center, {
      radius,
      color: '#00e5a0',
      fillColor: '#00e5a0',
      fillOpacity: 0.06,
      weight: 1.5,
      dashArray: '5 4',
    }).addTo(map)

    map.on('click', (e: any) => {
      const newCenter: [number, number] = [e.latlng.lat, e.latlng.lng]
      setCenter(newCenter)
      setLocationLabel(`📍 ${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`)
    })

    mapRef.current = map

    setTimeout(() => map.invalidateSize(true), 100)
    setTimeout(() => map.invalidateSize(true), 500)

    const onResize = () => setTimeout(() => map.invalidateSize(true), 100)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [L])

  useEffect(() => {
    if (!mapRef.current || !circleRef.current || !L) return
    mapRef.current.removeLayer(circleRef.current)
    circleRef.current = L.circle(center, {
      radius,
      color: '#00e5a0',
      fillColor: '#00e5a0',
      fillOpacity: 0.06,
      weight: 1.5,
      dashArray: '5 4',
    }).addTo(mapRef.current)
  }, [center, radius, L])

  function toggleLayer() {
    if (!mapRef.current || !L) return
    if (isSatellite) {
      mapRef.current.removeLayer(satLayerRef.current)
      streetLayerRef.current.addTo(mapRef.current)
    } else {
      mapRef.current.removeLayer(streetLayerRef.current)
      satLayerRef.current.addTo(mapRef.current)
    }
    setIsSatellite(!isSatellite)
  }

  useEffect(() => {
    if (!mapRef.current || !L) return

    markersRef.current.forEach((m) => mapRef.current.removeLayer(m))
    markersRef.current = []

    crossings.forEach((c) => {
      const color = COLORS[c.status]
      const icon = L.divIcon({
        html: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" viewBox="0 0 24 32">
          <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z" fill="${color}" stroke="white" stroke-width="1.5"/>
          <circle cx="12" cy="12" r="5" fill="white"/></svg>`,
        iconSize: [24, 32],
        iconAnchor: [12, 32],
        className: '',
      })
      const marker = L.marker([c.lat, c.lng], { icon })
        .addTo(mapRef.current)
        .on('click', () => selectCrossing(c))
      markersRef.current.push(marker)
    })
  }, [crossings, L])

  async function loadCrossings() {
    setLoading(true)
    setSidebarOpen(false)
    try {
      const res = await fetch(
        `/api/crossings?lat=${center[0]}&lng=${center[1]}&radius=${radius}`
      )
      const data = await res.json()
      setCrossings(data.crossings || [])
      if (data.warning) {
        console.warn('Warning:', data.warning)
      }
      setTimeout(() => {
        if (markersRef.current.length > 0 && mapRef.current && L) {
          const g = L.featureGroup(markersRef.current)
          mapRef.current.fitBounds(g.getBounds().pad(0.15))
        }
      }, 100)
    } catch (err) {
      alert('Errore nel caricamento punti.')
    }
    setLoading(false)
  }

  function selectCrossing(c: Crossing) {
    setSelected(c)
    setAnalysis('')
    setImageUrl('')
    if (mapRef.current) {
      mapRef.current.setView([c.lat, c.lng], Math.max(mapRef.current.getZoom(), 17))
    }
    setSidebarOpen(false)

    // Carica l'analisi esistente se c'è
    fetch(`/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ crossingId: c.id }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.cached && data.analysis) {
          setAnalysis(data.analysis.ai_full_response)
          setImageUrl(data.analysis.image_url || '')
        }
      })
      .catch(() => {})
  }

  async function analyzeSelected(force = false) {
    if (!selected) return
    setAnalyzing(true)
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crossingId: selected.id, force }),
      })
      const data = await res.json()
      if (data.error) {
        alert('Errore AI: ' + data.error)
      } else {
        setAnalysis(data.analysis.ai_full_response)
        setImageUrl(data.analysis.image_url || '')
        const newStatus = data.crossing.status
        setCrossings((prev) =>
          prev.map((c) => (c.id === selected.id ? { ...c, status: newStatus } : c))
        )
        setSelected({ ...selected, status: newStatus })
      }
    } catch (err) {
      alert('Errore di rete.')
    }
    setAnalyzing(false)
  }

  async function analyzeBatch() {
    const pending = crossings.filter((c) => c.status === 'unknown').slice(0, 10)
    if (pending.length === 0) {
      alert('Tutti i punti sono già stati analizzati!')
      return
    }
    if (!confirm(`Analizzare ${pending.length} punti? Ci vorrà circa ${pending.length * 3} secondi.`))
      return

    setSidebarOpen(false)
    setBatchRunning(true)
    setBatchProgress({ done: 0, total: pending.length })

    for (let i = 0; i < pending.length; i++) {
      const c = pending[i]
      try {
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ crossingId: c.id }),
        })
        const data = await res.json()
        if (!data.error && data.crossing) {
          const newStatus = data.crossing.status
          setCrossings((prev) =>
            prev.map((cc) => (cc.id === c.id ? { ...cc, status: newStatus } : cc))
          )
        }
      } catch {}
      setBatchProgress({ done: i + 1, total: pending.length })
      if (i < pending.length - 1) {
        await new Promise((r) => setTimeout(r, 2000))
      }
    }

    setBatchRunning(false)
    setBatchProgress(null)
  }

  async function searchZone() {
    if (!zone.trim()) return
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(zone + ', Roma')}&format=json&limit=1`
      )
      const data = await res.json()
      if (data[0]) {
        const newCenter: [number, number] = [parseFloat(data[0].lat), parseFloat(data[0].lon)]
        setCenter(newCenter)
        setLocationLabel(`📍 ${data[0].display_name.split(',')[0]}`)
        mapRef.current?.setView(newCenter, 16)
        setSidebarOpen(false)
      } else {
        alert('Zona non trovata.')
      }
    } catch {
      alert('Errore di rete.')
    }
  }

  const stats = {
    ok: crossings.filter((c) => c.status === 'ok').length,
    bad: crossings.filter((c) => c.status === 'bad').length,
    partial: crossings.filter((c) => c.status === 'partial').length,
    total: crossings.length,
  }

  const statusLabel = (s: CrossingStatus) => {
    const map = {
      ok: { cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500', label: '✓ Rampa' },
      bad: { cls: 'bg-rose-500/15 text-rose-400 border-rose-500', label: '✗ Nessuna' },
      partial: { cls: 'bg-amber-500/15 text-amber-400 border-amber-500', label: '~ Parziale' },
      unknown: { cls: 'bg-gray-500/15 text-gray-400 border-gray-500', label: '? N/D' },
    }
    return map[s]
  }

  return (
    <>
      <div id="map" className="fixed inset-0 z-[1] bg-neutral-900" />

      <div className="fixed top-0 left-0 right-0 h-14 bg-black/80 backdrop-blur-xl border-b border-white/10 flex items-center gap-2 px-3 z-[100]">
        <button
          onClick={() => setSidebarOpen(true)}
          className="w-9 h-9 rounded-lg bg-white/10 border border-white/10 text-white text-xl flex items-center justify-center"
        >
          ☰
        </button>
        <div className="font-bold text-white">
          Accessi<span className="text-emerald-400">Map</span>
        </div>
        <div className="ml-auto flex gap-1.5 overflow-x-auto">
          <span className="text-xs px-2 py-1 rounded-full bg-white/10 border border-white/10 whitespace-nowrap text-white">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1" />
            {stats.ok}
          </span>
          <span className="text-xs px-2 py-1 rounded-full bg-white/10 border border-white/10 whitespace-nowrap text-white">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-400 mr-1" />
            {stats.bad}
          </span>
          <span className="text-xs px-2 py-1 rounded-full bg-white/10 border border-white/10 whitespace-nowrap text-white">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 mr-1" />
            {stats.partial}
          </span>
          <span className="text-xs px-2 py-1 rounded-full bg-white/10 border border-white/10 whitespace-nowrap text-white">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-400 mr-1" />
            {stats.total}
          </span>
        </div>
      </div>

      {batchProgress && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[150] bg-emerald-400 text-black px-4 py-2 rounded-lg font-bold text-sm shadow-lg">
          🤖 Analisi {batchProgress.done}/{batchProgress.total}…
        </div>
      )}

      <button
        onClick={toggleLayer}
        className="fixed bottom-5 right-3 z-50 bg-black/80 backdrop-blur border border-white/10 rounded-lg px-3 py-2 text-xs text-white font-mono"
      >
        {isSatellite ? '🛰 Satellite' : '🗺 Mappa'}
      </button>
      <div className="fixed bottom-5 left-3 z-50 bg-black/80 backdrop-blur border border-white/10 rounded-lg px-3 py-2 text-xs text-white font-mono max-w-[55%] overflow-hidden text-ellipsis whitespace-nowrap pointer-events-none">
        {locationLabel}
      </div>

      {sidebarOpen && (
        <div onClick={() => setSidebarOpen(false)} className="fixed inset-0 bg-black/60 z-[190]" />
      )}

      <div
        className={`fixed top-0 left-0 w-[min(350px,100vw)] h-full bg-neutral-900/95 backdrop-blur-xl border-r border-white/10 z-[200] flex flex-col transition-transform duration-300 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="font-bold text-lg text-white">
            Accessi<span className="text-emerald-400">Map</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="w-8 h-8 rounded-lg bg-white/10 border border-white/10 text-white"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="p-4 border-b border-white/10">
            <div className="text-[0.6rem] uppercase tracking-widest text-gray-400 mb-2 font-mono">
              🔍 Cerca zona
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={zone}
                onChange={(e) => setZone(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && searchZone()}
                placeholder="Trastevere, Via Appia…"
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-emerald-400 font-mono"
              />
              <button
                onClick={searchZone}
                className="bg-emerald-400 text-black px-3 py-2 rounded-lg font-bold text-sm"
              >
                Cerca
              </button>
            </div>
          </div>

          <div className="p-4 border-b border-white/10">
            <div className="text-[0.6rem] uppercase tracking-widest text-gray-400 mb-2 font-mono">
              📏 Raggio di ricerca
            </div>
            <div className="flex items-center gap-3 mb-3">
              <span className="text-xs text-gray-400 font-mono">Raggio:</span>
              <input
                type="range"
                min={100}
                max={2000}
                step={100}
                value={radius}
                onChange={(e) => setRadius(parseInt(e.target.value))}
                className="flex-1 accent-emerald-400"
              />
              <span className="text-sm text-emerald-400 font-mono min-w-[50px] text-right">
                {radius >= 1000 ? `${(radius / 1000).toFixed(1)} km` : `${radius} m`}
              </span>
            </div>
            <button
              onClick={loadCrossings}
              disabled={loading}
              className="w-full bg-emerald-400 text-black py-2.5 rounded-lg font-bold text-sm disabled:opacity-50 mb-2"
            >
              {loading ? 'Caricamento…' : '📍 Carica attraversamenti'}
            </button>
            <button
              onClick={analyzeBatch}
              disabled={batchRunning || crossings.length === 0}
              className="w-full bg-white/10 border border-white/10 text-white py-2.5 rounded-lg font-bold text-sm disabled:opacity-50"
            >
              {batchRunning ? 'Analisi in corso…' : '🤖 Analizza tutti (max 10)'}
            </button>
          </div>

          <div className="p-4 border-b border-white/10">
            <div className="text-[0.6rem] uppercase tracking-widest text-gray-400 mb-2 font-mono">
              Legenda
            </div>
            <div className="flex flex-wrap gap-3 text-xs font-mono text-gray-400">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                Con rampa
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-rose-400" />
                Senza
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                Parziale
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-gray-400" />
                N/D
              </span>
            </div>
          </div>

          <div className="px-4 pt-3 pb-1 text-[0.6rem] uppercase tracking-widest text-gray-400 font-mono">
            Attraversamenti ({crossings.length})
          </div>
          <div className="px-3 pb-4">
            {crossings.length === 0 ? (
              <div className="text-center py-8 text-gray-500 font-mono text-xs">
                🗺️
                <br />
                Clicca &quot;Carica attraversamenti&quot;
              </div>
            ) : (
              crossings.map((c) => {
                const sb = statusLabel(c.status)
                return (
                  <div
                    key={c.id}
                    onClick={() => selectCrossing(c)}
                    className={`bg-white/5 border rounded-lg p-3 mb-1.5 cursor-pointer transition ${
                      selected?.id === c.id
                        ? 'border-emerald-400 bg-emerald-400/10'
                        : 'border-white/10 hover:border-emerald-400/50'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <div className="text-sm font-semibold text-white flex-1 truncate">
                        {c.name || `Punto #${c.id}`}
                      </div>
                      <span
                        className={`text-[0.6rem] font-mono px-2 py-0.5 rounded-full border ${sb.cls}`}
                      >
                        {sb.label}
                      </span>
                    </div>
                    <div className="text-[0.65rem] text-gray-400 font-mono">
                      {c.lat.toFixed(5)}, {c.lng.toFixed(5)}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {selected && (
        <div className="fixed bottom-0 left-0 right-0 bg-neutral-900/95 backdrop-blur-xl border-t border-white/10 rounded-t-2xl p-4 pb-6 z-[150] max-h-[80vh] overflow-y-auto">
          <div className="w-10 h-1 bg-white/20 rounded mx-auto mb-3" />
          <button
            onClick={() => setSelected(null)}
            className="absolute top-3 right-3 w-8 h-8 rounded-lg bg-white/10 border border-white/10 text-white text-sm"
          >
            ✕
          </button>
          <div className="font-bold mb-1 pr-10 text-white">
            {selected.name || `Punto #${selected.id}`}
          </div>
          <div className="text-xs text-gray-400 font-mono mb-3">
            {selected.lat.toFixed(6)}, {selected.lng.toFixed(6)}
          </div>

          <div className="w-full h-44 bg-white/5 border border-white/10 rounded-xl overflow-hidden mb-3 flex items-center justify-center">
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt="Vista stradale" className="w-full h-full object-cover" />
            ) : (
              <div className="text-center text-gray-400 text-xs font-mono p-4">
                📷
                <br />
                Premi Analizza per caricare
              </div>
            )}
          </div>

          {analysis && (
            <div className="bg-white/5 border border-white/10 rounded-lg p-3 mb-3 text-sm text-white leading-relaxed">
              <div className="text-[0.6rem] uppercase tracking-widest text-emerald-400 mb-1.5 font-mono">
                🤖 Analisi AI
              </div>
              <div
                dangerouslySetInnerHTML={{
                  __html: analysis
                    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                    .replace(/\n/g, '<br>'),
                }}
              />
            </div>
          )}

          <button
            onClick={() => analyzeSelected(!!analysis)}
            disabled={analyzing}
            className="w-full bg-emerald-400 text-black py-3 rounded-lg font-bold disabled:opacity-50"
          >
            {analyzing ? '⏳ Analisi in corso…' : analysis ? '🔄 Rianalizza' : '🤖 Analizza con AI'}
          </button>
        </div>
      )}
    </>
  )
}