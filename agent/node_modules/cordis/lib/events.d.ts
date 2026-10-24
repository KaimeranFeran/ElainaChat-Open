import { Awaitable, Promisify } from 'cosmokit';
import { Context } from './context.ts';
import { Fiber, FiberState } from './fiber.ts';
export declare function isBailed(value: any): boolean;
export type Parameters<F> = F extends (...args: infer P) => any ? P : never;
export type ReturnType<F> = F extends (...args: any) => infer R ? R : never;
export type ThisType<F> = F extends (this: infer T, ...args: any) => any ? T : never;
export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall';
declare module './context.ts' {
    interface Context {
        parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void>;
        parallel<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): Promise<void>;
        emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void;
        emit<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): void;
        serial<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>;
        serial<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>;
        bail<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>;
        bail<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>;
        waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>;
        waterfall<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>;
        on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean;
        once<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean;
    }
}
export interface EventOptions {
    prepend?: boolean;
    global?: boolean;
}
export interface Hook extends EventOptions {
    ctx: Context;
    callback: (...args: any[]) => any;
}
export declare class EventsService {
    private ctx;
    _hooks: Record<keyof any, Hook[]>;
    constructor(ctx: Context);
    private _resolve;
    /** @deprecated */
    dispatch(type: string, args: any[]): ((...args: any[]) => any)[];
    parallel(...args: any[]): Promise<void>;
    emit(...args: any[]): void;
    serial(...args: any[]): Promise<any>;
    bail(...args: any[]): any;
    waterfall(...args: any[]): any;
    private register;
    private unregister;
    on(name: string | symbol, listener: (...args: any) => any, options?: boolean | EventOptions): any;
    once(name: string | symbol, listener: (...args: any) => any, options?: boolean | EventOptions): any;
}
export interface Events {
    [key: symbol]: (...args: any[]) => any;
    'internal/plugin'(fiber: Fiber): void;
    'internal/status'(fiber: Fiber, oldValue: FiberState): void;
    'internal/service'(this: Context, name: string, value: any): void;
    'internal/update'(this: Fiber, resolvedConfig: any, next: () => Awaitable<void>): Awaitable<void>;
    'internal/commit'(fiber: Fiber, originalConfig: any): void;
    'internal/config'(fiber: Fiber, next: () => any): any;
    'internal/get'(ctx: Context, name: string, error: Error, next: () => any): any;
    'internal/set'(ctx: Context, name: string, value: any, error: Error, next: () => boolean): boolean;
    'internal/listener'(this: Context, name: string, listener: any, prepend: boolean): void;
    'internal/dispatch'(mode: DispatchMode, name: string | symbol, args: any[], thisArg: any): void;
}
