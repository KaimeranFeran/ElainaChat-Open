/**
 * kernel 生命周期薄封装。
 *
 * 设计目标：不重新发明插件系统，只在 cordis 的 Context/plugin 上加三件宿主必需的能力：
 * 1. 失败隔离：一个插件抛错不能让 sidecar 崩溃（设计文档第 8 节）；
 * 2. 可回收：宿主退出/热卸载时能按安装的反序释放所有插件 fiber；
 * 3. 可观测：宿主日志能拿到每个插件的安装结果。
 *
 * 因此本文件只依赖 cordis 原生语义（ctx.plugin / fiber.dispose / ctx.effect），
 * 不做自己的调度。
 */
import { Context, type Fiber, type Plugin } from 'cordis';
import { ToolsService } from './tools.ts';

export interface MountRecord {
  name: string;
  ok: boolean;
  fiber?: Fiber;
  error?: Error;
}

export interface MountResult extends MountRecord {
  ok: boolean;
}

export interface KernelOptions {
  /** 是否自动安装内置 tools 注册表服务（默认 true；单测内核本身时可关掉） */
  tools?: boolean;
}

export interface Kernel {
  readonly ctx: Context;
  /** 按安装顺序记录每次 mount 的结果，供日志/诊断使用 */
  readonly mounts: MountRecord[];
  readonly disposed: boolean;
  /** 安装插件；失败被隔离成返回值，不向调用方抛出 */
  install(plugin: Plugin, config?: unknown): Promise<MountResult>;
  /** 释放所有已安装插件（反序），失败收集在 disposeErrors 里 */
  dispose(): Promise<void>;
  readonly disposeErrors: Error[];
}

function pluginLabel(plugin: Plugin): string {
  const named = plugin as { name?: unknown };
  if (typeof named.name === 'string' && named.name) return named.name;
  return 'anonymous-plugin';
}

/**
 * 创建内核。默认自动挂内置 ToolsService，因为 tools/runtime 的所有注册都从它开始；
 * 返回 Promise 是因为 cordis 的 plugin 安装是异步 fiber（await 后服务才 guarantee 可用）。
 */
export async function createKernel(options: KernelOptions = {}): Promise<Kernel> {
  const ctx = new Context();
  const mounts: MountRecord[] = [];
  const disposeErrors: Error[] = [];
  let disposed = false;

  const kernel: Kernel = {
    ctx,
    mounts,
    disposeErrors,
    get disposed() {
      return disposed;
    },
    async install(plugin: Plugin, config?: unknown): Promise<MountResult> {
      const name = pluginLabel(plugin);
      if (disposed) {
        const error = new Error('kernel 已释放，不能再安装插件：' + name);
        mounts.push({ name, ok: false, error });
        return { name, ok: false, error };
      }
      try {
        // cordis 的 plugin 泛型签名对动态插件不友好，这里统一走运行时入口；
        // 失败会在 await 时抛出，正好作为隔离边界。
        const fiber = (await (ctx.plugin as unknown as (p: Plugin, c?: unknown) => Fiber & PromiseLike<Fiber>)(plugin, config));
        const record: MountRecord = { name, ok: true, fiber };
        mounts.push(record);
        return record;
      } catch (reason) {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        const record: MountRecord = { name, ok: false, error };
        mounts.push(record);
        return record;
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // 反序释放：后安装的插件可能依赖先安装的（比如插件依赖 tools 服务）
      for (const record of [...mounts].reverse()) {
        if (!record.ok || !record.fiber) continue;
        try {
          await record.fiber.dispose();
        } catch (reason) {
          disposeErrors.push(reason instanceof Error ? reason : new Error(String(reason)));
        }
      }
      mounts.length = 0;
    },
  };

  if (options.tools !== false) {
    const result = await kernel.install(ToolsService);
    if (!result.ok) {
      throw new Error('内置 tools 服务安装失败：' + (result.error?.message ?? 'unknown'));
    }
  }

  return kernel;
}
