import type { Metadata, Viewport } from 'next'
import './globals.css'
import 'leaflet/dist/leaflet.css'
import { ToastContainer } from '../components/Toast'

export const metadata: Metadata = {
  title: 'AccessiMap — Rampe Roma',
  description: 'Mappa accessibilità attraversamenti pedonali a Roma',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'AccessiMap',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0d0e10',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="it">
      <body className="bg-neutral-950 text-white overflow-hidden">
        {children}
        <ToastContainer />
      </body>
    </html>
  )
}