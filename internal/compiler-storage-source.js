/** One construction contract for compiler-owned storage in every emitted realm. */
export const compilerStorageSource = `(object, WeakMap, WeakSet, symbol, promise, reflect, arrayConstructor, functionPrototype) => {
  const define = object.defineProperty, defineProperties = object.defineProperties, setPrototype = object.setPrototypeOf;
  const uncurry = functionPrototype.bind.bind(functionPrototype.call);
  const descriptor = (value,writable=false,configurable=false) => {
    const result=object.create(null);result.value=value;result.writable=writable;result.configurable=configurable;return result;
  };
  if(symbol.dispose===void 0)define(symbol,'dispose',descriptor(symbol.for('nodejs.dispose')));
  if(symbol.asyncDispose===void 0)define(symbol,'asyncDispose',descriptor(symbol.for('nodejs.asyncDispose')));
  const mapMethods = object.create(null), setMethods = object.create(null);
  for (const name of ['get','set','has','delete']) mapMethods[name] = descriptor(WeakMap.prototype[name]);
  for (const name of ['has','add','delete']) setMethods[name] = descriptor(WeakSet.prototype[name]);
  const values = uncurry(arrayConstructor.prototype.values);
  const arrayMethods = object.create(null);
  for (const name of ['push','pop','unshift']) arrayMethods[name] = descriptor(arrayConstructor.prototype[name]);
  const apply = reflect.apply;
  for (const name of ['concat','splice']) {
    const operation = arrayConstructor.prototype[name];
    arrayMethods[name] = descriptor(function(...args){return array(apply(operation,this,args))});
  }
  const next = uncurry(object.getPrototypeOf(values([])).next);
  const description = uncurry(object.getOwnPropertyDescriptor(symbol.prototype,'description').get);
  const then = uncurry(promise.prototype.then);
  function array(value){
    setPrototype(value,null);
    defineProperties(value,arrayMethods);
    define(value,'constructor',descriptor(void 0,true,true));
    define(value,symbol.iterator,descriptor(function(){
      const iterator=values(value);
      setPrototype(iterator,null);
      define(iterator,'next',descriptor(function(){return next(iterator)}));
      return iterator;
    },false,true));
    return value;
  }
  return {
    functionCall:functionPrototype.call,functionApply:functionPrototype.apply,functionBind:functionPrototype.bind,
    promiseThen:promise.prototype.then,
    record(value){return setPrototype(value,null)},
    observeOwnedPromise(value,fulfilled,rejected){
      setPrototype(value,null);
      then(value,result=>{try{fulfilled(result)}catch(error){rejected(error)}},rejected);
    },
    async awaitValue(value,fulfilled,rejected){
      let result;
      try{result=await value}catch(error){if(rejected)return await rejected(error);throw error}
      return await fulfilled(result);
    },
    weakMapStore(){return defineProperties(new WeakMap(),mapMethods)},
    weakSetStore(){return defineProperties(new WeakSet(),setMethods)},
    symbolDescription:description,
    array
  };
}`
