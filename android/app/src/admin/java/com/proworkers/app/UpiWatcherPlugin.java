package com.proworkers.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.text.TextUtils;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Lets the admin screen turn on notification access and hand the login token to the listener. */
@CapacitorPlugin(name = "UpiWatcher")
public class UpiWatcherPlugin extends Plugin {

    private boolean isEnabled() {
        String flat = Settings.Secure.getString(getContext().getContentResolver(), "enabled_notification_listeners");
        if (TextUtils.isEmpty(flat)) return false;
        String me = getContext().getPackageName();
        for (String s : flat.split(":")) {
            ComponentName cn = ComponentName.unflattenFromString(s);
            if (cn != null && me.equals(cn.getPackageName())) return true;
        }
        return false;
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("enabled", isEnabled());
        call.resolve(r);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent i = new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS");
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void saveConfig(PluginCall call) {
        String token = call.getString("token", "");
        String api = call.getString("apiBase", "");
        SharedPreferences sp = getContext().getSharedPreferences("pw_upi", Context.MODE_PRIVATE);
        sp.edit().putString("token", token).putString("api", api).apply();
        call.resolve();
    }

    @PluginMethod
    public void clearConfig(PluginCall call) {
        getContext().getSharedPreferences("pw_upi", Context.MODE_PRIVATE).edit().clear().apply();
        call.resolve();
    }
}
