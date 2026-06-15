package ai.devin.rtflow;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

/** MainActivity · 控制台面板 (file:// WebView, 与引擎共享 localStorage 账号)。 */
public class MainActivity extends AppCompatActivity {

    private WebView panel;

    @SuppressWarnings("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        startRelay();

        panel = new WebView(this);
        WebSettings s = panel.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        panel.addJavascriptInterface(new Panel(), "Panel");
        panel.loadUrl("file:///android_asset/engine/panel.html");
        setContentView(panel);
    }

    private void startRelay() {
        Intent svc = new Intent(this, RelayService.class);
        if (Build.VERSION.SDK_INT >= 26) ContextCompat.startForegroundService(this, svc);
        else startService(svc);
    }

    public class Panel {
        @JavascriptInterface public String status() { return RelayService.lastStatus; }
        @JavascriptInterface public void restart() {
            stopService(new Intent(MainActivity.this, RelayService.class));
            startRelay();
        }
        @JavascriptInterface public void openTab(String url, String accountJson) {
            startActivity(new Intent(MainActivity.this, TabActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT | Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
                    .putExtra("url", url).putExtra("account", accountJson));
        }
    }

    @Override protected void onDestroy() { if (panel != null) { panel.destroy(); panel = null; } super.onDestroy(); }
}
