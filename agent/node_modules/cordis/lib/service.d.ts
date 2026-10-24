import { Context } from './context.ts';
import { symbols } from './utils.ts';
export declare abstract class Service<out T = never> {
    protected ctx: Context;
    static readonly init: unique symbol;
    static readonly check: unique symbol;
    static readonly invoke: unique symbol;
    static readonly metadata: unique symbol;
    static readonly extend: unique symbol;
    static readonly tracker: unique symbol;
    static readonly mergeIntercept: unique symbol;
    static readonly resolveIntercept: unique symbol;
    [symbols.metadata]: T;
    name: string;
    constructor(ctx: Context, name: string);
    protected [symbols.filter](ctx: Context): boolean;
    protected [symbols.extend](props?: any): any;
    [symbols.mergeIntercept](...values: T[]): T;
    [symbols.resolveIntercept](): T;
    static [Symbol.hasInstance](instance: any): boolean;
}
