'use client'

import { useCallback, useEffect, useState } from 'react'

// Stato React persistito in localStorage. SSR-safe: usa l'initial al primo render,
// poi rehydrate dal localStorage al mount lato client.
export function usePersistedState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValueRaw] = useState<T>(initial)

  // Hydration: legge localStorage al mount client (necessario per SSR — non si può
  // accedere a localStorage nel render iniziale).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw !== null) {
        const parsed = JSON.parse(raw) as T
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setValueRaw(parsed)
      }
    } catch {
      // ignora valori corrotti
    }
  }, [key])

  // Setter che persiste in localStorage ad ogni cambio
  const setValue = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValueRaw((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v
        try { localStorage.setItem(key, JSON.stringify(next)) } catch {}
        return next
      })
    },
    [key]
  )

  return [value, setValue]
}
