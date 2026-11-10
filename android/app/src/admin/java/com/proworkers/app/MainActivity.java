package com.proworkers.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UpiWatcherPlugin.class);   // admin "auto-verify UPI payments" switch
        super.onCreate(savedInstanceState);
    }
}
