import { template, types as t } from '@babel/core'

// Babel owns lexical lifetimes and abrupt-completion routing. This context
// stores only private state: GetMethod, Call and Await belong to the emitter.
const contextFactory = template.statement(`function HELPER() {
  const empty = {__proto__: null}, stack = [];
  return {
    __proto__: null, e: empty, stack,
    validate(value) {
      if (value != null && INTRINSICS.Object(value) !== value) {
        throw new INTRINSICS.TypeError('using declarations require an object, function, null, or undefined.');
      }
      return value;
    },
    add(value, dispose, asynchronous, fallback) {
      if (value != null && typeof dispose !== 'function') throw new INTRINSICS.TypeError('Object is not disposable.');
      if (value != null || asynchronous) stack.push({__proto__: null, v: value, d: dispose, a: asynchronous, f: fallback});
      return value;
    },
    suppress(error) {
      if (this.e !== empty) {
        if (typeof INTRINSICS.SuppressedError === 'function') error = new INTRINSICS.SuppressedError(error, this.e);
        else {
          const suppressed = new INTRINSICS.Error();
          INTRINSICS.Object.defineProperties(suppressed, {
            name: {value: 'SuppressedError', writable: true, configurable: true},
            error: {value: error, writable: true, configurable: true},
            suppressed: {value: this.e, writable: true, configurable: true}
          });
          error = suppressed;
        }
      }
      this.e = error;
    },
    finish() { if (this.e !== empty) throw this.e; }
  };
}`)

const acquisition = template.expression(`(
  VALUE = CONTEXT.validate(INITIALIZER),
  METHOD = VALUE == null ? void 0 : ASYNC ? VALUE[INTRINSICS.Symbol.asyncDispose] : void 0,
  FALLBACK = ASYNC && METHOD == null,
  METHOD = VALUE != null && METHOD == null ? VALUE[INTRINSICS.Symbol.dispose] : METHOD,
  CONTEXT.add(VALUE, METHOD, ASYNC, FALLBACK)
)`)

const disposal = asynchronous => template.statement(`{
  let RESOURCE${asynchronous ? ', STATE = 0' : ''};
  while (RESOURCE = CONTEXT.stack.pop()) {
    try {
      ${asynchronous ? 'if (!RESOURCE.a && STATE === 1) { STATE = 0; await void 0; }' : ''}
      if (RESOURCE.d) {
        let VALUE, FAILED = false;
        try { VALUE = (0, INTRINSICS.Reflect.apply)(RESOURCE.d, RESOURCE.v, []); }
        catch (ERROR) { VALUE = ERROR; FAILED = true; }
        if (FAILED) {
          ${asynchronous ? 'if (RESOURCE.f) { STATE |= 2; await void 0; }' : ''}
          throw VALUE;
        }
        ${asynchronous ? 'if (RESOURCE.a) { STATE |= 2; await (RESOURCE.f ? void 0 : VALUE); }' : ''}
      } ${asynchronous ? 'else { STATE |= 1; }' : ''}
    } catch (ERROR) { CONTEXT.suppress(ERROR); }
  }
  ${asynchronous ? 'if (STATE === 1) await void 0;' : ''}
  CONTEXT.finish();
}`, { allowAwaitOutsideFunction: true })

const disposalLoops = [disposal(false), disposal(true)]

/** Replace the maintained lowerer's private protocol at its binding identity.
 * Inline operations introduce blocks and temporaries, never a source callable
 * activation. Acquisition completes before the original declaration initializes;
 * the existing finally still controls return, break, continue and throw. */
export function lowerResourceOperations(file, intrinsics, allocate) {
  const helper = file.declarations.usingCtx
  const intrinsic = t.identifier(intrinsics)
  const contexts = new Map()
  file.path.traverse({ VariableDeclarator(path) {
    if (!t.isCallExpression(path.node.init) || !t.isIdentifier(path.node.init.callee, helper)) return
    contexts.set(path.scope.getBinding(path.node.id.name), path.parentPath)
  } })
  const names = labels => Object.fromEntries(labels.map(label => [label, t.identifier(allocate(`resource_${label.toLowerCase()}`))]))
  file.path.traverse({ CallExpression: { exit(path) {
    const callee = path.node.callee
    if (path.node.loc || !t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.object)) return
    const declaration = contexts.get(path.scope.getBinding(callee.object.name))
    if (!declaration) return
    const common = { CONTEXT: callee.object, INTRINSICS: intrinsic }
    if (callee.property.name === 'u' || callee.property.name === 'a') {
      const temporaries = names(['VALUE', 'METHOD', 'FALLBACK'])
      declaration.insertBefore(t.variableDeclaration('let', Object.values(temporaries).map(name => t.variableDeclarator(t.cloneNode(name)))))
      path.replaceWith(acquisition({ ...common, ...temporaries,
        INITIALIZER: path.node.arguments[0], ASYNC: t.booleanLiteral(callee.property.name === 'a') }))
    } else if (callee.property.name === 'd') {
      const asynchronous = path.parentPath.isAwaitExpression()
      const statement = asynchronous ? path.parentPath.parentPath : path.parentPath
      statement.replaceWith(disposalLoops[Number(asynchronous)]({ ...common,
        ...names(asynchronous ? ['RESOURCE', 'STATE', 'VALUE', 'FAILED', 'ERROR'] : ['RESOURCE', 'VALUE', 'FAILED', 'ERROR']) }))
    }
  } } })
  file.scope.getBinding(helper.name).path.replaceWith(contextFactory({ HELPER: helper, INTRINSICS: intrinsic }))
  file.scope.crawl()
}
