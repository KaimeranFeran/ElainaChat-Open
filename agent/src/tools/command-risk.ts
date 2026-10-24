/**
 * shell 命令风险分类（审批层唯一数据源）。
 *
 * 原则：分类宁可保守 —— 未知命令一律按 mutating 处理；只有明确只读的
 * 命令族才归为 safe；会造成不可逆数据丢失的命令归为 destructive。
 * 这里只做词法判断，不做沙箱；真正执行仍由审批层与 shell 治理兜底。
 */

export type CommandRisk = 'safe' | 'mutating' | 'destructive';

export interface CommandAnalysis {
  risk: CommandRisk;
  reason: string;
}

const DESTRUCTIVE_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|[\s;&|])rm\s+-[a-zA-Z-]*[rR][a-zA-Z-]*/, reason: 'rm 递归删除' },
  { pattern: /(^|[\s;&|])rm\s+-[a-zA-Z-]*f/, reason: 'rm 强制删除' },
  { pattern: /\bremove-item\b[^\n;&|]*-recurse/i, reason: 'Remove-Item -Recurse 递归删除' },
  { pattern: /\bremove-item\b[^\n;&|]*-force/i, reason: 'Remove-Item -Force 强制删除' },
  { pattern: /\b(del|erase)\b[^\n;&|]*\/[a-z]*[fsq]/i, reason: 'del/erase 带 /f /s /q 删除' },
  { pattern: /\b(rmdir|rd)\b[^\n;&|]*\/s/i, reason: 'rmdir /s 递归删除目录' },
  { pattern: /\bformat\s+[a-zA-Z]:/, reason: 'format 格式化磁盘' },
  { pattern: /\bdiskpart\b/i, reason: 'diskpart 磁盘分区操作' },
  { pattern: /\bmkfs(\.\w+)?\s/i, reason: 'mkfs 格式化文件系统' },
  { pattern: /\bdd\s+if=/i, reason: 'dd 原始磁盘写入' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'git reset --hard 丢弃工作区改动' },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*[fdx]/i, reason: 'git clean -fdx 删除未跟踪文件' },
  { pattern: /\bgit\s+push\b[^\n;&|]*\s(--force|-f)(\s|$)/i, reason: 'git push --force 强推' },
  { pattern: /\bgit\s+branch\s+-D\b/, reason: 'git branch -D 强制删分支' },
  { pattern: /\bgit\s+checkout\s+--\s+\./, reason: 'git checkout -- . 丢弃改动' },
  { pattern: /\bgit\s+restore\s+(--source\S*\s+)?\./, reason: 'git restore . 丢弃改动' },
  { pattern: /\bgit\s+reset\s+--keep\b/i, reason: 'git reset --keep 可能丢弃改动' },
  { pattern: /\b(shutdown|stop-computer|restart-computer)\b/i, reason: '关机/重启' },
  { pattern: /\breg\s+delete\b/i, reason: 'reg delete 删除注册表项' },
  { pattern: /\bbcdedit\b/i, reason: 'bcdedit 修改启动配置' },
  { pattern: /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, reason: 'SQL 破坏性语句' },
  { pattern: /\bdelete\s+from\s+[^\n;]*?(;\s*$|$)/i, reason: 'SQL 无 WHERE 的 DELETE' },
  { pattern: /\b(rimraf|npkill)\b/i, reason: 'rimraf/npkill 批量删除' },
  { pattern: /\b(cipher\s+\/w|takeown\b|icacls\b[^\n;&|]*\/deny)/i, reason: '权限/擦除类危险操作' },
  { pattern: /\btaskkill\b[^\n;&|]*\/f[^\n;&|]*(\/im|\/t)\b/i, reason: 'taskkill 强杀进程树' },
];

/** 明确只读的命令头（PowerShell 别名 + 常用只读工具） */
const SAFE_HEADS = new Set([
  'ls',
  'dir',
  'gci',
  'get-childitem',
  'tree',
  'cat',
  'type',
  'get-content',
  'gc',
  'pwd',
  'get-location',
  'gl',
  'echo',
  'write-output',
  'write-host',
  'where',
  'where.exe',
  'which',
  'get-command',
  'test-path',
  'resolve-path',
  'get-item',
  'get-itemproperty',
  'get-date',
  'get-process',
  'get-service',
  'get-help',
  'get-module',
  'get-variable',
  'select-string',
  'findstr',
  'grep',
  'rg',
  'head',
  'tail',
  'wc',
  'measure-object',
  'sort-object',
  'select-object',
  'where-object',
  'format-table',
  'format-list',
  'format-wide',
  'out-string',
  'compare-object',
  'get-filehash',
  'stat',
  'readlink',
  'realpath',
  'whoami',
  'hostname',
  'systeminfo',
  'ipconfig',
  'ping',
  'nslookup',
  'netstat',
  'basename',
  'dirname',
  'cut',
  'uniq',
  'tr',
  'printenv',
  'env',
]);

