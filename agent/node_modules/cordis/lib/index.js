var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/events.ts
import { defineProperty as defineProperty3 } from "cosmokit";

// src/fiber.ts
import { defineProperty as defineProperty2, isNullable } from "cosmokit";

// src/utils.ts
import { defineProperty } from "cosmokit";
var DisposableList = class {
  static {
    __name(this, "DisposableList");
  }
  sn = 0;
  map = /* @__PURE__ */ new Map();
  weak = /* @__PURE__ */ new WeakMap();
  get length() {
    return this.map.size;
  }
  push(value) {
    const sn = ++this.sn;
    this.map.set(sn, value);
    this.weak.set(value, sn);
    return () => this.map.delete(sn);
  }
  delete(value) {
    const sn = this.weak.get(value);
    if (!sn) return false;
    return this.map.delete(sn);
  }
  clear() {
    const values = [...this.map.values()];
    this.map.clear();
    return values.reverse();
  }
  [Symbol.iterator]() {
    return this.map.values();
  }
  [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")]() {
    return [...this];
  }
};
var symbols = {
  // internal symbols
  shadow: /* @__PURE__ */ Symbol.for("cordis.shadow"),
  caller: /* @__PURE__ */ Symbol.for("cordis.caller"),
  receiver: /* @__PURE__ */ Symbol.for("cordis.receiver"),
  original: /* @__PURE__ */ Symbol.for("cordis.original"),
  decorator: /* @__PURE__ */ Symbol.for("cordis.decorator"),
  initHooks: /* @__PURE__ */ Symbol.for("cordis.initHooks"),
  checkProto: /* @__PURE__ */ Symbol.for("cordis.checkProto"),
  // context symbols
  root: /* @__PURE__ */ Symbol.for("cordis.root"),
  effect: /* @__PURE__ */ Symbol.for("cordis.effect"),
  filter: /* @__PURE__ */ Symbol.for("cordis.filter"),
  isolate: /* @__PURE__ */ Symbol.for("cordis.isolate"),
  intercept: /* @__PURE__ */ Symbol.for("cordis.intercept"),
  // service symbols
  init: /* @__PURE__ */ Symbol.for("cordis.init"),
  check: /* @__PURE__ */ Symbol.for("cordis.check"),
  invoke: /* @__PURE__ */ Symbol.for("cordis.invoke"),
  metadata: /* @__PURE__ */ Symbol.for("cordis.metadata"),
  extend: /* @__PURE__ */ Symbol.for("cordis.extend"),
  tracker: /* @__PURE__ */ Symbol.for("cordis.tracker"),
  mergeIntercept: /* @__PURE__ */ Symbol.for("cordis.mergeIntercept"),
  resolveIntercept: /* @__PURE__ */ Symbol.for("cordis.resolveIntercept")
};
var GeneratorFunction = function* () {
}.constructor;
var AsyncGeneratorFunction = async function* () {
}.constructor;
function isConstructor(func) {
  if (!func.prototype) return false;
  if (func instanceof GeneratorFunction) return false;
  if (AsyncGeneratorFunction !== Function && func instanceof AsyncGeneratorFunction) return false;
  return true;
}
__name(isConstructor, "isConstructor");
function joinPrototype(proto1, proto2) {
  if (proto1 === Object.prototype) return proto2;
  const result = Object.create(joinPrototype(Object.getPrototypeOf(proto1), proto2));
  for (const key of Reflect.ownKeys(proto1)) {
    Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto1, key));
  }
  return result;
}
__name(joinPrototype, "joinPrototype");
function isObject(value) {
  return value && (typeof value === "object" || typeof value === "function");
}
__name(isObject, "isObject");
function getPropertyDescriptor(target, prop) {
  let proto = target;
  while (proto) {
    const desc = Reflect.getOwnPropertyDescriptor(proto, prop);
    if (desc) return desc;
    proto = Object.getPrototypeOf(proto);
  }
}
__name(getPropertyDescriptor, "getPropertyDescriptor");
function getTraceable(ctx, value) {
  if (!isObject(value)) return value;
  if (Object.hasOwn(value, symbols.shadow)) {
    return Object.getPrototypeOf(value);
  }
  const tracker = value[symbols.tracker];
  if (!tracker) return value;
  return createTraceable(ctx, value, tracker);
}
__name(getTraceable, "getTraceable");
function withProps(target, props) {
  if (!props) return target;
  return new Proxy(target, {
    get: /* @__PURE__ */ __name((target2, prop, receiver) => {
      if (prop in props && prop !== "constructor") return Reflect.get(props, prop, receiver);
      return Reflect.get(target2, prop, receiver);
    }, "get"),
    set: /* @__PURE__ */ __name((target2, prop, value, receiver) => {
      if (prop in props && prop !== "constructor") return Reflect.set(props, prop, value, receiver);
      return Reflect.set(target2, prop, value, receiver);
    }, "set")
  });
}
__name(withProps, "withProps");
function withProp(target, prop, value) {
  return withProps(target, Object.defineProperty(/* @__PURE__ */ Object.create(null), prop, {
    value,
    writable: false
  }));
}
__name(withProp, "withProp");
function createShadow(useSite, target, property, receiver) {
  if (!property) return receiver;
  const value = getPropertyDescriptor(target, property)?.value;
  if (!value) return receiver;
  const defSite = value[symbols.shadow] ?? value;
  return withProp(receiver, property, useSite.extend({ [symbols.shadow]: defSite }));
}
__name(createShadow, "createShadow");
function createShadowMethod(ctx, value, outer, shadow) {
  return new Proxy(value, {
    apply: /* @__PURE__ */ __name((target, thisArg, args) => {
      if (thisArg === outer) thisArg = shadow;
      return getTraceable(ctx, Reflect.apply(target, thisArg, args));
    }, "apply")
  });
}
__name(createShadowMethod, "createShadowMethod");
function createTraceable(ctx, value, tracker) {
  const defSite = ctx[symbols.shadow] ?? ctx;
  const useSite = ctx[symbols.shadow] ? Object.getPrototypeOf(ctx) : ctx;
  const proxy = new Proxy(value, {
    get: /* @__PURE__ */ __name((target, prop, receiver) => {
      if (prop === symbols.original) return target;
      if (prop === symbols.caller) return defSite;
      if (prop === tracker.property) return useSite;
      if (typeof prop === "symbol") {
        return Reflect.get(target, prop, receiver);
      }
      if (tracker.associate && useSite.reflect.props[`${tracker.associate}.${prop}`]) {
        return Reflect.get(ctx, `${tracker.associate}.${prop}`, withProp(ctx, symbols.receiver, receiver));
      }
      let shadow, innerValue;
      const desc = getPropertyDescriptor(target, prop);
      if (desc && "value" in desc) {
        innerValue = desc.value;
      } else {
        shadow = createShadow(useSite, target, tracker.property, receiver);
        innerValue = Reflect.get(target, prop, shadow);
      }
      const innerTracker = innerValue?.[symbols.tracker];
      if (innerTracker) {
        return createTraceable(useSite, innerValue, innerTracker);
      } else if (!tracker.noShadow && typeof innerValue === "function") {
        shadow ??= createShadow(useSite, target, tracker.property, receiver);
        return createShadowMethod(useSite, innerValue, receiver, shadow);
      } else {
        return innerValue;
      }
    }, "get"),
    set: /* @__PURE__ */ __name((target, prop, value2, receiver) => {
      if (prop === symbols.original) return false;
      if (prop === symbols.caller) return false;
      if (prop === tracker.property) return false;
      if (typeof prop === "symbol") {
        return Reflect.set(target, prop, value2, receiver);
      }
      if (tracker.associate && useSite.reflect.props[`${tracker.associate}.${prop}`]) {
        return Reflect.set(ctx, `${tracker.associate}.${prop}`, value2, withProp(ctx, symbols.receiver, receiver));
      }
      const shadow = createShadow(useSite, target, tracker.property, receiver);
      return Reflect.set(target, prop, value2, shadow);
    }, "set"),
    apply: /* @__PURE__ */ __name((target, thisArg, args) => {
      const receiver = tracker.noShadow ? proxy : createShadow(useSite, target, tracker.property, proxy);
      return applyTraceable(receiver, target, thisArg, args);
    }, "apply")
  });
  return proxy;
}
__name(createTraceable, "createTraceable");
function applyTraceable(proxy, value, thisArg, args) {
  if (!value[symbols.invoke]) return Reflect.apply(value, thisArg, args);
  return value[symbols.invoke].apply(proxy, args);
}
__name(applyTraceable, "applyTraceable");
function createCallable(name, proto, tracker) {
  const self = /* @__PURE__ */ __name(function(...args) {
    const proxy = createTraceable(self["ctx"], self, tracker);
    return Reflect.apply(proxy, this, args);
  }, "self");
  defineProperty(self, "name", name);
  return Object.setPrototypeOf(self, proto);
}
__name(createCallable, "createCallable");
function handleError(info, reason, getOuterStack) {
  const innerLines = info.error.stack.split("\n");
  if (typeof reason?.stack !== "string") {
    const outerError = new Error(reason);
    const lines2 = outerError.stack.split("\n");
    lines2.splice(1, Infinity, ...getOuterStack());
    outerError.stack = lines2.join("\n");
    throw outerError;
  }
  const lines = reason.stack.split("\n");
  let index = lines.indexOf(innerLines[2]);
  if (index === -1) throw reason;
  index -= info.offset;
  while (index > 0) {
    if (!lines[index - 1].endsWith(" (<anonymous>)")) break;
    index -= 1;
  }
  lines.splice(index, Infinity, ...getOuterStack());
  reason.stack = lines.join("\n");
  throw reason;
}
__name(handleError, "handleError");
function composeError(callback, getOuterStack = buildOuterStack()) {
  const info = { offset: 1, error: new Error() };
  try {
    const result = callback(info);
    if (isObject(result) && "then" in result) {
      return result.then(void 0, (reason) => handleError(info, reason, getOuterStack));
    } else {
      return result;
    }
  } catch (reason) {
    handleError(info, reason, getOuterStack);
  }
}
__name(composeError, "composeError");
function buildOuterStack(offset = 0) {
  const outerError = new Error();
  return () => outerError.stack.split("\n").slice(3 + offset);
}
__name(buildOuterStack, "buildOuterStack");

