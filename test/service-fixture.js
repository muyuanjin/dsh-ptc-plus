import { Service } from '@deepseek-ai/cordis'

/**
 * Construct a service and settle the init it schedules.
 *
 * A registry publishes its service when it is constructed, but does the asynchronous work
 * that makes that service usable — registering projections, binding a factory — in its
 * `Service.init`. Constructing it on the fixture's own context keeps it visible to every
 * plugin later mounted on that context; awaiting the init here makes the service usable
 * before the test creates an agent. Mounting it with `ctx.plugin` would register it in a
 * child fiber the next plugin cannot see.
 */
export async function settleService(service) {
  const init = service?.[Service.init]
  if (typeof init === 'function') await init.call(service)
  return service
}
