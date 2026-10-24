import { Awaitable, Dict } from 'cosmokit';
import { Context } from './context.ts';
import { Plugin } from './registry.ts';
import { DisposableList } from './utils.ts';
import { Impl } from './reflect.ts';
import { StandardSchemaV1 } from '@standard-schema/spec';
declare module './context.ts' {
    interface Context extends Pick<Fiber, 'effect'> {
        fiber: Fiber;
    }
}
export declare class ValidationError extends TypeError {
    issues: readonly StandardSchemaV1.Issue[];
    name: string;
    constructor(issues: readonly StandardSchemaV1.Issue[]);
    static is(error: unknown): error is ValidationError;
    static normalizePath(path?: StandardSchemaV1.Issue['path']): PropertyKey[];
    static formatPath(path: StandardSchemaV1.Issue['path']): string;
}
export declare function resolveConfig(runtime: Plugin.Runtime, config: any): any;
interface AsyncDisposable<T extends Awaitable<void> = Awaitable<void>> extends PromiseLike<() => T> {
    (): T;
}
export type Disposable<T = any> = () => T;
export type Effect<T = any> = SyncEffect<T> | AsyncEffect<T>;
type SyncEffect<T = any> = Disposable<T> | Iterable<Disposable<T>, void, void>;
type AsyncEffect<T = any> = Promise<Disposable<T>> | AsyncIterable<Disposable<T>, void, void>;
export interface EffectMeta {
    label: string;
    children: EffectMeta[];
}
export declare const enum FiberState {
    PENDING = 0,
    LOADING = 1,
    ACTIVE = 2,
    FAILED = 3,
    DISPOSED = 4,
    UNLOADING = 5
}
export declare class CordisError extends Error {
    code: CordisError.Code;
    constructor(code: CordisError.Code, message?: string);
}
export declare namespace CordisError {
    type Code = keyof typeof Code;
    const Code: {
        readonly INACTIVE_EFFECT: "cannot create effect on inactive context";
    };
}
export declare class Fiber {
    parent: Context;
    config: any;
    inject: Dict<any>;
    runtime: Plugin.Runtime | null;
    uid: number | null;
    readonly ctx: Context;
    state: FiberState;
    readonly dispose: () => Promise<void>;
    committed: Readonly<Dict<Impl>> | undefined;
    readonly provisions: Set<Impl>;
    inertia: Promise<void> | undefined;
    readonly _hooks: Dict<DisposableList<Function>>;
    readonly _disposables: DisposableList<Disposable<any>>;
    protected context: Context;
    private _error;
    private _revision;
    private _runner;
    private _store;
    private _release;
    constructor(parent: Context, config: any, inject: Dict<any>, runtime: Plugin.Runtime | null, getOuterStack: () => string[]);
    get name(): string;
    assertActive(): void;
    private _resolve;
    private _execute;
    effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>;
    effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>;
    getEffects(): EffectMeta[];
    private _getState;
    private _updateState;
    _checkImpl(name: string): boolean | undefined;
    _refresh(): void;
    private _setEpoch;
    private _reload;
    private _unload;
    await(): Promise<this>;
    restart(): Promise<void>;
    update(config: any, noSave?: boolean): Awaitable<void>;
}
export {};