// src/fiber.ts
var kValidationError = /* @__PURE__ */ Symbol.for("ValidationError");
var ValidationError = class _ValidationError extends TypeError {
  constructor(issues) {
    super(`invalid config:
` + issues.map((issue) => {
      if (issue.path?.length) {
        return `  - ${issue.message} (at ${_ValidationError.formatPath(issue.path)})`;
      } else {
        return `  - ${issue.message}`;
      }
    }).join("\n"));
    this.issues = issues;
  }
  issues;
  static {
    __name(this, "ValidationError");
  }
  name = "ValidationError";
  static is(error) {
    return !!error?.[kValidationError];
  }
  static normalizePath(path = []) {
    return path.map((segment) => typeof segment === "object" ? segment.key : segment);
  }
  static formatPath(path) {
    return _ValidationError.normalizePath(path).map(String).join(".");
  }
};
Object.defineProperty(ValidationError.prototype, kValidationError, {
  value: true
});
function resolveConfig(runtime, config) {
  if (!runtime.Config) return config;
  const result = runtime.Config["~standard"].validate(config);
  if ("then" in result) {
    throw new TypeError("Async config validation is not supported");
  }
  if (result.issues) {
    throw new ValidationError(result.issues);
  } else {
    return result.value;
  }
}
__name(resolveConfig, "resolveConfig");
var FiberState = /* @__PURE__ */ ((FiberState3) => {
  FiberState3[FiberState3["PENDING"] = 0] = "PENDING";
  FiberState3[FiberState3["LOADING"] = 1] = "LOADING";
  FiberState3[FiberState3["ACTIVE"] = 2] = "ACTIVE";
  FiberState3[FiberState3["FAILED"] = 3] = "FAILED";
  FiberState3[FiberState3["DISPOSED"] = 4] = "DISPOSED";
  FiberState3[FiberState3["UNLOADING"] = 5] = "UNLOADING";
  return FiberState3;
})(FiberState || {});
var CordisError = class _CordisError extends Error {
  constructor(code, message) {
    super(message ?? _CordisError.Code[code]);
    this.code = code;
  }
  code;
  static {
    __name(this, "CordisError");
  }
};
((CordisError2) => {
  CordisError2.Code = {
    INACTIVE_EFFECT: "cannot create effect on inactive context"
  };
})(CordisError || (CordisError = {}));
var INACTIVE = "__INACTIVE__";
var Fiber = class {
  constructor(parent, config, inject, runtime, getOuterStack) {
    this.parent = parent;
    this.config = config;
    this.inject = inject;
    this.runtime = runtime;
    const collect = /* @__PURE__ */ __name((dispose) => {
      this._disposables.push(dispose);
    }, "collect");
    if (runtime) {
      this.uid = parent.registry.counter;
      this.ctx = this.context = parent.extend({ fiber: this });
      this._runner = {
        epoch: INACTIVE,
        getOuterStack,
        execute: /* @__PURE__ */ __name(function() {
          const config2 = this._resolve(this.config);
          if (isConstructor(runtime.callback)) {
            const instance = new runtime.callback(this.ctx, config2);
            for (const hook of instance?.[symbols.initHooks] ?? []) {
              hook();
            }
            return instance?.[symbols.init]?.();
          } else {
            return runtime.callback(this.ctx, config2);
          }
        }, "execute"),
        collect
      };
      this.context.emit("internal/plugin", this);
      for (const name of Object.keys(this.inject)) {
        this._checkImpl(name);
      }
      this.dispose = parent.fiber.effect(() => {
        const remove = runtime.fibers.push(this);
        try {
          this._refresh();
        } catch (error) {
          this.ctx.logger.error(error);
          this._error = error;
        }
        return async () => {
          this.uid = null;
          this.context.emit("internal/plugin", this);
          if (this.ctx.registry.has(runtime.callback)) {
            remove();
            if (!runtime.fibers.length) {
              this.ctx.registry.delete(runtime.callback);
            }
          }
          this._setEpoch(INACTIVE);
          while (this.inertia) {
            await this.inertia;
          }
          this._updateState(() => {
          });
        };
      }, "ctx.plugin()");
    } else {
      this.uid = 0;
      this.ctx = this.context = parent;
      this.state = 2 /* ACTIVE */;
      this.committed = /* @__PURE__ */ Object.create(null);
      this._runner = {
        epoch: "0",
        getOuterStack,
        execute: /* @__PURE__ */ __name(() => {
        }, "execute"),
        collect
      };
      this.dispose = () => this.restart();
    }
  }
  parent;
  config;
  inject;
  runtime;
  static {
    __name(this, "Fiber");
  }
  uid;
  ctx;
  state = 0 /* PENDING */;
  dispose;
  committed;
  provisions = /* @__PURE__ */ new Set();
  inertia;
  _hooks = /* @__PURE__ */ Object.create(null);
  _disposables = new DisposableList();
  // Same as `this.ctx`, but with a more specific type.
  context;
  _error;
  _revision = 0;
  _runner;
  _store = /* @__PURE__ */ Object.create(null);
  _release;
  get name() {
    let fiber = this;
    do {
      if (fiber.runtime?.name) return fiber.runtime.name;
      fiber = fiber.parent.fiber;
    } while (fiber !== fiber.parent.fiber);
    return "root";
  }
  assertActive() {
    if (this.uid !== null) return;
    throw new CordisError("INACTIVE_EFFECT");
  }
  _resolve(config) {
    return this.context.waterfall("internal/config", this, () => config);
  }
  _execute(runner) {
    const oldEpoch = runner.epoch;
    return composeError((info) => {
      const safeCollect = /* @__PURE__ */ __name((dispose) => {
        if (typeof dispose === "function") {
          runner.collect(dispose);
        } else if (!isNullable(dispose)) {
          throw new TypeError("Invalid effect");
        }
      }, "safeCollect");
      const effect = runner.execute.call(this);
      if (typeof effect === "function") {
        return runner.collect(effect);
      } else if (isNullable(effect)) {
      } else if (!isObject(effect)) {
        throw new TypeError("Invalid effect");
      } else if ("then" in effect) {
        return effect.then(safeCollect);
      } else if (Symbol.iterator in effect) {
        info.error = new Error();
        const iter = effect[Symbol.iterator]();
        while (true) {
          const result = iter.next();
          safeCollect(result.value);
          if (result.done) return;
        }
      } else if (Symbol.asyncIterator in effect) {
        const iter = effect[Symbol.asyncIterator]();
        return (async () => {
          await Promise.resolve();
          info.error = new Error();
          while (true) {
            if (runner.epoch !== oldEpoch) return;
            const result = await iter.next();
            safeCollect(result.value);
            if (result.done) return;
          }
        })();
      } else {
        throw new TypeError("Invalid effect");
      }
    }, runner.getOuterStack);
  }
  effect(execute, label = "anonymous") {
    this.assertActive();
    const disposables = [];
    const dispose = /* @__PURE__ */ __name(() => {
      let task2;
      for (const dispose2 of disposables.splice(0).reverse()) {
        if (task2) {
          task2 = task2.then(dispose2);
        } else {
          const result = dispose2();
          if (isObject(result) && "then" in result) {
            task2 = result;
          }
        }
      }
      return task2;
    }, "dispose");
    const meta = { label, children: [] };
    const runner = {
      execute,
      epoch: true,
      collect: /* @__PURE__ */ __name((dispose2) => {
        disposables.push(dispose2);
        this._disposables.delete(dispose2);
        if (dispose2[symbols.effect]) {
          meta.children.push(dispose2[symbols.effect]);
        }
      }, "collect"),
      getOuterStack: buildOuterStack()
    };
    let task;
    try {
      task = this._execute(runner);
    } catch (reason) {
      dispose();
      throw reason;
    }
    task?.catch(dispose).catch((error) => this.ctx.logger.error(error));
    const wrapper = defineProperty2(() => {
      if (!runner.epoch) return;
      runner.epoch = false;
      return task ? task.then(dispose) : dispose();
    }, symbols.effect, meta);
    const disposeAsync = /* @__PURE__ */ __name(() => {
      if (!runner.epoch) return;
      runner.epoch = false;
      return dispose();
    }, "disposeAsync");
    wrapper.then = async (onFulfilled, onRejected) => {
      return Promise.resolve(task).then(() => disposeAsync).then(onFulfilled, onRejected);
    };
    disposables.push(this._disposables.push(wrapper));
    return wrapper;
  }
  getEffects() {
    return [...this._disposables].map((dispose) => dispose[symbols.effect]).filter(Boolean);
  }
  _getState() {
    if (this.uid === null) return 4 /* DISPOSED */;
    if (this._error) return 3 /* FAILED */;
    if (this._runner.epoch !== INACTIVE) return 2 /* ACTIVE */;
    return 0 /* PENDING */;
  }
  _updateState(callback) {
    const oldState = this.state;
    this.state = callback() ?? this._getState();
    if (oldState === this.state) return;
    this.context.emit("internal/status", this, oldState);
    if (oldState !== 2 /* ACTIVE */ && this.state !== 2 /* ACTIVE */) return;
    for (const key of Reflect.ownKeys(this.ctx.reflect.store)) {
      const impl = this.ctx.reflect.store[key];
      if (impl.ctx.fiber !== this) continue;
      this.ctx.isolate(impl.name, impl.isolate).reflect.notify([impl.name]);
    }
  }
  _checkImpl(name) {
    const impl = this.ctx.reflect._getImpl(name, true);
    if (!impl) return delete this._store[name];
    try {
      if (impl.check && !impl.check.call(getTraceable(this.ctx, impl.value))) {
        return delete this._store[name];
      }
    } catch (error) {
      impl.ctx.logger.error(error);
      return delete this._store[name];
    }
    this._store[name] = impl;
  }
  _refresh() {
    let epoch = `${this._revision}`;
    for (const name of Object.keys(this.inject)) {
      const impl = this._store[name];
      if (!impl) {
        epoch = INACTIVE;
        break;
      }
      epoch += ":" + impl.uid;
    }
    this._setEpoch(epoch);
  }
  _setEpoch(epoch) {
    const oldEpoch = this._runner.epoch;
    if (epoch === oldEpoch) return;
    if (this._error) return;
    this._runner.epoch = epoch;
    if (this.inertia) return;
    this._updateState(() => {
      if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
        this.inertia = this._reload();
        return 1 /* LOADING */;
      } else {
        this.inertia = this._unload();
        return 5 /* UNLOADING */;
      }
    });
  }
  async _reload() {
    this.committed = { ...this._store };
    for (const impl of Object.values(this.committed)) {
      if (impl.ctx.fiber === this) continue;
      impl.dependents.add(this);
    }
    const oldEpoch = this._runner.epoch;
    try {
      await Promise.resolve();
      if (this._runner.epoch === oldEpoch) {
        await this._execute(this._runner);
      }
    } catch (reason) {
      this.ctx.logger.error(reason);
      if (this._runner.epoch === oldEpoch) {
        this._error = reason;
        this._runner.epoch = INACTIVE;
      }
    }
    this._updateState(() => {
      if (this._runner.epoch === oldEpoch) {
        this.inertia = void 0;
      } else {
        this.inertia = this._unload();
        return 5 /* UNLOADING */;
      }
    });
  }
  async _unload() {
    while ([...this.provisions].some((impl) => impl.dependents.size)) {
      await new Promise((resolve) => this._release = resolve);
    }
    this._release = void 0;
    await Promise.all(this._disposables.clear().map(async (dispose) => {
      try {
        await composeError(async (info) => {
          await Promise.resolve();
          info.error = new Error();
          await dispose();
        }, this._runner.getOuterStack);
      } catch (reason) {
        this.ctx.logger.error(reason);
      }
    }));
    for (const impl of Object.values(this.committed ?? {})) {
      if (!impl.dependents.delete(this) || impl.dependents.size) continue;
      impl.release?.();
      impl.ctx.fiber._release?.();
    }
    this.committed = void 0;
    this._updateState(() => {
      if (this._runner.epoch === INACTIVE) {
        this.inertia = void 0;
      } else {
        this.inertia = this._reload();
        return 1 /* LOADING */;
      }
    });
  }
  async await() {
    while (this.inertia) {
      await this.inertia;
    }
    if (this._error) throw this._error;
    return this;
  }
  async restart() {
    const fiber = this.ctx.fiber;
    fiber.assertActive();
    fiber._revision++;
    fiber._refresh();
    await fiber.await();
  }
  update(config, noSave = false) {
    const fiber = this.ctx.fiber;
    fiber.assertActive();
    const loaded = fiber._runner.epoch !== INACTIVE;
    const resolved = loaded ? fiber._resolve(config) : void 0;
    if (!noSave) fiber.context.emit("internal/commit", fiber, config);
    fiber.config = config;
    fiber._error = void 0;
    const restart = /* @__PURE__ */ __name(() => fiber.restart(), "restart");
    const result = loaded ? fiber.context.waterfall(fiber, "internal/update", resolved, restart) : restart();
    if (result === void 0) return;
    const task = Promise.resolve(result);
    task.catch(() => {
    });
    return task;
  }
};

