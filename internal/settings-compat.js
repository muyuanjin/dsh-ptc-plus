/**
 * Whether the installed settings generation owns the plugin's exported `Config`
 * document.
 *
 * A generation that still attaches through the provider section installer — on
 * its settings service, or on the package helper an older release published —
 * validates the plugin's own fields and has no volatile contract. The
 * generation that serves the exported `Config` itself, and commits only fields
 * marked volatile, publishes neither installer. Both probes read the installed
 * public surface, so no release identity selects the shape.
 *
 * @param settingsModule - the installed public settings package surface.
 * @returns whether that generation serves the plugin's Config document itself.
 */
export function hostOwnsSettingsDocument(settingsModule) {
  return typeof settingsModule?.installSettingsSection !== 'function'
    && typeof settingsModule?.SettingsProvider?.prototype?.installSection !== 'function'
}

/**
 * Build one exported `Config` field for the installed settings generation.
 *
 * A generation that serves the document itself keeps a form mounted and commits
 * new values into the retained handle only for fields whose nearest schema
 * ancestor is marked volatile, so the marker is applied there. A builder that
 * does not publish that capability keeps the plain described field and lets the
 * host report its own missing volatile contract instead of failing this import;
 * the generation that installs its own section validates the same fields itself
 * and must not receive the marker, because its validated defaults would become
 * live handles its document path never commits.
 *
 * @param options.Schema - the schema builder the plugin imports.
 * @param options.field - one field definition from `internal/config-spec.js`.
 * @param options.settingsModule - the installed public settings package surface.
 * @returns the Cordis schema field for that definition.
 */
export function configFieldSchema({ Schema, field, settingsModule }) {
  const base = field.type === 'boolean'
    ? Schema.boolean().default(field.default)
    : field.type === 'enum'
      // Keep omission visible until resolveConfig migrates legacy policies.
      ? Schema.union(field.options.map(option => Schema.const(option)))
      : Schema.number().step(1).min(field.min).max(field.max).default(field.default)
  const described = base.description(field.description)
  if (!hostOwnsSettingsDocument(settingsModule)) return described
  return typeof described.volatile === 'function' ? described.volatile() : described
}

/** Install an optional settings section across current and legacy DSH settings APIs. */
export function installSettingsSectionCompat({
  ctx,
  settingsModule,
  namespace,
  schema,
  entry,
  hooks,
  ownerFiber,
  onProvider,
}) {
  ctx.inject(['settings'], settingsContext => {
    const provider = settingsContext.settings
    onProvider(provider)
    if (typeof provider?.installSection === 'function') {
      provider.installSection(ctx, namespace, schema, entry, hooks)
      return
    }
    if (typeof settingsModule?.installSettingsSection !== 'function') {
      // The newest settings generation owns its document and card from the
      // plugin's exported Config, so it exposes no section installer to call.
      // Treat that shape as a host-owned surface instead of a load failure;
      // the host commits volatile-only changes into the retained handles and
      // notifies this fiber through `loader/volatile-update`.
      if (typeof provider?.configure === 'function') {
        // The host records the own-page policy against the profile entry's own
        // fiber, so the owner is the plugin's entry context rather than the
        // scope this installation happens to run in.
        const dispose = provider.configure({ auto: false }, ownerFiber ?? ctx.fiber)
        ctx.effect?.(() => dispose, 'ptc-plus settings page policy')
      }
      return
    }
    const mountedOwner = new Proxy(ctx, {
      get(target, property) {
        if (property === 'inject') {
          return (_services, attach) => attach(settingsContext)
        }
        return Reflect.get(target, property, target)
      },
    })
    settingsModule.installSettingsSection(mountedOwner, namespace, schema, entry, hooks)
  })
}
