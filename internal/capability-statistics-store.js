import { effectiveCapabilitySettings } from './capability-policy.js'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { capabilityCoverage, createCapabilityStatistics, reduceCapabilityStatistics, validateCapabilityStatistics } from './capability-statistics.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const evidence = { tool: 'host-execution-result', task: 'host-execution-result', skill: 'skill-body-accepted', resource: 'resource-access', 'resource-template': 'resource-access' }

/** Locked metadata only; never persists arguments, results, resource contents or Skill bodies. */
export class CapabilityStatisticsStore {
  constructor({ filename, ctx, dshHome } = {}) {
    this.filename = resolve(filename ?? join(resolveDshHome(dshHome), 'ptc-plus', 'capability-statistics.json'))
    this.userId = hash(dirname(this.filename))
    this.ctx = ctx
    this.tail = Promise.resolve()
  }

  async read(windowSize) {
    let value
    try { value = JSON.parse(await readFile(this.filename, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { schema: 'ptc-capability-statistics-store/v1', nextOrder: 1, members: [], families: [],
        state: createCapabilityStatistics({ windowSize, maxFamilies: 10000, maxScopes: 20000, maxCapabilitiesPerFamily: 2000 }) }
    }
    if (value?.schema !== 'ptc-capability-statistics-store/v1' || !Array.isArray(value.members)
      || !Array.isArray(value.families) || value.families.length > 10000
      || value.members.length > 10000 || !Number.isSafeInteger(value.nextOrder) || value.nextOrder < 1) throw new TypeError('damaged capability statistics store')
    validateCapabilityStatistics(value.state)
    const identities = new Set()
    const orders = new Set()
    for (const family of value.families) {
      if (typeof family?.id !== 'string' || !family.id.trim() || identities.has(family.id)
        || !Number.isSafeInteger(family.observationRevision) || family.observationRevision < 0
        || (family.eligibleOrder !== null && (!Number.isSafeInteger(family.eligibleOrder)
          || family.eligibleOrder < 1 || family.eligibleOrder >= value.nextOrder || orders.has(family.eligibleOrder)))) {
        throw new TypeError('damaged capability statistics family provenance')
      }
      identities.add(family.id)
      if (family.eligibleOrder !== null) orders.add(family.eligibleOrder)
    }
    for (const retained of value.state.families) {
      const family = value.families.find(item => item.id === retained.familyId)
      if (retained.userId !== this.userId || !family || (value.state.status === 'usable'
        && (family.eligibleOrder !== retained.eligibleOrder || family.observationRevision !== retained.observationRevision))) {
        throw new TypeError('inconsistent capability statistics family provenance')
      }
    }
    if (value.state.windows.some(window => window.userId !== this.userId || window.floor >= value.nextOrder)) {
      throw new TypeError('inconsistent capability statistics qualification frontier')
    }
    for (const member of value.members) {
      if (typeof member.id !== 'string' || typeof member.familyId !== 'string' || !identities.has(member.familyId)
        || !['active', 'settled', 'unknown'].includes(member.status)) throw new TypeError('damaged capability statistics member')
    }
    if (new Set(value.members.map(item => item.id)).size !== value.members.length) throw new TypeError('duplicate capability statistics member')
    if (value.state.limits.windowSize !== windowSize) throw new TypeError('statistics window changed; retained samples are unavailable')
    return value
  }

  family(agent) {
    let session = agent.session
    const visited = new Set()
    while (session.header?.origin === 'subagent' && session.header?.parentSession) {
      if (visited.has(session.id)) return null
      visited.add(session.id)
      session = this.ctx?.sessions?.get?.(session.header.parentSession)
        ?? this.ctx?.agents?.get?.(session.header.parentSession)?.session
      if (!session) return null
    }
    return session.id
  }

  memberSettlement(session, live) {
    if (live && live.status !== 'idle') return 'active'
    const events = session.snapshotEvents().filter(event => session.isOwnSeq?.(event.seq) !== false)
    const start = events.findLast(event => event.type === 'turn/start')
    if (!start) return 'unknown'
    const end = events.findLast(event => event.type === 'turn/end' && event.data.turn === start.data.turn)
    const entered = events.some(event => event.type === 'step/start' && event.data.turn === start.data.turn)
    if (!end) return live ? 'active' : 'unknown'
    if (end.data.reason?.kind !== 'completed' || !entered) return 'unknown'
    if (live?.inbox?.nextStep?.length || live?.inbox?.nextTurn?.length) return 'active'
    return 'settled'
  }

  mutate(agent, snapshot, additions = [], status = 'active') {
    const settings = effectiveCapabilitySettings(snapshot.settings).statistics
    if (!snapshot.settings.policy && !snapshot.plan.enabled || settings?.enabled !== true || !Number.isSafeInteger(settings.windowSize)
      || settings.windowSize < 1 || settings.windowSize > 10000) return Promise.resolve()
    const familyId = this.family(agent)
    if (!familyId) return Promise.resolve()
    const operation = async () => {
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
      return withFileLock(this.filename, async () => {
        const document = await this.read(settings.windowSize)
        if (document.state.status !== 'usable') return
        const retained = structuredClone(document)
        const capacityExceeded = async () => {
          retained.state.status = 'capacity-exceeded'
          await writeFileAtomic(this.filename, JSON.stringify(retained) + '\n', { mode: 0o600, dirMode: 0o700 })
        }
        if (additions.length > document.state.limits.maxCapabilitiesPerFamily) return capacityExceeded()
        const liveAgents = this.ctx?.agents?.list?.()
        const sessions = this.ctx?.sessions?.list?.()
        const completeCensus = Array.isArray(liveAgents) && Array.isArray(sessions)
        const known = new Map((sessions ?? []).map(session => [session.id, session]))
        for (const live of liveAgents ?? []) known.set(live.session.id, live.session)
        known.set(agent.session.id, agent.session)
        for (const session of known.values()) {
          if (this.family({ session }) !== familyId) continue
          let member = document.members.find(item => item.id === session.id)
          if (!member) { member = { id: session.id, familyId, status: 'unknown' }; document.members.push(member) }
          if (member.familyId !== familyId) throw new TypeError('capability statistics lineage changed')
          const live = (liveAgents ?? []).find(item => item.session.id === session.id)
          member.status = completeCensus ? this.memberSettlement(session, live) : 'unknown'
          if (session.id === agent.session.id && status !== 'idle') member.status = 'active'
        }
        // A missing descendant or an incomplete public census cannot establish
        // a family denominator, even if every observed agent currently is idle.
        for (const member of document.members.filter(item => item.familyId === familyId)) {
          if (!known.has(member.id)) member.status = 'unknown'
        }
        const familyMembers = document.members.filter(item => item.familyId === familyId)
        const settlement = familyMembers.every(item => item.status === 'settled') ? 'settled'
          : familyMembers.some(item => item.status === 'unknown') ? 'unknown' : 'active'
        // Window eviction removes sample payloads, never the immutable family
        // qualification or revision used by restored and concurrent observers.
        let provenance = document.families.find(item => item.id === familyId)
        if (!provenance) {
          provenance = { id: familyId, observationRevision: -1, eligibleOrder: null }
          document.families.push(provenance)
        }
        if (document.families.length > 10000 || provenance.observationRevision >= Number.MAX_SAFE_INTEGER
          || document.nextOrder >= Number.MAX_SAFE_INTEGER) return capacityExceeded()
        provenance.eligibleOrder ??= settlement === 'settled' ? document.nextOrder++ : null
        provenance.observationRevision++
        document.state = reduceCapabilityStatistics(document.state, { type: 'family-observation', userId: this.userId, familyId,
          observationRevision: provenance.observationRevision, settlement, eligibleOrder: provenance.eligibleOrder, observations: additions })
        if (document.members.length > 10000) return capacityExceeded()
        await writeFileAtomic(this.filename, JSON.stringify(document) + '\n', { mode: 0o600, dirMode: 0o700 })
      })
    }
    const task = this.tail.then(operation, operation)
    this.tail = task.catch(() => {})
    return task
  }

  observations(agent, snapshot, id, useEvidence = null, outcome = null) {
    const workspaceId = hash(resolve(agent.session.header.cwd))
    return snapshot.plan.entries.filter(entry => ['full', 'on-demand', 'host'].includes(entry.selection)
      && (id === undefined || entry.id === id)).map(entry => ({ workspaceId,
      id: entry.id, revision: entry.revision, category: entry.category, disclosure: entry.selection,
      planRevision: snapshot.plan.configurationRevision, useEvidence, outcome }))
  }

  available(agent, snapshot) { return this.mutate(agent, snapshot, this.observations(agent, snapshot)) }
  used(agent, snapshot, id, useEvidence, outcome) {
    const entry = snapshot.plan.entries.find(item => item.id === id)
    if (!entry || evidence[entry.category] !== useEvidence) return Promise.resolve()
    return this.mutate(agent, snapshot, this.observations(agent, snapshot, id, useEvidence, outcome))
  }
  status(agent, snapshot, status) { return this.mutate(agent, snapshot, [], status) }

  async coverage(agent, capabilities, settings) {
    try {
      await this.tail
      const { state } = await this.read(settings.windowSize)
      const workspaceId = hash(resolve(agent.session.header.cwd))
      return Object.fromEntries(capabilities.map(item => [item.id, { revision: item.revision,
        workspace: capabilityCoverage(state, { userId: this.userId, workspaceId, id: item.id, revision: item.revision }),
        global: capabilityCoverage(state, { userId: this.userId, workspaceId: null, id: item.id, revision: item.revision }) }]))
    } catch (error) {
      this.ctx?.logger?.warn?.('ptc-plus: automatic allocation unavailable; retaining manual capability settings', error)
      return null
    }
  }
}