// src/events.ts
function isBailed(value) {
  return value !== null && value !== false && value !== void 0;
}
__name(isBailed, "isBailed");
var EventsService = class {
  constructor(ctx) {
    this.ctx = ctx;
    defineProperty3(this, symbols.tracker, {
      property: "ctx",
      noShadow: true
    });
    this.on("internal/listener", function(name, listener, options) {
      if (name === "internal/update" && !options.global) {
        const hooks = this.fiber._hooks["internal/update"] ??= new DisposableList();
        const method = options.prepend ? "unshift" : "push";
        return this.fiber.effect(() => hooks[method](listener), 'ctx.on("internal/update")');
      }
    });
    this.on("internal/update", function(config, next) {
      const cbs = [...this._hooks["internal/update"] || []];
      const _next = /* @__PURE__ */ __name(() => {
        const cb = cbs.shift() ?? next;
        return cb.call(this, config, _next);
      }, "_next");
      return _next();
    }, { global: true, prepend: true });
    this.on("internal/config", (fiber, next) => {
      return resolveConfig(fiber.runtime, next());
    });
  }
  ctx;
  static {
    __name(this, "EventsService");
  }
  _hooks = /* @__PURE__ */ Object.create(null);
  _resolve(type, args) {
    const thisArg = typeof args[0] === "object" || typeof args[0] === "function" ? args.shift() : null;
    const name = args.shift();
    if ((typeof name !== "string" || !name.startsWith("internal/")) && this._hooks["internal/dispatch"]?.length) {
      this.emit("internal/dispatch", type, name, args, thisArg);
    }
    const filter = thisArg?.[Context.filter];
    const callbacks = (this._hooks[name] || []).filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx)).map((hook) => hook.callback);
    return [thisArg, callbacks, name];
  }
  /** @deprecated */
  dispatch(type, args) {
    const [thisArg, callbacks] = this._resolve(type, args);
    return callbacks.map((callback) => callback.bind(thisArg));
  }
  async parallel(...args) {
    const [thisArg, callbacks, name] = this._resolve("parallel", args);
    const results = await Promise.allSettled(callbacks.map(async (callback) => Reflect.apply(callback, thisArg, args)));
    const errors = results.filter((result) => result.status === "rejected");
    if (!errors.length) return;
    const label = typeof name === "symbol" ? String(name) : `"${name}"`;
    throw new AggregateError(errors.map((error) => error.reason), `one or more listeners of event ${label} failed`);
  }
  emit(...args) {
    const [thisArg, callbacks] = this._resolve("emit", args);
    for (const callback of callbacks) Reflect.apply(callback, thisArg, args);
  }
  async serial(...args) {
    const [thisArg, callbacks] = this._resolve("serial", args);
    for (const callback of callbacks) {
      const result = await Reflect.apply(callback, thisArg, args);
      if (isBailed(result)) return result;
    }
  }
  bail(...args) {
    const [thisArg, callbacks] = this._resolve("bail", args);
    for (const callback of callbacks) {
      const result = Reflect.apply(callback, thisArg, args);
      if (isBailed(result)) return result;
    }
  }
  waterfall(...args) {
    const [thisArg, callbacks] = this._resolve("waterfall", args);
    const inner = args.pop();
    const dispatch = /* @__PURE__ */ __name(() => {
      const callback = callbacks.shift();
      if (!callback) return inner();
      let called = false;
      const next = /* @__PURE__ */ __name(() => {
        if (called) throw new Error("next() called multiple times");
        called = true;
        return dispatch();
      }, "next");
      return Reflect.apply(callback, thisArg, [...args, next]);
    }, "dispatch");
    return dispatch();
  }
  register(label, name, callback, options) {
    const method = options.prepend ? "unshift" : "push";
    return this.ctx.fiber.effect(() => {
      const hooks = this._hooks[name] ??= [];
      hooks[method]({ ctx: this.ctx, callback, ...options });
      return () => this.unregister(name, callback);
    }, label);
  }
  unregister(name, callback) {
    const hooks = this._hooks[name];
    if (!hooks) return;
    const index = hooks.findIndex((hook) => hook.callback === callback);
    if (index >= 0) {
      hooks.splice(index, 1);
      if (!hooks.length) delete this._hooks[name];
      return true;
    }
  }
  on(name, listener, options) {
    if (typeof options !== "object") {
      options = { prepend: options };
    }
    this.ctx.fiber.assertActive();
    listener = this.ctx.reflect.bind(listener);
    const result = this.bail(this.ctx, "internal/listener", name, listener, options);
    if (result) return result;
    const label = `ctx.on(${typeof name === "string" ? JSON.stringify(name) : name.toString()})`;
    return this.register(label, name, listener, options);
  }
  once(name, listener, options) {
    const dispose = this.on(name, function(...args) {
      dispose();
      return listener.apply(this, args);
    }, options);
    return dispose;
  }
};