/** 只有「版本/帮助」参数时才算只读的可执行文件（跑脚本会改工作区，按 mutating） */
const VERSION_ONLY_HEADS = new Set([
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'python',
  'python3',
  'py',
  'tsc',
  'deno',
  'bun',
  'dotnet',
  'go',
  'cargo',
  'java',
  'php',
  'ruby',
  'perl',
]);

const VERSION_FLAGS = new Set(['--version', '-v', '-V', '--help', '-h', 'version', '--info']);

/** git 只读子命令（args 另做单独校验） */
const GIT_SAFE_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'rev-list',
  'ls-files',
  'ls-tree',
  'blame',
  'shortlog',
  'describe',
  'cat-file',
  'grep',
  'reflog',
  'show-ref',
  'merge-base',
  'count-objects',
  'check-ignore',
  'for-each-ref',
  'version',
  'help',
]);

/** 会写文件的 shell 重定向/写入 cmdlet：出现在任何位置都不算 safe */
const WRITE_MARKERS = [
  /\bout-file\b/i,
  /\bset-content\b/i,
  /\badd-content\b/i,
  /\btee-object\b/i,
  /\bexport-csv\b/i,
  /\bnew-item\b/i,
  /\bcopy-item\b/i,
  /\bmove-item\b/i,
  /\bstart-process\b/i,
  /\binvoke-expression\b/i,
  /\biex\b/i,
];

