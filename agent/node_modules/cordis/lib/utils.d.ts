import type { Context } from './context.ts';
import type { Service } from './service.ts';
export declare class DisposableList<T extends WeakKey> {
    private sn;
    private map;
    private weak;
    get length(): number;
    push(value: T): () => boolean;
    delete(value: T): boolean;
    clear(): T[];
    [Symbol.iterator](): MapIterator<T>;
}
export interface Tracker {
    associate?: string;
    property?: string;
    noShadow?: boolean;
}
export declare const symbols: {
    shadow: symbol;
    caller: symbol;
    receiver: symbol;
    original: symbol;
    decorator: symbol;
    initHooks: symbol;
    checkProto: symbol;
    root: typeof Context.root;
    effect: typeof Context.effect;
    filter: typeof Context.filter;
    isolate: typeof Context.isolate;
    intercept: typeof Context.intercept;
    init: typeof Service.init;
    check: typeof Service.check;
    invoke: typeof Service.invoke;
    metadata: typeof Service.metadata;
    extend: typeof Service.extend;
    tracker: typeof Service.tracker;
    mergeIntercept: typeof Service.mergeIntercept;
    resolveIntercept: typeof Service.resolveIntercept;
};
export declare function isConstructor(func: any): func is new (...args: any) => any;
export declare function joinPrototype(proto1: {}, proto2: {}): any;
export declare function isObject(value: any): value is {};
export declare function getPropertyDescriptor(target: any, prop: string | symbol): TypedPropertyDescriptor<any> | undefined;
export declare function getTraceable<T>(ctx: Context, value: T): T;
export declare function withProps(target: any, props?: {}): any;
export declare function createCallable(name: string, proto: {}, tracker: Tracker): any;
interface StackInfo {
    offset: number;
    error: Error;
}
export declare function composeError<T>(callback: (info: StackInfo) => T, getOuterStack?: () => string[]): T;
export declare function buildOuterStack(offset?: number): () => string[];
export {};