// src/logger.ts
import { defineProperty as defineProperty6, hyphenate } from "cosmokit";

// src/service.ts
import { defineProperty as defineProperty5, isNullable as isNullable3 } from "cosmokit";

// src/reflect.ts
import { defineProperty as defineProperty4, isNullable as isNullable2 } from "cosmokit";
function enhanceError(error) {
  const lines = error.stack.split("\n");
  lines.splice(0, 2, `Error: ${error.message}`);
  error.stack = lines.join("\n");
  return error;
}
__name(enhanceError, "enhanceError");
var RESERVED_WORDS = ["prototype", "then"];
function isSpecialProperty(prop) {
  return typeof prop === "symbol" || RESERVED_WORDS.includes(prop) || parseInt(prop).toString() === prop || prop.startsWith("_");
}
__name(isSpecialProperty, "isSpecialProperty");
function locate(ctx, name) {
  const key = ctx[symbols.isolate][name];
  let table = ctx[symbols.isolate];
  let fiber = ctx.fiber;
  while (true) {
    let impl;
    for (const provision of fiber.provisions) {
      if (provision.name === name && provision.ctx[symbols.isolate][name] === key) impl = provision;
    }
    if (impl) return { impl };
    while (table !== fiber.ctx[symbols.isolate]) {
      if (!table || Object.hasOwn(table, name)) return;
      table = Object.getPrototypeOf(table);
    }
    impl = fiber.committed?.[name];
    if (impl || name in fiber.inject) return { fiber, impl };
    if (!fiber.runtime) return;
    fiber = fiber.parent.fiber;
  }
}
__name(locate, "locate");
var ReflectService = class {
  constructor(ctx) {
    this.ctx = ctx;
    defineProperty4(this, symbols.tracker, {
      property: "ctx",
      noShadow: true
    });
    this.mixin("reflect", ["get", "set", "provide", "accessor", "mixin"]);
    this.mixin("fiber", ["runtime", "effect"]);
    this.mixin("registry", ["inject", "plugin"]);
    this.mixin("events", ["on", "once", "parallel", "emit", "serial", "bail", "waterfall"]);
  }
  ctx;
  static {
    __name(this, "ReflectService");
  }
  static handler = {
    get: /* @__PURE__ */ __name((target, prop, ctx) => {
      if (isSpecialProperty(prop)) {
        return Reflect.get(target, prop, ctx);
      }
      if (Reflect.has(target, prop)) {
        return getTraceable(ctx, Reflect.get(target, prop, ctx));
      }
      const error = new Error(`cannot get property "${prop}" without inject`);
      try {
        const def = target.reflect.props[prop];
        if (def?.type === "accessor") {
          return def.get.call(ctx, ctx[symbols.receiver], error);
        }
        const defSite = ctx[symbols.shadow] ?? ctx;
        if (!defSite.fiber.runtime) return ctx.reflect.get(prop, false);
        return ctx.events.waterfall("internal/get", ctx, prop, error, () => {
          const result = locate(defSite, prop);
          if (!result) throw error;
          if (result.impl) return getTraceable(ctx, result.impl.value);
          error.message = `cannot get required service "${prop}" in inactive context`;
          throw error;
        });
      } catch (e) {
        throw e === error ? enhanceError(e) : e;
      }
    }, "get"),
    set: /* @__PURE__ */ __name((target, prop, value, ctx) => {
      if (isSpecialProperty(prop)) {
        return Reflect.set(target, prop, value, ctx);
      }
      const error = new Error(`cannot set property "${prop}" without provide`);
      const def = target.reflect.props[prop];
      if (!def) {
        if (!ctx.fiber.runtime) return Reflect.set(target, prop, value, ctx);
        throw enhanceError(error);
      }
      try {
        if (def.type === "accessor") {
          if (!def.set) return false;
          return def.set.call(ctx, value, ctx[symbols.receiver], error);
        }
        return ctx.events.waterfall("internal/set", ctx, prop, value, error, () => {
          return ctx.reflect.set(prop, value, error);
        });
      } catch (e) {
        throw e === error ? enhanceError(e) : e;
      }
    }, "set"),
    has: /* @__PURE__ */ __name((target, prop) => {
      if (isSpecialProperty(prop)) {
        return Reflect.has(target, prop);
      }
      if (Reflect.has(target, prop)) return true;
      return !!target.reflect.props[prop];
    }, "has")
  };
  store = /* @__PURE__ */ Object.create(null);
  props = /* @__PURE__ */ Object.create(null);
  _implCounter = 0;
  get(name, strict = true) {
    return getTraceable(this.ctx, this._getImpl(name, strict)?.value);
  }
  _getImpl(name, strict = true) {
    const key = this.ctx[symbols.isolate][name];
    const impl = key && this.store[key];
    if (!impl) return;
    if (strict && impl.ctx.fiber.state !== 2 /* ACTIVE */) return;
    return impl;
  }
  set(name, value, error) {
    const key = this.ctx[symbols.isolate][name];
    const impl = this.store[key];
    if (!impl) {
      throw new Error(`cannot set property "${name}" without provide`);
    }
    if (impl.ctx.fiber !== this.ctx.fiber) {
      throw new Error(`cannot set property "${name}" in multiple fibers`);
    }
    impl.value = value;
    return true;
  }
  provide(name, value, check) {
    return this.ctx.fiber.effect(() => {
      if (!this.props[name]) {
        this.props[name] ??= { type: "service" };
      } else if (this.props[name].type !== "service") {
        throw new Error(`property "${name}" is already declared as ${this.props[name].type}`);
      }
      this.props[name] = { type: "service" };
      this.ctx[symbols.root][symbols.isolate][name] ??= Symbol(name);
      const key = this.ctx[symbols.isolate][name];
      const impl = { uid: ++this._implCounter, name, value, ctx: this.ctx, check, isolate: key, dependents: /* @__PURE__ */ new Set() };
      if (this.store[key]) {
        throw new Error(`service "${name}" has been registered at <${this.store[key].ctx.fiber.name}>`);
      }
      this.store[key] = impl;
      this.ctx.fiber.provisions.add(impl);
      if (this.ctx.fiber.state === 2 /* ACTIVE */) {
        this.notify([name]);
      }
      return async () => {
        if (this.store[impl.isolate] === impl) delete this.store[impl.isolate];
        this.ctx.isolate(name, impl.isolate).reflect.notify([name]);
        await new Promise((resolve) => {
          impl.release = resolve;
          if (!impl.dependents.size) resolve();
        });
        impl.release = void 0;
        this.ctx.fiber.provisions.delete(impl);
      };
    }, `ctx.provide(${JSON.stringify(name)})`);
  }
  notify(names, filter = (ctx, name) => ctx[symbols.isolate][name] === this.ctx[symbols.isolate][name]) {
    for (const runtime of this.ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        let hasUpdate = false;
        for (const name of names) {
          if (!(name in fiber.inject)) continue;
          if (!filter(fiber.ctx, name)) continue;
          hasUpdate = true;
          fiber._checkImpl(name);
        }
        if (!hasUpdate) continue;
        fiber._refresh();
      }
    }
    for (const name of names) {
      const self = Object.create(this.ctx);
      self[symbols.filter] = (target) => filter(target, name);
      this.ctx.events.emit(self, "internal/service", name, this._getImpl(name, false)?.value);
    }
  }
  accessor(name, options) {
    return this.ctx.fiber.effect(() => {
      if (name in this.props) {
        throw new Error(`property "${name}" is already declared as ${this.props[name].type}`);
      }
      this.props[name] = { type: "accessor", ...options };
      return () => delete this.props[name];
    }, `ctx.accessor(${JSON.stringify(name)})`);
  }
  mixin(source, mixins) {
    const self = this;
    return this.ctx.fiber.effect(function* () {
      const entries = Array.isArray(mixins) ? mixins.map((key) => [key, key]) : Object.entries(mixins);
      const getTarget = /* @__PURE__ */ __name((ctx, error) => {
        return ctx[source];
      }, "getTarget");
      for (const [key, value] of entries) {
        yield self.accessor(value, {
          get(receiver, error) {
            const service = getTarget(this, error);
            if (isNullable2(service)) return service;
            const mixin = receiver ? withProps(receiver, service) : service;
            const value2 = Reflect.get(service, key, mixin);
            if (typeof value2 !== "function") return value2;
            return value2.bind(mixin ?? service);
          },
          set(value2, receiver, error) {
            const service = getTarget(this, error);
            const mixin = receiver ? withProps(receiver, service) : service;
            return Reflect.set(service, key, value2, mixin);
          }
        });
      }
    }, `ctx.mixin(${JSON.stringify(source)})`);
  }
  trace(value) {
    return getTraceable(this.ctx, value);
  }
  bind(callback) {
    return new Proxy(callback, {
      apply: /* @__PURE__ */ __name((target, thisArg, args) => {
        return Reflect.apply(target, this.trace(thisArg), args.map((arg) => this.trace(arg)));
      }, "apply"),
      construct: /* @__PURE__ */ __name((target, args, newTarget) => {
        return Reflect.construct(target, args.map((arg) => this.trace(arg)), newTarget);
      }, "construct")
    });
  }
};

