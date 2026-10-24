import { Dict } from 'cosmokit';
import { EventsService } from './events.ts';
import { LoggerService } from './logger.ts';
import { ReflectService } from './reflect.ts';
import { InjectKey, RegistryService } from './registry.ts';
import { symbols } from './utils.ts';
import './fiber.ts';
export interface Context {
    [symbols.root]: this;
    [symbols.isolate]: Dict<symbol>;
    [symbols.intercept]: Dict;
    baseUrl?: string | undefined;
    events: EventsService;
    logger: LoggerService;
    reflect: ReflectService;
    registry: RegistryService;
}
export declare class Context {
    static readonly root: unique symbol;
    static readonly effect: unique symbol;
    static readonly filter: unique symbol;
    static readonly isolate: unique symbol;
    static readonly intercept: unique symbol;
    static is(value: any): value is Context;
    constructor();
    extend(meta?: {}): this;
    isolate(name: string, label?: symbol): this;
    intercept<K extends InjectKey>(name: K, config: Context[K] extends {
        [symbols.metadata]: infer T;
    } ? T : never): this;
    intercept(name: string, config: any): this;
}
