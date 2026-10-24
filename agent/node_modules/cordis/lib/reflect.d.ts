import { Dict } from 'cosmokit';
import { Context } from './context.ts';
import { Fiber } from './fiber.ts';
declare module './context.ts' {
    interface Context {
        get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K];
        get(name: string, strict?: boolean): any;
        set<K extends string & keyof this>(name: K, value: undefined | this[K]): void;
        set(name: string, value: any): void;
        provide<K extends string & keyof this>(name: K, value: undefined | this[K]): () => void;
        provide(name: string, value?: any): () => void;
        accessor(name: string, options: Omit<Property.Accessor, 'type'>): void;
        mixin<K extends string & keyof this>(name: K, mixins: (keyof this & keyof this[K])[] | Dict<string>): void;
        mixin<T extends {}>(source: T, mixins: (keyof this & keyof T)[] | Dict<string>): void;
    }
}
export type Property = Property.Service | Property.Accessor;
export declare namespace Property {
    interface Service {
        type: 'service';
    }
    interface Accessor {
        type: 'accessor';
        get: (this: Context, receiver: any, error: Error) => any;
        set?: (this: Context, value: any, receiver: any, error: Error) => boolean;
    }
}
export interface Impl {
    uid: number;
    name: string;
    ctx: Context;
    dependents: Set<Fiber>;
    release?: () => void;
    value?: any;
    check?: () => boolean;
    isolate: symbol;
}
export declare function locate(ctx: Context, name: string): {
    fiber?: Fiber;
    impl?: Impl;
} | undefined;
export declare class ReflectService {
    ctx: Context;
    static handler: ProxyHandler<Context>;
    store: Dict<Impl, symbol>;
    props: Dict<Property>;
    private _implCounter;
    constructor(ctx: Context);
    get(name: string, strict?: boolean): any;
    _getImpl(name: string, strict?: boolean): Impl | undefined;
    set(name: string, value: any, error?: Error): boolean;
    provide(name: string, value?: any, check?: () => boolean): import("./fiber.ts").Disposable<Promise<void>>;
    notify(names: string[], filter?: (ctx: Context, name: string) => boolean): void;
    accessor(name: string, options: Omit<Property.Accessor, 'type'>): import("./fiber.ts").Disposable<Promise<void>>;
    mixin(source: any, mixins: string[] | Dict<string>): import("./fiber.ts").Disposable<Promise<void>>;
    trace<T>(value: T): T;
    bind<T extends Function>(callback: T): T;
}