// src/service.ts
var Service = class _Service {
  constructor(ctx, name) {
    this.ctx = ctx;
    name ??= this.constructor["provide"];
    let self = this;
    const tracker = {
      associate: name,
      property: "ctx"
    };
    if (self[symbols.invoke]) {
      self = createCallable(name, joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker);
    }
    self.ctx = ctx;
    self.name = name;
    defineProperty5(self, symbols.tracker, tracker);
    self.ctx.reflect.provide(name, self, this[symbols.check]);
    return self;
  }
  ctx;
  static {
    __name(this, "Service");
  }
  static init = symbols.init;
  static check = symbols.check;
  static invoke = symbols.invoke;
  static metadata = symbols.metadata;
  static extend = symbols.extend;
  static tracker = symbols.tracker;
  static mergeIntercept = symbols.mergeIntercept;
  static resolveIntercept = symbols.resolveIntercept;
  name;
  [symbols.filter](ctx) {
    return ctx[symbols.isolate][this.name] === this.ctx[symbols.isolate][this.name];
  }
  [symbols.extend](props) {
    let self;
    if (this[_Service.invoke]) {
      self = createCallable(this.name, this, this[symbols.tracker]);
    } else {
      self = Object.create(this);
    }
    return Object.assign(self, props);
  }
  [symbols.mergeIntercept](...values) {
    return Object.assign({}, ...values);
  }
  [symbols.resolveIntercept]() {
    const values = [];
    let intercept = this.ctx[Context.intercept];
    while (this.name in intercept) {
      if (Object.hasOwn(intercept, this.name)) {
        values.unshift(intercept[this.name]);
      }
      intercept = Object.getPrototypeOf(intercept);
    }
    const value = locate(this[symbols.caller] ?? this.ctx, this.name)?.fiber?.inject[this.name];
    if (!isNullable3(value)) values.unshift(value);
    const merge = this[symbols.mergeIntercept] ?? _Service.prototype[symbols.mergeIntercept];
    return merge.apply(this, values);
  }
  static [Symbol.hasInstance](instance) {
    if (!instance) return false;
    let constructor = instance.constructor;
    while (constructor) {
      constructor = constructor.prototype?.constructor;
      if (constructor === this) return true;
      constructor &&= Object.getPrototypeOf(constructor);
    }
    return false;
  }
};

