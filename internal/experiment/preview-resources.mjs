import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const NO_STORE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const RESOURCE = '/api/experiment-preview'
const failure = status => new Response(null, { status, headers: NO_STORE })

function replaceRequired(source, original, replacement) {
  if (!source.includes(original)) throw new Error('unsupported Flex3D viewer version')
  return source.replace(original, replacement)
}

/** Serves only published previews. The surrounding connection route must authenticate owner peers. */
export class PreviewResources {
  constructor(store, flexRoot, resourcePath = RESOURCE) {
    this.store = store
    this.flexRoot = flexRoot
    this.resourcePath = resourcePath
    this.previews = new Map()
    this.selected = new Map()
  }

  publish(preview) {
    this.previews.set(preview.id, preview)
  }

  select(id) {
    const preview = this.previews.get(id)
    if (!preview) throw new Error('preview not published')
    this.selected.set(preview.sessionId, id)
  }

  withdraw(id) {
    const preview = this.previews.get(id)
    this.previews.delete(id)
    if (preview && this.selected.get(preview.sessionId) === id) this.selected.delete(preview.sessionId)
  }

  isCurrent(preview) {
    const experiment = this.store.get(preview.id)
    const last = this.store.getChecks(preview.id, preview.revision).filter(check => check.name === 'protocol-analysis').at(-1)
    return experiment.revision === preview.revision && experiment.snapshot.sessionId === preview.sessionId && !!last && last.status === 'passed' && last.taskId === preview.taskId && last.protocolHash === experiment.protocolHash && last.result?.analysisSha256 === preview.analysisSha256
  }

  async fetch(request) {
    if (request.method !== 'GET') return failure(405)
    const url = new URL(request.url)
    const id = url.searchParams.get('id')
    const revision = Number(url.searchParams.get('revision'))
    const resource = url.searchParams.get('resource')
    const sessionId = url.searchParams.get('session')
    if (!sessionId) return failure(400)
    try {
      if (resource === 'status') {
        const selected = this.previews.get(this.selected.get(sessionId))
        const status = selected && this.isCurrent(selected) ? { status: 'ready', id: selected.id, revision: selected.revision, task: selected.taskId } : { status: 'waiting' }
        return Response.json(status, { headers: NO_STORE })
      }
      if (!id || !Number.isSafeInteger(revision) || revision < 1 || !resource) return failure(400)
      const preview = this.previews.get(id)
      if (!preview || preview.revision !== revision || preview.sessionId !== sessionId) return failure(404)
      if (url.searchParams.get('task') !== preview.taskId || !this.isCurrent(preview)) return failure(409)
      const address = name => `${this.resourcePath}?${new URLSearchParams({ id, revision: String(revision), session: sessionId, task: preview.taskId, resource: name })}`
      let path
      let contentType
      if (resource === 'viewer') {
        let html = await readFile(join(this.flexRoot, 'viewer.html'), 'utf8')
        html = replaceRequired(html, '/vendor/three.module.js', address('three'))
        html = replaceRequired(html, '/viewer.js', address('script').replaceAll('&', '&amp;'))
        return new Response(html, { headers: { ...NO_STORE, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'" } })
      }
      if (resource === 'script') {
        let script = await readFile(join(this.flexRoot, 'web/viewer.js'), 'utf8')
        script = replaceRequired(script, '/vendor/OrbitControls.js', address('orbit'))
        script = replaceRequired(script, 'let key = params.get("key");', 'let key = "preview";')
        script = replaceRequired(script, '`/flex3d/${key}/assets/${item.file}`', `(${JSON.stringify(address('asset'))} + '&file=' + encodeURIComponent(item.file))`)
        script = replaceRequired(script, '`/flex3d/${key}/info`', JSON.stringify(address('info')))
        script = replaceRequired(script, '`/flex3d/${key}/analysis.json`', JSON.stringify(address('analysis')))
        script = replaceRequired(script, '`/flex3d/${key}/view.json`', JSON.stringify(address('view')))
        if (this.resourcePath === RESOURCE) script = replaceRequired(script, '  select(0);\n}', '  select(0);\n  playBtn.click();\n}')
        return new Response(script, { headers: { ...NO_STORE, 'Content-Type': 'text/javascript; charset=utf-8' } })
      }
      if (resource === 'orbit') { path = join(this.flexRoot, 'web/vendor/OrbitControls.js'); contentType = 'text/javascript; charset=utf-8' }
      else if (resource === 'three') { path = join(this.flexRoot, 'web/vendor/three.module.js'); contentType = 'text/javascript; charset=utf-8' }
      else if (resource === 'info') { path = join(preview.directory, 'info.json'); contentType = 'application/json; charset=utf-8' }
      else if (resource === 'analysis') { path = join(preview.directory, 'analysis.json'); contentType = 'application/json; charset=utf-8' }
      else if (resource === 'view') { path = join(preview.directory, 'view.json'); contentType = 'application/json; charset=utf-8' }
      else if (resource === 'asset') {
        const file = url.searchParams.get('file')
        if (!file || !/^[A-Za-z0-9_.-]+\.png$/.test(file)) return failure(400)
        path = join(preview.directory, 'flex_assets', file)
        contentType = 'image/png'
      } else return failure(404)
      const bytes = await readFile(path)
      return new Response(bytes, { headers: { ...NO_STORE, 'Content-Type': contentType } })
    } catch (error) {
      if (error?.code === 'NOT_FOUND' || error?.code === 'ENOENT') return failure(404)
      return failure(500)
    }
  }
}
