<script setup lang="ts">
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph'
import * as THREE from 'three'
import {
  BLUE, flowRanks, KIND_COLOR, KIND_LABEL, mainFlow, RED, type GNode, type Graph, type NodeKind, type Trace,
} from '~/utils/supernode'

const props = defineProps<{ graph: Graph; red: Trace; blue: Trace; selectedId: string | null }>()
const emit = defineEmits<{ select: [id: string | null] }>()

type Ring = 'sel' | 'red' | 'blue'
type RNode = GNode & {
  x?: number; y?: number; z?: number; vx?: number; vy?: number; vz?: number
  fx?: number; fy?: number; fz?: number
  tx?: number; ty: number; tz: number // layout target
  mesh?: THREE.Mesh<THREE.SphereGeometry, THREE.MeshLambertMaterial>
  text?: THREE.Sprite
  rings?: Record<Ring, THREE.Sprite>
}
type RLink = { source: string | RNode; target: string | RNode; kind: string; main?: boolean; overlay?: 'red' | 'blue' }

const RADIUS: Record<NodeKind, number> = {
  supernode: 11, equipment: 7.5, boundary: 5.5, line: 1.8, valve: 2.8, instrument: 2.4, interlock: 3.4, utility: 3.2, condition: 4.2,
}
const BIG: NodeKind[] = ['supernode', 'equipment', 'boundary']
// Main flow runs left → right at MAIN_Y; side streams sit above and behind it, tags below, conditions on top.
const LAYER_Y: Record<NodeKind, number> = {
  supernode: 130, equipment: 85, boundary: 85, line: 85, valve: -20, instrument: -20, interlock: -20, utility: -70, condition: 160,
}
const MAIN_Y = 40
const SIDE_Z = -40
const X_STEP = 70
const BRANCH_GAP = 24
const LABEL_DIST = 220 // small labels appear when the camera is closer than this
const RING: Record<Ring, { color: string; scale: number }> = {
  sel: { color: '#27272a', scale: 1.4 }, red: { color: RED, scale: 1.8 }, blue: { color: BLUE, scale: 2.25 },
}
const LINK_STYLE: Record<string, { color: string; width: number }> = {
  main: { color: '#52514e', width: 1.6 },
  flow: { color: '#b5b4ad', width: 0.5 },
  contains: { color: '#d4d3cc', width: 0.3 },
  tag: { color: '#c9c8c0', width: 0 },
  utility: { color: '#c9c8c0', width: 0 },
  acts_on: { color: '#e8c3d2', width: 0 },
  signal: { color: '#b9b4dc', width: 0 },
  red: { color: RED, width: 2.4 },
  blue: { color: BLUE, width: 1.6 },
}
const FADED = '#e4e3dd'
const LINK_DISTANCE: Record<string, number> = { flow: 26, contains: 55, tag: 14, utility: 22, acts_on: 40, signal: 12 }

const flow = mainFlow(props.graph)
const badges = new Map<string, string>([...flow.starts.map(id => [id, 'START'] as const), ...flow.ends.map(id => [id, 'END'] as const)])

const el = ref<HTMLDivElement>()
const hidden = ref(new Set<NodeKind>())
let fg: ForceGraph3DInstance<RNode, RLink> | undefined
let nodes: RNode[] = []
let baseLinks: RLink[] = []
let raf = 0
let fitted = false
let resizeObserver: ResizeObserver | undefined
let ringTexture: THREE.CanvasTexture | undefined
let hoverId: string | null = null
let hoverSet = new Set<string>()

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const endOf = (e: string | RNode) => (typeof e === 'string' ? e : e.id)
const kindOf = (e: string | RNode) => props.graph.byId.get(endOf(e))?.kind
const styleOf = (l: RLink) => LINK_STYLE[l.overlay ?? (l.main ? 'main' : l.kind)]!

function textSprite(text: string, height: number, weight: number, color: string, bg?: string) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const font = `${weight} 48px Inter, sans-serif`
  const pad = bg ? 28 : 4
  ctx.font = font
  canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2
  canvas.height = bg ? 72 : 60
  ctx.font = font // resizing the canvas resets the context
  if (bg) {
    ctx.fillStyle = bg
    ctx.beginPath()
    ctx.roundRect(0, 0, canvas.width, canvas.height, canvas.height / 2)
    ctx.fill()
  }
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, canvas.width / 2, canvas.height / 2)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }))
  sprite.scale.set((height * canvas.width) / canvas.height, height, 1)
  return sprite
}