// src/logger.ts
var LoggerLevel = /* @__PURE__ */ ((LoggerLevel2) => {
  LoggerLevel2[LoggerLevel2["ERROR"] = 0] = "ERROR";
  LoggerLevel2[LoggerLevel2["WARN"] = 1] = "WARN";
  LoggerLevel2[LoggerLevel2["INFO"] = 2] = "INFO";
  LoggerLevel2[LoggerLevel2["DEBUG"] = 3] = "DEBUG";
  return LoggerLevel2;
})(LoggerLevel || {});
var defaultFormatters = {
  s: /* @__PURE__ */ __name((value) => String(value), "s"),
  d: /* @__PURE__ */ __name((value) => Math.trunc(Number(value)), "d"),
  i: /* @__PURE__ */ __name((value) => Math.trunc(Number(value)), "i"),
  f: /* @__PURE__ */ __name((value) => Number(value), "f"),
  o: /* @__PURE__ */ __name((value) => JSON.stringify(value), "o"),
  O: /* @__PURE__ */ __name((value) => JSON.stringify(value), "O"),
  c: /* @__PURE__ */ __name(() => "", "c"),
  C: /* @__PURE__ */ __name((value, exporter, message) => {
    return Logger.color(exporter, Logger.code(message.name, exporter.colors), value);
  }, "C")
};
function isAggregateError(error) {
  return error instanceof Error && Array.isArray(error["errors"]);
}
__name(isAggregateError, "isAggregateError");
var Logger = class {
  constructor(options, service) {
    this.service = service;
    Object.assign(this, options);
    this.error = this._method("error", 0 /* ERROR */);
    this.info = this._method("info", 2 /* INFO */);
    this.warn = this._method("warn", 1 /* WARN */);
    this.debug = this._method("debug", 3 /* DEBUG */);
  }
  service;
  static {
    __name(this, "Logger");
  }
  static color(exporter, code, value, decoration = "") {
    if (!exporter.colors) return "" + value;
    return `\x1B[3${code < 8 ? code : "8;5;" + code}${exporter.colors >= 2 ? decoration : ""}m${value}\x1B[0m`;
  }
  static code(name, level) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash << 3) - hash + name.charCodeAt(i) + 13;
      hash |= 0;
    }
    const colors = !level ? [] : level >= 2 ? c256 : c16;
    return colors[Math.abs(hash) % colors.length];
  }
  static format(exporter, message) {
    const args = message.args.slice();
    if (args[0] instanceof Error) {
      args[0] = args[0].stack || args[0].message;
      args.unshift("%s");
    } else if (typeof args[0] !== "string") {
      args.unshift("%o");
    }
    let format = args.shift();
    format = format.replace(/%([a-zA-Z%])/g, (match, char) => {
      if (match === "%%") return "%";
      const formatter = exporter.formatters?.[char] ?? defaultFormatters[char];
      if (typeof formatter === "function") {
        const value = args.shift();
        return formatter(value, exporter, message);
      }
      return match;
    });
    const oFormatter = exporter.formatters?.o ?? defaultFormatters.o;
    for (let arg of args) {
      if (typeof arg === "object" && arg) {
        arg = oFormatter(arg, exporter, message);
      }
      format += " " + arg;
    }
    const { maxLength = 10240 } = exporter;
    return format.split(/\r?\n/g).map((line) => {
      return line.slice(0, maxLength) + (line.length > maxLength ? "..." : "");
    }).join("\n");
  }
  _method(type, level) {
    return (...args) => {
      if (args.length === 1 && args[0] instanceof Error) {
        if (args[0].cause) {
          this[type](args[0].cause);
        } else if (isAggregateError(args[0]) && args[0].errors.length) {
          args[0].errors.forEach((error) => this[type](error));
          return;
        }
      }
      const sn = ++this.service._snMessage;
      const ts = Date.now();
      for (const exporter of this.service.exporters.values()) {
        const targetLevel = exporter.levels?.[this.name] ?? exporter.levels?.default ?? this.level ?? 2 /* INFO */;
        if (targetLevel < level) continue;
        const message = { sn, ts, type, level, name: this.name, ...this.meta, args };
        exporter.export(message);
      }
    };
  }
};
var c16 = [6, 2, 3, 4, 5, 1];
var c256 = [
  20,
  21,
  26,
  27,
  32,
  33,
  38,
  39,
  40,
  41,
  42,
  43,
  44,
  45,
  56,
  57,
  62,
  63,
  68,
  69,
  74,
  75,
  76,
  77,
  78,
  79,
  80,
  81,
  92,
  93,
  98,
  99,
  112,
  113,
  129,
  134,
  135,
  148,
  149,
  160,
  161,
  162,
  163,
  164,
  165,
  166,
  167,
  168,
  169,
  170,
  171,
  172,
  173,
  178,
  179,
  184,
  185,
  196,
  197,
  198,
  199,
  200,
  201,
  202,
  203,
  204,
  205,
  206,
  207,
  208,
  209,
  214,
  215,
  220,
  221
];
var LoggerService = class _LoggerService {
  static {
    __name(this, "LoggerService");
  }
  bufferSize = 1e3;
  buffer = [];
  ctx;
  _snMessage = 0;
  _snExporter = 0;
  exporters = /* @__PURE__ */ new Map();
  constructor(ctx) {
    const tracker = {
      property: "ctx",
      noShadow: true
    };
    const self = createCallable("logger", joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker);
    Object.assign(self, this);
    self.ctx = ctx;
    defineProperty6(self, symbols.tracker, tracker);
    self.exporter({
      colors: 3,
      export: /* @__PURE__ */ __name((message) => {
        self.buffer.push(message);
        const overflow = self.buffer.length - self.bufferSize;
        if (overflow === 1) {
          self.buffer.shift();
        } else if (overflow > 1) {
          self.buffer.splice(0, overflow);
        }
      }, "export")
    });
    return self;
  }
  exporter(exporter) {
    return this.ctx.effect(() => {
      const id = ++this._snExporter;
      this.exporters.set(id, exporter);
      return () => this.exporters.delete(id);
    }, "ctx.logger.exporter()");
  }
  [symbols.invoke](name) {
    const caller = this[symbols.caller];
    const config = Service.prototype[Service.resolveIntercept].call(this);
    const fiber = (caller ?? this.ctx).fiber;
    name ??= config.name;
    name ??= hyphenate(fiber.name);
    return new Logger({
      name,
      level: config.level,
      meta: { fiber: new WeakRef(fiber) }
    }, this);
  }
  static {
    for (const type of ["error", "info", "warn", "debug"]) {
      ;
      _LoggerService.prototype[type] = function(...args) {
        return this()[type](...args);
      };
    }
  }
};

