import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as config from 'virtual:morphkit'
import { LocalStore, MorphkitProvider } from '@morphkit/runtime'
import { MorphkitChat } from '@morphkit/ui'
import './index.css'
import App from './App.tsx'

// one user in this example; use your signed-in user's id
const userId = 'demo-user'
const store = new LocalStore('t1-vite')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MorphkitProvider config={config} store={store} userId={userId}>
      <App />
      <MorphkitChat agentUrl="/agent" />
    </MorphkitProvider>
  </StrictMode>,
)
