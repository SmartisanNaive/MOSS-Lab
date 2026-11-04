import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import logo from './assets/labscriptai-logo.webp'

/** Render the LabScriptAI mark at the size requested by its host. */
export function LabScriptBrandMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <img src={logo} alt="" width={size} height={size} className={className} style={{ borderRadius: '20%', objectFit: 'contain' }} />
}
