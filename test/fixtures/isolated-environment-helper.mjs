process.once('message', (message) => {
  const report = {
    helper: process.env.ELECTRON_RUN_AS_NODE ?? null,
    worker: message?.env?.ELECTRON_RUN_AS_NODE ?? null,
  }
  process.send({ type: 'worker-message', value: report }, () => process.disconnect())
})