// src/registry.ts
import { defineProperty as defineProperty7 } from "cosmokit";
function isApplicable(object) {
  return object && typeof object === "object" && typeof object.apply === "function";
}
__name(isApplicable, "isApplicable");
function Inject(name, config) {
  return function(value, decorator) {
    if (decorator.kind === "class") {
      if (!Object.hasOwn(value, "inject")) {
        defineProperty7(value, "inject", Object.create(Object.getPrototypeOf(value).inject ?? null));
        defineProperty7(value.inject, symbols.checkProto, true);
      }
      value.inject[name] = config;
    } else if (decorator.kind === "method") {
      const inject = (value[symbols.decorator] ??= {}).inject ??= /* @__PURE__ */ Object.create(null);
      inject[name] = config;
      decorator.addInitializer(function() {
        const property = this[symbols.tracker]?.property;
        (this[symbols.initHooks] ??= []).push(() => {
          this.ctx.inject(inject, (ctx) => {
            return value.call(property ? withProps(this, { [property]: ctx }) : this);
          });
        });
      });
    } else {
      throw new Error("@Inject() can only be used on class or class methods");
    }
  };
}
__name(Inject, "Inject");
((Inject2) => {
  function resolve(inject, result = /* @__PURE__ */ Object.create(null)) {
    if (!inject) return result;
    if (Array.isArray(inject)) {
      for (const name of inject) {
        result[name] = null;
      }
    } else if (Reflect.has(inject, symbols.checkProto)) {
      Object.assign(result, resolve(Object.getPrototypeOf(inject)));
      for (const name of Object.keys(inject)) {
        result[name] = inject[name] ?? null;
      }
    } else {
      for (const name of Object.keys(inject)) {
        result[name] = inject[name] ?? null;
      }
    }
    return result;
  }
  Inject2.resolve = resolve;
  __name(resolve, "resolve");
})(Inject || (Inject = {}));
var RegistryService = class {
  constructor(ctx) {
    this.ctx = ctx;
    defineProperty7(this, symbols.tracker, {
      property: "ctx",
      noShadow: true
    });
  }
  ctx;
  static {
    __name(this, "RegistryService");
  }
  _counter = 0;
  _internal = /* @__PURE__ */ new Map();
  get counter() {
    return ++this._counter;
  }
  get size() {
    return this._internal.size;
  }
  resolve(plugin) {
    try {
      if (typeof plugin === "function") return plugin;
      if (isApplicable(plugin)) return plugin.apply;
    } catch {
    }
  }
  get(plugin) {
    const key = this.resolve(plugin);
    return key && this._internal.get(key);
  }
  has(plugin) {
    const key = this.resolve(plugin);
    return !!key && this._internal.has(key);
  }
  delete(plugin) {
    const key = this.resolve(plugin);
    const runtime = key && this._internal.get(key);
    if (!runtime) return;
    this._internal.delete(key);
    for (const fiber of runtime.fibers) {
      fiber.dispose();
    }
    return runtime;
  }
  keys() {
    return this._internal.keys();
  }
  values() {
    return this._internal.values();
  }
  entries() {
    return this._internal.entries();
  }
  forEach(callback) {
    return this._internal.forEach(callback);
  }
  inject(inject, callback) {
    return this.plugin({ inject, apply: callback, name: callback.name });
  }
  plugin(plugin, config, getOuterStack = buildOuterStack()) {
    const callback = this.resolve(plugin);
    if (!callback) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin);
    this.ctx.fiber.assertActive();
    let runtime = this._internal.get(callback);
    if (!runtime) {
      let name = plugin.name;
      if (name === "apply") name = void 0;
      runtime = { name, callback, fibers: new DisposableList(), Config: plugin.Config };
      this._internal.set(callback, runtime);
    }
    const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack);
    const wrapped = Object.create(fiber);
    wrapped.then = (onFulfilled, onRejected) => {
      return fiber.await().then(onFulfilled, onRejected);
    };
    return wrapped;
  }
};

