package com.elainachat.opensource;

import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 桌宠开关与配置桥（前端设置项调用）。
 */
@CapacitorPlugin(name = "ElainaPet")
public class ElainaPetPlugin extends Plugin {

    private SharedPreferences sp() {
        return getContext().getSharedPreferences("elaina_pet", android.content.Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        JSObject o = call.getData();
        boolean enabled = o.optBoolean("enabled", false);
        String baseUrl = o.optString("baseUrl", "");
        String apiKey = o.optString("apiKey", "");
        String systemPrompt = o.optString("systemPrompt", "");
        int interval = o.optInt("interval", 15);
        boolean proactive = o.optBoolean("proactive", false);
        // scale / clickthrough 在下方随 o.opt... 存取
        sp().edit()
                .putBoolean("enabled", enabled)
                .putString("baseUrl", baseUrl)
                .putString("apiKey", apiKey)
                .putString("systemPrompt", systemPrompt)
                .putInt("interval", Math.max(5, Math.min(60, interval)))
                .putBoolean("proactive", proactive)
                .putFloat("scale", (float) Math.max(0.6, Math.min(1.6, o.optDouble("scale", 1.0))))
                .putBoolean("clickthrough", o.optBoolean("clickthrough", false))
                .apply();
        Intent i = new Intent(getContext(), ElainaPetService.class);
        if (enabled) {
            if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i);
            else getContext().startService(i);
        } else {
            getContext().stopService(i);
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", sp().getBoolean("enabled", false));
        ret.put("proactive", sp().getBoolean("proactive", false));
        ret.put("interval", sp().getInt("interval", 15));
        ret.put("overlayGranted", android.provider.Settings.canDrawOverlays(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) { call.reject("无法打开无障碍设置"); return; }
        call.resolve();
    }

    /* ---------- Shizuku：保活 / 自动开启无障碍 ---------- */
    private static final int SHIZUKU_REQ = 4801;

    @PluginMethod
    public void checkShizuku(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            boolean running = rikka.shizuku.Shizuku.pingBinder();
            boolean granted = running && (rikka.shizuku.Shizuku.isPreV11() ||
                    rikka.shizuku.Shizuku.checkSelfPermission() == android.content.pm.PackageManager.PERMISSION_GRANTED);
            ret.put("running", running);
            ret.put("granted", granted);
        } catch (Throwable e) {
            ret.put("running", false);
            ret.put("granted", false);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void requestShizuku(PluginCall call) {
        try {
            if (!rikka.shizuku.Shizuku.pingBinder()) { call.reject("Shizuku 未运行，请先安装并启动 Shizuku"); return; }
            if (rikka.shizuku.Shizuku.isPreV11() || rikka.shizuku.Shizuku.checkSelfPermission() == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                /* Shizuku 已授权：引导开启无障碍（并打开电池白名单），配合前台服务保活 */
                openAccessibilitySettingsInternal();
                JSObject ok = new JSObject();
                ok.put("granted", true);
                ok.put("guided", true);
                call.resolve(ok);
                return;
            }
            rikka.shizuku.Shizuku.requestPermission(SHIZUKU_REQ);
            JSObject ret = new JSObject();
            ret.put("requested", true);
            call.resolve(ret);
        } catch (Throwable e) {
            call.reject("Shizuku 授权失败：" + e.getMessage());
        }
    }

    /** Shizuku 已授权时的保活引导：无障碍设置 + 电池白名单（Android 限制无法静默开启无障碍） */
    @PluginMethod
    public void autoEnableAccessibility(PluginCall call) {
        try { openAccessibilitySettingsInternal(); call.resolve(); }
        catch (Throwable e) { call.reject("打开无障碍设置失败：" + e.getMessage()); }
    }

    private void openAccessibilitySettingsInternal() {
        try {
            android.content.Intent i = new android.content.Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
            i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Throwable e) { /* 忽略 */ }
    }

    private void enableKeepAlive() { /* 保活由前台服务 + 开机自启 + 电池白名单引导承担 */ }

    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) { call.reject("无法打开悬浮窗设置"); return; }
        call.resolve();
    }

    @PluginMethod
    public void openBatteryWhitelist(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            try {
                Intent i2 = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                i2.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i2);
            } catch (Exception e2) { call.reject("无法打开电池优化设置"); return; }
        }
        call.resolve();
    }

    @PluginMethod
    public void openBrandWhitelist(PluginCall call) {
        try {
            String[][] targets = {
                    {"com.miui.securitycenter", "com.miui.securitycenter/.permcenter.autostart.AutoStartManagementActivity"},
                    {"com.huawei.systemmanager", "com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity"},
                    {"com.coloros.safecenter", "com.coloros.safecenter/.permission.startup.StartupAppListActivity"},
                    {"com.vivo.permissionmanager", "com.vivo.permissionmanager/.activity.BgStartUpManagerActivity"}
            };
            for (String[] t : targets) {
                try {
                    Intent i = new Intent();
                    i.setComponent(ComponentName.unflattenFromString(t[1]));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(i);
                    call.resolve();
                    return;
                } catch (Exception e) { /* 尝试下一个厂商 */ }
            }
            call.reject("未找到厂商自启动设置页");
        } catch (Exception e) { call.reject(e.getMessage()); }
    }
}