/** Dashed circle drawn around a node; rotating it gives the "animated stroke". */
function ringSprite(color: string, size: number) {
  if (!ringTexture) {
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const ctx = c.getContext('2d')!
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 8
    ctx.setLineDash([16, 10])
    ctx.beginPath()
    ctx.arc(64, 64, 56, 0, Math.PI * 2)
    ctx.stroke()
    ringTexture = new THREE.CanvasTexture(c)
  }
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture, color, transparent: true, depthWrite: false }))
  sprite.scale.set(size, size, 1)
  sprite.visible = false
  sprite.raycast = () => {} // rings must not steal clicks from neighbouring nodes
  return sprite
}

function nodeObject(n: RNode) {
  const r = RADIUS[n.kind]
  const big = BIG.includes(n.kind)
  const group = new THREE.Group()
  n.mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), new THREE.MeshLambertMaterial({ color: KIND_COLOR[n.kind], transparent: true }))
  n.text = textSprite(n.label, big ? 4.6 : 2.2, big ? 600 : 500, big ? '#0b0b0b' : '#52514e')
  n.text.position.y = n.kind === 'supernode' ? r + 5 : -(r + (big ? 3.8 : 2))
  group.add(n.mesh, n.text)
  const badge = badges.get(n.id)
  if (badge) {
    const b = textSprite(badge, 5, 700, '#ffffff', '#0b0b0b')
    b.position.y = r + 5.5
    group.add(b)
  }
  const ring = (k: Ring) => ringSprite(RING[k].color, r * 2 * RING[k].scale + 2)
  n.rings = { sel: ring('sel'), red: ring('red'), blue: ring('blue') }
  group.add(...Object.values(n.rings))
  return group
}

/** Pulls every free node toward its layout target (side streams above/behind, tags below). */
function layoutForce() {
  let ns: RNode[] = []
  const force = (alpha: number) => {
    for (const n of ns) {
      const k = (n.tx === undefined ? 0.08 : 0.6) * alpha // side-stream units/lines hold their row firmly
      n.vy! += (n.ty - n.y!) * k
      n.vz! += (n.tz - n.z!) * k
      if (n.tx !== undefined) n.vx! += (n.tx - n.x!) * k
    }
  }
  force.initialize = (all: RNode[]) => { ns = all }
  return force
}

function linkColor(l: RLink) {
  if (hoverId && !l.overlay && endOf(l.source) !== hoverId && endOf(l.target) !== hoverId) return FADED
  return styleOf(l).color
}

/** Hovering a node keeps it and its direct neighbours vivid and fades everything else. */
function setHover(n: RNode | null) {
  hoverId = n?.id ?? null
  hoverSet = new Set(n ? [n.id, ...(props.graph.adj.get(n.id) ?? []).map(e => e.id)] : [])
  fg?.linkColor(l => linkColor(l))
}

function animate() {
  const t = performance.now() / 1000
  const cam = fg?.camera().position
  for (const n of nodes) {
    if (!n.rings || !n.mesh || !n.text) continue
    const lit = n.id === props.selectedId || props.red.nodes.has(n.id) || props.blue.nodes.has(n.id) || hoverSet.has(n.id)
    const faded = hoverId !== null && !hoverSet.has(n.id)
    const near = !!cam && Math.hypot(cam.x - n.x!, cam.y - n.y!, cam.z - n.z!) < LABEL_DIST
    n.mesh.material.opacity = faded ? 0.15 : 1
    n.text.visible = BIG.includes(n.kind) || lit || near
    n.text.material.opacity = faded ? 0.25 : 1
    n.rings.sel.visible = n.id === props.selectedId
    for (const [key, set, dir] of [['red', props.red.nodes, 1], ['blue', props.blue.nodes, -1]] as const) {
      const s = n.rings[key]
      s.visible = set.has(n.id)
      if (!s.visible) continue
      s.material.rotation = dir * t * 1.5
      s.material.opacity = 0.65 + 0.35 * Math.sin(t * 4)
    }
  }
  raf = requestAnimationFrame(animate)
}

