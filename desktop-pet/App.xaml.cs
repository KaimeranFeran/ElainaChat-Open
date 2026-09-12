using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace ElainaPet;

/// <summary>
/// 应用入口。负责单实例控制与启动主窗口。
/// </summary>
public partial class App : Application
{
    // 单实例互斥体名称（Local=仅当前会话；改 Global\ 可跨会话单实例）。
    private const string MutexName = "Local\\ElainaPet_SingleInstance_Mutex";

    private Mutex? _mutex;

    /// <summary>错误日志（%AppData%\ElainaPet\error.log）</summary>
    public static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ElainaPet", "error.log");

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // 尝试创建全局互斥体；若创建失败说明已有实例在运行。
        _mutex = new Mutex(true, MutexName, out bool createdNew);
        if (!createdNew)
        {
            MessageBox.Show("ElainaPet 已在运行。", "提示",
                MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        /* 全局异常兜底：避免 async void / UI 线程异常直接崩进程且无提示 */
        DispatcherUnhandledException += (_, args) =>
        {
            try { File.AppendAllText(LogPath, DateTime.Now + " [UI] " + args.Exception + Environment.NewLine); } catch { }
            MessageBox.Show("发生错误：" + args.Exception.Message + "\n\n日志：" + LogPath, "ElainaChat", MessageBoxButton.OK, MessageBoxImage.Warning);
            args.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
        {
            try { File.AppendAllText(LogPath, DateTime.Now + " [Domain] " + args.ExceptionObject + Environment.NewLine); } catch { }
        };
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            try { File.AppendAllText(LogPath, DateTime.Now + " [Task] " + args.Exception + Environment.NewLine); } catch { }
            args.SetObserved();
        };

        // 手动创建主窗口（不用 StartupUri，便于单实例控制）。
        var main = new MainWindow();
        MainWindow = main;
        main.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        if (_mutex != null)
        {
            try { _mutex.ReleaseMutex(); } catch { /* 忽略重复释放 */ }
            _mutex.Dispose();
            _mutex = null;
        }
        base.OnExit(e);
    }
}
