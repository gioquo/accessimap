'use client'

import { useEffect, useState } from 'react'

export interface ToastMessage {
  id: number
  text: string
  type: 'error' | 'success' | 'info'
}

let counter = 0
let dispatch: ((m: Omit<ToastMessage, 'id'>) => void) | null = null

// API globale: chiama showToast() da qualsiasi componente
export function showToast(text: string, type: ToastMessage['type'] = 'info') {
  if (dispatch) dispatch({ text, type })
  else console.warn('Toast not mounted yet:', text)
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  useEffect(() => {
    dispatch = (m) => {
      const id = ++counter
      setToasts((prev) => [...prev, { ...m, id }])
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000)
    }
    return () => { dispatch = null }
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[300] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`px-4 py-2.5 rounded-lg font-mono text-sm shadow-lg backdrop-blur border pointer-events-auto ${
            t.type === 'error'
              ? 'bg-rose-500/90 border-rose-400 text-white'
              : t.type === 'success'
              ? 'bg-emerald-500/90 border-emerald-400 text-black'
              : 'bg-neutral-800/95 border-white/20 text-white'
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