onMounted(async () => {
  await nextTick() // .client components render their template after mount (Nuxt docs)
  const ranks = flowRanks(props.graph)
  const maxRank = Math.max(0, ...ranks.values())
  // Parallel main-flow branches (same rank, e.g. pumps A/B) are spread vertically around MAIN_Y.
  const branchIndex = new Map<string, number>()
  const branchCount = new Map<number, number>()
  for (const id of flow.nodes) {
    const rank = ranks.get(id) ?? 0
    branchIndex.set(id, branchCount.get(rank) ?? 0)
    branchCount.set(rank, (branchCount.get(rank) ?? 0) + 1)
  }
  const supers = props.graph.nodes.filter(n => n.kind === 'supernode')

  nodes = props.graph.nodes.map((n) => {
    const rank = ranks.get(n.id)
    const main = flow.nodes.has(n.id)
    const rn: RNode = {
      ...n,
      ty: main ? MAIN_Y + (branchIndex.get(n.id)! - (branchCount.get(rank!)! - 1) / 2) * BRANCH_GAP : LAYER_Y[n.kind],
      tz: rank !== undefined && !main ? SIDE_Z : 0,
    }
    if (rank !== undefined) rn.tx = (rank - maxRank / 2) * X_STEP
    // One SuperNode sits in the centre; more spread out left/right around it.
    const i = supers.indexOf(n)
    if (i >= 0) Object.assign(rn, { fx: (i - (supers.length - 1) / 2) * 220, fy: LAYER_Y.supernode, fz: 0 })
    // The main flow is pinned on a straight START → END line; everything else lays out around it.
    if (main) Object.assign(rn, { fx: rn.tx, fy: rn.ty, fz: 0 })
    rn.x = rn.fx ?? rn.tx ?? (Math.random() - 0.5) * 100
    rn.y = rn.ty
    rn.z = rn.tz + (Math.random() - 0.5) * 30
    return rn
  })
  baseLinks = props.graph.links.map(l => ({ ...l, main: l.kind === 'flow' && flow.nodes.has(l.source) && flow.nodes.has(l.target) }))

  // Default trackball controls: with 'orbit', three r186 throws on the library's synthetic pointerup after a node click/drag.
  const g = new ForceGraph3D(el.value!) as unknown as ForceGraph3DInstance<RNode, RLink>
  fg = g
  g.width(el.value!.clientWidth)
    .height(el.value!.clientHeight)
    .backgroundColor('#ececec')
    .showNavInfo(false)
    .nodeThreeObject(nodeObject)
    .nodeLabel(n => `<b>${esc(n.id)}</b><br>${KIND_LABEL[n.kind]}${n.label !== n.id ? ` · ${esc(n.label)}` : ''}`)
    .nodeVisibility(n => !hidden.value.has(n.kind))
    .linkVisibility(l => !hidden.value.has(kindOf(l.source)!) && !hidden.value.has(kindOf(l.target)!))
    .linkColor(linkColor)
    .linkWidth(l => styleOf(l).width)
    .linkOpacity(0.9)
    .linkCurvature(l => (l.overlay === 'blue' ? 0.25 : 0))
    // Main flow always shows slow dots in the flow direction; red/blue paths get faster coloured dots.
    .linkDirectionalParticles(l => (l.overlay ? 3 : l.main ? 2 : 0))
    .linkDirectionalParticleWidth(l => (l.overlay ? 2.4 : 1.4))
    .linkDirectionalParticleSpeed(l => (l.overlay ? 0.012 : 0.004))
    .linkDirectionalParticleColor(l => (l.overlay ? styleOf(l).color : '#27272a'))
    .onNodeClick(n => emit('select', n.id))
    .onNodeHover(setHover)
    .onBackgroundClick(() => emit('select', null))
    .onNodeDragEnd(n => Object.assign(n, { fx: n.x, fy: n.y, fz: n.z }))
    .onEngineStop(() => {
      // Freeze the layout so later highlight updates don't move anything.
      for (const n of nodes) Object.assign(n, { fx: n.x, fy: n.y, fz: n.z })
      if (!fitted) {
        fitted = true
        g.zoomToFit(600, 40)
      }
    })
    // Lay out synchronously before the first frame, then settle by tick count (not wall time,
    // which stops early when the tab is hidden and frames are throttled).
    .warmupTicks(200)
    .cooldownTicks(80)
  g.d3Force('layout', layoutForce())
  g.d3Force('link')!.distance((l: RLink) => LINK_DISTANCE[l.kind] ?? 30)
  g.d3Force('charge')!.strength(-50)
  g.graphData({ nodes, links: baseLinks })

  resizeObserver = new ResizeObserver(([entry]) => g.width(entry!.contentRect.width).height(entry!.contentRect.height))
  resizeObserver.observe(el.value!)
  animate()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  resizeObserver?.disconnect()
  fg?._destructor()
})

