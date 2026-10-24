package com.proworkers.app;

import android.app.Notification;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads "money received" notifications from UPI apps and forwards ONLY the amount and text of
 * those to the ProWorkers server (admin login). The server decides whether it matches a payment.
 * Turned on by the admin in Settings > Notification access. Does nothing if not logged in as admin.
 */
public class UpiNotificationListener extends NotificationListenerService {

    // Apps whose notifications are considered. Add a package name here to support another app.
    private static final Set<String> APPS = new HashSet<>(Arrays.asList(
            "com.google.android.apps.nbu.paisa.user",   // Google Pay
            "com.phonepe.app",                          // PhonePe
            "net.one97.paytm",                          // Paytm
            "in.org.npci.upiapp",                       // BHIM
            "in.amazon.mShop.android.shopping",         // Amazon Pay
            "com.sbi.lotusintouch",                     // SBI YONO
            "com.snapwork.hdfc",                        // HDFC
            "com.csam.icici.bank.imobile",              // ICICI iMobile
            "com.axis.mobile",                          // Axis
            "com.msf.kbank.mobile",                     // Kotak
            "com.bankofbaroda.mconnect"                 // Bank of Baroda
    ));

    private static final Pattern CREDIT = Pattern.compile(
            "(received|credited|paid you|sent you|has paid|payment from|money in)", Pattern.CASE_INSENSITIVE);
    private static final Pattern NOT_CREDIT = Pattern.compile(
            "(debited|you paid|paid to|sent to|you sent|requested|request from|declined|failed|refund)", Pattern.CASE_INSENSITIVE);
    private static final Pattern AMOUNT = Pattern.compile(
            "(?:₹|rs\\.?|inr)\\s?([0-9][0-9,]*(?:\\.[0-9]{1,2})?)", Pattern.CASE_INSENSITIVE);

    private final ArrayDeque<String> seen = new ArrayDeque<>();

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            if (sbn == null || !APPS.contains(sbn.getPackageName())) return;
            Notification n = sbn.getNotification();
            if (n == null || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;

            Bundle e = n.extras;
            String title = str(e.getCharSequence(Notification.EXTRA_TITLE));
            String text  = str(e.getCharSequence(Notification.EXTRA_TEXT));
            String big   = str(e.getCharSequence(Notification.EXTRA_BIG_TEXT));
            String all   = (title + " " + (big.isEmpty() ? text : big)).trim();
            if (all.isEmpty()) return;

            if (!CREDIT.matcher(all).find() || NOT_CREDIT.matcher(all).find()) return;
            Matcher m = AMOUNT.matcher(all);
            if (!m.find()) return;
            final double amount = Double.parseDouble(m.group(1).replace(",", ""));
            if (amount <= 0) return;

            String key = sbn.getKey() + "|" + sbn.getPostTime();
            synchronized (seen) {
                if (seen.contains(key)) return;
                seen.add(key);
                while (seen.size() > 50) seen.poll();
            }

            final String pkg = sbn.getPackageName();
            final String body = all.length() > 300 ? all.substring(0, 300) : all;
            new Thread(() -> send(amount, pkg, body)).start();
        } catch (Throwable ignored) { }
    }

    private static String str(CharSequence c) { return c == null ? "" : c.toString(); }

    private void send(double amount, String pkg, String text) {
        SharedPreferences sp = getSharedPreferences("pw_upi", Context.MODE_PRIVATE);
        String token = sp.getString("token", "");
        String api = sp.getString("api", "");
        if (token.isEmpty() || api.isEmpty()) return;
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(api + "/admin/upi-credits").openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(20000);
                c.setReadTimeout(20000);   // free servers can take a while to wake up
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setRequestProperty("Authorization", "Bearer " + token);
                JSONObject j = new JSONObject();
                j.put("amount", amount);
                j.put("pkg", pkg);
                j.put("text", text);
                try (OutputStream os = c.getOutputStream()) { os.write(j.toString().getBytes(StandardCharsets.UTF_8)); }
                int code = c.getResponseCode();
                c.disconnect();
                if (code >= 200 && code < 300) return;
                if (code == 401 || code == 403) return;   // token expired: open the admin app once to refresh
            } catch (Throwable ignored) { }
            try { Thread.sleep(3000); } catch (InterruptedException ignored) { }
        }
    }
}