// src/context.ts
var Context = class _Context {
  static {
    __name(this, "Context");
  }
  static root = symbols.root;
  static effect = symbols.effect;
  static filter = symbols.filter;
  static isolate = symbols.isolate;
  static intercept = symbols.intercept;
  static is(value) {
    return !!value?.[_Context.is];
  }
  static {
    _Context.is[Symbol.toPrimitive] = () => /* @__PURE__ */ Symbol.for("cordis.is");
    _Context.prototype[_Context.is] = true;
  }
  constructor() {
    this[symbols.isolate] = /* @__PURE__ */ Object.create(null);
    this[symbols.intercept] = /* @__PURE__ */ Object.create(null);
    const self = new Proxy(this, ReflectService.handler);
    this[symbols.root] = self;
    this.baseUrl = void 0;
    this.fiber = new Fiber(self, {}, /* @__PURE__ */ Object.create(null), null, () => []);
    this.reflect = new ReflectService(self);
    this.registry = new RegistryService(self);
    this.events = new EventsService(self);
    this.logger = new LoggerService(self);
    this.fiber._disposables.clear();
    return self;
  }
  [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")]() {
    return `Context <${this.fiber.name}>`;
  }
  extend(meta = {}) {
    const shadow = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value;
    const self = Object.create(getTraceable(this, this));
    for (const prop of Reflect.ownKeys(meta)) {
      Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop));
    }
    if (!shadow) return self;
    return Object.assign(Object.create(self), { [symbols.shadow]: shadow });
  }
  isolate(name, label) {
    const shadow = Object.create(this[symbols.isolate]);
    shadow[name] = label ?? Symbol(name);
    return this.extend({ [symbols.isolate]: shadow });
  }
  intercept(name, config) {
    const intercept = Object.create(this[symbols.intercept]);
    intercept[name] = config;
    return this.extend({ [symbols.intercept]: intercept });
  }
};
export {
  Context,
  CordisError,
  DisposableList,
  EventsService,
  Fiber,
  FiberState,
  Inject,
  Logger,
  LoggerLevel,
  LoggerService,
  RegistryService,
  Service,
  ValidationError,
  buildOuterStack,
  c16,
  c256,
  composeError,
  createCallable,
  defaultFormatters,
  getPropertyDescriptor,
  getTraceable,
  isBailed,
  isConstructor,
  isObject,
  joinPrototype,
  resolveConfig,
  symbols,
  withProps
};
