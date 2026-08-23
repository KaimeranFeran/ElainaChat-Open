package com.elainachat.opensource;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ByokSecretsPlugin.class);
        registerPlugin(ByokHttpPlugin.class);
        registerPlugin(FileBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