function splitSegments(command: string): string[] {
  return command
    .split(/\r?\n|;|&&|\|\||\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

function hasWriteMarker(segment: string): boolean {
  if (/(^|[^>])>{1,2}(?!&)/.test(segment)) return true;
  return WRITE_MARKERS.some((pattern) => pattern.test(segment));
}

function analyzeGit(tokens: string[]): CommandAnalysis {
  const subcommand = (tokens[1] ?? '').toLowerCase();
  const rest = tokens.slice(2);
  if (!subcommand) return { risk: 'mutating', reason: 'git 无子命令（可能进入交互帮助）' };
  if (GIT_SAFE_SUBCOMMANDS.has(subcommand)) {
    if (subcommand === 'diff' || subcommand === 'show' || subcommand === 'log') {
      if (rest.some((arg) => arg === '--output' || arg.startsWith('--output='))) {
        return { risk: 'mutating', reason: 'git ' + subcommand + ' --output 会写文件' };
      }
    }
    return { risk: 'safe', reason: 'git ' + subcommand + ' 为只读查询' };
  }
  if (subcommand === 'branch') {
    const allowed = new Set(['-a', '-r', '-v', '-vv', '--list', '--all', '--remotes', '--show-current', '--no-color', '--color', '--contains', '--merged', '--no-merged', '--verbose']);
    if (rest.every((arg) => allowed.has(arg))) return { risk: 'safe', reason: 'git branch 列分支' };
    return { risk: 'mutating', reason: 'git branch 带创建/删除/改名参数' };
  }
  if (subcommand === 'tag') {
    if (rest.length === 0 || rest.every((arg) => arg === '--list' || arg === '-l' || arg === '-n' || arg.startsWith('-n'))) {
      return { risk: 'safe', reason: 'git tag 列标签' };
    }
    return { risk: 'mutating', reason: 'git tag 会创建/删除标签' };
  }
  if (subcommand === 'remote') {
    if (rest.length === 0 || rest.every((arg) => arg === '-v' || arg === '--verbose' || arg === 'show' || arg === 'get-url')) {
      return { risk: 'safe', reason: 'git remote 列远端' };
    }
    return { risk: 'mutating', reason: 'git remote 修改远端配置' };
  }
  if (subcommand === 'config') {
    if (rest.length === 0 || rest.some((arg) => arg === '--get' || arg === '--get-all' || arg === '--get-regexp' || arg === '--list' || arg === '-l')) {
      return { risk: 'safe', reason: 'git config 读取配置' };
    }
    return { risk: 'mutating', reason: 'git config 写配置' };
  }
  if (subcommand === 'stash') {
    if (rest.length === 0 || rest[0] === 'list' || rest[0] === 'show') return { risk: 'safe', reason: 'git stash 只读' };
    return { risk: 'mutating', reason: 'git stash 修改工作区状态' };
  }
  if (subcommand === 'worktree') {
    if (rest.length === 0 || rest[0] === 'list') return { risk: 'safe', reason: 'git worktree 列出' };
    return { risk: 'mutating', reason: 'git worktree 修改工作区' };
  }
  return { risk: 'mutating', reason: 'git ' + subcommand + ' 会修改仓库' };
}

function analyzeSegment(segment: string): CommandAnalysis {
  if (hasWriteMarker(segment)) return { risk: 'mutating', reason: '包含重定向或写文件命令' };
  if (/\$\(|\x60/.test(segment)) return { risk: 'mutating', reason: '包含命令替换，效果无法静态确认' };
  const tokens = tokenize(segment);
  if (tokens.length === 0) return { risk: 'mutating', reason: '空命令' };
  let head = tokens[0].toLowerCase();
  // cmd /c、powershell -Command 这类包装层：剥掉后按内层判断
  if ((head === 'cmd' || head === 'cmd.exe') && (tokens[1] ?? '').toLowerCase() === '/c') {
    return analyzeSegment(tokens.slice(2).join(' '));
  }
  if ((head === 'powershell' || head === 'powershell.exe' || head === 'pwsh' || head === 'pwsh.exe') && tokens.length > 1) {
    const idx = tokens.findIndex((token) => /^-(command|c)$/i.test(token));
    if (idx >= 0) return analyzeSegment(tokens.slice(idx + 1).join(' '));
  }
  if (head.startsWith('&')) head = head.slice(1).toLowerCase();
  if (!head) return { risk: 'mutating', reason: '空命令' };
  if (head === 'git') return analyzeGit(tokens);
  if (SAFE_HEADS.has(head)) return { risk: 'safe', reason: head + ' 为只读命令' };
  if (VERSION_ONLY_HEADS.has(head)) {
    const args = tokens.slice(1);
    if (args.length > 0 && args.every((arg) => VERSION_FLAGS.has(arg.toLowerCase()))) {
      return { risk: 'safe', reason: head + ' 只查询版本/帮助' };
    }
    return { risk: 'mutating', reason: head + ' 会执行脚本或修改文件' };
  }
  if (head === 'more' || head === 'more.com') return { risk: 'safe', reason: 'more 分页查看（执行层会拦截交互）' };
  return { risk: 'mutating', reason: '未知命令，按变更类处理：' + head };
}

/** 分析一条命令，返回风险等级与判定原因 */
export function analyzeCommand(command: string): CommandAnalysis {
  const text = String(command ?? '').trim();
  if (!text) return { risk: 'mutating', reason: '空命令，无法确认意图' };
  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.pattern.test(text)) return { risk: 'destructive', reason: rule.reason };
  }
  const segments = splitSegments(text);
  if (segments.length === 0) return { risk: 'mutating', reason: '空命令，无法确认意图' };
  for (const segment of segments) {
    const analysis = analyzeSegment(segment);
    if (analysis.risk !== 'safe') return analysis;
  }
  return { risk: 'safe', reason: '全部为只读查询命令' };
}

/** 只要风险等级 */
export function classifyCommand(command: string): CommandRisk {
  return analyzeCommand(command).risk;
}

/** git commit 是否带了内联提交信息（否则会打开编辑器等待输入） */
function hasCommitMessage(segment: string): boolean {
  return /(^|\s)(?:-[a-zA-Z]*m|--message(?:=|\s)|-F\b|--file(?:=|\s)|-C\b|--reuse-message(?:=|\s)|--no-edit\b)/.test(segment);
}

/**
 * 交互特征检测：命中即拒绝执行（INTERACTIVE_BLOCKED），
 * 因为 stdin 已关闭，交互命令只会挂到超时。
 */
export function detectInteractive(command: string): string | null {
  const text = String(command ?? '');
  if (/\bread-host\b/i.test(text)) return 'Read-Host 会阻塞等待输入';
  if (/(^|[|;&]\s*)pause(\.exe)?(\s|$)/i.test(text)) return 'pause 会阻塞等待按键';
  if (/(^|[|;&]\s*)more(\.com)?(\s|$)/i.test(text)) return 'more 是交互式分页器';
  if (/\bout-gridview\b/i.test(text)) return 'Out-GridView 会打开交互窗口';
  if (/\bgit\s+commit\b/i.test(text)) {
    const segments = text.split(/[;&|\r\n]+/).filter((part) => /\bgit\s+commit\b/i.test(part));
    // 只要有一处 commit 没带内联信息，整条命令就会在某一步挂起等编辑器
    if (segments.some((segment) => !hasCommitMessage(segment))) return 'git commit 缺少 -m/--message，会打开编辑器等待输入';
  }
  return null;
}
