/** Install an optional settings section across current and legacy DSH settings APIs. */
export function installSettingsSectionCompat({
  ctx,
  settingsModule,
  namespace,
  schema,
  entry,
  hooks,
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
      throw new Error('ptc-plus: incompatible settings service; expected installSection or installSettingsSection')
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
