using System.Threading;
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
