import { Context } from './context.ts';
import { Fiber } from './fiber.ts';
import { symbols } from './utils.ts';
export type LoggerType = 'error' | 'info' | 'warn' | 'debug';
export type LoggerMethod = (format: any, ...param: any[]) => void;
export type Formatter = (value: any, exporter: Exporter, message: Message) => any;
export declare const enum LoggerLevel {
    ERROR = 0,
    WARN = 1,
    INFO = 2,
    DEBUG = 3
}
export interface Message {
    sn: number;
    ts: number;
    name: string;
    type: LoggerType;
    level: number;
    args: any[];
    fiber?: WeakRef<Fiber>;
}
export interface Exporter {
    colors?: number | false;
    maxLength?: number;
    levels?: Record<string, number>;
    formatters?: Record<string, Formatter>;
    export(message: Message): void;
}
export declare const defaultFormatters: Record<string, Formatter>;
export interface LoggerOptions {
    name: string;
    meta?: Partial<Message>;
    level?: number;
}
export interface Logger extends LoggerOptions {
}
export interface Logger extends Record<LoggerType, LoggerMethod> {
}
export declare class Logger {
    private service;
    static color(exporter: Exporter, code: number, value: any, decoration?: string): string;
    static code(name: string, level?: false | number): number;
    static format(exporter: Exporter, message: Message): string;
    constructor(options: LoggerOptions, service: LoggerService);
    private _method;
}
export declare const c16: number[];
export declare const c256: number[];
export declare namespace LoggerService {
    interface Intercept {
        name?: string;
        level?: number;
    }
}
export interface LoggerService extends Record<LoggerType, LoggerMethod> {
    (name?: string): Logger;
}
export declare class LoggerService {
    [symbols.metadata]: LoggerService.Intercept;
    bufferSize: number;
    buffer: Message[];
    ctx: Context;
    _snMessage: number;
    _snExporter: number;
    exporters: Map<number, Exporter>;
    constructor(ctx: Context);
    exporter(exporter: Exporter): import("./fiber.ts").Disposable<Promise<void>>;
    [symbols.invoke](name?: string): Logger;
}
