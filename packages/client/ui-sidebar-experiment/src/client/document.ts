import type { PreviewBundle } from './bundle.ts'

function text(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function base64(bytes: Uint8Array): string {
  let value = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(value)
}

function replaceRequired(source: string, target: string, replacement: string): string {
  if (!source.includes(target)) throw new Error('Unsupported preview resource')
  return source.replaceAll(target, replacement)
}

/**
 * Embed checked preview bytes in an opaque-origin HTML document and replace the viewer's resource URLs with local blob-backed values.
 * The bundle identity and endpoint must match the URLs embedded in the fetched viewer and script resources.
 * @param bundle - resources returned by {@link fetchPreviewBundle} for this preview identity.
 * @param session - session id used to form the expected resource URLs; demo callers pass `demo`.
 * @param id - published experiment id used in the expected resource URLs.
 * @param revision - checked experiment revision used in the expected resource URLs.
 * @param task - protocol-check task id used in the expected resource URLs.
 * @param endpoint - preview route used by those URLs; defaults to `/api/experiment-preview`, or use `/api/experiment-demo`.
 * @returns an HTML string containing the bundled resources and CSP-limited bootstrap code.
 * @throws when a required resource reference is missing or bundled text is not valid UTF-8.
 */
export function createPreviewDocument(bundle: PreviewBundle, session: string, id: string, revision: number, task: string, endpoint: '/api/experiment-preview' | '/api/experiment-demo' = '/api/experiment-preview'): string {
  const url = (resource: string) => `${endpoint}?${new URLSearchParams({ id, revision: String(revision), session, task, resource })}`
  let viewer = text(bundle.viewer)
  let script = text(bundle.script)
  viewer = replaceRequired(viewer, url('three'), '__PREVIEW_THREE__')
  viewer = replaceRequired(viewer, url('script').replaceAll('&', '&amp;'), '__PREVIEW_SCRIPT__')
  script = replaceRequired(script, url('orbit'), '__PREVIEW_ORBIT__')
  for (const resource of ['info', 'analysis', 'view']) script = replaceRequired(script, url(resource), `__PREVIEW_${resource.toUpperCase()}__`)
  const assetExpression = `(${JSON.stringify(url('asset'))} + '&file=' + encodeURIComponent(item.file))`
  script = replaceRequired(script, assetExpression, 'globalThis.__previewAssets[item.file]')
  const payload = base64(new TextEncoder().encode(JSON.stringify({
    viewer, script, three: base64(bundle.three), orbit: base64(bundle.orbit),
    info: base64(bundle.info), analysis: base64(bundle.analysis), view: base64(bundle.view),
    assets: Object.fromEntries(Object.entries(bundle.assets).map(([name, bytes]) => [name, base64(bytes)])),
  })))
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src blob: data:; connect-src blob:; worker-src blob:; base-uri 'none'; form-action 'none'"><script>(()=>{
const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const payload=JSON.parse(new TextDecoder().decode(bytes('${payload}')));
const blob=(data,type)=>URL.createObjectURL(new Blob([data],{type}));
const three=blob(bytes(payload.three),'text/javascript');
const orbit=blob(bytes(payload.orbit),'text/javascript');
const info=blob(bytes(payload.info),'application/json');
const analysis=blob(bytes(payload.analysis),'application/json');
const view=blob(bytes(payload.view),'application/json');
globalThis.__previewAssets=Object.fromEntries(Object.entries(payload.assets).map(([name,data])=>[name,blob(bytes(data),'image/png')]));
let script=payload.script.replaceAll('__PREVIEW_ORBIT__',orbit).replaceAll('__PREVIEW_INFO__',info).replaceAll('__PREVIEW_ANALYSIS__',analysis).replaceAll('__PREVIEW_VIEW__',view);
const scriptUrl=blob(script,'text/javascript');
const html=payload.viewer.replaceAll('__PREVIEW_THREE__',three).replaceAll('__PREVIEW_SCRIPT__',scriptUrl);
document.open();document.write(html);document.close();
})()</script>`
}
