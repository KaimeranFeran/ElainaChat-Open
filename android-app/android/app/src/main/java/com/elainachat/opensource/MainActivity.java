package com.elainachat.opensource;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ByokSecretsPlugin.class);
        registerPlugin(ByokHttpPlugin.class);
        registerPlugin(ElainaPetPlugin.class);
        registerPlugin(FileBridgePlugin.class);
        super.onCreate(savedInstanceState);
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setMediaPlaybackRequiresUserGesture(false);
        }
    }
}
