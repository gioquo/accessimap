// Utility geografiche condivise tra route API e componenti

export function toRad(deg: number) { return (deg * Math.PI) / 180 }
export function toDeg(rad: number) { return (rad * 180) / Math.PI }

export function offsetPoint(lat: number, lng: number, distM: number, bearingDeg: number) {
  const R = 6371000
  const brng = toRad(bearingDeg)
  const latR = toRad(lat); const lngR = toRad(lng)
  const dR = distM / R
  const newLat = Math.asin(Math.sin(latR) * Math.cos(dR) + Math.cos(latR) * Math.sin(dR) * Math.cos(brng))
  const newLng = lngR + Math.atan2(Math.sin(brng) * Math.sin(dR) * Math.cos(latR), Math.cos(dR) - Math.sin(latR) * Math.sin(newLat))
  return { lat: toDeg(newLat), lng: toDeg(newLng) }
}

export function bearingTo(lat1: number, lng1: number, lat2: number, lng2: number) {
  const dLng = toRad(lng2 - lng1)
  const y = Math.sin(dLng) * Math.cos(toRad(lat2))
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000
  const dLat = toRad(lat2 - lat1); const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Pitch fisico per Street View: punta esattamente al suolo alla distanza target
// Camera Street View ~1.4m → arctan(1.4/dist) gradi verso il basso
export function pitchForDist(dist: number) {
  return -Math.round(Math.atan2(1.4, Math.max(dist, 3)) * 180 / Math.PI)
}

// Validazione coordinate: rifiuta NaN, fuori range, nullish
export function isValidLatLng(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    !isNaN(lat) && !isNaN(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180
  )
}
