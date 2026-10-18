import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as config from 'virtual:pleatkit'
import { LocalStore, PleatkitProvider } from '@pleatkit/runtime'
import { PleatkitChat } from '@pleatkit/ui'
import './index.css'
import App from './App.tsx'

// one user in this example; use your signed-in user's id
const userId = 'demo-user'
const store = new LocalStore('t1-vite')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PleatkitProvider config={config} store={store} userId={userId}>
      <App />
      <PleatkitChat agentUrl="/agent" />
    </PleatkitProvider>
  </StrictMode>,
)
