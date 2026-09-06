package com.elainachat.opensource;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

/**
 * 开机自启：桌宠开启时拉起守护服务（保活）。
 */
public class ElainaBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : intent.getAction();
        if (!"android.intent.action.BOOT_COMPLETED".equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) return;
        try {
            SharedPreferences sp = context.getSharedPreferences("elaina_pet", Context.MODE_PRIVATE);
            if (!sp.getBoolean("enabled", false)) return;
            Intent i = new Intent(context, ElainaPetService.class);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i);
            else context.startService(i);
        } catch (Exception e) { /* 忽略 */ }
    }
}
