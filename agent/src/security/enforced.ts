/**
 * 开源版强制开关：官方网关黑名单无条件生效（本文件由 scripts/sync-agent.mjs 生成，勿手改）。
 *
 * 闭源版与开源版的 agent 代码完全相同；唯一的差异在这里：
 *   · 闭源版允许用户配置任何非网关服务商；
 *   · 开源版即使配置文件被改，也必须保证「agent 不走官方网关」这条硬约束不失效
 *     （docs/agent-design.md §1：命中即 agent 不可用，非提示）。
 *
 * 使用方：开源侧 gateway-blocklist / config 校验在判断前先看这个常量。
 */
export const OPEN_ENFORCE_GATEWAY_BLOCKLIST = true;
