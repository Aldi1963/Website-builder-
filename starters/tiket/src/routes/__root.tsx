import type { ReactNode } from 'react'
import { Outlet, createRootRoute, HeadContent, Scripts } from '@tanstack/react-router'
import styles from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    ],
    links: [
      { rel: 'stylesheet', href: styles },
      // Font Inter untuk tipografi yang rapi & konsisten.
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
      },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="id">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-dvh bg-slate-950 text-slate-100 antialiased">
        {children}
      <script
        dangerouslySetInnerHTML={{
          __html: `if(typeof Buffer==='undefined'){globalThis.Buffer={from(v,enc){const a=typeof v==='string'?(enc==='hex'?Uint8Array.from(v.match(/../g)||[],x=>parseInt(x,16)):Uint8Array.from(atob(v),c=>c.charCodeAt(0))):v;return{length:a.length,[Symbol.iterator]:a[Symbol.iterator].bind(a),toString(e){if(e==='hex')return Array.from(a,x=>x.toString(16).padStart(2,'0')).join('');let s='';for(const b of a)s+=String.fromCharCode(b);return btoa(s)},write(s,off){for(let i=0;i<s.length;i++)a[off+i]=s.charCodeAt(i);return i},byteLength:a.length}},isBuffer(){return false}}}`,
        }}
      />
        <Scripts />
      </body>
    </html>
  )
}
