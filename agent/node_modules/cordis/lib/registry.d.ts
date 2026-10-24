import { Dict } from 'cosmokit';
import { StandardSchemaV1 } from '@standard-schema/spec';
import { Context } from './context.ts';
import { Fiber } from './fiber.ts';
import { DisposableList, symbols } from './utils.ts';
export type Inject<M = Dict> = (keyof M)[] | {
    [K in keyof M]?: M[K];
};
export type InjectKey = keyof {
    [K in keyof Context & string as Context[K] extends {
        [symbols.metadata]: any;
    } ? K : never]: any;
};
export declare function Inject<K extends InjectKey>(name: K, config?: Context[K] extends {
    [symbols.metadata]: infer T;
} ? T : never): (value: any, decorator: ClassDecoratorContext<any> | ClassMethodDecoratorContext<any>) => void;
export declare namespace Inject {
    function resolve(inject: Inject | null | undefined, result?: Dict): Dict;
}
export type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>;
export declare namespace Plugin {
    interface Base<T = any> {
        name?: string;
        Config?: StandardSchemaV1<any, T>;
        inject?: Inject;
        provide?: string | string[];
        intercept?: Dict<boolean>;
    }
    interface Transform<S, T> {
        schema?: true;
        Config: (config: S) => T;
    }
    interface Function<T = any> extends Base<T> {
        (ctx: Context, config: T): any;
    }
    interface Constructor<T = any> extends Base<T> {
        new (ctx: Context, config: T): any;
    }
    interface Object<T = any> extends Base<T> {
        apply(ctx: Context, config: T): any;
    }
    interface Runtime {
        name?: string;
        fibers: DisposableList<Fiber>;
        callback: globalThis.Function;
        Config?: StandardSchemaV1;
    }
}
type Spread<T> = undefined extends T ? [config?: T] : [config: T];
type GetPluginParameters<P> = P extends (ctx: Context, ...args: infer R) => any ? R : P extends new (ctx: Context, ...args: infer R) => any ? R : P extends {
    apply(ctx: Context, ...args: infer R): any;
} ? R : never;
type GetPluginConfig<P> = P extends Plugin.Transform<infer S, any> ? S : GetPluginParameters<P>[0];
declare module './context.ts' {
    interface Context {
        inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>;
        plugin<P extends Plugin>(plugin: P, ...args: Spread<GetPluginConfig<P>>): Fiber & PromiseLike<Fiber>;
    }
}
export declare class RegistryService {
    ctx: Context;
    private _counter;
    private _internal;
    constructor(ctx: Context);
    get counter(): number;
    get size(): number;
    resolve(plugin: Plugin): Function | undefined;
    get(plugin: Plugin): Plugin.Runtime | undefined;
    has(plugin: Plugin): boolean;
    delete(plugin: Plugin): Plugin.Runtime | undefined;
    keys(): MapIterator<Function>;
    values(): MapIterator<Plugin.Runtime>;
    entries(): MapIterator<[Function, Plugin.Runtime]>;
    forEach(callback: (value: Plugin.Runtime, key: Function) => void): void;
    inject(inject: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>;
    plugin(plugin: Plugin, config?: any, getOuterStack?: () => string[]): Fiber & PromiseLike<Fiber>;
}
export {};