// Red/blue paths are drawn as extra links on top of the base links, oriented in propagation order.
watch(() => [props.red, props.blue] as const, ([red, blue]) => {
  const overlay = (t: Trace, kind: 'red' | 'blue'): RLink[] => t.links.map(l => ({ ...l, kind, overlay: kind }))
  fg?.graphData({ nodes, links: [...baseLinks, ...overlay(red, 'red'), ...overlay(blue, 'blue')] })
})

// Fly to the selected node: keep the current viewing distance and angle, re-centre on the node.
watch(() => props.selectedId, (id) => {
  const n = nodes.find(x => x.id === id)
  if (!fg || !n) return
  const cam = fg.cameraPosition()
  const target = (fg.controls() as { target: THREE.Vector3 }).target
  const at = { x: n.x!, y: n.y!, z: n.z! }
  fg.cameraPosition({ x: at.x + cam.x - target.x, y: at.y + cam.y - target.y, z: at.z + cam.z - target.z }, at, 700)
})

function toggleKind(kind: NodeKind) {
  const next = new Set(hidden.value)
  if (!next.delete(kind)) next.add(kind)
  hidden.value = next
  // Re-set the accessors so the graph re-evaluates visibility.
  fg?.nodeVisibility(n => !next.has(n.kind))
    .linkVisibility(l => !next.has(kindOf(l.source)!) && !next.has(kindOf(l.target)!))
}

function zoom(factor: number) {
  if (!fg) return
  const cam = fg.cameraPosition()
  const t = (fg.controls() as { target: THREE.Vector3 }).target
  fg.cameraPosition({ x: t.x + (cam.x - t.x) * factor, y: t.y + (cam.y - t.y) * factor, z: t.z + (cam.z - t.z) * factor }, t, 300)
}

const LEGEND = (['equipment', 'boundary', 'line', 'valve', 'instrument', 'interlock', 'utility', 'condition'] as const)
  .filter(kind => props.graph.nodes.some(n => n.kind === kind))
  .map(kind => ({ kind, label: KIND_LABEL[kind], color: KIND_COLOR[kind] }))
</script>

<template>
  <div class="relative h-full w-full overflow-hidden rounded-xl">
    <!-- the library only reports "no hover" on moves inside the canvas, so clear it on leave -->
    <div ref="el" class="h-full w-full" @pointerleave="setHover(null)" />

    <div class="absolute right-3 top-3 flex flex-col gap-1.5">
      <button type="button" aria-label="Zoom in" class="size-9 rounded-lg bg-white text-lg shadow-sm hover:bg-zinc-50" @click="zoom(0.75)">+</button>
      <button type="button" aria-label="Zoom out" class="size-9 rounded-lg bg-white text-lg shadow-sm hover:bg-zinc-50" @click="zoom(1.33)">−</button>
      <button type="button" aria-label="Fit graph" class="size-9 rounded-lg bg-white text-sm shadow-sm hover:bg-zinc-50" @click="fg?.zoomToFit(500, 40)">⤢</button>
    </div>

    <div class="absolute bottom-3 left-3 right-3 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-700">
      <button
        v-for="l in LEGEND" :key="l.kind" type="button" :aria-pressed="!hidden.has(l.kind)" :title="`Show / hide ${l.label}`"
        class="flex items-center gap-1.5 rounded-full bg-white/80 px-2 py-0.5 hover:bg-white"
        :class="hidden.has(l.kind) && 'line-through opacity-40'"
        @click="toggleKind(l.kind)"
      >
        <i class="size-2.5 rounded-full" :style="{ background: l.color }" />{{ l.label }}
      </button>
      <span class="ml-1 flex items-center gap-1"><i class="h-[3px] w-4 rounded bg-[#52514e]" />Main flow</span>
      <span class="flex items-center gap-1"><i class="h-0.5 w-4" :style="{ background: RED }" />Consequence</span>
      <span class="flex items-center gap-1"><i class="h-0.5 w-4" :style="{ background: BLUE }" />Safeguard / IPL</span>
      <span class="ml-auto text-zinc-500">Drag to rotate · scroll to zoom · click a node</span>
    </div>
  </div>
</template>
