import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as config from 'virtual:pleatkit'
import { HttpStore, PleatkitProvider } from '@pleatkit/runtime'
import { PleatkitChat } from '@pleatkit/ui'
import './index.css'
import App from './App.tsx'

// one user in this example; use your signed-in user's id
const userId = 'demo-user'
// edits live in store-server (`pnpm store`), so they follow the user to other browsers and an admin can see them
const store = new HttpStore({ baseUrl: '/pleatkit-store', userId, appId: 't1-vite' })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PleatkitProvider config={config} store={store} userId={userId}>
      <App />
      <PleatkitChat agentUrl="/agent" />
    </PleatkitProvider>
  </StrictMode>,
)
