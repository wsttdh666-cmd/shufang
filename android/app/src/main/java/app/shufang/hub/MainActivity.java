package app.shufang.hub;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppToolsPlugin.class);
        registerPlugin(TomatoEnginePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
