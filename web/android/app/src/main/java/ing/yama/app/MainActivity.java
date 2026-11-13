package ing.yama.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins: the scanner's text reader and the updater (docs/mobile.md).
        registerPlugin(TextReaderPlugin.class);
        registerPlugin(UpdaterPlugin.class);
        // Before the bridge reads its server path: drop a web build that never started.
        UpdaterPlugin.recoverOnLaunch(this);
        super.onCreate(savedInstanceState);
    }
}
