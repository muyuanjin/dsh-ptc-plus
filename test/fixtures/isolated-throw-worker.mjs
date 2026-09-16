await new Promise((resolve, reject) => {
  process.stderr.write('inner-worker-final-stderr-marker\n', error => {
    if (error === null || error === undefined) resolve()
    else reject(error)
  })
})

throw new Error('inner worker terminal failure')
